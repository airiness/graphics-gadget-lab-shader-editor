//! Filesystem facts and Editor-owned registry storage. No native readiness claims.
use crate::environment_io::{error, ordinary_path, EnvironmentHostError as Error};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, TryLockError};

const JSON_LIMIT: usize = 16 * 1024 * 1024;
const RECORD_LIMIT: usize = 65536;
static STAGE: AtomicU64 = AtomicU64::new(1);
fn io(e: impl ToString) -> Error {
    error("io-error", e)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryKind {
    Environment,
    State,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryHandle {
    pub directory_id: String,
    pub root: String,
    pub kind: DirectoryKind,
}
#[derive(Clone)]
struct Selected {
    path: PathBuf,
    kind: DirectoryKind,
}
#[derive(Default)]
pub struct EnvironmentStorageService {
    selected: Mutex<HashMap<String, Selected>>,
    sequence: AtomicU64,
    // Bound expensive hashing to one operation per service, not an unbounded worker queue.
    observing: Mutex<()>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    path: String,
    kind: String,
    reparse_point: bool,
    link_count: u32,
    size: Option<u64>,
    sha256: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryObservation {
    directory_id: String,
    root: String,
    kind: DirectoryKind,
    entries: Vec<Entry>,
    metadata_text: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    registry_version: u32,
    environment_id: String,
    environment_root: PathBuf,
    state_root: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySelection {
    record_text: String,
    environment: DirectoryHandle,
    state: DirectoryHandle,
}

fn finalized_directory(path: &Path) -> Result<PathBuf, Error> {
    let path = ordinary_path(path)?;
    if !path.is_dir() {
        return Err(error("invalid-path", "Expected a directory"));
    }
    if path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
        .starts_with(".staging-")
    {
        return Err(error(
            "incomplete-publication",
            "Staging directory is not usable",
        ));
    }
    Ok(path)
}
fn regular_file(path: &Path) -> Result<File, Error> {
    ordinary_path(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let file = options.open(path).map_err(io)?;
    if !file.metadata().map_err(io)?.is_file() {
        return Err(error("invalid-member", "Expected a regular file"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        if info.nNumberOfLinks != 1 {
            return Err(error("hard-link", "Independent file required"));
        }
    }
    Ok(file)
}
fn text(path: &Path, limit: usize) -> Result<String, Error> {
    let file = regular_file(path)?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > limit {
        return Err(error("limit-exceeded", "Text exceeds host bound"));
    }
    String::from_utf8(bytes).map_err(|_| error("invalid-json", "Invalid UTF-8"))
}
fn hash(path: &Path) -> Result<(u64, String), Error> {
    let mut file = regular_file(path)?;
    let before = file.metadata().map_err(io)?;
    let mut digest = Sha256::new();
    let mut size = 0;
    let mut buffer = [0u8; 65536];
    let started = std::time::Instant::now();
    loop {
        if started.elapsed().as_secs() >= 120 {
            return Err(error(
                "limit-exceeded",
                "File observation exceeded 120 seconds",
            ));
        }
        let n = file.read(&mut buffer).map_err(io)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
        size += n as u64;
    }
    let after = file.metadata().map_err(io)?;
    if size != before.len() || before.modified().map_err(io)? != after.modified().map_err(io)? {
        return Err(error("source-changed", "File changed during observation"));
    }
    Ok((size, format!("{:x}", digest.finalize())))
}
fn inventory(root: &Path, hashes: bool) -> Result<Vec<Entry>, Error> {
    let mut pending = vec![root.to_path_buf()];
    let mut entries = Vec::new();
    let mut directories = 0;
    let started = std::time::Instant::now();
    while let Some(directory) = pending.pop() {
        ordinary_path(&directory)?;
        directories += 1;
        if directories > 10000 {
            return Err(error("limit-exceeded", "Too many directories"));
        }
        for item in fs::read_dir(directory).map_err(io)? {
            if started.elapsed().as_secs() >= 120 {
                return Err(error(
                    "limit-exceeded",
                    "Directory observation exceeded its host budget",
                ));
            }
            let path = item.map_err(io)?.path();
            ordinary_path(&path)?;
            let relative = path
                .strip_prefix(root)
                .map_err(io)?
                .to_str()
                .ok_or_else(|| error("invalid-path", "Invalid path encoding"))?
                .replace('\\', "/");
            let metadata = fs::symlink_metadata(&path).map_err(io)?;
            let (kind, size, sha256) = if metadata.is_dir() {
                pending.push(path);
                ("directory", None, None)
            } else if metadata.is_file() {
                if hashes {
                    let (size, digest) = hash(&path)?;
                    ("file", Some(size), Some(digest))
                } else {
                    regular_file(&path)?;
                    ("file", None, None)
                }
            } else {
                return Err(error("invalid-member", "Non-regular entry"));
            };
            entries.push(Entry {
                path: relative,
                kind: kind.into(),
                reparse_point: false,
                link_count: 1,
                size,
                sha256,
            });
            if entries.len() > 30000 {
                return Err(error("limit-exceeded", "Too many entries"));
            }
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
impl EnvironmentStorageService {
    pub(crate) fn selected_path(&self, id: &str, kind: DirectoryKind) -> Result<PathBuf, Error> {
        let selected = self.selected.lock().map_err(io)?.get(id).cloned().ok_or_else(|| error("invalid-handle", "Unknown directory"))?;
        if selected.kind != kind { return Err(error("invalid-handle", "Wrong directory kind")); }
        finalized_directory(&selected.path)
    }
    pub fn open_registration(
        &self,
        registry: &RegistryStorage,
        key: &str,
    ) -> Result<RecoverySelection, Error> {
        let record_text = registry.read(key)?;
        let binding: Binding =
            serde_json::from_str(&record_text).map_err(|e| error("invalid-json", e))?;
        if binding.registry_version != 1 || binding.environment_id != format!("sha256:{key}") {
            return Err(error("registry-conflict", "Invalid saved binding"));
        }
        // Paths come only from the host-owned saved record, never an IPC path argument.
        finalized_directory(&binding.environment_root)?;
        finalized_directory(&binding.state_root)?;
        let environment = self.select(&binding.environment_root, DirectoryKind::Environment)?;
        let state = self.select(&binding.state_root, DirectoryKind::State)?;
        Ok(RecoverySelection {
            record_text,
            environment,
            state,
        })
    }
    pub fn select(&self, path: &Path, kind: DirectoryKind) -> Result<DirectoryHandle, Error> {
        let path = finalized_directory(path)?;
        let mut selected = self.selected.lock().map_err(io)?;
        if selected.len() >= 64 {
            return Err(error("limit-exceeded", "Too many selected directories"));
        }
        let directory_id = format!(
            "environment-directory:{}",
            self.sequence.fetch_add(1, Ordering::Relaxed) + 1
        );
        let root = path
            .to_str()
            .ok_or_else(|| error("invalid-path", "Invalid path encoding"))?
            .to_owned();
        selected.insert(directory_id.clone(), Selected { path, kind });
        Ok(DirectoryHandle {
            directory_id,
            root,
            kind,
        })
    }
    pub fn observe(&self, id: &str) -> Result<DirectoryObservation, Error> {
        let _guard = self.observing.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => error("host-busy", "An Environment observation is running"),
            _ => error("host-task-failed", "Observation lock failed"),
        })?;
        let selected = self
            .selected
            .lock()
            .map_err(io)?
            .get(id)
            .cloned()
            .ok_or_else(|| error("invalid-handle", "Unknown directory handle"))?;
        let path = finalized_directory(&selected.path)?;
        if path != selected.path {
            return Err(error("source-changed", "Canonical directory changed"));
        }
        let metadata = path.join(if selected.kind == DirectoryKind::Environment {
            "environment.json"
        } else {
            "state.json"
        });
        let metadata_text = match fs::symlink_metadata(&metadata) {
            Ok(_) => Some(text(&metadata, JSON_LIMIT)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(io(e)),
        };
        let entries = inventory(&path, selected.kind == DirectoryKind::Environment)?;
        finalized_directory(&path)?;
        // Bind the parsed metadata bytes to the same snapshot used for member facts.
        if let Some(ref initial) = metadata_text {
            if text(&metadata, JSON_LIMIT)? != *initial {
                return Err(error(
                    "source-changed",
                    "Metadata changed during observation",
                ));
            }
        }
        Ok(DirectoryObservation {
            directory_id: id.into(),
            root: path.to_string_lossy().into(),
            kind: selected.kind,
            entries,
            metadata_text,
        })
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum RegistryEntry {
    Record { key: String, text: String },
    Refused { key: String, diagnostic: Error },
}
#[derive(Debug, Serialize)]
pub struct RegistryScan {
    entries: Vec<RegistryEntry>,
    pending: Vec<String>,
}
pub struct RegistryStorage {
    root: PathBuf,
}
fn key_valid(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
// Resolve existing ancestors first; missing storage is never created by inspection.
fn prospective(path: &Path) -> Result<PathBuf, Error> {
    match fs::symlink_metadata(path) {
        Ok(_) => ordinary_path(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| error("invalid-path", "Missing local ancestor"))?;
            let name = path
                .file_name()
                .ok_or_else(|| error("invalid-path", "Missing directory name"))?;
            Ok(prospective(parent)?.join(name))
        }
        Err(e) => Err(io(e)),
    }
}
impl RegistryStorage {
    pub fn new(root: PathBuf) -> Result<Self, Error> {
        Ok(Self {
            root: prospective(&root)?,
        })
    }
    pub fn read(&self, key: &str) -> Result<String, Error> {
        if !key_valid(key) {
            return Err(error("registry-conflict", "Invalid registry key"));
        }
        let directory = self.root.join(key);
        finalized_directory(&directory)?;
        let names: Vec<_> = fs::read_dir(&directory)
            .map_err(io)?
            .take(2)
            .collect::<Result<_, _>>()
            .map_err(io)?;
        if names.len() != 1 || names[0].file_name() != "registration.json" {
            return Err(error("registry-conflict", "Unexpected registry contents"));
        }
        text(&directory.join("registration.json"), RECORD_LIMIT)
    }
    pub fn scan(&self) -> Result<RegistryScan, Error> {
        prospective(&self.root)?;
        let mut names = match fs::read_dir(&self.root) {
            Ok(items) => {
                let mut names = Vec::new();
                for item in items {
                    names.push(item.map_err(io)?.file_name());
                    if names.len() > 1024 {
                        return Err(error("limit-exceeded", "Registry exceeds 1024 entries"));
                    }
                }
                names
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(io(e)),
        };
        names.sort();
        let mut entries = Vec::new();
        let mut pending = Vec::new();
        for name in names {
            let key = name.to_string_lossy().into_owned();
            let result = (|| {
                ordinary_path(&self.root.join(&name))?;
                if key.starts_with(".pending-")
                    && key.len() == 45
                    && key[9..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                {
                    if !self.root.join(&name).is_dir() {
                        return Err(error(
                            "registry-conflict",
                            "Pending entry is not a directory",
                        ));
                    }
                    pending.push(key.clone());
                    Ok(None)
                } else {
                    self.read(&key).map(Some)
                }
            })();
            match result {
                Ok(Some(text)) => entries.push(RegistryEntry::Record { key, text }),
                Ok(None) => (),
                Err(mut diagnostic) => {
                    diagnostic.data_path = key.clone();
                    entries.push(RegistryEntry::Refused { key, diagnostic });
                }
            }
        }
        Ok(RegistryScan { entries, pending })
    }
    /// Host-internal only: future native proof composition calls this; there is no insert IPC.
    #[allow(dead_code)]
    pub fn insert(&self, key: &str, content: &str) -> Result<(String, bool), Error> {
        if content.len() > RECORD_LIMIT {
            return Err(error("limit-exceeded", "Registry record exceeds 64 KiB"));
        }
        let binding: Binding =
            serde_json::from_str(content).map_err(|e| error("invalid-json", e))?;
        if binding.registry_version != 1
            || !key_valid(key)
            || binding.environment_id != format!("sha256:{key}")
        {
            return Err(error("registry-conflict", "Invalid registry binding"));
        }
        let environment = finalized_directory(&binding.environment_root)?;
        let state = finalized_directory(&binding.state_root)?;
        if environment.as_os_str() != binding.environment_root.as_os_str()
            || state.as_os_str() != binding.state_root.as_os_str()
        {
            return Err(error(
                "invalid-path",
                "Registration requires canonical selected roots",
            ));
        }
        let registry = prospective(&self.root)?;
        for (a, b) in [
            (&environment, &state),
            (&environment, &registry),
            (&state, &registry),
        ] {
            let a = a.to_string_lossy().to_lowercase();
            let b = b.to_string_lossy().to_lowercase();
            if a == b || a.starts_with(&(b.clone() + "\\")) || b.starts_with(&(a + "\\")) {
                return Err(error(
                    "invalid-path",
                    "Registry, Environment and state must be disjoint",
                ));
            }
        }
        fs::create_dir_all(&registry).map_err(io)?;
        ordinary_path(&registry)?;
        let scan = self.scan()?;
        if scan.entries.len() + scan.pending.len() >= 1024 {
            return Err(error("limit-exceeded", "Registry is full"));
        }
        let destination = registry.join(key);
        if destination.exists() {
            return self.read(key).map(|text| (text, false));
        }
        let nonce = STAGE.fetch_add(1, Ordering::Relaxed);
        let stage = registry.join(format!(
            ".pending-{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            std::process::id(),
            (nonce >> 32) & 0xffff,
            (nonce >> 16) & 0xffff,
            nonce & 0xffff,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(io)?
                .as_nanos()
                & 0xffffffffffff
        ));
        fs::create_dir(&stage).map_err(io)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.join("registration.json"))
            .map_err(io)?;
        file.write_all(content.as_bytes()).map_err(io)?;
        file.sync_all().map_err(io)?;
        drop(file);
        // Windows directory rename refuses replacement. Interrupted stages are retained.
        match fs::rename(&stage, &destination) {
            Ok(()) => self.read(key).map(|text| (text, true)),
            Err(_) if destination.exists() => self.read(key).map(|text| (text, false)),
            Err(e) => Err(io(e)),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "gglab-environment-storage-{}-{}",
                std::process::id(),
                STAGE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(ordinary_path(&path).unwrap())
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn setup(temp: &Temp) -> (RegistryStorage, String, String) {
        for name in ["environment", "state"] {
            fs::create_dir(temp.0.join(name)).unwrap();
        }
        let key = "1".repeat(64);
        let record = serde_json::json!({"registryVersion":1,"environmentId":format!("sha256:{key}"),"environmentRoot":temp.0.join("environment"),"stateRoot":temp.0.join("state")}).to_string();
        (
            RegistryStorage::new(temp.0.join("registry")).unwrap(),
            key,
            record,
        )
    }
    #[test]
    fn missing_registry_scan_is_read_only_and_commit_survives_restart() {
        let temp = Temp::new();
        let (registry, key, record) = setup(&temp);
        assert!(registry.scan().unwrap().entries.is_empty());
        assert!(!registry.root.exists());
        assert_eq!(
            registry.insert(&key, &record).unwrap(),
            (record.clone(), true)
        );
        let restarted = RegistryStorage::new(registry.root.clone()).unwrap();
        assert_eq!(
            restarted.insert(&key, &record).unwrap(),
            (record.clone(), false)
        );
        let conflicting = record.replace("environment\"", "state\"");
        assert!(restarted.insert(&key, &conflicting).is_err());
        assert_eq!(restarted.read(&key).unwrap(), record);
        let service = EnvironmentStorageService::default();
        let selected = service.open_registration(&registry, &key).unwrap();
        assert_eq!(selected.environment.kind, DirectoryKind::Environment);
        fs::remove_dir(temp.0.join("state")).unwrap();
        assert!(service.open_registration(&registry, &key).is_err());
        assert!(!temp.0.join("state").exists());
    }
    #[test]
    fn pending_corrupt_and_linked_records_do_not_hide_good_records() {
        let temp = Temp::new();
        let (registry, key, record) = setup(&temp);
        registry.insert(&key, &record).unwrap();
        fs::create_dir(
            registry
                .root
                .join(".pending-00000000-0000-0000-0000-000000000000"),
        )
        .unwrap();
        fs::create_dir(registry.root.join("broken")).unwrap();
        let scan = registry.scan().unwrap();
        assert_eq!(scan.pending.len(), 1);
        assert_eq!(scan.entries.len(), 2);
        assert!(scan
            .entries
            .iter()
            .any(|e| matches!(e, RegistryEntry::Record { .. })));
        fs::hard_link(
            registry.root.join(&key).join("registration.json"),
            temp.0.join("alias.json"),
        )
        .unwrap();
        assert_eq!(registry.read(&key).unwrap_err().code, "hard-link");
    }
    #[test]
    fn observations_stream_hashes_and_reject_linked_members_and_unknown_handles() {
        let temp = Temp::new();
        fs::write(temp.0.join("environment.json"), "{}").unwrap();
        fs::create_dir(temp.0.join("payload")).unwrap();
        fs::write(temp.0.join("payload/file"), b"abc").unwrap();
        let service = EnvironmentStorageService::default();
        let handle = service.select(&temp.0, DirectoryKind::Environment).unwrap();
        let observation = service.observe(&handle.directory_id).unwrap();
        let file = observation
            .entries
            .iter()
            .find(|e| e.path == "payload/file")
            .unwrap();
        assert_eq!(file.size, Some(3));
        assert_eq!(
            file.sha256.as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(
            service
                .observe("environment-directory:999")
                .unwrap_err()
                .code,
            "invalid-handle"
        );
        fs::hard_link(temp.0.join("payload/file"), temp.0.join("alias")).unwrap();
        assert_eq!(
            service.observe(&handle.directory_id).unwrap_err().code,
            "hard-link"
        );
    }
    #[test]
    fn canonical_staging_case_and_short_aliases_are_refused() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
        let temp = Temp::new();
        let staging = temp.0.join(".staging-environment-long-name");
        fs::create_dir(&staging).unwrap();
        let service = EnvironmentStorageService::default();
        for path in [
            &staging,
            &staging.with_file_name(".STAGING-ENVIRONMENT-LONG-NAME"),
        ] {
            assert_eq!(
                service
                    .select(path, DirectoryKind::Environment)
                    .unwrap_err()
                    .code,
                "incomplete-publication"
            );
        }
        let wide: Vec<u16> = staging.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut buffer = vec![0u16; 32768];
        let n =
            unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) };
        assert!(n > 0 && (n as usize) < buffer.len());
        let short = PathBuf::from(String::from_utf16(&buffer[..n as usize]).unwrap());
        if short.file_name() == staging.file_name() {
            eprintln!("SKIP: volume does not provide a distinct 8.3 alias");
        } else {
            assert_eq!(
                service
                    .select(&short, DirectoryKind::State)
                    .unwrap_err()
                    .code,
                "incomplete-publication"
            );
        }
        let final_path = staging.with_file_name("final-environment");
        fs::rename(staging, &final_path).unwrap();
        assert!(service
            .select(&final_path, DirectoryKind::Environment)
            .is_ok());
    }
    #[test]
    fn junctions_and_registry_bounds_fail_closed() {
        let temp = Temp::new();
        let (registry, key, record) = setup(&temp);
        let linked = temp.0.join("linked");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&linked)
            .arg(temp.0.join("environment"))
            .output()
            .unwrap();
        assert!(status.status.success());
        assert_eq!(
            EnvironmentStorageService::default()
                .select(&linked, DirectoryKind::Environment)
                .unwrap_err()
                .code,
            "reparse-point"
        );
        fs::remove_dir(linked).unwrap();
        assert_eq!(
            registry
                .insert(&key, &" ".repeat(RECORD_LIMIT + 1))
                .unwrap_err()
                .code,
            "limit-exceeded"
        );
        registry.insert(&key, &record).unwrap();
        fs::write(registry.root.join(&key).join("registration.json"), [255]).unwrap();
        assert_eq!(registry.read(&key).unwrap_err().code, "invalid-json");
    }
    #[test]
    fn concurrent_no_replace_registration_converges_on_one_winner() {
        let temp = Temp::new();
        let (registry, key, record) = setup(&temp);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let root = registry.root.clone();
                let key = key.clone();
                let record = record.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    RegistryStorage::new(root)
                        .unwrap()
                        .insert(&key, &record)
                        .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|(_, inserted)| *inserted).count(), 1);
        assert!(results.iter().all(|(text, _)| text == &record));
    }
}
