//! Bounded Workspace roots, deterministic discovery, and refresh observations.
//!
//! A root enters through a host-owned directory dialog and is retained as a
//! host-lifetime URI capability. Discovery accepts only that URI, never a path.
//! It canonicalizes every traversed directory and document before checking
//! containment, skips directory links and excluded content trees, and stops at
//! explicit depth/entry/document limits.
//!
//! Discovery snapshots carry a deterministic revision token. Repeating a scan
//! with the caller's last token yields `unchanged` or a complete newer snapshot;
//! this is a pull-based refresh hint, not save authority. Exact document reads
//! and compare-and-swap saves remain authoritative in `document_io`.

use crate::document_io::{canonical_document_uri, DocumentFileService, DocumentIoError};
use crate::shader_tool::identity::hash_bytes;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

const MAX_DISCOVERY_DEPTH: usize = 32;
const MAX_DISCOVERY_ENTRIES: usize = 20_000;
const MAX_DISCOVERED_DOCUMENTS: usize = 5_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRoot {
    pub canonical_workspace_uri: String,
    pub display_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocumentEntry {
    pub relative_path: String,
    pub canonical_document_uri: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiscoverySnapshot {
    pub root: WorkspaceRoot,
    pub documents: Vec<WorkspaceDocumentEntry>,
    pub discovery_revision_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiscoveryId {
    pub sequence: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiscoveryRequest {
    pub canonical_workspace_uri: String,
    pub observed_discovery_revision_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceDiscoverySettlement {
    Changed {
        discovery_id: WorkspaceDiscoveryId,
        snapshot: WorkspaceDiscoverySnapshot,
    },
    Unchanged {
        discovery_id: WorkspaceDiscoveryId,
        canonical_workspace_uri: String,
        discovery_revision_token: String,
    },
    Cancelled {
        discovery_id: WorkspaceDiscoveryId,
    },
    Failed {
        discovery_id: WorkspaceDiscoveryId,
        error: WorkspaceIoError,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDiscoveryCancelOutcome {
    pub discovery_id: WorkspaceDiscoveryId,
    pub cancellation_requested: bool,
    pub already_settled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceIoError {
    InvalidRequest { detail: String },
    Unauthorized { canonical_workspace_uri: String },
    NotFound { detail: String },
    NotDirectory { detail: String },
    RootInvalidated { canonical_workspace_uri: String },
    LimitExceeded { limit_kind: String, limit: usize },
    Io { operation: String, detail: String },
    DocumentAuthority { error: DocumentIoError },
    HostTask { detail: String },
}

#[derive(Debug, Clone)]
struct AuthorizedWorkspace {
    root: WorkspaceRoot,
    canonical_path: PathBuf,
}

#[derive(Debug, Clone, Copy)]
struct DiscoveryLimits {
    max_depth: usize,
    max_entries: usize,
    max_documents: usize,
}

impl Default for DiscoveryLimits {
    fn default() -> Self {
        Self {
            max_depth: MAX_DISCOVERY_DEPTH,
            max_entries: MAX_DISCOVERY_ENTRIES,
            max_documents: MAX_DISCOVERED_DOCUMENTS,
        }
    }
}

#[derive(Debug)]
pub struct WorkspaceDiscoveryAttempt {
    pub discovery_id: WorkspaceDiscoveryId,
    pub settle: JoinHandle<WorkspaceDiscoverySettlement>,
}

pub struct WorkspaceFileService {
    documents: Arc<DocumentFileService>,
    registered_workspaces: Mutex<HashMap<String, AuthorizedWorkspace>>,
    pending_discoveries: Arc<Mutex<HashMap<WorkspaceDiscoveryId, Arc<AtomicBool>>>>,
    next_discovery_sequence: AtomicU64,
    limits: DiscoveryLimits,
}

impl WorkspaceFileService {
    pub fn new(documents: Arc<DocumentFileService>) -> Self {
        Self {
            documents,
            registered_workspaces: Mutex::new(HashMap::new()),
            pending_discoveries: Arc::new(Mutex::new(HashMap::new())),
            next_discovery_sequence: AtomicU64::new(1),
            limits: DiscoveryLimits::default(),
        }
    }

    /// Admit one directory chosen by the host-owned Workspace dialog.
    pub fn register_selected_root(
        &self,
        selected_path: PathBuf,
    ) -> Result<WorkspaceRoot, WorkspaceIoError> {
        let display_path = selected_path.to_string_lossy().into_owned();
        let canonical_path = selected_path.canonicalize().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                WorkspaceIoError::NotFound {
                    detail: format!("the selected Workspace no longer exists: {display_path}"),
                }
            } else {
                workspace_io_error("canonicalize selected Workspace", error)
            }
        })?;
        if !canonical_path
            .metadata()
            .map_err(|error| workspace_io_error("read selected Workspace metadata", error))?
            .is_dir()
        {
            return Err(WorkspaceIoError::NotDirectory {
                detail: format!("the selected Workspace is not a directory: {display_path}"),
            });
        }
        let canonical_workspace_uri = workspace_uri(&canonical_path)?;
        let root = WorkspaceRoot {
            canonical_workspace_uri: canonical_workspace_uri.clone(),
            display_path,
        };
        let workspace = AuthorizedWorkspace {
            root: root.clone(),
            canonical_path,
        };
        self.registered_workspaces
            .lock()
            .map_err(|_| registry_error("update Workspace authority registry"))?
            .insert(canonical_workspace_uri, workspace);
        Ok(root)
    }

    /// Start one bounded scan. Settlement happens off the Tauri worker so the
    /// caller receives an identity immediately and may cancel it explicitly.
    pub fn discover(
        &self,
        request: &WorkspaceDiscoveryRequest,
    ) -> Result<WorkspaceDiscoveryAttempt, WorkspaceIoError> {
        if let Some(token) = &request.observed_discovery_revision_token {
            if token.trim().is_empty() {
                return Err(WorkspaceIoError::InvalidRequest {
                    detail: "observedDiscoveryRevisionToken must be null or non-empty".to_string(),
                });
            }
        }
        let workspace = self.authorized_workspace(&request.canonical_workspace_uri)?;
        let discovery_id = WorkspaceDiscoveryId {
            sequence: self.next_discovery_sequence.fetch_add(1, Ordering::Relaxed),
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        self.pending_discoveries
            .lock()
            .map_err(|_| registry_error("register Workspace discovery"))?
            .insert(discovery_id, Arc::clone(&cancelled));

        let pending = Arc::clone(&self.pending_discoveries);
        let documents = Arc::clone(&self.documents);
        let observed_token = request.observed_discovery_revision_token.clone();
        let limits = self.limits;
        let spawn = std::thread::Builder::new()
            .name(format!(
                "gglab-workspace-discovery-{}",
                discovery_id.sequence
            ))
            .spawn(move || {
                let discovered = discover_workspace(&workspace, limits, &cancelled);
                let settlement = if cancelled.load(Ordering::Acquire) {
                    WorkspaceDiscoverySettlement::Cancelled { discovery_id }
                } else {
                    match discovered {
                        Ok(discovered) => settle_discovery(
                            discovery_id,
                            &workspace,
                            observed_token.as_deref(),
                            discovered,
                            &documents,
                            &cancelled,
                        ),
                        Err(error) => WorkspaceDiscoverySettlement::Failed {
                            discovery_id,
                            error,
                        },
                    }
                };
                if let Ok(mut entries) = pending.lock() {
                    entries.remove(&discovery_id);
                }
                settlement
            });

        match spawn {
            Ok(settle) => Ok(WorkspaceDiscoveryAttempt {
                discovery_id,
                settle,
            }),
            Err(error) => {
                if let Ok(mut entries) = self.pending_discoveries.lock() {
                    entries.remove(&discovery_id);
                }
                Err(workspace_io_error("start Workspace discovery", error))
            }
        }
    }

    pub fn cancel_discovery(
        &self,
        discovery_id: WorkspaceDiscoveryId,
    ) -> WorkspaceDiscoveryCancelOutcome {
        let cancellation = self
            .pending_discoveries
            .lock()
            .ok()
            .and_then(|entries| entries.get(&discovery_id).cloned());
        if let Some(cancellation) = cancellation {
            cancellation.store(true, Ordering::Release);
            WorkspaceDiscoveryCancelOutcome {
                discovery_id,
                cancellation_requested: true,
                already_settled: false,
            }
        } else {
            WorkspaceDiscoveryCancelOutcome {
                discovery_id,
                cancellation_requested: false,
                already_settled: true,
            }
        }
    }

    fn authorized_workspace(
        &self,
        canonical_workspace_uri: &str,
    ) -> Result<AuthorizedWorkspace, WorkspaceIoError> {
        if canonical_workspace_uri.trim().is_empty() {
            return Err(WorkspaceIoError::InvalidRequest {
                detail: "canonicalWorkspaceUri must not be empty".to_string(),
            });
        }
        self.registered_workspaces
            .lock()
            .map_err(|_| registry_error("read Workspace authority registry"))?
            .get(canonical_workspace_uri)
            .cloned()
            .ok_or_else(|| WorkspaceIoError::Unauthorized {
                canonical_workspace_uri: canonical_workspace_uri.to_string(),
            })
    }

    #[cfg(test)]
    fn for_test(documents: Arc<DocumentFileService>, limits: DiscoveryLimits) -> Self {
        Self {
            documents,
            registered_workspaces: Mutex::new(HashMap::new()),
            pending_discoveries: Arc::new(Mutex::new(HashMap::new())),
            next_discovery_sequence: AtomicU64::new(1),
            limits,
        }
    }
}

impl Drop for WorkspaceFileService {
    fn drop(&mut self) {
        if let Ok(discoveries) = self.pending_discoveries.lock() {
            for cancellation in discoveries.values() {
                cancellation.store(true, Ordering::Release);
            }
        }
    }
}

#[derive(Debug)]
struct DiscoveredDocument {
    entry: WorkspaceDocumentEntry,
    canonical_path: PathBuf,
    display_path: String,
    observed_size: u64,
    observed_modified_nanos: u128,
}

fn discover_workspace(
    workspace: &AuthorizedWorkspace,
    limits: DiscoveryLimits,
    cancelled: &AtomicBool,
) -> Result<Vec<DiscoveredDocument>, WorkspaceIoError> {
    let observed_root = workspace.canonical_path.canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            WorkspaceIoError::RootInvalidated {
                canonical_workspace_uri: workspace.root.canonical_workspace_uri.clone(),
            }
        } else {
            workspace_io_error("revalidate canonical Workspace root", error)
        }
    })?;
    if observed_root != workspace.canonical_path {
        return Err(WorkspaceIoError::RootInvalidated {
            canonical_workspace_uri: workspace.root.canonical_workspace_uri.clone(),
        });
    }
    let mut documents = Vec::new();
    let mut entry_count = 0usize;
    let mut directories = vec![(workspace.canonical_path.clone(), 0usize)];
    let mut visited_directories = HashSet::from([workspace.canonical_path.clone()]);

    while let Some((directory, depth)) = directories.pop() {
        check_cancelled(cancelled)?;
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| workspace_io_error("enumerate Workspace directory", error))?;
        for entry in entries {
            check_cancelled(cancelled)?;
            entry_count += 1;
            if entry_count > limits.max_entries {
                return Err(limit_error("entries", limits.max_entries));
            }
            let entry = entry
                .map_err(|error| workspace_io_error("read Workspace directory entry", error))?;
            let file_type = entry
                .file_type()
                .map_err(|error| workspace_io_error("read Workspace entry type", error))?;
            if is_directory_link(&entry, &file_type)? {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                if excluded_directory(entry.file_name().as_os_str()) {
                    continue;
                }
                if depth >= limits.max_depth {
                    return Err(limit_error("depth", limits.max_depth));
                }
                let canonical = match path.canonicalize() {
                    Ok(path) => path,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => {
                        return Err(workspace_io_error(
                            "canonicalize Workspace directory",
                            error,
                        ));
                    }
                };
                if !is_contained(&workspace.canonical_path, &canonical)
                    || !visited_directories.insert(canonical.clone())
                {
                    continue;
                }
                directories.push((canonical, depth + 1));
                continue;
            }
            if !file_type.is_file() || !is_shader_graph_path(&path) {
                continue;
            }
            let canonical_path = match path.canonicalize() {
                Ok(path) => path,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(workspace_io_error("canonicalize Workspace document", error));
                }
            };
            if !is_contained(&workspace.canonical_path, &canonical_path) {
                continue;
            }
            let metadata = match canonical_path.metadata() {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(workspace_io_error(
                        "read Workspace document observation",
                        error,
                    ));
                }
            };
            if documents.len() >= limits.max_documents {
                return Err(limit_error("documents", limits.max_documents));
            }
            let relative = canonical_path
                .strip_prefix(&workspace.canonical_path)
                .map_err(|_| WorkspaceIoError::InvalidRequest {
                    detail: "a discovered document escaped its canonical Workspace root"
                        .to_string(),
                })?;
            documents.push(DiscoveredDocument {
                entry: WorkspaceDocumentEntry {
                    relative_path: portable_relative_path(relative),
                    canonical_document_uri: canonical_document_uri(&canonical_path)
                        .map_err(document_authority_error)?,
                },
                display_path: path.to_string_lossy().into_owned(),
                canonical_path,
                observed_size: metadata.len(),
                observed_modified_nanos: modified_nanos(&metadata),
            });
        }
    }

    documents.sort_by(|left, right| {
        left.entry
            .relative_path
            .cmp(&right.entry.relative_path)
            .then_with(|| {
                left.entry
                    .canonical_document_uri
                    .cmp(&right.entry.canonical_document_uri)
            })
    });
    Ok(documents)
}

