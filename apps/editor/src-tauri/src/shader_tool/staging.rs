//! Private root layout (design §9 "roots", §10 staging) — all of it the
//! service's own host data location: the WebView has no path into it, no
//! read, no write, no list.
//!
//! ```text
//! <private>/
//!   staging/<sequence>/<sourceIdentity>.hlsl   per-ATTEMPT source area
//!   cache/                                      the tool's shared cache root
//!   artifacts/<sequence>/                       per-attempt publication area
//! ```
//!
//! Per-attempt isolation is the property: two attempts — even identical
//! bytes under a different target, or a double build click — NEVER share an
//! area, so one attempt's cleanup can never remove another attempt's
//! input. The staging NAME (`<sourceIdentity>.hlsl` under `<sequence>`) is
//! the inspector's evidence — a name, not a usable path: the service owns
//! both halves, and the WebView holds neither.

use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct ToolchainRoots {
    private: PathBuf,
}

impl ToolchainRoots {
    /// The production location: the service's own host data directory.
    pub fn from_host_environment() -> Self {
        let base = host_data_directory();
        let private = base
            .join("io.gglab")
            .join("shadergraph")
            .join("toolchain-service");
        Self { private }
    }

    /// A private area under a caller-chosen root — the test seam; same
    /// layout, no host-environment assumptions.
    pub fn under(root: PathBuf) -> Self {
        Self { private: root.join("toolchain-service") }
    }

    /// The full private area; every service-owned location derives from it.
    pub fn private(&self) -> &Path {
        &self.private
    }

    /// The per-attempt staging area (`<private>/staging/<sequence>/`).
    pub fn attempt_staging(&self, sequence: u64) -> PathBuf {
        self.private.join("staging").join(sequence.to_string())
    }

    /// The tool's shared cache root — shared BY DESIGN (the tool's own
    /// cache), service-owned (its private area).
    pub fn cache_root(&self) -> PathBuf {
        self.private.join("cache")
    }

    /// The per-attempt artifact publication area.
    pub fn attempt_artifacts(&self, sequence: u64) -> PathBuf {
        self.private.join("artifacts").join(sequence.to_string())
    }

    /// Stage the delivered emission for one attempt and return the staged
    /// file. The file name is the durable source identity — the service's
    /// staging NAME for the inspector.
    pub fn write_attempt_source(
        &self,
        sequence: u64,
        source_identity: &str,
        source: &[u8],
    ) -> std::io::Result<PathBuf> {
        let dir = self.attempt_staging(sequence);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{source_identity}.hlsl"));
        std::fs::write(&path, source)?;
        Ok(path)
    }

    /// Clean one attempt's staging area (the source). The artifact area is
    /// DELIBERATELY kept — it is the attempt's evidence — and the shared
    /// cache root is the tool's own to manage.
    pub fn clean_attempt_staging(&self, sequence: u64) {
        let _ = std::fs::remove_dir_all(self.attempt_staging(sequence));
    }
}

/// The host data directory — the service's "its host data location":
/// `%LOCALAPPDATA%` on Windows, `$XDG_DATA_HOME` / `~/.local/share`
/// elsewhere. A failure to resolve is a Host refusal upstream, not a panic.
fn host_data_directory() -> PathBuf {
    #[cfg(windows)]
    if let Some(appdata) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(appdata);
    }
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(data_home);
    }
    PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| std::ffi::OsString::from(".")))
        .join(".local")
        .join("share")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_attempt_areas_are_isolated_and_cleanable() {
        let dir = std::env::temp_dir().join("gglab-staging-test");
        let _ = std::fs::remove_dir_all(&dir);
        let roots = ToolchainRoots::under(dir.clone());
        let a = roots.write_attempt_source(1, "aa", b"one").unwrap();
        let b = roots.write_attempt_source(2, "aa", b"two").unwrap();
        // Same bytes under a different attempt: distinct areas.
        assert_ne!(a.parent().unwrap(), b.parent().unwrap());
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(std::fs::read(&b).unwrap(), b"two");
        roots.clean_attempt_staging(1);
        assert!(!a.exists());
        assert!(b.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
