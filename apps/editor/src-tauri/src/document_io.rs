//! Bounded native document snapshots and compare-and-swap saves.
//!
//! Caller-supplied paths never cross into the command boundary. Open and Save
//! As receive paths only from host-owned dialogs, canonicalize them, and
//! register an opaque canonical document URI as a capability for this host
//! lifetime. A display path may be returned as provenance, but subsequent
//! reads and saves accept only a URI already present in the registry.
//!
//! A snapshot couples exact UTF-8 bytes with the host's opaque revision token.
//! Save re-reads that token before an atomic same-directory replacement and
//! returns a structured conflict instead of overwriting a changed file.

use crate::shader_tool::identity::hash_bytes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_DOCUMENT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub canonical_document_uri: String,
    pub display_path: String,
    pub text: String,
    pub file_revision_token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentSnapshotRequest {
    pub canonical_document_uri: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentRequest {
    pub canonical_document_uri: String,
    pub expected_file_revision_token: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentAsRequest {
    pub default_name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DocumentSaveOutcome {
    Saved {
        snapshot: DocumentSnapshot,
    },
    Conflict {
        canonical_document_uri: String,
        expected_file_revision_token: Option<String>,
        observed_file_revision_token: Option<String>,
    },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DocumentIoError {
    InvalidRequest { detail: String },
    Unauthorized { canonical_document_uri: String },
    IdentityInvalidated { canonical_document_uri: String },
    NotFound { detail: String },
    TooLarge { size: u64, limit: u64 },
    InvalidUtf8 { detail: String },
    Io { operation: String, detail: String },
    HostTask { detail: String },
}

#[derive(Debug, Clone)]
struct AuthorizedDocument {
    canonical_path: PathBuf,
    display_path: String,
}

/// Host-lifetime authority registry plus deterministic temporary-name source.
pub struct DocumentFileService {
    registered_documents: Mutex<HashMap<String, AuthorizedDocument>>,
    save_gate: Mutex<()>,
    next_temp_sequence: AtomicU64,
}

impl Default for DocumentFileService {
    fn default() -> Self {
        Self::new()
    }
}

impl DocumentFileService {
    pub fn new() -> Self {
        Self {
            registered_documents: Mutex::new(HashMap::new()),
            save_gate: Mutex::new(()),
            next_temp_sequence: AtomicU64::new(1),
        }
    }

    /// Admit an existing path selected by a host-owned Open dialog.
    pub fn open_selected_path(
        &self,
        selected_path: PathBuf,
    ) -> Result<DocumentSnapshot, DocumentIoError> {
        let display_path = selected_path.to_string_lossy().into_owned();
        let canonical_path = selected_path.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                DocumentIoError::NotFound {
                    detail: format!("the selected document no longer exists: {display_path}"),
                }
            } else {
                io_error("canonicalize selected document", error)
            }
        })?;
        self.read_and_authorize(canonical_path, display_path)
    }

    /// Re-read an already-authorized document by its host-issued URI.
    pub fn read_snapshot(&self, canonical_uri: &str) -> Result<DocumentSnapshot, DocumentIoError> {
        let document = self.authorized_document(canonical_uri)?;
        self.read_authorized(canonical_uri, &document)
    }

    /// Admit one canonical file proven by bounded Workspace discovery.
    /// Discovery supplies display provenance only; the returned URI is the
    /// sole subsequent read/save authority exposed to the WebView.
    pub(crate) fn register_discovered_document(
        &self,
        canonical_path: PathBuf,
        display_path: String,
    ) -> Result<String, DocumentIoError> {
        let canonical_uri = canonical_document_uri(&canonical_path)?;
        let document = AuthorizedDocument {
            canonical_path,
            display_path,
        };
        self.registered_documents
            .lock()
            .map_err(|_| DocumentIoError::Io {
                operation: "update document authority registry".to_string(),
                detail: "the registry lock was poisoned".to_string(),
            })?
            .insert(canonical_uri.clone(), document);
        Ok(canonical_uri)
    }

    /// Compare the current token and atomically replace the authorized file.
    pub fn save(
        &self,
        request: &SaveDocumentRequest,
    ) -> Result<DocumentSaveOutcome, DocumentIoError> {
        // Serialize native saves so two WebView requests based on the same
        // revision cannot both pass validation and become last-writer-wins.
        let _save_guard = self.save_gate.lock().map_err(|_| DocumentIoError::Io {
            operation: "serialize document save".to_string(),
            detail: "the save lock was poisoned".to_string(),
        })?;
        if request.expected_file_revision_token.trim().is_empty() {
            return Err(DocumentIoError::InvalidRequest {
                detail: "expectedFileRevisionToken must not be empty".to_string(),
            });
        }
        validate_document_size(request.text.as_bytes())?;
        let document = self.authorized_document(&request.canonical_document_uri)?;
        let current = match self.read_authorized(&request.canonical_document_uri, &document) {
            Ok(snapshot) => snapshot,
            Err(DocumentIoError::NotFound { .. } | DocumentIoError::IdentityInvalidated { .. }) => {
                return Ok(DocumentSaveOutcome::Conflict {
                    canonical_document_uri: request.canonical_document_uri.clone(),
                    expected_file_revision_token: Some(
                        request.expected_file_revision_token.clone(),
                    ),
                    observed_file_revision_token: None,
                });
            }
            Err(error) => return Err(error),
        };
        if current.file_revision_token != request.expected_file_revision_token {
            return Ok(conflict(
                request.canonical_document_uri.clone(),
                Some(request.expected_file_revision_token.clone()),
                Some(current.file_revision_token),
            ));
        }

        let temp_path = self.write_temporary(&document.canonical_path, request.text.as_bytes())?;
        let temp_guard = TemporaryPath::new(temp_path);

        // Revalidate after the complete replacement bytes are durable. This
        // catches external writes that overlap preparation instead of trusting
        // an earlier watcher event or metadata observation.
        let observed = match self.read_authorized(&request.canonical_document_uri, &document) {
            Ok(snapshot) => snapshot.file_revision_token,
            Err(DocumentIoError::NotFound { .. } | DocumentIoError::IdentityInvalidated { .. }) => {
                return Ok(conflict(
                    request.canonical_document_uri.clone(),
                    Some(request.expected_file_revision_token.clone()),
                    None,
                ));
            }
            Err(error) => return Err(error),
        };
        if observed != request.expected_file_revision_token {
            return Ok(conflict(
                request.canonical_document_uri.clone(),
                Some(request.expected_file_revision_token.clone()),
                Some(observed),
            ));
        }

        preserve_permissions(&document.canonical_path, temp_guard.path())?;
        atomic_replace(temp_guard.path(), &document.canonical_path)?;
        temp_guard.disarm();
        self.read_authorized(&request.canonical_document_uri, &document)
            .map(|snapshot| DocumentSaveOutcome::Saved { snapshot })
    }

    /// Save to a path selected by the host. Existing files are conflicts;
    /// overwriting one requires a later explicit conflict-resolution action.
    pub fn save_as_selected_path(
        &self,
        selected_path: PathBuf,
        text: &str,
    ) -> Result<DocumentSaveOutcome, DocumentIoError> {
        let _save_guard = self.save_gate.lock().map_err(|_| DocumentIoError::Io {
            operation: "serialize document save as".to_string(),
            detail: "the save lock was poisoned".to_string(),
        })?;
        validate_selected_file_name(&selected_path)?;
        validate_document_size(text.as_bytes())?;
        if selected_path.exists() {
            let snapshot = self.open_selected_path(selected_path)?;
            return Ok(conflict(
                snapshot.canonical_document_uri,
                None,
                Some(snapshot.file_revision_token),
            ));
        }

        let display_path = selected_path.to_string_lossy().into_owned();
        let file_name =
            selected_path
                .file_name()
                .ok_or_else(|| DocumentIoError::InvalidRequest {
                    detail: "the selected destination has no file name".to_string(),
                })?;
        let parent = selected_path
            .parent()
            .ok_or_else(|| DocumentIoError::InvalidRequest {
                detail: "the selected destination has no parent directory".to_string(),
            })?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(|error| io_error("canonicalize save destination", error))?;
        let canonical_path = canonical_parent.join(file_name);
        let temp_path = self.write_temporary(&canonical_path, text.as_bytes())?;
        let temp_guard = TemporaryPath::new(temp_path);

        match atomic_create(temp_guard.path(), &canonical_path) {
            Ok(()) => temp_guard.disarm(),
            Err(_error) if canonical_path.exists() => {
                let snapshot = self.read_and_authorize(canonical_path, display_path)?;
                return Ok(conflict(
                    snapshot.canonical_document_uri,
                    None,
                    Some(snapshot.file_revision_token),
                ));
            }
            Err(error) => return Err(error),
        }
        self.read_and_authorize(canonical_path, display_path)
            .map(|snapshot| DocumentSaveOutcome::Saved { snapshot })
    }

    fn authorized_document(
        &self,
        canonical_uri: &str,
    ) -> Result<AuthorizedDocument, DocumentIoError> {
        if canonical_uri.trim().is_empty() {
            return Err(DocumentIoError::InvalidRequest {
                detail: "canonicalDocumentUri must not be empty".to_string(),
            });
        }
        self.registered_documents
            .lock()
            .map_err(|_| DocumentIoError::Io {
                operation: "read document authority registry".to_string(),
                detail: "the registry lock was poisoned".to_string(),
            })?
            .get(canonical_uri)
            .cloned()
            .ok_or_else(|| DocumentIoError::Unauthorized {
                canonical_document_uri: canonical_uri.to_string(),
            })
    }

    fn read_and_authorize(
        &self,
        canonical_path: PathBuf,
        display_path: String,
    ) -> Result<DocumentSnapshot, DocumentIoError> {
        let canonical_uri = canonical_document_uri(&canonical_path)?;
        let document = AuthorizedDocument {
            canonical_path,
            display_path,
        };
        let snapshot = self.read_authorized(&canonical_uri, &document)?;
        self.registered_documents
            .lock()
            .map_err(|_| DocumentIoError::Io {
                operation: "update document authority registry".to_string(),
                detail: "the registry lock was poisoned".to_string(),
            })?
            .insert(canonical_uri, document);
        Ok(snapshot)
    }

    fn read_authorized(
        &self,
        canonical_uri: &str,
        document: &AuthorizedDocument,
    ) -> Result<DocumentSnapshot, DocumentIoError> {
        let observed_path = document.canonical_path.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                DocumentIoError::NotFound {
                    detail: format!("the authorized document no longer exists: {canonical_uri}"),
                }
            } else {
                io_error("revalidate canonical document identity", error)
            }
        })?;
        if observed_path != document.canonical_path {
            return Err(DocumentIoError::IdentityInvalidated {
                canonical_document_uri: canonical_uri.to_string(),
            });
        }
        let file = File::open(&document.canonical_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                DocumentIoError::NotFound {
                    detail: format!("the authorized document no longer exists: {canonical_uri}"),
                }
            } else {
                io_error("open document snapshot", error)
            }
        })?;
        let size = file
            .metadata()
            .map_err(|error| io_error("read document metadata", error))?
            .len();
        if size > MAX_DOCUMENT_BYTES {
            return Err(DocumentIoError::TooLarge {
                size,
                limit: MAX_DOCUMENT_BYTES,
            });
        }
        let mut bytes = Vec::with_capacity(size as usize);
        file.take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| io_error("read document snapshot", error))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(DocumentIoError::TooLarge {
                size: bytes.len() as u64,
                limit: MAX_DOCUMENT_BYTES,
            });
        }
        let revision = hash_bytes(&bytes);
        let text = String::from_utf8(bytes).map_err(|error| DocumentIoError::InvalidUtf8 {
            detail: error.to_string(),
        })?;
        Ok(DocumentSnapshot {
            canonical_document_uri: canonical_uri.to_string(),
            display_path: document.display_path.clone(),
            text,
            file_revision_token: revision,
        })
    }

    fn write_temporary(&self, target: &Path, bytes: &[u8]) -> Result<PathBuf, DocumentIoError> {
        let parent = target
            .parent()
            .ok_or_else(|| DocumentIoError::InvalidRequest {
                detail: "the document path has no parent directory".to_string(),
            })?;
        let name = target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document");
        for _ in 0..16 {
            let sequence = self.next_temp_sequence.fetch_add(1, Ordering::Relaxed);
            let path = parent.join(format!(
                ".{name}.gglab-{}-{sequence}.tmp",
                std::process::id()
            ));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                        let _ = std::fs::remove_file(&path);
                        return Err(io_error("write temporary document", error));
                    }
                    return Ok(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error("create temporary document", error)),
            }
        }
        Err(DocumentIoError::Io {
            operation: "create temporary document".to_string(),
            detail: "could not allocate a unique same-directory temporary path".to_string(),
        })
    }
}

