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
//!
//! Closing the final check → replace window (the guarantees are
//! platform-qualified):
//!
//! - Windows (the guarded settlement, see
//!   [`DocumentFileService::settle_guarded_save`]): the save first acquires
//!   a handle over the target for READ access, with a share mask that omits
//!   FILE_SHARE_WRITE. The guard requests only READ (not WRITE): the writer
//!   exclusion comes entirely from the write-unsharing mask, and requesting
//!   WRITE would add no exclusion while sparsely conflicting an unrelated
//!   read-only handle that does not share WRITE. Windows' two-way sharing
//!   rules then make writer exclusion OS-enforced for the guard's lifetime —
//!   no external writer can be present while the guard is held, nor appear
//!   while it is held — so the save validates the expected revision through
//!   the guard's own handle and commits the name while the exclusion holds.
//!   A writer that holds the file settles as a conflict without losing its
//!   bytes; a writer that arrives after the commit is a legitimate last
//!   writer. The sharing facts are pinned by the contract tests in `tests`,
//!   not assumed.
//!
//! - POSIX (the seize settlement, see
//!   [`DocumentFileService::commit_bytes_onto_name`]): open has no share
//!   modes, so exclusion cannot be acquired; the guarantee rests on atomic
//!   NAME semantics instead — seize the name, revalidate the seized bytes,
//!   commit a hard link only while the name is vacant (an occupied name
//!   fails the link and settles as a conflict), revalidate before cleanup.
//!   Residual: a writer whose handle predates the save can still land one
//!   write between the final revalidation and the cleanup — an interval of
//!   a few instructions, and the only writer class that can win a race
//!   here at all.

use crate::shader_tool::identity::hash_bytes;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

mod settlement_posix;
mod settlement_windows;

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

/// The settlement of one guarded commit attempt ([`DocumentFileService::commit_replacement`]).
#[derive(Debug, Clone, PartialEq, Eq)]
enum CommitSettlement {
    /// Our bytes hold the target name and the seized file never changed.
    Committed,
    /// The external state won; `save` maps this to a structured conflict
    /// without discarding the external bytes.
    Conflict {
        observed_file_revision_token: Option<String>,
    },
}

