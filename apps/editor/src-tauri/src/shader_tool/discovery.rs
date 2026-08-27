//! Discovery — pure bookkeeping over configuration facts. It walks the
//! three rules in order, first hit wins, and records one structured
//! failure reason per rule that did not resolve. It neither executes the
//! tool nor interprets any of its output, and it never guesses: a rule
//! with no input is a recorded `not-configured` failure, not a silent skip.

use std::path::Path;

use super::identity::hash_file;
use super::types::{
    DiscoverOutcome, DiscoverRequest, DiscoveryRule, DiscoveryRuleFailure, ToolCandidate,
};

fn now_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// One rule's resolution over one expected location: a candidate when the
/// location holds a readable file, otherwise that rule's structured reason.
fn resolve_rule(rule: DiscoveryRule, location: Option<&Path>) -> Result<ToolCandidate, String> {
    let path = location
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| "not-configured".to_string())?;
    if !path.exists() {
        return Err("missing".to_string());
    }
    if !path.is_file() {
        return Err("not-a-file".to_string());
    }
    let observation_identity = hash_file(path).map_err(|_| "identity-unreadable".to_string())?;
    // Forward-slash normalized form: the candidate carries the path as a
    // stable token (the client holds it opaquely), and it round-trips
    // losslessly on every host this service runs on.
    let tool_path = path.to_string_lossy().replace('\\', "/");
    Ok(ToolCandidate {
        rule,
        tool_path,
        observation_identity,
        resolved_at: now_epoch_millis(),
    })
}

/// Walk the rules in order — `explicit-config`, `sibling-build`,
/// `bundled` — and return the first resolved candidate with the
/// per-rule failure record (empty when one resolved).
///
/// `service_executable_dir` is the service's own location fact (it owns
/// the `bundled` rule's expected location); tests supply a fixture
/// directory instead of the real binary.
pub fn discover(
    request: &DiscoverRequest,
    service_executable_dir: Option<&Path>,
) -> DiscoverOutcome {
    let mut failures: Vec<DiscoveryRuleFailure> = Vec::new();

    let explicit = request
        .explicit_config
        .as_ref()
        .map(|path| Path::new(path));
    match resolve_rule(DiscoveryRule::ExplicitConfig, explicit) {
        Ok(candidate) => return DiscoverOutcome { candidate: Some(candidate), failures },
        Err(reason) => failures.push(DiscoveryRuleFailure {
            rule: DiscoveryRule::ExplicitConfig,
            reason,
        }),
    }

    let sibling = request
        .sibling_build_output
        .as_ref()
        .map(|dir| Path::new(dir).join("gglab-shaderc.exe"));
    match resolve_rule(DiscoveryRule::SiblingBuild, sibling.as_deref()) {
        Ok(candidate) => return DiscoverOutcome { candidate: Some(candidate), failures },
        Err(reason) => failures.push(DiscoveryRuleFailure {
            rule: DiscoveryRule::SiblingBuild,
            reason,
        }),
    }

    let bundled: Option<std::path::PathBuf> =
        request.bundled.then(|| service_executable_dir.map(|dir| dir.join("gglab-shaderc.exe")))
            .flatten();
    match resolve_rule(DiscoveryRule::Bundled, bundled.as_deref()) {
        Ok(candidate) => DiscoverOutcome { candidate: Some(candidate), failures },
        Err(reason) => DiscoverOutcome {
            candidate: None,
            failures: {
                failures.push(DiscoveryRuleFailure {
                    rule: DiscoveryRule::Bundled,
                    reason,
                });
                failures
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovery_is_first_hit_wins_with_per_rule_failures() {
        let base = std::env::temp_dir().join("gglab-discovery-test");
        let _ = fs::remove_dir_all(&base);
        let explicit = base.join("explicit");
        let sibling = base.join("sibling");
        let bundled = base.join("bundled");
        fs::create_dir_all(sibling.join("out")).unwrap();
        for dir in [
            explicit.parent().unwrap(),
            sibling.as_path(),
            bundled.as_path(),
        ] {
            let _ = fs::create_dir_all(dir);
        }
        // Nothing exists yet: all three rules record their reasons.
        let outcome = discover(
            &DiscoverRequest {
                explicit_config: Some(explicit.to_string_lossy().into_owned()),
                sibling_build_output: Some(sibling.join("out").to_string_lossy().into_owned()),
                bundled: true,
            },
            Some(bundled.parent().unwrap()),
        );
        assert!(outcome.candidate.is_none());
        let reasons: Vec<&str> = outcome
            .failures
            .iter()
            .map(|f| f.reason.as_str())
            .collect();
        assert_eq!(reasons, vec!["missing", "missing", "missing"]);

        // The sibling rule resolves over its host fact (the directory),
        // and stops the walk before the bundled rule.
        fs::write(sibling.join("out").join("gglab-shaderc.exe"), b"tool").unwrap();
        let outcome = discover(
            &DiscoverRequest {
                explicit_config: Some(
                    explicit.to_string_lossy().into_owned(),
                ),
                sibling_build_output: Some(
                    sibling.join("out").to_string_lossy().into_owned(),
                ),
                bundled: true,
            },
            Some(bundled.parent().unwrap()),
        );
        let candidate = outcome.candidate.expect("sibling rule resolves");
        assert_eq!(candidate.rule, DiscoveryRule::SiblingBuild);
        assert_eq!(candidate.observation_identity, super::super::identity::hash_bytes(b"tool"));
        // The failed rule is still recorded; the walk did not reach bundled.
        assert_eq!(outcome.failures.len(), 1);
        assert_eq!(outcome.failures[0].rule, DiscoveryRule::ExplicitConfig);

        // An unreadable / non-file entry is its own reason, not a guess.
        fs::remove_file(sibling.join("out").join("gglab-shaderc.exe")).unwrap();
        fs::create_dir_all(sibling.join("out").join("gglab-shaderc.exe")).unwrap();
        let outcome = discover(
            &DiscoverRequest {
                explicit_config: None,
                sibling_build_output: Some(
                    sibling.join("out").to_string_lossy().into_owned(),
                ),
                bundled: false,
            },
            None,
        );
        assert!(outcome.candidate.is_none());
        assert_eq!(outcome.failures[0].rule, DiscoveryRule::ExplicitConfig);
        assert_eq!(outcome.failures[0].reason, "not-configured");
        assert_eq!(outcome.failures[1].rule, DiscoveryRule::SiblingBuild);
        assert_eq!(outcome.failures[1].reason, "not-a-file");
        let _ = fs::remove_dir_all(&base);
    }
}
