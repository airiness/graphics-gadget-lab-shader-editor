/**
 * The compatibility verdicts the client holds over the tool's OWN
 * reported facts — facts the tool itself reports through the published
 * handshake, never facts the client guesses or mines from prose.
 *
 * Identity and version are judged against the requirement (the
 * descriptor's demand, mapped into the client's plain shape). The
 * supported-target fact is EXTRACTED, not judged: whether the configured
 * target is among a tool's published targets is one build's readiness,
 * judged where the configuration lives (the editor composition) — so the
 * same executable never oscillates between compatible and incompatible
 * when the target changes.
 */
import type { ToolFacts, ToolRequirement } from "./contract-facts.js";
import { clientSupportedCompilePolicyRange } from "./contract-range-declaration.js";
import type { SupportedContractRange } from "./contract-range-declaration.js";
import { compareSemver, parseSemver } from "./semver.js";

export type IdentityVerdict =
    | { readonly status: "match" }
    | {
        readonly status: "mismatch";
        readonly requiredIdentity: string;
        readonly reportedIdentity: string;
      };

/**
 * Judges the tool's reported identity against the identity the
 * requirement demands. Exact string equality — the identity is a
 * gate, not a fuzzy match.
 */
export function judgeToolIdentity(
    required: ToolRequirement,
    reported: ToolFacts,
): IdentityVerdict {
    if (reported.toolIdentity === required.identity) {
        return { status: "match" };
    }
    return {
        status: "mismatch",
        requiredIdentity: required.identity,
        reportedIdentity: reported.toolIdentity,
    };
}

export type VersionVerdict =
    | {
        readonly status: "meets-minimum";
        readonly observedVersion: string;
        readonly minimumVersion: string;
      }
    | {
        readonly status: "below-minimum";
        readonly observedVersion: string;
        readonly minimumVersion: string;
      }
    | {
        readonly status: "unparseable-version";
        readonly detail: string;
      }
    | {
        readonly status: "comparison-rule-unsupported";
        readonly rule: string;
      };

/**
 * Judges the tool's reported version against the requirement's minimum
 * under the requirement's OWN declared comparison rule. "semver" is the
 * only rule the client implements; any other rule name is an explicit
 * refusal (never a guess), and an unparseable version is an explicit
 * refusal on its side (never a default).
 */
export function judgeToolVersion(
    required: ToolRequirement,
    reported: ToolFacts,
): VersionVerdict {
    if (required.versionComparison !== "semver") {
        return {
            status: "comparison-rule-unsupported",
            rule: required.versionComparison,
        };
    }
    const observed = parseSemver(reported.toolVersion);
    const minimum = parseSemver(required.minimumVersion);
    if (observed === null || minimum === null) {
        return {
            status: "unparseable-version",
            detail:
                observed === null
                    ? `the tool's version "${reported.toolVersion}" is not a valid SemVer 2.0.0 version`
                    : `the requirement's minimum "${required.minimumVersion}" is not a valid SemVer 2.0.0 version`,
        };
    }
    const below = compareSemver(observed, minimum) < 0;
    const shared = {
        observedVersion: reported.toolVersion,
        minimumVersion: required.minimumVersion,
    };
    return below
        ? { status: "below-minimum", ...shared }
        : { status: "meets-minimum", ...shared };
}

export type CompilePolicyVerdict =
    | {
        readonly status: "supported";
        readonly observedRevision: number;
        readonly range: SupportedContractRange;
      }
    | {
        readonly status: "unsupported";
        readonly observedRevision: number;
        readonly range: SupportedContractRange;
      };

/**
 * Judges the tool's reported compile-policy revision against the
 * client's declared support range (the declaration module — the value
 * set is the toolchain's own axis, consumed here, never defined here).
 * The contract (R5) makes this field a consumer-must-participate
 * compatibility fact: a revision outside the declared range is an
 * explicit mismatch — never silently accepted, never reinterpreted.
 * This axis is independent of the tool version, the process-contract
 * axis, and the producer identity: the same recipe and the same
 * producer can produce different binaries under a different policy
 * revision, which is exactly why the value also enters the BuildIntent
 * identity.
 */
export function judgeCompilePolicyRevision(
    reported: ToolFacts,
    range: SupportedContractRange = clientSupportedCompilePolicyRange,
): CompilePolicyVerdict {
    const observed = reported.compilePolicyRevision;
    const shared = { observedRevision: observed, range };
    return observed >= range.minimum && observed <= range.maximum
        ? { status: "supported", ...shared }
        : { status: "unsupported", ...shared };
}

/**
 * Extracts the tool's published supported targets as a FACT: a frozen
 * snapshot suitable for inspection and for the editor composition to
 * judge a configured target against. The client holds no configuration
 * and makes no coverage judgment here — target readiness is one build's
 * compatibility, decided where the target is configured.
 */
export function extractSupportedTargets(reported: ToolFacts): readonly string[] {
    return [...reported.supportedTargets];
}