fn validate_selected_file_name(path: &Path) -> Result<(), DocumentIoError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if matches!(extension.as_deref(), Some("shadergraph" | "json")) {
        return Ok(());
    }
    Err(DocumentIoError::InvalidRequest {
        detail: "the selected document destination must end in .shadergraph or .json".to_string(),
    })
}

fn validate_document_size(bytes: &[u8]) -> Result<(), DocumentIoError> {
    let size = bytes.len() as u64;
    if size <= MAX_DOCUMENT_BYTES {
        return Ok(());
    }
    Err(DocumentIoError::TooLarge {
        size,
        limit: MAX_DOCUMENT_BYTES,
    })
}

pub(crate) fn canonical_document_uri(path: &Path) -> Result<String, DocumentIoError> {
    url::Url::from_file_path(path)
        .map(|value| value.to_string())
        .map_err(|_| DocumentIoError::InvalidRequest {
            detail: format!(
                "the host could not represent the canonical path as a file URI: {}",
                path.display()
            ),
        })
}

fn conflict(
    canonical_document_uri: String,
    expected_file_revision_token: Option<String>,
    observed_file_revision_token: Option<String>,
) -> DocumentSaveOutcome {
    DocumentSaveOutcome::Conflict {
        canonical_document_uri,
        expected_file_revision_token,
        observed_file_revision_token,
    }
}