fn settle_discovery(
    discovery_id: WorkspaceDiscoveryId,
    workspace: &AuthorizedWorkspace,
    observed_token: Option<&str>,
    discovered: Vec<DiscoveredDocument>,
    document_service: &DocumentFileService,
    cancelled: &AtomicBool,
) -> WorkspaceDiscoverySettlement {
    let discovery_revision_token = discovery_revision(&discovered);
    let mut entries = Vec::with_capacity(discovered.len());
    for document in discovered {
        if cancelled.load(Ordering::Acquire) {
            return WorkspaceDiscoverySettlement::Cancelled { discovery_id };
        }
        if let Err(error) = document_service
            .register_discovered_document(document.canonical_path, document.display_path)
        {
            return WorkspaceDiscoverySettlement::Failed {
                discovery_id,
                error: document_authority_error(error),
            };
        }
        entries.push(document.entry);
    }
    if cancelled.load(Ordering::Acquire) {
        return WorkspaceDiscoverySettlement::Cancelled { discovery_id };
    }
    // The caller's token is an observation, never authority. Re-register the
    // complete discovered set before returning `unchanged`, including after a
    // host restart where the caller retained a previous observation token.
    if observed_token == Some(discovery_revision_token.as_str()) {
        return WorkspaceDiscoverySettlement::Unchanged {
            discovery_id,
            canonical_workspace_uri: workspace.root.canonical_workspace_uri.clone(),
            discovery_revision_token,
        };
    }
    WorkspaceDiscoverySettlement::Changed {
        discovery_id,
        snapshot: WorkspaceDiscoverySnapshot {
            root: workspace.root.clone(),
            documents: entries,
            discovery_revision_token,
        },
    }
}

