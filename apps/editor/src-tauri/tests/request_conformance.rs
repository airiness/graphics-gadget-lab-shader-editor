//! The host side of the SAME conformance: the shared fixture
//! (`tests/toolchain-boundary-requests.json` at the repository root)
//! must be judged by the service's request-shape validation exactly as
//! the client's declaration judges it — well-formed on both sides, or
//! refused on both, naming the same field. The client is the authority;
//! a new rule is a client change first, a fixture extension, and only
//! then a host mirror.

use gglab_shader_graph_editor::{NativeCompileRequest, ServiceError, ShaderToolService};

#[derive(serde::Deserialize)]
struct Fixture {
    name: String,
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    request: NativeCompileRequest,
    #[serde(rename = "expectWellFormed")]
    expect_well_formed: bool,
    #[serde(rename = "expectReason")]
    #[serde(default)]
    expect_reason: Option<String>,
}

#[test]
fn the_host_judges_the_shared_fixture_like_the_client() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("tests")
        .join("toolchain-boundary-requests.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("the shared fixture must be readable at {path:?}: {err}"));
    let fixture: Fixture =
        serde_json::from_str(&text).expect("the shared fixture must parse as Rust DTOs");
    assert!(!fixture.cases.is_empty(), "the fixture must carry cases");
    for case in &fixture.cases {
        match ShaderToolService::validate_request(&case.request) {
            Ok(()) => {
                assert!(
                    case.expect_well_formed,
                    "case \"{}\": the host admitted a request the client declares unwell-formed",
                    case.name
                );
            }
            Err(ServiceError::RequestShape { field, .. }) => {
                assert!(
                    !case.expect_well_formed,
                    "case \"{}\": the host refused a request the client declares well-formed (field: {field})",
                    case.name
                );
                assert_eq!(
                    case.expect_reason.as_deref(),
                    Some(field.as_str()),
                    "case \"{}\": the host and the client must name the SAME field",
                    case.name
                );
            }
            Err(other) => {
                panic!("case \"{}\": the host's refusal must be a request-shape value, got {other:?}", case.name);
            }
        }
    }
}
