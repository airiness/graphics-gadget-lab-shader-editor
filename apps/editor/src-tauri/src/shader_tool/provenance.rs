//! The pre-spawn provenance guard (design §9 "execution" + TOCTOU clause).
//!
//! The contract: a spawn happens ONLY after the host confirms the
//! candidate's path still observes the candidate's identity — otherwise
//! the call is a structured `candidate-invalidated` refusal, NOT a spawn
//! of an unverified executable.
//!
//! The guard, not timing, closes the check-to-launch window: the check
//! opens the file with a share mode that BLOCKS write, delete, rename, and
//! replace, observes the identity on that handle, and the handle is held
//! until process creation settles. On Windows that means opening read-only
//! with `FILE_SHARE_READ` as the sole sharing bit — a concurrent writer,
//! deleter, or renamer gets a sharing violation for as long as the guard
//! lives. "Look at the metadata, then CreateProcess(a path)" is NOT
//! continuity and is NOT what this does.
//!
//! The guard deliberately uses only kernel32 FFI (two handles and two
//! reads of Win32 facts) so the crate carries no platform SDK dependency.

use super::identity::hash_bytes;

/// The guard's classifications — the host's own structured vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardRefusal {
    /// No file at the path anymore.
    Missing,
    /// A file that cannot be opened for an observation.
    Unreadable,
    /// The path holds a DIFFERENT file; the identity it observes now
    /// (reported by the refusal, for the client's re-discovery).
    Changed { current_identity: String },
    /// This host cannot run the guard (not the toolchain's platform).
    /// The service reports this as a `launch-failed` fact — never a spawn
    /// without a check. Constructed only outside the toolchain's host.
    #[allow(dead_code)]
    Unsupported,
}

/// A live provenance guard: it OWNS the blocking file handle. Dropping it
/// releases the block — which is exactly when the service is done (after
/// process creation settled). Holding it costs one OS handle.
#[must_use = "the guard blocks replacement of the candidate — drop it on purpose"]
#[derive(Debug)]
pub struct ProvenanceGuard {
    handle: isize,
}

impl Drop for ProvenanceGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            let _ = win32::CloseHandle(self.handle);
        }
    }
}

/// Verify the candidate's path still observes `expected_identity` and
/// return the guard that holds the path fixed until the spawn settles.
/// Refusals are the structured observations themselves (never an error
/// string, never an OS code leaking across the boundary).
pub fn verify_and_hold(
    path: &str,
    expected_identity: &str,
) -> Result<ProvenanceGuard, GuardRefusal> {
    let (guard, observed) = observe_and_hold(path)?;
    if observed != expected_identity {
        return Err(GuardRefusal::Changed {
            current_identity: observed,
        });
    }
    Ok(guard)
}

/// Observe a host-owned executable and hold its exact file fixed until the
/// caller completes process creation. This is used for the sibling WinApp:
/// unlike a discovered tool candidate it has no caller-supplied expected
/// digest, so the host reports the digest it observed under the same live
/// guard instead of performing a look-then-launch sequence.
pub fn observe_and_hold(path: &str) -> Result<(ProvenanceGuard, String), GuardRefusal> {
    #[cfg(windows)]
    {
        let mut wide: Vec<u16> = path.encode_utf16().collect();
        wide.push(0);
        let handle = unsafe {
            win32::CreateFileW(
                wide.as_ptr(),
                win32::GENERIC_READ,
                // FILE_SHARE_READ as the SOLE sharing bit: a concurrent
                // write, delete, rename, or replace all fail with a
                // sharing violation while this handle lives — that IS the
                // continuity. (Readers may still read; reading changes
                // nothing.)
                win32::FILE_SHARE_READ,
                std::ptr::null_mut(),
                win32::OPEN_EXISTING,
                win32::FILE_ATTRIBUTE_NORMAL,
                0,
            )
        };
        if handle == win32::INVALID_HANDLE_VALUE {
            let code = unsafe { win32::GetLastError() };
            return Err(if code == win32::ERROR_FILE_NOT_FOUND {
                GuardRefusal::Missing
            } else {
                GuardRefusal::Unreadable
            });
        }
        let observed = match read_handle_to_identity(handle) {
            Ok(identity) => identity,
            Err(err) => {
                unsafe {
                    let _ = win32::CloseHandle(handle);
                }
                return Err(err);
            }
        };
        Ok((ProvenanceGuard { handle }, observed))
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(GuardRefusal::Unsupported)
    }
}

/// Read the bytes through the already-open handle and identity them.
#[cfg(windows)]
fn read_handle_to_identity(handle: isize) -> Result<String, GuardRefusal> {
    let mut out: Vec<u8> = Vec::new();
    loop {
        let mut chunk = [0u8; 64 * 1024];
        let mut read_bytes: u32 = 0;
        let ok = unsafe {
            win32::ReadFile(
                handle,
                chunk.as_mut_ptr(),
                chunk.len() as u32,
                &mut read_bytes,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            let code = unsafe { win32::GetLastError() };
            if code == win32::ERROR_END_OF_FILE {
                break;
            }
            return Err(GuardRefusal::Unreadable);
        }
        if read_bytes == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..read_bytes as usize]);
    }
    Ok(hash_bytes(&out))
}

#[cfg(windows)]
mod win32 {
    pub const GENERIC_READ: u32 = 0x8000_0000;
    pub const FILE_SHARE_READ: u32 = 0x1;
    pub const OPEN_EXISTING: u32 = 3;
    pub const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    pub const INVALID_HANDLE_VALUE: isize = -1;
    pub const ERROR_FILE_NOT_FOUND: u32 = 2;
    pub const ERROR_END_OF_FILE: u32 = 31;

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateFileW(
            lpfilename: *const u16,
            dwdesiredaccess: u32,
            dwsharemode: u32,
            lpsecurityattributes: *mut std::ffi::c_void,
            dwcreationdisposition: u32,
            dwflagsandattributes: u32,
            htemplatefile: isize,
        ) -> isize;
        pub fn ReadFile(
            hfile: isize,
            lpbuffer: *mut u8,
            nnumberofbytestoread: u32,
            lpnumberofbytesread: *mut u32,
            lpoverlapped: *mut std::ffi::c_void,
        ) -> i32;
        pub fn CloseHandle(hObject: isize) -> i32;
        pub fn GetLastError() -> u32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(windows)]
    #[test]
    fn the_guard_classifies_matching_changed_and_missing() {
        let dir = std::env::temp_dir().join("gglab-provenance-test");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("tool.exe");
        fs::write(&path, b"first").unwrap();
        let first = super::super::identity::hash_file(&path).unwrap();
        let second_bytes = b"second-content";

        // Matching observation: the guard hands back the live handle.
        let guard = verify_and_hold(path.to_str().unwrap(), &first).unwrap();
        drop(guard);

        // Changed observation: different content, current identity reported.
        fs::write(&path, second_bytes).unwrap();
        let second = super::super::identity::hash_file(&path).unwrap();
        match verify_and_hold(path.to_str().unwrap(), &first) {
            Err(GuardRefusal::Changed { current_identity }) => {
                assert_eq!(current_identity, second);
            }
            other => panic!("expected changed, got {other:?}"),
        }

        // Missing observation.
        fs::remove_file(&path).unwrap();
        match verify_and_hold(path.to_str().unwrap(), &first) {
            Err(GuardRefusal::Missing) => {}
            other => panic!("expected missing, got {other:?}"),
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
