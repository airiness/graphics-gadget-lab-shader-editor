//! Windows save settlement for document IO: the OS-enforced writer-exclusion
//! guard (`SaveWriteGuard`) and the guard-based settlement
//! (`settle_guarded_save`) that closes the check → replace window completely.
//! The sharing facts this path rests on are pinned by the guard-contract
//! tests in `super::tests`, not assumed.

#[cfg(windows)]
use super::{
    read_bounded_bytes, AuthorizedDocument, CommitSettlement, DocumentFileService,
    DocumentIoError, io_error, io_error_detail, MAX_DOCUMENT_BYTES,
};
#[cfg(windows)]
use crate::shader_tool::identity::hash_bytes;
#[cfg(windows)]
use std::fs::File;
#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::sync::atomic::Ordering;

/// A Windows writer-exclusion guard over an existing file.
///
/// Acquire it by opening the file for READ access (the save reads through
/// the guard and never writes through it) with a share mask that OMITS
/// FILE_SHARE_WRITE. Windows' two-way, OS-enforced sharing rules then give
/// both directions of exclusion for the guard's whole lifetime:
/// - it is REFUSED while any writable handle exists (that handle's write
///   access is not covered by the guard's write-unsharing mask);
/// - while HELD, it refuses every later writable open (a later writer's
///   write access is not covered by the guard's write-unsharing mask).
///
/// That pins the contract: a guard can be held and a writer present at the
/// same time never happens. The save validates the expected revision
/// through this guard's own read (the exact committed inode, immune to
/// re-naming) and performs the name commitment while this exclusion holds,
/// so no external write can interleave between check and replace. Dropping
/// the guard releases it; the save remains the only writer the name sees.
///
/// REQUESTING READ (NOT WRITE) ACCESS IS LOAD-BEARING, NOT AN OPTIMIZATION:
/// the writer exclusion is created entirely by the share mask omitting
/// FILE_SHARE_WRITE, so the guard's desired access is free to be the minimal
/// READ. Requesting WRITE would add no exclusion and would sparsely conflict
/// an unrelated read-only handle that does not share WRITE — see
/// `the_read_only_guard_provides_the_same_writer_exclusion` (facts 6a/6b).
///
/// The sharing facts this restates are pinned by the guard-contract tests;
/// this is not assumed, it is measured.
#[cfg(windows)]
struct SaveWriteGuard {
    file: File,
}

#[cfg(windows)]
impl SaveWriteGuard {
    fn try_acquire(path: &Path) -> std::io::Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_SHARE_DELETE, FILE_SHARE_READ,
        };
        // READ access only (the save reads through the guard, never writes).
        // Writer exclusion comes ENTIRELY from the share mask omitting
        // FILE_SHARE_WRITE — the desired access is deliberately the minimal
        // READ so no unrelated read-only, write-unsharing handle is sparsely
        // conflicted. Pinned by the guard-contract tests, not assumed.
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .open(path)
            .map(|file| Self { file })
    }

    /// Read the whole file THROUGH THE GUARD HANDLE: this is the exact
    /// inode the save validates and commits to, immune to any re-naming of
    /// the name, and no writer can modify it (that is the point).
    fn read_all(&self) -> std::io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        self.file
            .try_clone()
            .map_err(|error| io_error_detail(error, "read guarded document"))?
            .take(MAX_DOCUMENT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| io_error_detail(error, "read guarded document"))?;
        if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("the document exceeds the {MAX_DOCUMENT_BYTES}-byte limit"),
            ));
        }
        Ok(bytes)
    }
}

