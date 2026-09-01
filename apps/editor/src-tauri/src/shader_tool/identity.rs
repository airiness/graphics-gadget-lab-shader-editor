//! Observation identity — the host's opaque token for "the file at this
//! path, right now".
//!
//! The client contract (`ToolCandidate::observationIdentity`) leaves the
//! token's MEANING to the host; this implementation chooses a SHA-256
//! CONTENT hash (64 lowercase hex): replacing the binary under the path
//! changes the identity (a `changed` observation), re-reading the same
//! unmodified file reproduces it (a re-observation of the same candidate),
//! and it needs no trust in a single size/mtime fact. What the token means
//! stays host-internal; the client holds it as an opaque string.

use sha2::{Digest, Sha256};

/// The SHA-256 of the given bytes, lowercase hex — the content-identity
/// form the core's durable source identity uses on the other side of the
/// boundary (the two are distinct identities; they merely share a form).
pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Read a file whole and return its observation identity. A failure to
/// open or read is reported by the caller as an `unreadable` observation —
/// the identity is not the point of failure, the observation is.
pub fn hash_file(path: &std::path::Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut out = Vec::new();
    file.read_to_end(&mut out)?;
    Ok(hash_bytes(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_a_stable_lowercase_hex_digest() {
        let a = hash_bytes(b"abc");
        let b = hash_bytes(b"abc");
        let c = hash_bytes(b"abd");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|ch| ch.is_ascii_hexdigit()));
    }
}