fn discovery_revision(documents: &[DiscoveredDocument]) -> String {
    // Metadata participates only in this refresh hint. Exact byte identity is
    // deliberately read later by DocumentFileService and remains the CAS
    // authority even when filesystem timestamp granularity misses a change.
    let capacity = documents
        .iter()
        .map(|document| {
            document.entry.relative_path.len() + document.entry.canonical_document_uri.len() + 2
        })
        .sum();
    let mut bytes = Vec::with_capacity(capacity);
    for document in documents {
        bytes.extend_from_slice(document.entry.relative_path.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(document.entry.canonical_document_uri.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(document.observed_size.to_string().as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(document.observed_modified_nanos.to_string().as_bytes());
        bytes.push(b'\n');
    }
    hash_bytes(&bytes)
}

fn modified_nanos(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_nanos())
}

fn portable_relative_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn excluded_directory(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name.to_ascii_lowercase().as_str(),
        "build" | "bin" | "obj" | "out" | "target" | "node_modules"
    )
}

fn is_directory_link(
    entry: &std::fs::DirEntry,
    file_type: &std::fs::FileType,
) -> Result<bool, WorkspaceIoError> {
    if file_type.is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        let metadata = std::fs::symlink_metadata(entry.path())
            .map_err(|error| workspace_io_error("inspect Workspace reparse point", error))?;
        return Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0);
    }
    #[cfg(not(windows))]
    {
        let _ = entry;
        Ok(false)
    }
}