/// Host-lifetime authority registry plus deterministic temporary-name source.
pub struct DocumentFileService {
    registered_documents: Mutex<HashMap<String, AuthorizedDocument>>,
    save_gate: Mutex<()>,
    next_temp_sequence: AtomicU64,
    /// Test observation only: the monotonic instant the last save commit
    /// settled. It carries no production semantics; ordering assertions in
    /// the race regressions compare their own writes against it.
    last_commit_unix_nanos: AtomicU64,
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
            last_commit_unix_nanos: AtomicU64::new(0),
        }
    }

    /// The monotonic instant (UNIX nanoseconds) the last commit settled, or
    /// 0 before any save. Exposed for the race regressions' ordering
    /// assertions only.
    pub fn last_commit_unix_nanos(&self) -> u64 {
        self.last_commit_unix_nanos.load(Ordering::Acquire)
    }

    /// Admit an existing path selected by a host-owned Open dialog.
    ///
    /// Serialized under the same transaction gate as saves: an interrupted
    /// save left mid-commit must be recovered here, but recovery must never
    /// observe — and "recover" — the aside belonging to a LIVE in-flight
    /// save, which only in-process serialization can exclude.
    pub fn open_selected_path(
        &self,
        selected_path: PathBuf,
    ) -> Result<DocumentSnapshot, DocumentIoError> {
        let _open_guard = self.save_gate.lock().map_err(|_| DocumentIoError::Io {
            operation: "serialize document open".to_string(),
            detail: "the save lock was poisoned".to_string(),
        })?;
        self.open_selected_path_locked(selected_path)
    }

    fn open_selected_path_locked(
        &self,
        selected_path: PathBuf,
    ) -> Result<DocumentSnapshot, DocumentIoError> {
        let display_path = selected_path.to_string_lossy().into_owned();
        // A target name may be missing because a save died mid-commit; the
        // seized copy is the file, and it becomes the target again first.
        let _recovered = self.recover_interrupted_saves(&selected_path)?;
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
        // Serialize with in-progress saves of any document: a read must not
        // race the name seizure inside one that holds the expected revision.
        let _read_guard = self.save_gate.lock().map_err(|_| DocumentIoError::Io {
            operation: "serialize document read".to_string(),
            detail: "the save lock was poisoned".to_string(),
        })?;
        let document = self.authorized_document(canonical_uri)?;
        let _recovered = self.recover_interrupted_saves(&document.canonical_path)?;
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
    ///
    /// The check → replace window is closed platform-qualified (module
    /// docs): Windows first acquires the write-exclusion guard and commits
    /// under it; POSIX commits through the name-seize settlement.
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
        // A save whose host died mid-commit must roll back before this save
        // can judge the on-disk state.
        let _recovered = self.recover_interrupted_saves(&document.canonical_path)?;
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
        let temp_guard = TemporaryPath::new(temp_path.clone());

        // Copy the target's permissions onto the replacement BEFORE the
        // commit: the committed file is a new directory entry, so it keeps
        // the identity of the temporary file (directory-inherited, same
        // user, same directory) rather than that of the seized target.
        if let Ok(permissions) = std::fs::metadata(&document.canonical_path) {
            let _ = std::fs::set_permissions(temp_guard.path(), permissions.permissions());
        }

        // Windows: the guarded settlement closes the check→replace window
        // completely (OS-enforced writer exclusion, contract-tested).
        // POSIX: the name-seize settlement (hard atomicity plus revalidation;
        // the documented sub-instruction residual remains there).
        #[cfg(windows)]
        let settlement = self.settle_guarded_save(
            &document,
            &temp_path,
            &request.expected_file_revision_token,
        )?;
        #[cfg(not(windows))]
        let settlement = self.commit_replacement(
            &document,
            &temp_path,
            &request.expected_file_revision_token,
        )?;
        match settlement {
            CommitSettlement::Committed => {
                temp_guard.disarm();
                self.read_authorized(&request.canonical_document_uri, &document)
                    .map(|snapshot| DocumentSaveOutcome::Saved { snapshot })
            }
            CommitSettlement::Conflict {
                observed_file_revision_token,
            } => Ok(conflict(
                request.canonical_document_uri.clone(),
                Some(request.expected_file_revision_token.clone()),
                observed_file_revision_token,
            )),
        }
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
        // A previously interrupted save may have left this destination name
        // missing while its seized copy holds the true file; the existing
        // destination check below must see the restored reality.
        let _recovered = self.recover_interrupted_saves(&selected_path)?;
        if selected_path.exists() {
            // Already under the save gate (acquired above): use the
            // unlocked form — the gate is not re-entrant.
            let snapshot = self.open_selected_path_locked(selected_path)?;
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

    /// Choose the private aside name for an in-flight save of this document.
    fn save_aside_path(&self, document: &AuthorizedDocument) -> Result<PathBuf, DocumentIoError> {
        let parent = document
            .canonical_path
            .parent()
            .ok_or_else(|| DocumentIoError::InvalidRequest {
                detail: "the document path has no parent directory".to_string(),
            })?;
        let file_name = document
            .canonical_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| DocumentIoError::InvalidRequest {
                detail: "the document path has no file name".to_string(),
            })?;
        let sequence = self.next_temp_sequence.fetch_add(1, Ordering::Relaxed);
        Ok(parent.join(format!(
            ".{file_name}.gglab-save-aside-{}-{sequence}",
            std::process::id()
        )))
    }

    /// Restore a save whose host died between seizing the target name and
    /// committing. The newest aside is the most recent pre-save state and
    /// becomes the target again; older copies are removed only when they
    /// hold the SAME state, and preserved under a visible name otherwise —
    /// an interrupted save is rolled back, never a reason to lose data.
    fn recover_interrupted_saves(&self, target: &Path) -> Result<bool, DocumentIoError> {
        let file_name = target
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DocumentIoError::InvalidRequest {
                detail: "the document path has no file name".to_string(),
            })?;
        let parent = target
            .parent()
            .ok_or_else(|| DocumentIoError::InvalidRequest {
                detail: "the document path has no parent directory".to_string(),
            })?;
        let prefix = format!(".{file_name}.gglab-save-aside-");
        let mut asides: Vec<(u64, PathBuf)> = Vec::new();
        for entry in std::fs::read_dir(parent)
            .map_err(|error| io_error("scan for interrupted saves", error))?
        {
            let entry = entry.map_err(|error| io_error("scan for interrupted saves", error))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(suffix) = name.strip_prefix(&prefix) else {
                continue;
            };
            let Some(seq_text) = suffix.rsplit('-').next() else {
                continue;
            };
            let Ok(sequence) = seq_text.parse::<u64>() else {
                continue;
            };
            asides.push((sequence, entry.path()));
        }
        if asides.is_empty() {
            return Ok(false);
        }

        // Newest first: the most recent pre-save state is the true current
        // state of the target; each older copy seen afterward is either a
        // duplicate or a genuinely older state to preserve visibly.
        asides.sort_by_key(|(sequence, _)| u64::MAX.checked_sub(*sequence).unwrap_or(u64::MAX));
        for (sequence, aside) in asides {
            if target.exists() {
                // The target already holds a state. An aside with the SAME
                // bytes is a duplicate (removal loses nothing); a different
                // state is preserved under a visible name, never deleted.
                let same = matches!(
                    (read_bounded_bytes(&aside), read_bounded_bytes(target)),
                    (Ok(first), Ok(second)) if first == second
                );
                if same {
                    std::fs::remove_file(&aside)
                        .map_err(|error| io_error("remove duplicate seized copy", error))?;
                } else {
                    std::fs::rename(
                        &aside,
                        parent.join(format!("{file_name}.gglab-recover-{sequence}")),
                    )
                    .map_err(|error| io_error("preserve seized copy", error))?;
                }
            } else {
                std::fs::rename(&aside, target)
                    .map_err(|error| io_error("restore seized document", error))?;
            }
        }
        Ok(true)
    }

    /// Internal lookup for remembering already admitted document identities.
    pub(crate) fn registered_path(&self, canonical_uri: &str) -> Result<PathBuf, DocumentIoError> {
        Ok(self.authorized_document(canonical_uri)?.canonical_path)
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
        let bytes = match read_bounded_bytes(&document.canonical_path) {
            Ok(bytes) => bytes,
            Err(error) => {
                let size = std::fs::metadata(&document.canonical_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                return Err(if error.kind() == std::io::ErrorKind::NotFound {
                    DocumentIoError::NotFound {
                        detail: format!("the authorized document no longer exists: {canonical_uri}"),
                    }
                } else if size > MAX_DOCUMENT_BYTES {
                    DocumentIoError::TooLarge {
                        size,
                        limit: MAX_DOCUMENT_BYTES,
                    }
                } else {
                    io_error("open document snapshot", error)
                });
            }
        };
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

fn io_error_detail(error: std::io::Error, hint: &str) -> std::io::Error {
    std::io::Error::new(error.kind(), format!("{hint}: {error}"))
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

/// Read a bounded file whole. Oversized output is an error (the caller
/// treats an unreadable revision as unverifiable, never as a match).
fn read_bounded_bytes(path: &Path) -> std::io::Result<Vec<u8>> {
    let size = std::fs::metadata(path)
        .map_err(|error| io_error_detail(error, "read bounded document"))?
        .len();
    if size > MAX_DOCUMENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("the document exceeds the {MAX_DOCUMENT_BYTES}-byte limit"),
        ));
    }
    let file = File::open(path).map_err(|error| io_error_detail(error, "open document"))?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error_detail(error, "read document snapshot"))?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("the document exceeds the {MAX_DOCUMENT_BYTES}-byte limit"),
        ));
    }
    Ok(bytes)
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

    // Measured Windows replacement semantics (the design rests on them):
    // a name MOVE (MoveFileEx) succeeds over a source another process holds
    // open for write (read sharing granted) and into a vacant name; it fails
    // with ACCESS_DENIED over a destination that is open. ReplaceFileW
    // fails (also ACCESS_DENIED) over a source open for write. That is why
    // the commit moves the seized copy onto a VACANT name for rollbacks and
    // why the cleanup never moves over an occupied name.

    // The Windows save guard rests on a different, probe-pinned fact: a
    // WRITE-ACCESS open (which requests write access) is refused by the
    // sharing rules whenever a writable handle exists that does not grant
    // FILE_SHARE_WRITE, and — once held — it refuses every later writable
    // open. That is a hard, OS-enforced writer exclusion for the whole
    // lifetime of the handle.

    // The Windows writer-exclusion contract the guarded save rests on,
    // pinned by measurement (the save path is forbidden from assuming these
    // sharing facts):
    // 1  a live writer denies the guard's acquisition;
    // 2  the held guard denies a later writer (readers stay allowed);
    // 3  the guard's own inode stays movable onto a vacant name (commit)
    //    and back (rollback);
    // 4  a REPLACE over the guard-held destination is refused (we never
    //    replace over an open destination);
    // 5  release restores normal writer access;
    // 6  the sharing check is two-way: even a writer that grants WRITE
    //    share cannot coexist with the no-WRITE-share guard.
    #[cfg(windows)]
    #[test]
    fn the_write_guard_pins_the_windows_sharing_contract() {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
        let dir = test_directory("guard-contract");
        let doc = dir.join("d.txt");
        std::fs::write(&doc, b"doc-bytes").unwrap();

        let write_guard = || {
            // requests READ+WRITE access (save shape); share without
            // FILE_SHARE_WRITE — the exclusion is the share mask
            OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
                .open(&doc)
        };

        // 1. a pre-existing writable handle (std defaults) must DENY the guard
        let writer = OpenOptions::new().write(true).open(&doc).unwrap();
        assert!(
            write_guard().is_err(),
            "1: guard acquisition must be denied while a writer holds the file"
        );
        drop(writer);
        assert!(write_guard().is_ok(), "1b: with no writer, the guard must acquire");

        // 2. the held guard must DENY a later writable open
        let guard = write_guard().unwrap();
        assert!(
            OpenOptions::new().write(true).open(&doc).is_err(),
            "2: while the guard is held, a new writer must be refused"
        );
        // 2b. ...but readers may still open (the guard shares READ)
        assert!(OpenOptions::new().read(true).open(&doc).is_ok(), "2b: readers keep working");
        // 3. the commit form: moving the guard's own inode onto a VACANT name must WORK
        let aside = dir.join("aside.txt");
        let s: Vec<u16> = doc.as_os_str().encode_wide().chain(Some(0)).collect();
        let a: Vec<u16> = aside.as_os_str().encode_wide().chain(Some(0)).collect();
        let mv = unsafe { MoveFileExW(s.as_ptr(), a.as_ptr(), 0) };
        assert_eq!(mv, 1, "3: the guard's file must be movable onto a vacant name");
        // 3b. ...and moving it back (rollback form) must work too
        let mv2 = unsafe { MoveFileExW(a.as_ptr(), s.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
        assert_eq!(mv2, 1, "3b: the rollback move must work");
        // 4. ReplaceFileW-style replace over the guard-held destination is refused
        let s2: Vec<u16> = aside.as_os_str().encode_wide().chain(Some(0)).collect();
        let r = unsafe { MoveFileExW(s2.as_ptr(), s.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
        assert_eq!(r, 0, "4: a REPLACE over the guard-held destination must be refused");
        drop(guard);
        // 5. releasing the guard must restore normal writer access
        let late_writer = OpenOptions::new().write(true).open(&doc).unwrap();
        drop(late_writer);
        // 6. the sharing check is two-way: a writer that DOES grant WRITE
        //    share is still refused against the no-WRITE-share guard (its
        //    own write access is not covered by the guard's share mask),
        //    so NO writable cohabitation is ever possible — an existing
        //    writer always settles as conflict/busy, never silent overlap.
        let sharing_writer = OpenOptions::new()
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&doc)
            .unwrap();
        assert!(
            write_guard().is_err(),
            "6: a sharing writer must still block the guard (two-way sharing check)"
        );
        drop(sharing_writer);
        let _ = std::fs::remove_dir_all(dir);
    }

    // P2 follow-up (review 2): does the guard REQUIRE WRITE desired access,
    // or is a READ-only guard with the same no-FILE_SHARE_WRITE mask
    // equivalent? This probe answers it by showing a READ-only guard keeps
    // the identical writer-exclusion contract, and then pinning the exact
    // spurious-conflict the WRITE-desiring guard has with an unrelated
    // restrictive (write-unsharing) reader that the READ-only form avoids.
    #[cfg(windows)]
    #[test]
    fn the_read_only_guard_provides_the_same_writer_exclusion() {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
        let dir = test_directory("read-only-guard-contract");
        let doc = dir.join("d.txt");
        std::fs::write(&doc, b"doc-bytes").unwrap();

        let read_guard = || {
            // READ access ONLY (no FILE_WRITE); same share mask that
            // OMITS FILE_SHARE_WRITE — the exclusion under test
            OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
                .open(&doc)
        };
        let write_guard = || {
            // the current production shape (READ+WRITE) for contrast
            OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
                .open(&doc)
        };

        // 1. a pre-existing writer must DENY the READ-only guard's acquisition
        let writer = OpenOptions::new().write(true).open(&doc).unwrap();
        assert!(
            read_guard().is_err(),
            "1: a READ-only guard must be denied while a writer holds the file"
        );
        drop(writer);
        assert!(
            read_guard().is_ok(),
            "1b: with no writer, the READ-only guard must acquire"
        );

        // 2. the held READ-only guard must DENY a later writable open
        let guard = read_guard().unwrap();
        assert!(
            OpenOptions::new().write(true).open(&doc).is_err(),
            "2: while a READ-only guard is held, a new writer must be refused"
        );
        // 2b. readers keep working
        assert!(
            OpenOptions::new().read(true).open(&doc).is_ok(),
            "2b: readers keep working"
        );
        // 3. the guard's own inode stays movable onto a vacant name (commit)
        let aside = dir.join("aside.txt");
        let s: Vec<u16> = doc.as_os_str().encode_wide().chain(Some(0)).collect();
        let a: Vec<u16> = aside.as_os_str().encode_wide().chain(Some(0)).collect();
        let mv = unsafe { MoveFileExW(s.as_ptr(), a.as_ptr(), 0) };
        assert_eq!(mv, 1, "3: the READ-only guard's file must be movable onto a vacant name");
        // 3b. ...and movable back (rollback)
        let mv2 = unsafe { MoveFileExW(a.as_ptr(), s.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
        assert_eq!(mv2, 1, "3b: the rollback move must work");
        // 4. a REPLACE over the guard-held destination is refused
        let s2: Vec<u16> = aside.as_os_str().encode_wide().chain(Some(0)).collect();
        let r = unsafe { MoveFileExW(s2.as_ptr(), s.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
        assert_eq!(r, 0, "4: a REPLACE over the guard-held destination must be refused");
        drop(guard);
        // 5. the two-way sharing check: even a writer that grants WRITE share
        //    still blocks the no-FILE_SHARE_WRITE guard — for READ-only too
        let sharing_writer = OpenOptions::new()
            .write(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(&doc)
            .unwrap();
        assert!(
            read_guard().is_err(),
            "5: a sharing writer must still block the READ-only guard (two-way sharing check)"
        );
        drop(sharing_writer);

        // 6. the decisive contrast: an unrelated restrictive reader (one that
        //    shares READ but NOT WRITE) sparsely conflicts the WRITE-desiring
        //    guard but the READ-only guard coexists with it
        let restrictive_reader = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .open(&doc)
            .unwrap();
        assert!(
            write_guard().is_err(),
            "6a: the WRITE-desiring guard is sparsely blocked by a restrictive reader"
        );
        assert!(
            read_guard().is_ok(),
            "6b: the READ-only guard coexists with the same restrictive reader"
        );
        drop(restrictive_reader);
        let _ = std::fs::remove_dir_all(dir);
    }

    fn document_file_count(directory: &Path) -> usize {
        std::fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path()
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("shadergraph"))
            })
            .count()
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
        assert_eq!(document_file_count(&directory), 1, "no temporary file may be left behind");
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

    // The Windows guard path, deterministically: a live writer that holds
    // the file while the save decides must settle as a conflict, with its
    // state untouched and no commitment artifacts left behind.
    #[cfg(windows)]
    #[test]
    fn a_live_writer_blocks_the_guarded_save_and_keeps_its_state() {
        let directory = test_directory("guarded-save-blocked");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"writer-state").unwrap();
        let service = DocumentFileService::new();
        let opened = service.open_selected_path(path.clone()).unwrap();

        // A live writer into the name: its unshared write access must
        // refuse the guard's write request.
        let writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        let outcome = service
            .save(&SaveDocumentRequest {
                canonical_document_uri: opened.canonical_document_uri.clone(),
                expected_file_revision_token: opened.file_revision_token.clone(),
                text: "local".to_string(),
            })
            .unwrap();
        drop(writer);

        let DocumentSaveOutcome::Conflict {
            observed_file_revision_token: Some(observed),
            ..
        } = outcome
        else {
            panic!("a live writer must settle the save as a conflict");
        };
        assert_eq!(observed, hash_bytes(b"writer-state"));
        // The writer's state is untouched and the directory is clean:
        // no seized copies, no temporary names.
        assert_eq!(std::fs::read(&path).unwrap(), b"writer-state");
        assert_eq!(
            std::fs::read_dir(&directory)
                .unwrap()
                .filter_map(Result::ok)
                .count(),
            1
        );
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

    // Race regressions for the final compare → replace window: the slice
    // between the final revision check and the commit. The commit settles
    // the window by seizing the target's NAME, committing onto the name
    // only while it is vacant, and revalidating the seized bytes; these
    // tests drive every branch of that settlement deterministically, then
    // race a live external writer against the full save path and assert
    // the one outcome the old check → replace order allowed but this
    // design must never allow: an external write that landed BEFORE the
    // commit being reported as a successful save.
    fn commit_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf, AuthorizedDocument) {
        let directory = test_directory(name);
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        let temp = directory.join("A.tmp.shadergraph");
        std::fs::write(&temp, b"local").unwrap();
        let document = AuthorizedDocument {
            canonical_path: path.canonicalize().unwrap(),
            display_path: path.to_string_lossy().into_owned(),
        };
        (directory, path, temp, document)
    }

    #[test]
    fn a_clean_seize_commits_onto_the_vacant_name_and_leaves_only_the_target() {
        let (directory, path, temp, document) = commit_fixture("clean-commit");
        let service = DocumentFileService::new();

        // Reproduce the settled state of save(): the target name is seized
        // into the aside slot the commit uses, the check passed, and now
        // the commit decides.
        let aside = path.with_file_name(".A.shadergraph.gglab-save-aside-test-1");
        std::fs::rename(&path, &aside).unwrap();
        let expected = hash_bytes(b"base");

        let settlement = service
            .commit_bytes_onto_name(&document, &temp, &aside, &expected)
            .expect("a settled commit must not fail");

        assert_eq!(
            settlement,
            CommitSettlement::Committed,
            "a clean seize must commit"
        );
        assert_eq!(
            document_file_count(&directory),
            1,
            "a settled save leaves only the target name behind"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"local");
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_foreign_file_recreating_the_name_wins_and_the_commit_is_a_conflict() {
        let (directory, path, temp, document) = commit_fixture("foreign-recreate");
        let service = DocumentFileService::new();

        let aside = path.with_file_name(".A.shadergraph.gglab-save-aside-test-1");
        std::fs::rename(&path, &aside).unwrap();
        // The external writer recreates the name while it is vacant.
        std::fs::write(&path, b"external").unwrap();
        let expected = hash_bytes(b"base");

        let settlement = service
            .commit_bytes_onto_name(&document, &temp, &aside, &expected)
            .expect("an occupied name must settle as a conflict, not an error");

        let _ = std::fs::remove_file(&temp);
        assert_eq!(
            settlement,
            CommitSettlement::Conflict {
                observed_file_revision_token: Some(hash_bytes(b"external"))
            },
            "a foreign file must be detected and reported"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"external",
            "the external file must win the name, untouched"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_late_write_into_the_seized_file_rolls_the_commit_back() {
        let (directory, path, temp, document) = commit_fixture("late-write-rollback");
        let service = DocumentFileService::new();

        let aside = path.with_file_name(".A.shadergraph.gglab-save-aside-test-1");
        std::fs::rename(&path, &aside).unwrap();
        let expected = hash_bytes(b"base");
        // Simulate the end state of a writer whose pre-seize handle writes
        // into the seized inode around the commit: the seized bytes are no
        // longer the expected revision.
        std::fs::write(&aside, b"external").unwrap();

        let settlement = service
            .commit_bytes_onto_name(&document, &temp, &aside, &expected)
            .expect("a moved seized file must settle as a conflict, not an error");

        let _ = std::fs::remove_file(&temp);
        assert_eq!(
            settlement,
            CommitSettlement::Conflict {
                observed_file_revision_token: Some(hash_bytes(b"external"))
            },
            "a late write into the seized file must be detected"
        );
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"external",
            "the external state must win the name again"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_interrupted_save_is_recovered_before_any_other_operation() {
        let directory = test_directory("interrupted-recovery");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        // Simulate a host death between the seize and the commit: the name
        // is vacant and the seized copy holds the pre-save state.
        let aside = path.with_file_name(".A.shadergraph.gglab-save-aside-test-7");
        std::fs::rename(&path, &aside).unwrap();
        assert!(!path.exists());

        // A fresh host must find the document again through any entry
        // point, restored to the state the interrupted save last held.
        let service = DocumentFileService::new();
        let snapshot = service.open_selected_path(path.clone()).expect("recovery must restore");
        assert_eq!(snapshot.text, "base");
        assert_eq!(std::fs::read(&path).unwrap(), b"base");
        assert!(!aside.exists());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_older_different_seized_state_is_preserved_when_restoring_the_newest() {
        let directory = test_directory("interrupted-recovery-multiple");
        let path = directory.join("A.shadergraph");
        // Two interrupted saves of two different pre-save states: the
        // oldest aside holds the older state, the newest the current one.
        std::fs::write(
            directory.join(".A.shadergraph.gglab-save-aside-test-1"),
            b"old-state",
        )
        .unwrap();
        std::fs::write(
            directory.join(".A.shadergraph.gglab-save-aside-test-2"),
            b"new-state",
        )
        .unwrap();

        let service = DocumentFileService::new();
        let snapshot = service.open_selected_path(path.clone()).expect("recovery must restore");
        assert_eq!(
            snapshot.text, "new-state",
            "the newest seized state is the most recent pre-save state"
        );
        // The older DIFFERENT state is preserved visibly, never deleted.
        assert_eq!(
            std::fs::read(directory.join("A.shadergraph.gglab-recover-1")).unwrap(),
            b"old-state"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    // The race regression for the exact window, end to end through save():
    // an external writer hammering the file from a second thread must
    // either win honestly (the save reports conflict and ITS state holds
    // the name — external bytes, or their truncated state if the writer
    // exited mid-cycle) or start too late (the save reports success and
    // its write lands after the commit instant). The one outcome the
    // old check → replace order allowed — a pre-commit external write
    // reported as a successful save — is what this design must never
    // produce. On Windows the write-access guard makes the two states
    // mutually exclusive for the whole commit interval; on POSIX the
    // revalidations close it; either way the invariants below hold.
    #[test]
    fn save_races_a_live_external_writer_without_silently_discarding_it() {
        use std::io::Write as _;
        use std::sync::Arc;
        let directory = test_directory("live-writer-race");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"base").unwrap();
        let service = DocumentFileService::new();
        let opened = service.open_selected_path(path.clone()).unwrap();

        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        // Progress = every successful open (each truncates: a file-state
        // change), writes = every successful write_all.
        let progress = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let writes = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut previous: Option<std::thread::JoinHandle<()>> = None;

        for _ in 0..30 {
            // Reset the fixture with no writer in flight.
            if let Some(handle) = previous.take() {
                handle.join().expect("the writer thread must exit");
            }
            std::fs::write(&path, b"base").unwrap();
            progress.store(0, std::sync::atomic::Ordering::Relaxed);
            writes.store(0, std::sync::atomic::Ordering::Relaxed);
            stop.store(false, std::sync::atomic::Ordering::Relaxed);

            let writer_stop = Arc::clone(&stop);
            let writer_progress = Arc::clone(&progress);
            let writer_writes = Arc::clone(&writes);
            let writer_path = path.clone();
            previous = Some(std::thread::spawn(move || loop {
                if writer_stop.load(std::sync::atomic::Ordering::Relaxed) {
                    break;
                }
                let Ok(mut file) = std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .open(&writer_path)
                else {
                    continue; // the name is vacant or the guard refused
                };
                // The open truncated: the name's state is now the
                // writer's, whether or not the write itself lands.
                writer_progress.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if file.write_all(b"external").is_ok() {
                    writer_writes.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }));

            let outcome = service
                .save(&SaveDocumentRequest {
                    canonical_document_uri: opened.canonical_document_uri.clone(),
                    expected_file_revision_token: opened.file_revision_token.clone(),
                    text: "local".to_string(),
                })
                .expect("the save must settle, not fail");
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            previous
                .take()
                .unwrap()
                .join()
                .expect("the writer thread must exit");

            let on_disk = std::fs::read(&path).unwrap();
            let progress = progress.load(std::sync::atomic::Ordering::Relaxed);
            let writes = writes.load(std::sync::atomic::Ordering::Relaxed);

            match outcome {
                DocumentSaveOutcome::Saved { .. } => {
                    assert!(
                        service.last_commit_unix_nanos() > 0,
                        "a saved commit must be stamped"
                    );
                    if on_disk == b"local" {
                        // The silent-discard signature — a pre-commit
                        // writer state yet the save succeeded with the
                        // local content — is impossible: a writer state
                        // present at the decision point is either held by
                        // a live handle (the guard refuses the commit →
                        // conflict), or already in the bytes (validation
                        // mismatch → conflict). A writer state observed
                        // here can therefore only be the writer's OWN
                        // legitimate post-commit action.
                        assert_eq!(
                            writes, 0,
                            "a writer that completed a write must have been detected \
                             as a conflict or its bytes must win the name — never be \
                             silently overwritten: disk={on_disk:?}"
                        );
                    }
                    // on_disk == b"external" is the legitimate last-writer
                    // case (post-commit write); b"" is a post-commit open
                    // whose write did not land — also outside the window.
                    assert!(
                        on_disk == b"local" || on_disk == b"external" || on_disk.is_empty(),
                        "the name must hold one side's bytes: disk={on_disk:?}"
                    );
                }
                DocumentSaveOutcome::Conflict { .. } => {
                    // A conflict means the external state won the name —
                    // their bytes, or their truncated state if they exited
                    // mid-cycle. Never OUR bytes.
                    assert_ne!(
                        on_disk, b"local",
                        "a conflict must not have committed the local content"
                    );
                    assert!(
                        progress > 0,
                        "a conflict means the external state won, so the writer \
                         must have touched the file"
                    );
                }
                other => panic!("the save must settle as Saved or Conflict, not {other:?}"),
            }
            // A settled save leaves the name holding content — never a
            // deleted name.
            assert!(path.exists());
        }
        let _ = std::fs::remove_dir_all(directory);
    }
}
