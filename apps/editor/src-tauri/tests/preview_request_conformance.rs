//! Rust mirror of the client's Preview request-shape declaration. Both sides
//! consume the same fixture and must agree on admission and refusal field.

use gglab_shader_graph_editor::{NativePreviewBuildRequest, ServiceError, ShaderToolService};

#[derive(serde::Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

#[derive(serde::Deserialize)]
struct Case {
    name: String,
    request: NativePreviewBuildRequest,
    #[serde(rename = "expectWellFormed")]
    expect_well_formed: bool,
    #[serde(rename = "expectReason", default)]
    expect_reason: Option<String>,
}

#[test]
fn the_host_judges_preview_requests_like_the_client() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("tests")
        .join("preview-toolchain-boundary-requests.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!("the shared Preview fixture must be readable at {path:?}: {err}")
    });
    let fixture: Fixture =
        serde_json::from_str(&text).expect("the shared Preview fixture must parse as Rust DTOs");
    assert!(!fixture.cases.is_empty());

    for case in &fixture.cases {
        match ShaderToolService::validate_preview_request(&case.request) {
            Ok(()) => assert!(
                case.expect_well_formed,
                "case \"{}\": the host admitted a Preview request the client rejects",
                case.name
            ),
            Err(ServiceError::RequestShape { field, .. }) => {
                assert!(
                    !case.expect_well_formed,
                    "case \"{}\": the host refused a Preview request the client admits",
                    case.name
                );
                assert_eq!(case.expect_reason.as_deref(), Some(field.as_str()));
            }
            Err(other) => panic!(
                "case \"{}\": expected a request-shape refusal, got {other:?}",
                case.name
            ),
        }
    }
}