fn is_shader_graph_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("shadergraph"))
}

fn is_contained(root: &Path, path: &Path) -> bool {
    path == root || path.strip_prefix(root).is_ok()
}

fn workspace_uri(path: &Path) -> Result<String, WorkspaceIoError> {
    url::Url::from_directory_path(path)
        .map(|value| value.to_string())
        .map_err(|_| WorkspaceIoError::InvalidRequest {
            detail: format!(
                "the host could not represent the canonical Workspace path as a file URI: {}",
                path.display()
            ),
        })
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), WorkspaceIoError> {
    if cancelled.load(Ordering::Acquire) {
        Err(WorkspaceIoError::InvalidRequest {
            detail: "Workspace discovery was cancelled".to_string(),
        })
    } else {
        Ok(())
    }
}

fn limit_error(limit_kind: &str, limit: usize) -> WorkspaceIoError {
    WorkspaceIoError::LimitExceeded {
        limit_kind: limit_kind.to_string(),
        limit,
    }
}

fn workspace_io_error(operation: &str, error: std::io::Error) -> WorkspaceIoError {
    WorkspaceIoError::Io {
        operation: operation.to_string(),
        detail: error.to_string(),
    }
}

fn registry_error(operation: &str) -> WorkspaceIoError {
    WorkspaceIoError::Io {
        operation: operation.to_string(),
        detail: "the registry lock was poisoned".to_string(),
    }
}

