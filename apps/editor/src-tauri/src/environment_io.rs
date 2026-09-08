//! Read-only Environment bootstrap and discovery. WebView requests contain host-issued IDs only.
use crate::shader_tool::provenance::observe_and_hold;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const MAX_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentHostError {
    pub code: String,
    pub message: String,
    pub data_path: String,
}
fn error(code: &str, message: impl ToString) -> EnvironmentHostError {
    EnvironmentHostError {
        code: code.into(),
        message: message.to_string(),
        data_path: "$".into(),
    }
}
fn io(e: impl ToString) -> EnvironmentHostError {
    error("io-error", e)
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentRepository {
    pub repository_id: String,
    pub display_path: String,
    pub bootstrap_text: String,
    pub publisher_sha256: String,
}
#[derive(Clone)]
struct SelectedRepository {
    root: PathBuf,
    bootstrap: PathBuf,
    bootstrap_sha256: String,
    publisher: PathBuf,
    publisher_sha256: String,
    search_roots: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bootstrap {
    bootstrap_version: u32,
    publisher: String,
    interpreter: String,
    minimum_python_version: String,
    transport: String,
    request_versions: Vec<u32>,
    result_versions: Vec<u32>,
    default_search_roots: Vec<String>,
    contract_status: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentProcessOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub canceled: bool,
    pub output_limit_exceeded: bool,
}
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum EnvironmentDiscoverySettlement {
    Settled {
        discovery_id: String,
        repository_id: String,
        publisher_sha256: String,
        interpreter_sha256: String,
        output: EnvironmentProcessOutput,
    },
    Failed {
        discovery_id: String,
        repository_id: String,
        error: EnvironmentHostError,
    },
}
pub struct EnvironmentDiscoveryJob {
    pub id: String,
    pub settle: JoinHandle<EnvironmentDiscoverySettlement>,
}
pub struct EnvironmentService {
    selected: Mutex<HashMap<String, SelectedRepository>>,
    running: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    sequence: AtomicU64,
}
impl Default for EnvironmentService {
    fn default() -> Self {
        Self::new()
    }
}
impl EnvironmentService {
    pub fn new() -> Self {
        Self {
            selected: Mutex::new(HashMap::new()),
            running: Arc::new(Mutex::new(HashMap::new())),
            sequence: AtomicU64::new(1),
        }
    }
    pub fn register_selected_repository(
        &self,
        root: PathBuf,
    ) -> Result<EnvironmentRepository, EnvironmentHostError> {
        let root = ordinary_path(&root)?;
        if !root.is_dir() {
            return Err(error("invalid-path", "Select a repository directory"));
        }
        let bootstrap = ordinary_path(&root.join("Scripts/Environment/bootstrap.json"))?;
        let (_guard, bootstrap_sha256) = guarded_small_file(&bootstrap)?;
        let bootstrap_text = std::fs::read_to_string(&bootstrap).map_err(io)?;
        let b: Bootstrap =
            serde_json::from_str(&bootstrap_text).map_err(|e| error("invalid-json", e))?;
        if b.bootstrap_version != 1
            || b.interpreter != "python"
            || b.minimum_python_version != "3.12"
            || b.transport != "single-utf8-json-stdin-stdout"
            || b.request_versions != [1]
            || b.result_versions != [1]
            || b.contract_status != "implemented-pending-owner-review"
        {
            return Err(error(
                "unsupported-version",
                "Bootstrap requires explicit consumer review",
            ));
        }
        locator(&b.publisher)?;
        if b.default_search_roots.len() > 32 {
            return Err(error("limit-exceeded", "Too many discovery roots"));
        }
        for value in &b.default_search_roots {
            locator(value)?;
        }
        let publisher = ordinary_path(&root.join(&b.publisher))?;
        let (_, publisher_sha256) = guarded_small_file(&publisher)?;
        let mut selected = self.selected.lock().map_err(io)?;
        if selected.len() >= 64 {
            return Err(error("limit-exceeded", "Too many selected repositories"));
        }
        let repository_id = format!(
            "environment-repository:{}",
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        selected.insert(
            repository_id.clone(),
            SelectedRepository {
                root: root.clone(),
                bootstrap,
                bootstrap_sha256,
                publisher,
                publisher_sha256: publisher_sha256.clone(),
                search_roots: b.default_search_roots,
            },
        );
        Ok(EnvironmentRepository {
            repository_id,
            display_path: root.to_string_lossy().into_owned(),
            bootstrap_text,
            publisher_sha256,
        })
    }
    pub fn discover(
        &self,
        repository_id: &str,
    ) -> Result<EnvironmentDiscoveryJob, EnvironmentHostError> {
        let selected = self
            .selected
            .lock()
            .map_err(io)?
            .get(repository_id)
            .cloned()
            .ok_or_else(|| error("invalid-handle", "Select the repository again"))?;
        let id = format!(
            "environment-discovery:{}",
            self.sequence.fetch_add(1, Ordering::Relaxed)
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let mut running = self.running.lock().map_err(io)?;
        if running.len() >= 8 {
            return Err(error("limit-exceeded", "Too many active discoveries"));
        }
        running.insert(id.clone(), Arc::clone(&cancel));
        drop(running);
        let attempts = Arc::clone(&self.running);
        let job_id = id.clone();
        let repository_id = repository_id.to_owned();
        let settle = std::thread::spawn(move || {
            let outcome = discover_selected(&selected, &cancel);
            if let Ok(mut map) = attempts.lock() {
                map.remove(&job_id);
            }
            match outcome {
                Ok((output, interpreter_sha256)) => EnvironmentDiscoverySettlement::Settled {
                    discovery_id: job_id,
                    repository_id,
                    publisher_sha256: selected.publisher_sha256,
                    interpreter_sha256,
                    output,
                },
                Err(error) => EnvironmentDiscoverySettlement::Failed {
                    discovery_id: job_id,
                    repository_id,
                    error,
                },
            }
        });
        Ok(EnvironmentDiscoveryJob { id, settle })
    }
    pub fn cancel(&self, discovery_id: &str) -> Result<bool, EnvironmentHostError> {
        let running = self.running.lock().map_err(io)?;
        if let Some(flag) = running.get(discovery_id) {
            flag.store(true, Ordering::Release);
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
fn locator(value: &str) -> Result<(), EnvironmentHostError> {
    if value.is_empty() || value.len() > 240 {
        return Err(error("invalid-path", "Invalid locator length"));
    }
    for part in value.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let device = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.as_bytes()[3].is_ascii_digit());
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || device
            || !part
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        {
            return Err(error("invalid-path", "Unsafe repository-relative locator"));
        }
    }
    Ok(())
}
fn ordinary_path(path: &Path) -> Result<PathBuf, EnvironmentHostError> {
    if !cfg!(windows) {
        return Err(error(
            "unsupported-platform",
            "Environment discovery requires Windows",
        ));
    }
    if !path.is_absolute()
        || path.to_string_lossy().starts_with(r"\\")
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(error("invalid-path", "Expected an absolute local path"));
    }
    for ancestor in path.ancestors() {
        let metadata = std::fs::symlink_metadata(ancestor).map_err(io)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(error("reparse-point", "Reparse paths are forbidden"));
            }
        }
        if metadata.file_type().is_symlink() {
            return Err(error("reparse-point", "Linked paths are forbidden"));
        }
    }
    let canonical = std::fs::canonicalize(path).map_err(io)?;
    let text = canonical.to_string_lossy();
    Ok(PathBuf::from(text.strip_prefix(r"\\?\").unwrap_or(&text)))
}
fn guarded_small_file(
    path: &Path,
) -> Result<(crate::shader_tool::provenance::ProvenanceGuard, String), EnvironmentHostError> {
    let metadata = std::fs::metadata(path).map_err(io)?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES as u64 {
        return Err(error(
            "limit-exceeded",
            "Bootstrap or publisher is not a bounded regular file",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let file = std::fs::File::open(path).map_err(io)?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        if info.nNumberOfLinks != 1 {
            return Err(error(
                "hard-link",
                "Linked publisher/bootstrap is forbidden",
            ));
        }
    }
    observe_and_hold(&path.to_string_lossy()).map_err(|e| {
        error(
            "publisher-unavailable",
            format!("Cannot hold selected file: {e:?}"),
        )
    })
}
fn python_path() -> Result<PathBuf, EnvironmentHostError> {
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        let path = directory.join("python.exe");
        if path.is_file() {
            return ordinary_path(&path);
        }
    }
    Err(error(
        "interpreter-unavailable",
        "Python 3.12+ is required; no automatic installation",
    ))
}
fn discover_selected(
    selected: &SelectedRepository,
    cancel: &Arc<AtomicBool>,
) -> Result<(EnvironmentProcessOutput, String), EnvironmentHostError> {
    if cancel.load(Ordering::Acquire) {
        return Err(error("cancelled", "Discovery cancelled before execution"));
    }
    ordinary_path(&selected.bootstrap)?;
    ordinary_path(&selected.publisher)?;
    let (_bootstrap_guard, bootstrap_hash) = guarded_small_file(&selected.bootstrap)?;
    let (_publisher_guard, publisher_hash) = guarded_small_file(&selected.publisher)?;
    if bootstrap_hash != selected.bootstrap_sha256 || publisher_hash != selected.publisher_sha256 {
        return Err(error(
            "source-changed",
            "Bootstrap or publisher changed; select the repository again",
        ));
    }
    let python = python_path()?;
    let (_interpreter_guard, interpreter_hash) = guarded_small_file(&python)?;
    let probe = execute(
        &python,
        &[
            "-c".into(),
            "import sys;sys.exit(0 if sys.version_info >= (3,12) else 2)".into(),
        ],
        &selected.root,
        Vec::new(),
        cancel,
        Duration::from_secs(30),
    )?;
    if probe.canceled || probe.timed_out || probe.output_limit_exceeded {
        return Ok((probe, interpreter_hash));
    }
    if probe.exit_code != Some(0) {
        return Err(error("interpreter-unavailable", "Python 3.12+ is required"));
    }
    let request = serde_json::to_vec(&serde_json::json!({ "requestVersion": 1, "operation": "discover", "repositoryRoot": selected.root, "searchRoots": selected.search_roots })).map_err(io)?;
    // Both file guards stay alive until the interpreter exits, including its deferred script open.
    let output = execute(
        &python,
        &[selected.publisher.to_string_lossy().into_owned()],
        &selected.root,
        request,
        cancel,
        Duration::from_secs(120),
    )?;
    Ok((output, interpreter_hash))
}
fn capture(mut stream: impl Read, overflow: Arc<AtomicBool>) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = stream.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        let remaining = MAX_BYTES - output.len();
        output.extend_from_slice(&buffer[..n.min(remaining)]);
        if n > remaining {
            overflow.store(true, Ordering::Release);
        }
    }
    Ok(output)
}
fn execute(
    executable: &Path,
    args: &[String],
    cwd: &Path,
    input: Vec<u8>,
    cancel: &Arc<AtomicBool>,
    budget: Duration,
) -> Result<EnvironmentProcessOutput, EnvironmentHostError> {
    if cancel.load(Ordering::Acquire) {
        return Err(error("cancelled", "Discovery cancelled before spawn"));
    }
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(io)?;
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let out_flag = Arc::clone(&overflow);
    let err_flag = Arc::clone(&overflow);
    let out = std::thread::spawn(move || capture(stdout, out_flag));
    let err = std::thread::spawn(move || capture(stderr, err_flag));
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let start = Instant::now();
    let mut canceled = false;
    let mut timed_out = false;
    let mut wait_error = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Err(e) => {
                wait_error = Some(e);
                let _ = child.kill();
                break child.wait().ok();
            }
            Ok(None) => {}
        }
        canceled = cancel.load(Ordering::Acquire);
        timed_out = start.elapsed() >= budget;
        if canceled || timed_out || overflow.load(Ordering::Acquire) {
            let _ = child.kill();
            break child.wait().ok();
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let stdout = out
        .join()
        .map_err(|_| io("stdout reader failed"))?
        .map_err(io)?;
    let stderr = err
        .join()
        .map_err(|_| io("stderr reader failed"))?
        .map_err(io)?;
    let input_result = writer.join().map_err(|_| io("stdin writer failed"))?;
    if let Some(e) = wait_error {
        return Err(io(e));
    }
    let exceeded = overflow.load(Ordering::Acquire);
    if !canceled && !timed_out && !exceeded {
        input_result.map_err(io)?;
    }
    Ok(EnvironmentProcessOutput {
        stdout,
        stderr,
        exit_code: status.and_then(|s| s.code()),
        canceled,
        timed_out,
        output_limit_exceeded: exceeded,
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let path = std::env::temp_dir().join(format!(
                "gglab-environment-host-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            assert!(self.0.starts_with(std::env::temp_dir()));
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn repository(script: &str) -> Temp {
        let root = Temp::new();
        let scripts = root.0.join("Scripts/Environment");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("publisher.py"), script).unwrap();
        std::fs::write(scripts.join("bootstrap.json"), serde_json::to_vec(&serde_json::json!({
            "bootstrapVersion": 1, "publisher": "Scripts/Environment/publisher.py", "interpreter": "python", "minimumPythonVersion": "3.12",
            "transport": "single-utf8-json-stdin-stdout", "requestVersions": [1], "resultVersions": [1], "defaultSearchRoots": ["Build/Output", "OtherBuilds"], "contractStatus": "implemented-pending-owner-review"
        })).unwrap()).unwrap();
        root
    }
    #[test]
    fn discovery_uses_selected_root_and_bootstrap_roots_not_caller_paths() {
        let root = repository("import sys\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n");
        let service = EnvironmentService::new();
        let selected = service
            .register_selected_repository(root.0.clone())
            .unwrap();
        assert!(service.discover("D:/arbitrary/path").is_err());
        let job = service.discover(&selected.repository_id).unwrap();
        let id = job.id.clone();
        match job.settle.join().unwrap() {
            EnvironmentDiscoverySettlement::Settled {
                output,
                publisher_sha256,
                ..
            } => {
                assert_eq!(output.exit_code, Some(0));
                assert!(!output.canceled);
                assert_eq!(publisher_sha256, selected.publisher_sha256);
                let request: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(request["operation"], "discover");
                assert_eq!(
                    request["searchRoots"],
                    serde_json::json!(["Build/Output", "OtherBuilds"])
                );
                assert_eq!(request["repositoryRoot"], selected.display_path);
            }
            other => panic!("unexpected settlement: {other:?}"),
        }
        assert!(!service.cancel(&id).unwrap());
    }
    #[test]
    fn changed_publisher_is_refused_before_execution() {
        let root = repository("raise RuntimeError('must not execute')");
        let service = EnvironmentService::new();
        let selected = service
            .register_selected_repository(root.0.clone())
            .unwrap();
        std::fs::write(
            root.0.join("Scripts/Environment/publisher.py"),
            "raise RuntimeError('changed')",
        )
        .unwrap();
        match service
            .discover(&selected.repository_id)
            .unwrap()
            .settle
            .join()
            .unwrap()
        {
            EnvironmentDiscoverySettlement::Failed { error, .. } => {
                assert_eq!(error.code, "source-changed")
            }
            other => panic!("unexpected settlement: {other:?}"),
        }
    }
    #[test]
    fn publisher_guard_blocks_replacement_and_linked_publishers_are_refused() {
        let root = repository("pass");
        let path = root.0.join("Scripts/Environment/publisher.py");
        let (guard, _) = guarded_small_file(&path).unwrap();
        assert!(std::fs::write(&path, "replacement").is_err());
        assert!(std::fs::rename(&path, root.0.join("moved.py")).is_err());
        drop(guard);
        std::fs::hard_link(&path, root.0.join("linked.py")).unwrap();
        assert_eq!(guarded_small_file(&path).unwrap_err().code, "hard-link");
    }
    #[test]
    fn unsafe_bootstrap_locators_and_unknown_versions_are_refused() {
        for value in ["../escape", "C:/escape", "a\\b", "a/NUL", "a//b", "a/x."] {
            assert!(locator(value).is_err());
        }
        let root = repository("pass");
        let path = root.0.join("Scripts/Environment/bootstrap.json");
        let text = std::fs::read_to_string(&path)
            .unwrap()
            .replace("\"bootstrapVersion\":1", "\"bootstrapVersion\":2");
        std::fs::write(path, text).unwrap();
        assert_eq!(
            EnvironmentService::new()
                .register_selected_repository(root.0.clone())
                .unwrap_err()
                .code,
            "unsupported-version"
        );
    }
    #[test]
    fn cancellation_reaps_a_child_that_does_not_read_stdin() {
        let root = Temp::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancel);
        let setter = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            flag.store(true, Ordering::Release);
        });
        let output = execute(
            &python_path().unwrap(),
            &["-c".into(), "import time;time.sleep(60)".into()],
            &root.0,
            vec![b'x'; 100000],
            &cancel,
            Duration::from_secs(5),
        )
        .unwrap();
        setter.join().unwrap();
        assert!(output.canceled);
        assert!(output.exit_code.is_some());
    }
    #[test]
    fn timeout_and_output_limits_are_explicit_and_bounded() {
        let root = Temp::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let python = python_path().unwrap();
        let output = execute(
            &python,
            &["-c".into(), "import time;time.sleep(60)".into()],
            &root.0,
            vec![],
            &cancel,
            Duration::from_millis(80),
        )
        .unwrap();
        assert!(output.timed_out);
        assert!(output.exit_code.is_some());
        for stream in ["stdout", "stderr"] {
            let script = format!("import sys,time;sys.{stream}.buffer.write(b'x'*{});sys.{stream}.flush();time.sleep(60)", MAX_BYTES + 100000);
            let output = execute(
                &python,
                &["-c".into(), script],
                &root.0,
                vec![],
                &cancel,
                Duration::from_secs(5),
            )
            .unwrap();
            assert!(output.output_limit_exceeded);
            assert!(output.stdout.len() <= MAX_BYTES);
            assert!(output.stderr.len() <= MAX_BYTES);
        }
    }
    #[test]
    #[ignore = "requires the sibling producer checkout and Python 3.12+"]
    fn real_producer_discovery_is_read_only_and_candidate_preserving() {
        let root = std::env::var_os("GGLAB_ENVIRONMENT_SOURCE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
                for _ in 0..4 {
                    path.pop();
                }
                path.join("GraphicsGadgetLab")
            });
        let service = EnvironmentService::new();
        let repository = service.register_selected_repository(root).unwrap();
        let job = service.discover(&repository.repository_id).unwrap();
        match job.settle.join().unwrap() {
            EnvironmentDiscoverySettlement::Settled {
                output,
                publisher_sha256,
                interpreter_sha256,
                ..
            } => {
                assert_eq!(output.exit_code, Some(0));
                assert!(!output.timed_out && !output.canceled && !output.output_limit_exceeded);
                let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
                assert_eq!(response["operation"], "discover");
                assert_eq!(response["success"], true);
                assert!(response["result"]["candidates"].is_array());
                println!("publisher={publisher_sha256} interpreter={interpreter_sha256} response={response}");
            }
            other => panic!("unexpected settlement: {other:?}"),
        }
    }
}
