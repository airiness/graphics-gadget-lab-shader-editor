/**
 * The NativeBuildReadiness composition — the editor's single verdict
 * over "can THIS build run NOW" (design authority: the toolchain
 * integration design, section 6; section 13 for the inspector it
 * explains).
 *
 * Two state spaces, two domains: the TOOL's compatibility is the
 * client's verdict over the tool (judged in @gglab/shader-toolchain-client);
 * the BUILD's readiness is this composition over that verdict plus the
 * other inputs only this composition point knows: the profile/descriptor
 * verdict (core's), the host execution capability (the service's report,
 * as observed by the shell), the explicit target configuration, and the
 * target-coverage judgment (the client-extracted supportedTargets FACT
 * against the CONFIGURED target — one build's compatibility, judged
 * where the configuration lives).
 *
 * The composition is recomposed from current facts on every input
 * change (readiness is derived, never remembered), and a `NotReady` is
 * ALWAYS the structured, complete, visible reason list — every
 * non-Ready input contributes its reason, in the design's vocabulary.
 * It is the inspector's explanation, not a failure.
 */
import type { ToolCompatibilityState, UnprovenReason } from "@gglab/shader-toolchain-client";

/** The design's reason vocabulary — one per non-Ready input class.
 *  Every reason carries the SAME visible shape: a stable code plus a
 *  complete detail line (and, where the machine's own structured facts
 *  exist, their stable codes too) — the inspector reads these verbatim. */
export type NativeBuildReadinessReason =
    | { readonly reason: "ToolUnavailable"; readonly detail: string }
    | { readonly reason: "ToolDiscovered"; readonly detail: string }
    | {
          readonly reason: "ToolUnproven";
          readonly detail: string;
          readonly unprovenDetails: readonly { readonly code: string }[];
      }
    | {
          readonly reason: "ToolIncompatible";
          readonly detail: string;
          readonly mismatchCodes: readonly string[];
      }
    | { readonly reason: "DescriptorIncompatible"; readonly detail: string }
    | { readonly reason: "HostUnavailable"; readonly detail: string }
    | { readonly reason: "TargetNotConfigured"; readonly detail: string }
    | {
          readonly reason: "TargetUnsupported";
          readonly detail: string;
          readonly configuredTarget: string;
          readonly supportedTargets: readonly string[];
      };

/** `Ready`, or `NotReady` with the COMPLETE structured reason list. */
export type NativeBuildReadiness =
    | { readonly status: "Ready" }
    | { readonly status: "NotReady"; readonly reasons: readonly NativeBuildReadinessReason[] };

/** The composition's inputs — each from exactly one owner. */
export interface NativeReadinessInput {
    /** The client's verdict over the tool (the tool state space). */
    readonly tool: ToolCompatibilityState;
    /** A descriptor instance is loaded (the core's reader accepted it). */
    readonly descriptorLoaded: boolean;
    /** The core's profile x descriptor compatibility verdict. */
    readonly descriptorCompatible: boolean;
    /** The core's own structured explanation of a failed verdict. */
    readonly descriptorDetail: string;
    /** The host execution capability, as the shell observed the service. */
    readonly hostAvailable: boolean;
    /** Why not (web shell without a service, etc.). */
    readonly hostDetail: string;
    /** The explicit build target configuration (null = not configured).
     *  The target is ALWAYS an explicit configuration — never the
     *  descriptor's, never the tool's. */
    readonly configuredTarget: string | null;
    /** The tool's published supported targets, extracted by the client
     *  as a fact (null = no proven tool facts to carry them; the
     *  coverage question is then covered by the tool's own reason). */
    readonly supportedTargets: readonly string[] | null;
}

type NonCompatibleTool = Exclude<ToolCompatibilityState, { readonly status: "compatible" }>;

function toolReason(tool: NonCompatibleTool): NativeBuildReadinessReason {
    switch (tool.status) {
        case "unavailable":
            return {
                reason: "ToolUnavailable",
                detail: "no currently valid resolved tool candidate (discovery failed on every rule, or the resolved observation was refuted)",
            };
        case "discovered":
            return {
                reason: "ToolDiscovered",
                detail: "a candidate resolved, but no handshake has proven it yet — the handshake is the operation that establishes proof",
            };
        case "unproven":
            return {
                reason: "ToolUnproven",
                detail: "a handshake was attempted but the tool's machine facts are not proven under a supported contract",
                unprovenDetails: tool.reasons.map((r) => ({ code: unprovenCode(r) })),
            };
        case "incompatible":
            return {
                reason: "ToolIncompatible",
                detail: "the tool's own reported facts contradict the requirements (identity, version, or contract axis)",
                mismatchCodes: tool.mismatches.map((m) => m.kind),
            };
    }
}

/** The stable code of one structured unproven reason (for the
 *  inspector's reason list — the machine's own structured facts stay
 *  addressable without prose scraping). */
function unprovenCode(reason: UnprovenReason): string {
    return reason.reason;
}

function isNonCompatibleTool(tool: ToolCompatibilityState): tool is NonCompatibleTool {
    return tool.status !== "compatible";
}

/**
 * The composition. Total: every input contributes at most its own
 * reason(s), in a stable order (tool, descriptor, host, target), so the
 * same facts always read the same — downgrades are as visible as
 * upgrades.
 */
export function composeNativeBuildReadiness(input: NativeReadinessInput): NativeBuildReadiness {
    const reasons: NativeBuildReadinessReason[] = [];
    if (isNonCompatibleTool(input.tool)) {
        // The switch above is exhaustive over the non-compatible states —
        // TypeScript proves it at compile time.
        reasons.push(toolReason(input.tool));
    }
    if (!input.descriptorLoaded) {
        reasons.push({
            reason: "DescriptorIncompatible",
            detail: "no profile descriptor instance is loaded — the core can neither judge the profile against it nor emit",
        });
    } else if (!input.descriptorCompatible) {
        reasons.push({
            reason: "DescriptorIncompatible",
            detail: input.descriptorDetail,
        });
    }
    if (!input.hostAvailable) {
        reasons.push({
            reason: "HostUnavailable",
            detail: input.hostDetail,
        });
    }
    const target = input.configuredTarget !== null && input.configuredTarget !== "" ? input.configuredTarget : null;
    if (target === null) {
        reasons.push({
            reason: "TargetNotConfigured",
            detail: "no explicit build target is configured (the build target is an explicit configuration — never the descriptor's, never the tool's)",
        });
    } else if (input.supportedTargets === null) {
        // No proven tool facts to judge coverage against — the tool's own
        // reason above already says why; there is no second guess here.
    } else if (!input.supportedTargets.includes(target)) {
        reasons.push({
            reason: "TargetUnsupported",
            detail: `the configured target ${target} is not among the tool's published supported targets (${[...input.supportedTargets].join(", ") || "(none)"}) — the tool's own compatibility verdict is not affected by this`,
            configuredTarget: target,
            supportedTargets: [...input.supportedTargets],
        });
    }
    return reasons.length === 0 ? { status: "Ready" } : { status: "NotReady", reasons };
}

/** The product gate (section 6 guarantee): only a `Ready` composition
 *  admits a native compile request. There is no bypass: no dev mode,
 *  environment flag, or local setting routes around this verdict,
 *  because no alternative path is defined. */
export function readinessAdmitsCompile(readiness: NativeBuildReadiness): boolean {
    return readiness.status === "Ready";
}