fn document_authority_error(error: DocumentIoError) -> WorkspaceIoError {
    WorkspaceIoError::DocumentAuthority { error }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gglab-workspace-io-{name}-{}-{sequence}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn settle(
        service: &WorkspaceFileService,
        root: &WorkspaceRoot,
        observed_token: Option<String>,
    ) -> WorkspaceDiscoverySettlement {
        service
            .discover(&WorkspaceDiscoveryRequest {
                canonical_workspace_uri: root.canonical_workspace_uri.clone(),
                observed_discovery_revision_token: observed_token,
            })
            .unwrap()
            .settle
            .join()
            .unwrap()
    }

    #[test]
    fn discovery_is_recursive_deterministic_and_registers_document_authority() {
        let directory = test_directory("recursive");
        std::fs::create_dir_all(directory.join("Materials/Water")).unwrap();
        std::fs::create_dir_all(directory.join("Build/Generated")).unwrap();
        std::fs::create_dir_all(directory.join(".hidden")).unwrap();
        std::fs::write(directory.join("Z.shadergraph"), b"z").unwrap();
        std::fs::write(directory.join("Materials/A.shadergraph"), b"a").unwrap();
        std::fs::write(directory.join("Materials/Water/B.SHADERGRAPH"), b"b").unwrap();
        std::fs::write(directory.join("Materials/ignore.json"), b"json").unwrap();
        std::fs::write(directory.join("Build/Generated/no.shadergraph"), b"build").unwrap();
        std::fs::write(directory.join(".hidden/no.shadergraph"), b"hidden").unwrap();
        let documents = Arc::new(DocumentFileService::new());
        let service = WorkspaceFileService::new(Arc::clone(&documents));
        let root = service.register_selected_root(directory.clone()).unwrap();
        assert_eq!(
            url::Url::parse(&root.canonical_workspace_uri)
                .unwrap()
                .to_file_path()
                .unwrap()
                .canonicalize()
                .unwrap(),
            directory.canonicalize().unwrap()
        );

        let WorkspaceDiscoverySettlement::Changed { snapshot, .. } = settle(&service, &root, None)
        else {
            panic!("initial discovery should return a complete snapshot");
        };

        assert_eq!(
            snapshot
                .documents
                .iter()
                .map(|document| document.relative_path.as_str())
                .collect::<Vec<_>>(),
            [
                "Materials/A.shadergraph",
                "Materials/Water/B.SHADERGRAPH",
                "Z.shadergraph"
            ]
        );
        let opened = documents
            .read_snapshot(&snapshot.documents[0].canonical_document_uri)
            .unwrap();
        assert_eq!(opened.text, "a");
        assert_eq!(snapshot.discovery_revision_token.len(), 64);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_equal_discovery_revision_is_an_unchanged_refresh_hint() {
        let directory = test_directory("unchanged");
        std::fs::write(directory.join("A.shadergraph"), b"a").unwrap();
        let service = WorkspaceFileService::new(Arc::new(DocumentFileService::new()));
        let root = service.register_selected_root(directory.clone()).unwrap();
        let WorkspaceDiscoverySettlement::Changed { snapshot, .. } = settle(&service, &root, None)
        else {
            panic!("initial discovery should change");
        };

        let outcome = settle(
            &service,
            &root,
            Some(snapshot.discovery_revision_token.clone()),
        );

        assert!(matches!(
            outcome,
            WorkspaceDiscoverySettlement::Unchanged {
                discovery_revision_token,
                ..
            } if discovery_revision_token == snapshot.discovery_revision_token
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_retained_observation_token_never_substitutes_for_host_authority() {
        let directory = test_directory("retained-observation");
        std::fs::write(directory.join("A.shadergraph"), b"a").unwrap();
        let first_documents = Arc::new(DocumentFileService::new());
        let first_service = WorkspaceFileService::new(first_documents);
        let first_root = first_service
            .register_selected_root(directory.clone())
            .unwrap();
        let WorkspaceDiscoverySettlement::Changed { snapshot, .. } =
            settle(&first_service, &first_root, None)
        else {
            panic!("initial discovery should change");
        };

        let restarted_documents = Arc::new(DocumentFileService::new());
        let restarted_service = WorkspaceFileService::new(Arc::clone(&restarted_documents));
        let restarted_root = restarted_service
            .register_selected_root(directory.clone())
            .unwrap();
        let outcome = settle(
            &restarted_service,
            &restarted_root,
            Some(snapshot.discovery_revision_token.clone()),
        );

        assert!(matches!(
            outcome,
            WorkspaceDiscoverySettlement::Unchanged { .. }
        ));
        assert_eq!(
            restarted_documents
                .read_snapshot(&snapshot.documents[0].canonical_document_uri)
                .unwrap()
                .text,
            "a"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn adding_a_document_changes_the_observation_token() {
        let directory = test_directory("changed");
        std::fs::write(directory.join("A.shadergraph"), b"a").unwrap();
        let service = WorkspaceFileService::new(Arc::new(DocumentFileService::new()));
        let root = service.register_selected_root(directory.clone()).unwrap();
        let WorkspaceDiscoverySettlement::Changed { snapshot, .. } = settle(&service, &root, None)
        else {
            panic!("initial discovery should change");
        };
        std::fs::write(directory.join("B.shadergraph"), b"b").unwrap();

        let WorkspaceDiscoverySettlement::Changed {
            snapshot: newer, ..
        } = settle(
            &service,
            &root,
            Some(snapshot.discovery_revision_token.clone()),
        )
        else {
            panic!("a new document must change discovery");
        };

        assert_ne!(
            newer.discovery_revision_token,
            snapshot.discovery_revision_token
        );
        assert_eq!(newer.documents.len(), 2);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn changing_document_bytes_changes_the_refresh_observation() {
        let directory = test_directory("content-changed");
        let path = directory.join("A.shadergraph");
        std::fs::write(&path, b"a").unwrap();
        let service = WorkspaceFileService::new(Arc::new(DocumentFileService::new()));
        let root = service.register_selected_root(directory.clone()).unwrap();
        let WorkspaceDiscoverySettlement::Changed { snapshot, .. } = settle(&service, &root, None)
        else {
            panic!("initial discovery should change");
        };
        std::fs::write(&path, b"changed bytes").unwrap();

        let outcome = settle(&service, &root, Some(snapshot.discovery_revision_token));

        assert!(matches!(
            outcome,
            WorkspaceDiscoverySettlement::Changed { .. }
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn an_unregistered_root_uri_cannot_be_used_as_a_path() {
        let service = WorkspaceFileService::new(Arc::new(DocumentFileService::new()));
        let error = service
            .discover(&WorkspaceDiscoveryRequest {
                canonical_workspace_uri: "file:///D:/not-authorized".to_string(),
                observed_discovery_revision_token: None,
            })
            .unwrap_err();
        assert!(matches!(error, WorkspaceIoError::Unauthorized { .. }));
    }

    #[test]
    fn a_missing_registered_root_is_invalidated_before_traversal() {
        let directory = test_directory("invalidated-root");
        let service = WorkspaceFileService::new(Arc::new(DocumentFileService::new()));
        let root = service.register_selected_root(directory.clone()).unwrap();
        std::fs::remove_dir(&directory).unwrap();

        let outcome = settle(&service, &root, None);

        assert!(matches!(
            outcome,
            WorkspaceDiscoverySettlement::Failed {
                error: WorkspaceIoError::RootInvalidated { .. },
                ..
            }
        ));
    }

    #[test]
    fn discovery_limits_fail_instead_of_returning_a_partial_tree() {
        let directory = test_directory("limit");
        std::fs::write(directory.join("A.shadergraph"), b"a").unwrap();
        std::fs::write(directory.join("B.shadergraph"), b"b").unwrap();
        let service = WorkspaceFileService::for_test(
            Arc::new(DocumentFileService::new()),
            DiscoveryLimits {
                max_depth: 2,
                max_entries: 1,
                max_documents: 10,
            },
        );
        let root = service.register_selected_root(directory.clone()).unwrap();

        let outcome = settle(&service, &root, None);

        assert!(matches!(
            outcome,
            WorkspaceDiscoverySettlement::Failed {
                error: WorkspaceIoError::LimitExceeded { .. },
                ..
            }
        ));
        let _ = std::fs::remove_dir_all(directory);
    }

    #[test]
    fn a_cancelled_scan_never_returns_a_partial_snapshot() {
        let directory = test_directory("cancelled");
        std::fs::write(directory.join("A.shadergraph"), b"a").unwrap();
        let workspace_path = directory.canonicalize().unwrap();
        let workspace = AuthorizedWorkspace {
            root: WorkspaceRoot {
                canonical_workspace_uri: workspace_uri(&workspace_path).unwrap(),
                display_path: directory.to_string_lossy().into_owned(),
            },
            canonical_path: workspace_path,
        };
        let cancelled = AtomicBool::new(true);

        let error =
            discover_workspace(&workspace, DiscoveryLimits::default(), &cancelled).unwrap_err();

        assert!(matches!(error, WorkspaceIoError::InvalidRequest { .. }));
        let _ = std::fs::remove_dir_all(directory);
    }
}