fn preserve_permissions(target: &Path, replacement: &Path) -> Result<(), DocumentIoError> {
    let permissions = std::fs::metadata(target)
        .map_err(|error| io_error("read replaced document permissions", error))?
        .permissions();
    std::fs::set_permissions(replacement, permissions)
        .map_err(|error| io_error("apply replaced document permissions", error))
}

#[cfg(windows)]
fn atomic_replace(replacement: &Path, target: &Path) -> Result<(), DocumentIoError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement_wide: Vec<u16> = replacement
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let ok = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            replacement_wide.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok == 0 {
        return Err(io_error(
            "atomically replace document",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(replacement: &Path, target: &Path) -> Result<(), DocumentIoError> {
    std::fs::rename(replacement, target)
        .map_err(|error| io_error("atomically replace document", error))
}

#[cfg(windows)]
fn atomic_create(source: &Path, target: &Path) -> Result<(), DocumentIoError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(io_error(
            "atomically create document",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_create(source: &Path, target: &Path) -> Result<(), DocumentIoError> {
    std::fs::hard_link(source, target)
        .map_err(|error| io_error("atomically create document", error))?;
    std::fs::remove_file(source)
        .map_err(|error| io_error("remove linked temporary document", error))
}

fn io_error(operation: &str, error: std::io::Error) -> DocumentIoError {
    DocumentIoError::Io {
        operation: operation.to_string(),
        detail: error.to_string(),
    }
}

struct TemporaryPath {
    path: PathBuf,
}

impl TemporaryPath {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn disarm(mut self) {
        self.path = PathBuf::new();
    }
}

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gglab-document-io-{name}-{}-{sequence}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn snapshot_returns_exact_text_canonical_uri_and_stable_revision() {
        let directory = test_directory("snapshot");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"first bytes").unwrap();
        let service = DocumentFileService::new();

        let first = service.open_selected_path(path.clone()).unwrap();
        let second = service
            .read_snapshot(&first.canonical_document_uri)
            .unwrap();

        assert_eq!(first, second);
        assert_eq!(first.text, "first bytes");
        assert_eq!(first.file_revision_token.len(), 64);
        assert!(first.canonical_document_uri.starts_with("file:"));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_unregistered_uri_never_grants_path_access() {
        let service = DocumentFileService::new();
        let error = service
            .read_snapshot("file:///C:/not-authorized.shadergraph")
            .unwrap_err();
        assert!(matches!(error, DocumentIoError::Unauthorized { .. }));
    }

    #[test]
    fn an_invalidated_registered_identity_is_a_save_conflict() {
        let directory = test_directory("identity-invalidated");
        std::fs::create_dir(directory.join("sub")).unwrap();
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        let canonical_path = path.canonicalize().unwrap();
        let canonical_uri = canonical_document_uri(&canonical_path).unwrap();
        let service = DocumentFileService::new();
        service.registered_documents.lock().unwrap().insert(
            canonical_uri.clone(),
            AuthorizedDocument {
                canonical_path: directory.join("sub/../A.shadergraph"),
                display_path: path.to_string_lossy().into_owned(),
            },
        );

        let outcome = service
            .save(&SaveDocumentRequest {
                canonical_document_uri: canonical_uri,
                expected_file_revision_token: hash_bytes(b"base"),
                text: "local".to_string(),
            })
            .unwrap();

        assert!(matches!(outcome, DocumentSaveOutcome::Conflict { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"base");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn compare_and_swap_save_rejects_an_external_change() {
        let directory = test_directory("conflict");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        let service = DocumentFileService::new();
        let opened = service.open_selected_path(path.clone()).unwrap();
        std::fs::write(&path, b"external").unwrap();

        let outcome = service
            .save(&SaveDocumentRequest {
                canonical_document_uri: opened.canonical_document_uri.clone(),
                expected_file_revision_token: opened.file_revision_token,
                text: "local".to_string(),
            })
            .unwrap();

        assert!(matches!(outcome, DocumentSaveOutcome::Conflict { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"external");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn successful_save_returns_the_new_snapshot_and_cleans_temporary_files() {
        let directory = test_directory("save");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        let service = DocumentFileService::new();
        let opened = service.open_selected_path(path.clone()).unwrap();

        let outcome = service
            .save(&SaveDocumentRequest {
                canonical_document_uri: opened.canonical_document_uri,
                expected_file_revision_token: opened.file_revision_token,
                text: "saved".to_string(),
            })
            .unwrap();

        let DocumentSaveOutcome::Saved { snapshot } = outcome else {
            panic!("save should succeed");
        };
        assert_eq!(snapshot.text, "saved");
        assert_eq!(std::fs::read(&path).unwrap(), b"saved");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_revision_token_can_succeed_only_once() {
        let directory = test_directory("single-use-revision");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        let service = DocumentFileService::new();
        let opened = service.open_selected_path(path.clone()).unwrap();
        let request = SaveDocumentRequest {
            canonical_document_uri: opened.canonical_document_uri,
            expected_file_revision_token: opened.file_revision_token,
            text: "first save".to_string(),
        };

        assert!(matches!(
            service.save(&request).unwrap(),
            DocumentSaveOutcome::Saved { .. }
        ));
        assert!(matches!(
            service.save(&request).unwrap(),
            DocumentSaveOutcome::Conflict { .. }
        ));
        assert_eq!(std::fs::read(&path).unwrap(), b"first save");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_oversized_save_is_rejected_before_the_existing_file_changes() {
        let directory = test_directory("oversized-save");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        let service = DocumentFileService::new();
        let opened = service.open_selected_path(path.clone()).unwrap();
        let oversized = "x".repeat(MAX_DOCUMENT_BYTES as usize + 1);

        let error = service
            .save(&SaveDocumentRequest {
                canonical_document_uri: opened.canonical_document_uri,
                expected_file_revision_token: opened.file_revision_token,
                text: oversized,
            })
            .unwrap_err();

        assert!(matches!(error, DocumentIoError::TooLarge { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"base");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn save_as_never_overwrites_an_existing_destination_by_default() {
        let directory = test_directory("save-as-conflict");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"existing").unwrap();
        let service = DocumentFileService::new();

        let outcome = service
            .save_as_selected_path(path.clone(), "local")
            .unwrap();

        assert!(matches!(outcome, DocumentSaveOutcome::Conflict { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"existing");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_save_as_conflict_can_be_deliberately_overwritten_by_observed_revision() {
        let directory = test_directory("save-as-explicit-overwrite");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"existing").unwrap();
        let service = DocumentFileService::new();

        let conflict = service
            .save_as_selected_path(path.clone(), "local")
            .unwrap();
        let DocumentSaveOutcome::Conflict {
            canonical_document_uri,
            observed_file_revision_token: Some(observed_file_revision_token),
            ..
        } = conflict
        else {
            panic!("an existing Save As destination should return its observed revision");
        };

        let outcome = service
            .save(&SaveDocumentRequest {
                canonical_document_uri,
                expected_file_revision_token: observed_file_revision_token,
                text: "local".to_string(),
            })
            .unwrap();

        assert!(matches!(outcome, DocumentSaveOutcome::Saved { .. }));
        assert_eq!(std::fs::read(&path).unwrap(), b"local");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn save_as_atomically_creates_a_new_authorized_document() {
        let directory = test_directory("save-as-new");
        let path = directory.join("A.shadergraph");
        let service = DocumentFileService::new();

        let outcome = service.save_as_selected_path(path.clone(), "new").unwrap();

        let DocumentSaveOutcome::Saved { snapshot } = outcome else {
            panic!("save as should succeed");
        };
        assert_eq!(snapshot.text, "new");
        assert_eq!(
            service
                .read_snapshot(&snapshot.canonical_document_uri)
                .unwrap(),
            snapshot
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn invalid_utf8_is_an_explicit_snapshot_error() {
        let directory = test_directory("utf8");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, [0xff, 0xfe]).unwrap();
        let service = DocumentFileService::new();

        let error = service.open_selected_path(path).unwrap_err();

        assert!(matches!(error, DocumentIoError::InvalidUtf8 { .. }));
        let _ = std::fs::remove_dir_all(directory);
    }
}
