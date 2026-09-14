import type {
    PreviewAttemptOutcome,
    PreviewAttemptTermination,
} from "@gglab/shader-toolchain-client";

/**
 * User-facing HEADLINE for one Preview attempt settlement — the outcome
 * kind, and the outcome's own status/termination facts, in one line.
 * Structured diagnostics are NOT summarized into this string: the failure
 * envelope's diagnostics render as their own rows in the display surface
 * (the Preview panel view), each a structured fact with its location
 * identity, so the chronology stays navigable and un-flattened. A failed
 * build therefore remains actionable without a debugger: the headline
 * names the status and exit code, and the diagnostic rows underneath
 * carry the tool's lines.
 */
export function describePreviewAttemptOutcome(
    attemptSequence: number,
    outcome: PreviewAttemptOutcome,
): string {
    if (outcome.kind === "published") {
        return `Preview publication ${outcome.envelope.publicationId.slice(0, 12)}… produced.`;
    }
    if (outcome.kind === "canceled") {
        return `Preview attempt #${attemptSequence} was canceled.`;
    }
    if ("envelope" in outcome) {
        const envelope = outcome.envelope;
        return `Preview attempt #${attemptSequence} failed — ${envelope.status} (exit ${envelope.exitCode}).`;
    }
    return `Preview attempt #${attemptSequence} failed — ${describeTermination(outcome.termination)}.`;
}

function describeTermination(termination: PreviewAttemptTermination): string {
    switch (termination.kind) {
        case "timed-out":
            return "timed-out";
        case "launch-failed":
            return "launch-failed";
        case "candidate-invalidated":
            return termination.observedIdentity === null
                ? `candidate-invalidated (${termination.observation})`
                : `candidate-invalidated (${termination.observation}, observed identity ${termination.observedIdentity})`;
        case "attempt-sequence-mismatch":
            return `attempt-sequence-mismatch (expected ${termination.expected}, observed ${termination.observed})`;
        case "machine-document-rejected":
            return `machine-document-rejected (${termination.rejection.reason}: ${termination.rejection.detail})`;
        case "channel-violated":
            return describeChannelViolation(termination.violation);
    }
}

function describeChannelViolation(
    violation: Extract<PreviewAttemptTermination, { readonly kind: "channel-violated" }>["violation"],
): string {
    switch (violation.reason) {
        case "stderr-non-empty":
            return `channel-violated (stderr-non-empty, ${violation.byteLength} bytes)`;
        case "stdout-not-valid-utf8":
            return `channel-violated (stdout-not-valid-utf8: ${violation.detail})`;
        case "exit-code-mismatch":
            return `channel-violated (exit-code-mismatch, document ${violation.documentExitCode}, process ${violation.processExitCode})`;
    }
}
