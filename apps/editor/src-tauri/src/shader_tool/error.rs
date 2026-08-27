//! Structured boundary refusals — a value, always. The service never
//! leaks a prose-only failure or an OS error code across the boundary:
//! every refusal carries a machine reason (and the field it is about,
//! for `RequestShape`), so the editor can surface each one verbatim.

/// A structured refusal of the service itself (distinct from
/// `BoundaryResult`, which settles an attempt that was admitted):
/// `RequestShape` — the request was not one of the allowlisted shapes;
/// `Host` — a host-internal failure outside the settlement vocabulary
/// (for example: the attempt was not admitted in the first place).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceError {
    RequestShape {
        field: String,
        detail: String,
    },
    /// A host-internal failure outside the settlement vocabulary —
    /// part of the structured vocabulary even when a build path has
    /// not yet produced one of these.
    #[allow(dead_code)]
    Host {
        detail: String,
    },
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RequestShape { field, detail } => {
                write!(f, "request-shape ({field}): {detail}")
            }
            Self::Host { detail } => write!(f, "host: {detail}"),
        }
    }
}

impl std::error::Error for ServiceError {}

impl serde::Serialize for ServiceError {
    /// The refusal as the IPC wire value: `{"reason": "...", ...}` —
    /// structured, never a bare string: the editor (or its client) can
    /// key on `reason`, and for `request-shape` carries the field it is
    /// about.
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap as _;
        let mut map = serializer.serialize_map(None)?;
        match self {
            ServiceError::RequestShape { field, detail } => {
                map.serialize_entry("reason", "request-shape")?;
                map.serialize_entry("field", field)?;
                map.serialize_entry("detail", detail)?;
            }
            ServiceError::Host { detail } => {
                map.serialize_entry("reason", "host")?;
                map.serialize_entry("detail", detail)?;
            }
        }
        map.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_wire_refusal_is_structured() {
        let e = ServiceError::RequestShape {
            field: "sourceIdentity".to_string(),
            detail: "expected the 64-hex SHA-256 of the exact bytes".to_string(),
        };
        let value: serde_json::Value = serde_json::to_value(&e).unwrap();
        assert_eq!(value["reason"], "request-shape");
        assert_eq!(value["field"], "sourceIdentity");

        let host: serde_json::Value =
            serde_json::to_value(ServiceError::Host { detail: "x".into() }).unwrap();
        assert_eq!(host["reason"], "host");
    }
}
