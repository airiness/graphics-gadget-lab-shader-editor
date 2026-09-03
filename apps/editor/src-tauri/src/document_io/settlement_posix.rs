//! POSIX save settlement for document IO: the name-seize path
//! (`commit_replacement` → `commit_bytes_onto_name`) and the rollback-move
//! helpers. POSIX open has no share modes, so writer exclusion cannot be
//! acquired; the guarantee is built on atomic NAME semantics.
//! `commit_bytes_onto_name` and the rollback helpers also compile under
//! `test` on Windows, where the settlement tests exercise them directly.

#[cfg(any(not(windows), test))]
use super::{
    read_bounded_bytes, AuthorizedDocument, CommitSettlement, DocumentFileService,
    DocumentIoError, io_error,
};
#[cfg(any(not(windows), test))]
use crate::shader_tool::identity::hash_bytes;
#[cfg(any(not(windows), test))]
use std::path::Path;
#[cfg(any(not(windows), test))]
use std::sync::atomic::Ordering;

#[cfg(not(windows))]
impl DocumentFileService {
    /// Commit the durable temporary bytes onto the authorized target.
    ///
    /// Windows path (preferred, see `settle_guarded_save`): a guard handle
    /// whose share mask omits FILE_SHARE_WRITE gives OS-enforced writer
    /// exclusion for the whole validate → replace interval — the save cannot
    /// race a writer at all (a strict compare-and-swap).
    ///
    /// Non-Windows path (this function): POSIX open has no share modes, so
    /// exclusion cannot be acquired; the guarantee is built on NAME
    /// semantics instead, which are hard on both platforms:
    ///
    /// 1. seize: atomically rename the target into our private aside slot;
    /// 2. revalidate: the seized inode can still receive a write through a
    ///    handle the external writer opened before the seize, so its bytes
    ///    are re-read and re-hashed — a dirty seize is rolled back onto the
    ///    vacant name;
    /// 3. commit: hard-link the temporary bytes onto the name while it is
    ///    still vacant; a hard link over an occupied name fails — that
    ///    failure IS the detection of a foreign file;
    /// 4. revalidate again right before cleanup.
    ///
    /// Every interleaving ends as conflict (the external bytes win the
    /// name), a hard failure of the external writer's open, or a clean
    /// save. The one residual in THIS design is a writer write that lands
    /// between the step-4 verification and the cleanup — an interval of a
    /// few instructions, confined to a writer whose handle predates the
    /// save. The Windows guard path closes even that interval.
    pub(super) fn commit_replacement(
        &self,
        document: &AuthorizedDocument,
        temp_path: &Path,
        expected: &str,
    ) -> Result<CommitSettlement, DocumentIoError> {
        let aside_path = self.save_aside_path(document)?;

        // Seize the target's name. The seized file is the one the last
        // checks saw: any writer handle into it now points at the same
        // bytes under this private name.
        if let Err(_error) = std::fs::rename(&document.canonical_path, &aside_path) {
            // The file is gone (or otherwise unseizable): the expected
            // revision can no longer be established under any commit.
            return Ok(CommitSettlement::Conflict {
                observed_file_revision_token: None,
            });
        }

        self.commit_bytes_onto_name(document, temp_path, &aside_path, expected)
    }
}

#[cfg(any(not(windows), test))]
impl DocumentFileService {
    /// Settle a commit whose target name is already seized into `aside_path`.
    ///
    /// POSIX settlement and the settlement tests (the guarded Windows
    /// settlement settles without a prior seize). Hard name facts, plus two
    /// revalidations against the seized bytes:
    /// - a hard link onto an OCCUPIED name fails on both platforms — that
    ///   is the detection of a foreign file that re-created the name;
    /// - a hard link onto the VACANT name is atomic and succeeds — the
    ///   commit;
    /// - the seized inode can still receive a late write through a handle
    ///   opened before the seize, so its bytes are re-read and re-hashed
    ///   BOTH before the commit (a dirty seize is rolled back onto a
    ///   VACANT name — a move the OS always allows) and right before the
    ///   cleanup (a late write in the sliver between the checks is rolled
    ///   back onto the committed name).
    ///
    /// The only write a writer can still win is one that lands between the
    /// second verification and the cleanup: strictly narrower than the
    /// check → replace window this design replaces, and confined to a
    /// writer whose write handle predates the seize.
    pub(super) fn commit_bytes_onto_name(
        &self,
        document: &AuthorizedDocument,
        temp_path: &Path,
        aside_path: &Path,
        expected: &str,
    ) -> Result<CommitSettlement, DocumentIoError> {
        // First revalidation, before the commit: a seize that moved (or
        // cannot be verified) is rolled back so the external state wins.
        // The rollback must only MOVE — and a move is safe (and allowed
        // over an open source) only onto a name that no foreign file
        // occupies, so the name's occupancy is part of the decision:
        let side = read_bounded_bytes(aside_path);
        let dirty = match &side {
            Ok(bytes) => hash_bytes(bytes) != expected,
            Err(_error) => true, // unreadable ⇒ unverifiable ⇒ external wins
        };
        if dirty {
            let observed = match side {
                Ok(bytes) => Some(hash_bytes(&bytes)),
                Err(_error) => None,
            };
            let vacant = std::fs::metadata(&document.canonical_path)
                .err()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound);
            if vacant {
                atomic_move_replace_retry(aside_path, &document.canonical_path)?;
            } else {
                // A foreign file recreated the name while it was vacant.
                // It holds the name — possibly the only live handle to its
                // bytes — so it is never clobbered. The seized copy is
                // preserved under a visible name (or, if that rename is
                // refused, left for interrupted-save recovery to name).
                let file_name = document
                    .canonical_path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("document");
                let keep = document.canonical_path.parent().map(|parent| {
                    parent.join(format!(
                        "{file_name}.gglab-save-aside-keep-{}",
                        self.next_temp_sequence.fetch_add(1, Ordering::Relaxed)
                    ))
                });
                if let Some(keep) = keep {
                    let _ = std::fs::rename(aside_path, &keep);
                }
                // The conflict must name the state that HOLDS the name (the
                // one a reload or deliberate overwrite would act on).
                let name_observed = read_bounded_bytes(&document.canonical_path)
                    .ok()
                    .map(|bytes| hash_bytes(&bytes));
                return Ok(CommitSettlement::Conflict {
                    observed_file_revision_token: name_observed,
                });
            }
            return Ok(CommitSettlement::Conflict {
                observed_file_revision_token: observed,
            });
        }