#[cfg(windows)]
impl DocumentFileService {
    /// Windows save settlement with a hard writer-exclusion guard.
    ///
    /// The guard is the target itself, opened for READ access with a share
    /// mask that omits FILE_SHARE_WRITE. The sharing rules are two-way and
    /// OS-enforced (pinned by the contract tests in `super::tests`):
    /// - acquisition is denied while ANY writable handle exists (that
    ///   handle's write access is not covered by the guard's write-unsharing
    ///   mask);
    /// - while the guard is held, every later writable open is denied (the
    ///   later writer's write access is not covered by the guard's
    ///   write-unsharing mask).
    ///
    /// So for the whole validate → replace interval NO process other than
    /// us can write the file, and no new writer can appear: the
    /// check-then-replace window closes completely, and the only external
    /// outcomes left are "writer present → conflict" (their bytes keep the
    /// name, untouched) or "writer after release → legitimate last writer".
    pub(super) fn settle_guarded_save(
        &self,
        document: &AuthorizedDocument,
        temp_path: &Path,
        expected: &str,
    ) -> Result<CommitSettlement, DocumentIoError> {
        // 1. Acquire the writer exclusion. A live writer (or a file we
        //    cannot open at all) owns the outcome: conflict, never commit.
        let guard = match SaveWriteGuard::try_acquire(&document.canonical_path) {
            Ok(guard) => guard,
            Err(error) => {
                let observed = match error.kind() {
                    std::io::ErrorKind::NotFound => None,
                    _ => read_bounded_bytes(&document.canonical_path)
                        .ok()
                        .map(|bytes| hash_bytes(&bytes)),
                };
                return Ok(CommitSettlement::Conflict {
                    observed_file_revision_token: observed,
                });
            }
        };

        // 2. Verify the expected revision THROUGH THE GUARD HANDLE: this
        //    reads the exact inode the save committed to, immune to any
        //    re-naming of the name, and no writer can modify it now.
        let bytes =
            guard
                .read_all()
                .map_err(|error| io_error("read guarded document", error))?;
        if hash_bytes(&bytes) != expected {
            let observed = hash_bytes(&bytes);
            return Ok(CommitSettlement::Conflict {
                observed_file_revision_token: Some(observed),
            });
        }

        // 3. Move the guarded inode onto the private aside name (allowed:
        //    the guard shares DELETE, and the destination is vacant), then
        //    commit the temporary bytes onto the still-vacant name.
        let aside_path = self.save_aside_path(document)?;
        match std::fs::rename(&document.canonical_path, &aside_path) {
            Err(error) => {
                // The name is gone or was re-created by a foreign file:
                // either way the expected revision no longer holds the name.
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    let observed = read_bounded_bytes(&document.canonical_path)
                        .ok()
                        .map(|bytes| hash_bytes(&bytes));
                    // The foreign file owns the name; its bytes are
                    // reported, and nothing of ours touches them.
                    return Ok(CommitSettlement::Conflict {
                        observed_file_revision_token: observed,
                    });
                }
                Err(io_error("seize guarded document", error))
            }
            Ok(()) => match std::fs::hard_link(temp_path, &document.canonical_path) {
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    // A foreign file re-created the name in the sliver:
                    // its bytes stay on disk; the seized copy is named for
                    // recovery.
                    let observed = read_bounded_bytes(&document.canonical_path)
                        .ok()
                        .map(|b| hash_bytes(&b));
                    self.preserve_seized_aside(document, &aside_path);
                    Ok(CommitSettlement::Conflict {
                        observed_file_revision_token: observed,
                    })
                }
                Err(error) => {
                    // Give the name back before reporting: the document
                    // must never end up nameless.
                    let _ = std::fs::rename(&aside_path, &document.canonical_path);
                    Err(io_error("commit guarded document save", error))
                }
                Ok(()) => {
                    // The commit instant, taken AT the link.
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |elapsed| elapsed.as_nanos() as u64);
                    self.last_commit_unix_nanos
                        .store(now, Ordering::Release);
                    // Settled: keep only the target name. The guard's
                    // inode is now the deleted aside; closing it (drop)
                    // is the release — it can no longer interleave with
                    // anything because it has no name and no writer.
                    std::fs::remove_file(temp_path).map_err(|error| {
                        io_error("remove temporary document name", error)
                    })?;
                    std::fs::remove_file(&aside_path).map_err(|error| {
                        io_error("remove seized document", error)
                    })?;
                    Ok(CommitSettlement::Committed)
                }
            },
        }
    }

    /// Preserve a seized copy whose commit was refused, under a visible
    /// name the interrupted-save recovery recognizes.
    fn preserve_seized_aside(
        &self,
        document: &AuthorizedDocument,
        aside_path: &Path,
    ) {
        let file_name = document
            .canonical_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("document");
        let parent = document.canonical_path.parent();
        if let Some(parent) = parent {
            let keep = parent.join(format!(
                "{file_name}.gglab-save-aside-keep-{}",
                self.next_temp_sequence.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::rename(aside_path, &keep);
        }
    }
}
