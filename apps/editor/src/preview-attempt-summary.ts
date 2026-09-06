import type {
    PreviewAttemptOutcome,
    PreviewAttemptTermination,
} from "@gglab/shader-toolchain-client";

/** User-facing settlement summary for one Preview attempt. The tool's
 * structured status and diagnostics must survive the final UI projection so
 * a failed build remains actionable without consulting a debugger. */
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
        const heading = `Preview attempt #${attemptSequence} failed — ${envelope.status} (exit ${envelope.exitCode})`;
        const diagnostics = envelope.diagnostics.map((diagnostic) =>
            diagnostic.sourceIdentity === undefined
                ? diagnostic.message
                : `[source ${diagnostic.sourceIdentity}] ${diagnostic.message}`,
        );
        return diagnostics.length === 0
            ? `${heading}.`
            : `${heading}: ${diagnostics.join(" | ")}`;
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