        // Commit our bytes onto the name only if it is still vacant.
        let commit = std::fs::hard_link(temp_path, &document.canonical_path);
        if let Err(error) = commit {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                // A foreign file recreated the name while it was vacant.
                // Its bytes stay on disk; report their revision.
                let observed = read_bounded_bytes(&document.canonical_path)
                    .ok()
                    .map(|bytes| hash_bytes(&bytes));
                return Ok(CommitSettlement::Conflict {
                    observed_file_revision_token: observed,
                });
            }
            // Some other commit failure: give the name back before
            // reporting — the document must never end up nameless.
            let _ = std::fs::rename(aside_path, &document.canonical_path);
            return Err(io_error("commit document save", error));
        }

        // The commit instant, taken AT the link: writes into the committed
        // file are legitimate post-commit writes; the race regressions
        // order their observations against it.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos() as u64);
        self.last_commit_unix_nanos
            .store(now, Ordering::Release);

        // Second revalidation, right before cleanup: a writer whose handle
        // predates the seize can still land bytes into the seized inode in
        // the sliver after the first check; catching it rolls the commit
        // back onto the committed name (the external state wins again).
        {
            let side = read_bounded_bytes(aside_path);
            if let Ok(bytes) = side {
                if hash_bytes(&bytes) != expected {
                    atomic_move_replace_retry(aside_path, &document.canonical_path)?;
                    return Ok(CommitSettlement::Conflict {
                        observed_file_revision_token: Some(hash_bytes(&bytes)),
                    });
                }
            } else {
                atomic_move_replace_retry(aside_path, &document.canonical_path)?;
                return Ok(CommitSettlement::Conflict {
                    observed_file_revision_token: None,
                });
            }
        }

        // Settled: the committed bytes now live under both the target name
        // and the temporary name — keep only the target.
        std::fs::remove_file(temp_path)
            .map_err(|error| io_error("remove temporary document name", error))?;
        std::fs::remove_file(aside_path)
            .map_err(|error| io_error("remove seized document", error))?;
        Ok(CommitSettlement::Committed)
    }
}

/// Move `source` onto `target`, replacing whatever occupies the name.
///
/// This is a NAME operation (rename), not a data swap: it must succeed even
/// while another process holds handles to either file — rollback restores
/// rely on that, and a data-swap call (such as `ReplaceFileW`) refuses to
/// run while such handles exist. Used by the POSIX settlement and the
/// settlement tests; the guarded Windows settlement moves onto vacant names
/// instead and does not need it in production.
#[cfg(all(windows, test))]
fn atomic_move_replace(source: &Path, target: &Path) -> Result<(), DocumentIoError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(io_error(
            "restore seized document",
            std::io::Error::last_os_error(),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_move_replace(source: &Path, target: &Path) -> Result<(), DocumentIoError> {
    std::fs::rename(source, target)
        .map_err(|error| io_error("restore seized document", error))
}

/// Rollback move with a bounded retry.
///
/// A rollback onto an OCCUPIED name (the post-commit arms) can still be
/// refused by the OS when a live writer holds that name open for write —
/// there is no replacement primitive that moves over an open destination.
/// Such handles are transient: the writer drops them between cycles — so
/// retry briefly before escalating to an explicit failure (which leaves both
/// states on disk; nothing is lost).
#[cfg(any(not(windows), test))]
fn atomic_move_replace_retry(
    source: &Path,
    target: &Path,
) -> Result<(), DocumentIoError> {
    const ATTEMPTS: u32 = 50;
    let mut last_error = None;
    for _ in 0..ATTEMPTS {
        match atomic_move_replace(source, target) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    Err(last_error.expect("at least one attempt ran"))
}
