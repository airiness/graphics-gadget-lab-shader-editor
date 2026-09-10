//! Durable host-owned producer intent. No registration, activation or native Ready claims.
use crate::environment_io::{
    error, ordinary_path, request_selected, EnvironmentHostError as Error, EnvironmentService,
};
use crate::environment_storage::{DirectoryHandle, DirectoryKind, EnvironmentStorageService};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    deployment: String,
    tool_sha256: String,
    runtime_sha256: String,
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Prepare {
    Publish {
        repository_id: String,
        candidate: Candidate,
    },
    InitState {
        repository_id: String,
        environment_directory_id: String,
        environment_id: String,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    intent_version: u32,
    operation_id: String,
    operation: String,
    repository_root: PathBuf,
    publisher_sha256: String,
    candidate: Option<Candidate>,
    environment_root: Option<PathBuf>,
    environment_id: Option<String>,
    target_root: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    intent: Intent,
    target: Option<DirectoryHandle>,
    environment: Option<DirectoryHandle>,
    termination_unproven: bool,
}
#[derive(Default)]
pub struct MutationService {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pending_cancel: Mutex<HashSet<String>>,
    sequence: AtomicU64,
}
impl Drop for MutationService {
    fn drop(&mut self) {
        if let Ok(running) = self.running.lock() {
            for flag in running.values() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }
}
fn io(e: impl ToString) -> Error {
    error("io-error", e)
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn leaf(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !part.ends_with('.')
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        })
}
fn id(value: &str) -> Result<(), Error> {
    if value.len() != 32
        || !value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(error("invalid-handle", "Invalid producer operation ID"));
    }
    Ok(())
}
fn ensure(path: &Path) -> Result<PathBuf, Error> {
    if !path.try_exists().map_err(io)? {
        let parent = path
            .parent()
            .ok_or_else(|| error("invalid-path", "Missing parent"))?;
        ensure(parent)?;
        match std::fs::create_dir(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(io(e)),
        }
    }
    let path = ordinary_path(path)?;
    if !path.is_dir() {
        return Err(error("invalid-path", "Expected storage directory"));
    }
    Ok(path)
}
fn journal(root: &Path, key: &str) -> PathBuf {
    root.join("environment-operations")
        .join(format!("{key}.json"))
}
// A reversible base-36 spelling of the full operation ID, not a truncated identity.
fn compact_id(key: &str) -> String {
    let mut value = u128::from_str_radix(key, 16).expect("validated operation ID");
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize]);
        value /= 36;
        if value == 0 { break; }
    }
    digits.reverse(); String::from_utf8(digits).unwrap()
}
fn destination(root: &Path, key: &str, operation: &str) -> PathBuf {
    if operation == "publish" { root.join("environments").join(key) }
    else { root.join("s").join(compact_id(key)) }
}
fn saved_destination(root: &Path, key: &str, operation: &str, version: u32) -> PathBuf {
    if version == 1 && operation == "init-state" { root.join("environment-state").join(key) }
    else { destination(root, key, operation) }
}
fn load(root: &Path, key: &str) -> Result<Intent, Error> {
    id(key)?;
    let path = ordinary_path(&journal(root, key))?;
    if std::fs::metadata(&path).map_err(io)?.len() > 65536 {
        return Err(error("limit-exceeded", "Operation intent is too large"));
    }
    let (_guard, _) = crate::shader_tool::provenance::observe_and_hold(&path.to_string_lossy())
        .map_err(|e| error("source-changed", format!("{e:?}")))?;
    let intent: Intent = serde_json::from_slice(&std::fs::read(path).map_err(io)?).map_err(io)?;
    if ![1, 2].contains(&intent.intent_version)
        || intent.operation_id != key
        || !["publish", "init-state"].contains(&intent.operation.as_str())
        || intent.target_root != saved_destination(root, key, &intent.operation, intent.intent_version)
        || !hash(&intent.publisher_sha256)
    {
        return Err(error("invalid-shape", "Invalid saved operation intent"));
    }
    match (
        &intent.candidate,
        &intent.environment_root,
        &intent.environment_id,
    ) {
        (Some(c), None, None)
            if intent.operation == "publish"
                && leaf(&c.deployment)
                && hash(&c.tool_sha256)
                && hash(&c.runtime_sha256) => {}
        (None, Some(_), Some(e))
            if intent.operation == "init-state" && e.strip_prefix("sha256:").is_some_and(hash) => {}
        _ => return Err(error("invalid-shape", "Invalid saved operation binding")),
    }
    Ok(intent)
}
impl MutationService {
    pub fn prepare(
        &self,
        root: &Path,
        producer: &EnvironmentService,
        storage: &EnvironmentStorageService,
        request: Prepare,
    ) -> Result<Intent, Error> {
        let root = ensure(root)?;
        let (repository_id, candidate, environment_root, environment_id, operation) = match request
        {
            Prepare::Publish {
                repository_id,
                candidate,
            } => {
                if !leaf(&candidate.deployment)
                    || !hash(&candidate.tool_sha256)
                    || !hash(&candidate.runtime_sha256)
                {
                    return Err(error("invalid-shape", "Invalid selected deployment"));
                }
                (repository_id, Some(candidate), None, None, "publish")
            }
            Prepare::InitState {
                repository_id,
                environment_directory_id,
                environment_id,
            } => {
                if !environment_id.strip_prefix("sha256:").is_some_and(hash) {
                    return Err(error("identity-mismatch", "Invalid Environment identity"));
                }
                let environment =
                    storage.selected_path(&environment_directory_id, DirectoryKind::Environment)?;
                (
                    repository_id,
                    None,
                    Some(environment),
                    Some(environment_id),
                    "init-state",
                )
            }
        };
        let selected = producer.selected_repository(&repository_id)?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(io)?
            .as_nanos();
        let key = format!(
            "{:024x}{:08x}",
            now,
            self.sequence.fetch_add(1, Ordering::SeqCst)
        );
        let target_root = destination(&root, &key, operation);
        if operation == "init-state" { crate::environment_execution::validate_state_path(&target_root)?; }
        if environment_root.as_ref().is_some_and(|environment| {
            target_root.starts_with(environment) || environment.starts_with(&target_root)
                || root.join("environment-operations").starts_with(environment)
        }) {
            return Err(error("invalid-path", "Managed writes overlap the selected immutable Environment"));
        }
        ensure(target_root.parent().unwrap())?;
        ensure(&root.join("environment-operations"))?;
        let intent = Intent {
            intent_version: 2,
            operation_id: key.clone(),
            operation: operation.into(),
            repository_root: selected.root,
            publisher_sha256: selected.publisher_sha256,
            candidate,
            environment_root,
            environment_id,
            target_root,
        };
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(journal(&root, &key))
            .map_err(io)?;
        file.write_all(&serde_json::to_vec(&intent).map_err(io)?)
            .map_err(io)?;
        file.sync_all().map_err(io)?;
        Ok(intent)
    }
    pub fn list(&self, root: &Path) -> Result<Vec<String>, Error> {
        let dir = root.join("environment-operations");
        if !dir.try_exists().map_err(io)? {
            return Ok(vec![]);
        }
        ordinary_path(&dir)?;
        let mut ids = Vec::new();
        for entry in std::fs::read_dir(dir).map_err(io)? {
            let path = entry.map_err(io)?.path();
            if path.extension().is_some_and(|e| e == "json") {
                let key = path.file_stem().unwrap().to_string_lossy().into_owned();
                id(&key)?;
                ids.push(key);
                if ids.len() > 10000 {
                    return Err(error("limit-exceeded", "Too many operation intents"));
                }
            }
        }
        ids.sort();
        Ok(ids)
    }
    pub fn inspect(
        &self,
        root: &Path,
        storage: &EnvironmentStorageService,
        key: &str,
    ) -> Result<Inspection, Error> {
        if self.running.lock().map_err(io)?.contains_key(key) {
            return Err(error(
                "host-busy",
                "Wait for producer execution to settle before inspecting",
            ));
        }
        let intent = load(root, key)?;
        let target = if intent.target_root.try_exists().map_err(io)? {
            Some(storage.select(
                &intent.target_root,
                if intent.operation == "publish" {
                    DirectoryKind::Environment
                } else {
                    DirectoryKind::State
                },
            )?)
        } else {
            None
        };
        let environment = intent
            .environment_root
            .as_ref()
            .map(|p| storage.select(p, DirectoryKind::Environment))
            .transpose()?;
        let termination_unproven = root
            .join("environment-operations")
            .join(format!("{key}.running"))
            .try_exists()
            .map_err(io)?;
        Ok(Inspection {
            intent,
            target,
            environment,
            termination_unproven,
        })
    }
    pub fn cancel(&self, key: &str) -> Result<bool, Error> {
        id(key)?;
        let running = self.running.lock().map_err(io)?;
        if let Some(flag) = running.get(key) {
            flag.store(true, Ordering::SeqCst);
            Ok(true)
        } else {
            let mut pending = self.pending_cancel.lock().map_err(io)?;
            if pending.len() >= 10000 {
                return Err(error("limit-exceeded", "Too many cancellation requests"));
            }
            pending.insert(key.into());
            Ok(false)
        }
    }
    pub fn run(
        &self,
        root: &Path,
        producer: &EnvironmentService,
        repository_id: &str,
        key: &str,
    ) -> Result<serde_json::Value, Error> {
        let intent = load(root, key)?;
        let selected = producer.selected_repository(repository_id)?;
        if selected.root != intent.repository_root
            || selected.publisher_sha256 != intent.publisher_sha256
        {
            return Err(error(
                "source-changed",
                "Reselect the original publisher for this operation",
            ));
        }
        ordinary_path(intent.target_root.parent().unwrap())?;
        // A durable running marker is conservative after process/app death. Never blindly replay a mutation.
        let marker = root
            .join("environment-operations")
            .join(format!("{key}.running"));
        if marker.try_exists().map_err(io)? {
            return Err(error(
                "termination-unproven",
                "Inspect the retained target; automatic mutation retry is blocked",
            ));
        }
        if intent.target_root.try_exists().map_err(io)? {
            return Ok(serde_json::json!({"operationId":key,"kind":"existing-target"}));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut running = self.running.lock().map_err(io)?;
            if running.len() >= 4 || running.contains_key(key) {
                return Err(error("host-busy", "Producer operation already running"));
            }
            if self.pending_cancel.lock().map_err(io)?.remove(key) {
                cancel.store(true, Ordering::SeqCst);
            }
            running.insert(key.into(), cancel.clone());
        }
        let mut owns_marker = false;
        let mut outcome: Result<serde_json::Value, Error> = (|| {
            if cancel.load(Ordering::SeqCst) {
                return Err(error(
                    "cancelled",
                    "Producer operation cancelled before execution",
                ));
            }
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
                .map_err(io)?;
            owns_marker = true;
            file.write_all(b"Termination must be established before retry.\n")
                .map_err(io)?;
            file.sync_all().map_err(io)?;
            let request = if let Some(candidate) = &intent.candidate {
                // Re-observe the explicitly selected deployment; never choose the first discovered configuration.
                let deployment = ordinary_path(&selected.root.join(&candidate.deployment))?;
                if !deployment.starts_with(&selected.root) {
                    return Err(error("invalid-path", "Deployment escaped repository"));
                }
                for (name, expected) in [
                    ("gglab-shaderc.exe", &candidate.tool_sha256),
                    ("GraphicsGadgetLab.exe", &candidate.runtime_sha256),
                ] {
                    let path = ordinary_path(&deployment.join(name))?;
                    let (_, actual) =
                        crate::shader_tool::provenance::observe_and_hold(&path.to_string_lossy())
                            .map_err(|e| error("source-changed", format!("{e:?}")))?;
                    if &actual != expected {
                        return Err(error(
                            "source-changed",
                            "Selected deployment executable changed",
                        ));
                    }
                }
                serde_json::json!({"requestVersion":1,"operation":"publish","repositoryRoot":selected.root,"deployment":candidate.deployment,"destination":intent.target_root,"cancelFile":null})
            } else {
                serde_json::json!({"requestVersion":1,"operation":"init-state","environmentRoot":intent.environment_root,"stateRoot":intent.target_root})
            };
            let (output, interpreter_sha256) =
                request_selected(&selected, &request, &cancel, Duration::from_secs(900))?;
            // Only executor success establishes process-tree termination. Keep marker on all uncertain host failures.
            std::fs::remove_file(&marker).map_err(io)?;
            Ok(
                serde_json::json!({"operationId":key,"kind":"settled","publisherSha256":selected.publisher_sha256,"interpreterSha256":interpreter_sha256,"output":output}),
            )
        })();
        if owns_marker
            && outcome
                .as_ref()
                .is_err_and(|e| e.code != "termination-unproven")
        {
            // Pre-spawn refusal or an executor error after proven tree termination is retryable.
            // A panic/app death cannot reach this path and deliberately leaves the marker.
            if let Err(e) = std::fs::remove_file(&marker) {
                outcome = Err(io(e));
            }
        }
        self.running.lock().map_err(io)?.remove(key);
        outcome
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn pre_spawn_failure_and_early_cancel_leave_the_same_intent_retryable() {
        let root = temporary();
        let scripts = root.join("Scripts/Environment");
        ensure(&scripts).unwrap();
        std::fs::write(
            scripts.join("publisher.py"),
            b"raise Exception('must not execute')",
        )
        .unwrap();
        std::fs::write(scripts.join("bootstrap.json"),serde_json::to_vec(&serde_json::json!({"bootstrapVersion":1,"publisher":"Scripts/Environment/publisher.py","interpreter":"python","minimumPythonVersion":"3.12","transport":"single-utf8-json-stdin-stdout","requestVersions":[1],"resultVersions":[1],"defaultSearchRoots":["Build"],"contractStatus":"implemented-pending-owner-review"})).unwrap()).unwrap();
        let deployment = root.join("Build/Debug");
        ensure(&deployment).unwrap();
        std::fs::write(deployment.join("gglab-shaderc.exe"), b"changed").unwrap();
        let producer = EnvironmentService::new();
        let repository = producer.register_selected_repository(root.clone()).unwrap();
        let service = MutationService::default();
        let storage = EnvironmentStorageService::default();
        let overlapping = storage.select(&root, DirectoryKind::Environment).unwrap();
        assert!(service.prepare(&root, &producer, &storage, Prepare::InitState {
            repository_id: repository.repository_id.clone(), environment_directory_id: overlapping.directory_id,
            environment_id: format!("sha256:{}", "0".repeat(64)),
        }).is_err());
        let saved = service
            .prepare(
                &root,
                &producer,
                &storage,
                Prepare::Publish {
                    repository_id: repository.repository_id.clone(),
                    candidate: Candidate {
                        deployment: "Build/Debug".into(),
                        tool_sha256: "b".repeat(64),
                        runtime_sha256: "c".repeat(64),
                    },
                },
            )
            .unwrap();
        service.cancel(&saved.operation_id).unwrap();
        assert_eq!(
            service
                .run(
                    &root,
                    &producer,
                    &repository.repository_id,
                    &saved.operation_id
                )
                .unwrap_err()
                .code,
            "cancelled"
        );
        for _ in 0..2 {
            assert_eq!(
                service
                    .run(
                        &root,
                        &producer,
                        &repository.repository_id,
                        &saved.operation_id
                    )
                    .unwrap_err()
                    .code,
                "source-changed"
            );
            assert!(
                !service
                    .inspect(&root, &storage, &saved.operation_id)
                    .unwrap()
                    .termination_unproven
            );
        }
        assert!(!saved.target_root.exists());
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
    fn temporary() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "gglab-mutation-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        ensure(&root).unwrap()
    }
    fn intent(root: &Path) -> Intent {
        ensure(&root.join("environment-operations")).unwrap();
        let key = "1".repeat(32);
        let intent = Intent {
            intent_version: 1,
            operation_id: key.clone(),
            operation: "publish".into(),
            repository_root: root.into(),
            publisher_sha256: "a".repeat(64),
            candidate: Some(Candidate {
                deployment: "Build/Debug".into(),
                tool_sha256: "b".repeat(64),
                runtime_sha256: "c".repeat(64),
            }),
            environment_root: None,
            environment_id: None,
            target_root: destination(root, &key, "publish"),
        };
        std::fs::write(journal(root, &key), serde_json::to_vec(&intent).unwrap()).unwrap();
        intent
    }
    #[test]
    fn restart_lists_intents_and_retains_missing_or_unproven_targets() {
        let root = temporary();
        let saved = intent(&root);
        let service = MutationService::default();
        let storage = EnvironmentStorageService::default();
        assert_eq!(
            service.list(&root).unwrap(),
            vec![saved.operation_id.clone()]
        );
        let seen = service
            .inspect(&root, &storage, &saved.operation_id)
            .unwrap();
        assert!(seen.target.is_none());
        assert!(!seen.termination_unproven);
        std::fs::write(
            root.join("environment-operations")
                .join(format!("{}.running", saved.operation_id)),
            b"retained",
        )
        .unwrap();
        let restarted = MutationService::default();
        assert!(
            restarted
                .inspect(&root, &storage, &saved.operation_id)
                .unwrap()
                .termination_unproven
        );
        assert!(journal(&root, &saved.operation_id).exists());
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn compact_state_paths_preserve_identity_and_legacy_recovery() {
        let root = temporary();
        let mut saved = intent(&root);
        saved.operation = "init-state".into(); saved.candidate = None;
        saved.environment_root = Some(root.join("environment"));
        saved.environment_id = Some(format!("sha256:{}", "a".repeat(64)));
        for version in [1, 2] {
            saved.intent_version = version;
            saved.target_root = saved_destination(&root, &saved.operation_id, "init-state", version);
            std::fs::write(journal(&root, &saved.operation_id), serde_json::to_vec(&saved).unwrap()).unwrap();
            assert_eq!(load(&root, &saved.operation_id).unwrap().target_root, saved.target_root);
        }
        for key in ["0".repeat(32), "f".repeat(32), saved.operation_id.clone()] {
            assert_eq!(u128::from_str_radix(&compact_id(&key), 36).unwrap(), u128::from_str_radix(&key, 16).unwrap());
        }
        saved.target_root = root.join("s/other");
        std::fs::write(journal(&root, &saved.operation_id), serde_json::to_vec(&saved).unwrap()).unwrap();
        assert!(load(&root, &saved.operation_id).is_err());
        assert!(root.starts_with(std::env::temp_dir())); std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn state_path_limit_counts_windows_utf16_units() {
        use crate::environment_execution::validate_state_path;
        assert!(validate_state_path(Path::new(&"a".repeat(90))).is_ok());
        assert_eq!(validate_state_path(Path::new(&"a".repeat(91))).unwrap_err().code, "path-too-long");
        let supplementary = char::from_u32(0x1f600).unwrap().to_string().repeat(46);
        assert!(validate_state_path(Path::new(&supplementary)).is_err());
    }
    #[test]
    fn edited_journals_cannot_redirect_mutation_destinations() {
        let root = temporary();
        let mut saved = intent(&root);
        saved.target_root = root.join("unrelated");
        std::fs::write(
            journal(&root, &saved.operation_id),
            serde_json::to_vec(&saved).unwrap(),
        )
        .unwrap();
        assert!(load(&root, &saved.operation_id).is_err());
        assert!(load(&root, "../escape").is_err());
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "requires pinned producer, built deployment and explicit managed test root"]
    fn real_mutation_bridge() {
        use std::io::{BufRead, Write};
        let producer = EnvironmentService::new();
        let storage = EnvironmentStorageService::default();
        let service = MutationService::default();
        let repository = producer
            .register_selected_repository(PathBuf::from(
                std::env::var("GGLAB_ENVIRONMENT_SOURCE").unwrap(),
            ))
            .unwrap();
        let root = ensure(&PathBuf::from(
            std::env::var("GGLAB_MUTATION_ROOT").unwrap(),
        ))
        .unwrap();
        for line in std::io::stdin().lock().lines() {
            let request: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
            let a = &request["args"];
            let result: Result<serde_json::Value, Error> = (|| {
                Ok(match request["command"].as_str().unwrap() {
                    "repository" => serde_json::to_value(&repository).unwrap(),
                    "discover" => serde_json::to_value(
                        producer
                            .discover(&repository.repository_id)?
                            .settle
                            .join()
                            .unwrap(),
                    )
                    .unwrap(),
                    "shader-environment-prepare-mutation" => {
                        serde_json::to_value(service.prepare(
                            &root,
                            &producer,
                            &storage,
                            serde_json::from_value(a["request"].clone()).map_err(io)?,
                        )?)
                        .unwrap()
                    }
                    "shader-environment-run-mutation" => service.run(
                        &root,
                        &producer,
                        a["repositoryId"].as_str().unwrap(),
                        a["operationId"].as_str().unwrap(),
                    )?,
                    "shader-environment-inspect-mutation" => serde_json::to_value(
                        service.inspect(&root, &storage, a["operationId"].as_str().unwrap())?,
                    )
                    .unwrap(),
                    "shader-environment-list-mutations" => {
                        serde_json::to_value(service.list(&root)?).unwrap()
                    }
                    "shader-environment-cancel-mutation" => {
                        serde_json::to_value(service.cancel(a["operationId"].as_str().unwrap())?)
                            .unwrap()
                    }
                    "shader-environment-observe-directory" => {
                        serde_json::to_value(storage.observe(a["directoryId"].as_str().unwrap())?)
                            .unwrap()
                    }
                    _ => return Err(error("invalid-request", "Unknown bridge command")),
                })
            })();
            println!(
                "GGLAB_MUTATION_REPLY:{}",
                serde_json::to_string(&match result {
                    Ok(value) => serde_json::json!({"value":value}),
                    Err(error) => serde_json::json!({"error":error}),
                })
                .unwrap()
            );
            std::io::stdout().flush().unwrap();
        }
    }
}
