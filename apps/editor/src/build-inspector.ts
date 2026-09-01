/**
 * The Build Inspector (design authority: section 13) as a pure
 * PROJECTION. The invariant it enforces: ONE source of truth per field —
 * the inspector renders values lifted from their owner (the client's
 * verdict, the core's facts, the service's report, the configuration,
 * the session store), it computes none and remembers none; two sources
 * of truth for one field is a review failure, and neither is possible
 * here because every row below names the getter that supplies it.
 *
 * The projection is the stage's "replayable evidence, not opaque compile
 * failed" surface: from its alone, a reviewer can determine which tool,
 * under which contract facts, compiled which exact bytes to what
 * evidence, and why the states are what they are.
 */
import type { SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import {
    type AttemptOutcome,
    type BuildLineReport,
    type ToolCompatibilityState,
} from "@gglab/shader-toolchain-client";
import type { BuildTargetConfiguration } from "./build-target-config.js";
import type { NativeBuildFlow } from "./native-build-flow.js";
import type { NativeBuildReadiness } from "./native-build-readiness.js";

/** One inspector row: the field, the value as its owner holds it (the
 *  projection's own stringification for display is the ONLY text here),
 *  and the field's single source of truth, named. */
export interface BuildInspectorRow {
    readonly field: string;
    readonly value: string;
    readonly source: string;
}

/** A structured fact of the tool's proven side (each field with its
 *  owner), or the structured absence when the tool is not proven. */
export interface BuildInspectorFacts {
    readonly tool: BuildInspectorRow[];
    readonly descriptor: BuildInspectorRow[];
    readonly hostAndTarget: BuildInspectorRow[];
    readonly build: BuildInspectorRow[];
}

function row(field: string, value: unknown, source: string): BuildInspectorRow {
    return { field, value: value === null || value === undefined ? "(none)" : String(value), source };
}

/** Project the tool side: every field from the client's state, verbatim. */
export function projectToolFacts(state: ToolCompatibilityState): BuildInspectorRow[] {
    const candidateRow =
        state.status === "unavailable"
            ? []
            : [row("discovered candidate", state.candidate.toolPath, "service discovery"), row("resolved by rule", state.candidate.rule, "service discovery")];
    switch (state.status) {
        case "unavailable":
            return [row("compatibility", "unavailable", "client verdict")];
        case "compatible": {
            const facts = state.provenFacts;
            return [
                row("compatibility", "compatible (proven)", "client verdict"),
                ...candidateRow,
                row("tool identity", facts.toolIdentity, "client verdict over the tool's facts"),
                row("tool version", facts.toolVersion, "tool's proven fact (client's reader)"),
                row("process-contract axis", `${state.proof.processContractVersion}`, "tool's proven fact / client declaration"),
                row("compile-policy axis", `${state.proof.compilePolicyRevision}`, "tool's proven fact / client declaration"),
                row("producer identity", facts.producerIdentity, "tool's proven fact"),
                row("supported targets", [...facts.supportedTargets].join(", ") || "(none)", "tool's published fact (client-extracted)"),
            ];
        }
        case "discovered":
            return [row("compatibility", "discovered (a fact, never a readiness claim)", "client verdict"), ...candidateRow];
        case "unproven":
            return [row("compatibility", "unproven", "client verdict"), ...candidateRow, row("unproven reasons", state.reasons.map((r) => r.reason).join(", "), "client's structured reasons")];
        case "incompatible":
            return [row("compatibility", "incompatible", "client verdict"), ...candidateRow, row("mismatches", state.mismatches.map((m) => m.kind).join(", "), "client's structured mismatches")];
    }
}

/** Project the descriptor side: the instance's identity facts (core's
 *  reader over the loaded document), its process-contract requirement
 *  (the core's fact the verdicts were judged against), and the core's
 *  own compatibility verdict. The client never reads the descriptor —
 *  the editor mapped its contract to the client's plain requirement. */
export function projectDescriptorFacts(
    descriptor: SurfaceProfileDescriptor | null,
    compatibility: { readonly ok: boolean; readonly detail: string },
): BuildInspectorRow[] {
    if (descriptor === null) {
        return [row("descriptor instance", "(not loaded)", "core's reader over the loaded document")];
    }
    return [
        row("descriptor instance", `${descriptor.profileId} v${descriptor.profileVersion} (descriptor v${descriptor.descriptorVersion})`, "core's reader over the loaded document"),
        row("required tool identity", descriptor.processContract.tool.identity, "descriptor process contract (core's fact)"),
        row("required minimum tool version", descriptor.processContract.tool.minimumVersion, "descriptor process contract (core's fact)"),
        row("generated function (stage / entry)", `${descriptor.generatedFunction.stage} / ${descriptor.generatedFunction.name}`, "descriptor generatedFunction facts"),
        row("profile x descriptor compatibility", compatibility.ok ? "compatible" : `incompatible — ${compatibility.detail}`, "core's capability verdict"),
    ];
}

/** Project the host + target side: the service's capability report as
 *  the shell observed it, the explicit configuration, and the
 *  composition's coverage judgment (fact vs configuration). */
export function projectHostAndTargetFacts(
    flow: NativeBuildFlow,
    target: BuildTargetConfiguration,
    readiness: NativeBuildReadiness,
): BuildInspectorRow[] {
    const host = flow.host();
    const targetRow = row("build target", target.target, "explicit configuration (development default, always visible and changeable)");
    const coverageRow = (() => {
        const supported = flow.supportedTargets;
        if (supported === null) {
            return row("configured target supported by the tool?", "(no proven tool facts to judge against)", "editor composition");
        }
        const includes = supported.includes(target.target) ? "yes" : "no";
        return row(
            "configured target supported by the tool?",
            `${includes} (supported: ${[...supported].join(", ") || "(none)"})`,
            "editor composition (client-extracted fact vs configuration)",
        );
    })();
    const notReady = readiness.status === "NotReady" ? readiness.reasons.map((reason) => reason.reason).join(", ") : undefined;
    return [
        row("host execution capability", host.available ? "available (the service is reachable)" : `unavailable — ${host.detail}`, "service report (shell-observed)"),
        targetRow,
        coverageRow,
        ...(notReady !== undefined ? [row("readiness", `NotReady: ${notReady}`, "editor composition (derived, never remembered)")] : [row("readiness", "Ready", "editor composition (derived, never remembered)")]),
    ];
}

/** Project the build side: the composed request identity (BuildIntent's
 *  components, the `current`-ness anchor), the session's line report
 *  (the client's rules over the session store), and the NEWEST ISSUED
 *  attempt's outcome facts — the caller passes the anchor's own record
 *  (the session line is that outcome's single authority; null is the
 *  honest "not yet" while the anchor is still in flight). */
export function projectBuildFacts(
    flow: NativeBuildFlow,
    emission: { readonly sourceIdentity: string } | null,
    report: BuildLineReport | null,
    lastOutcome: AttemptOutcome | null,
): BuildInspectorRow[] {
    const session = flow.buildSession;
    const anchor = session.lastIssued?.intent;
    const intentRows =
        anchor === undefined
            ? [row("build intent", "(no issued attempt)", "composed NativeCompileRequest")]
            : [
                  row("build intent — source identity", anchor.sourceIdentity, "composed NativeCompileRequest"),
                  row("build intent — target / stage / entry", `${anchor.target} / ${anchor.stage} / ${anchor.entry}`, "composed NativeCompileRequest"),
                  row("build intent — tool identity / version", `${anchor.tool.identity} / ${anchor.tool.version}`, "composed NativeCompileRequest (proven facts)"),
                  row("build intent — contract / policy axes", `${anchor.tool.processContractVersion} / ${anchor.tool.compilePolicyRevision}`, "composed NativeCompileRequest (proven facts)"),
                  row("build intent — producer identity", anchor.tool.producerIdentity, "composed NativeCompileRequest (proven facts)"),
              ];
    const generatedRow = emission === null ? [] : [row("generated-source identity", emission.sourceIdentity, "core's emission (SHA-256 of the exact bytes)")];
    const lineRows =
        report === null
            ? []
            : [
                  ...(report.current !== undefined ? [row("current result", `attempt #${report.current.buildId.sequence}`, "session store over the client's rules")] : []),
                  ...(report.lastGood !== undefined ? [row("last-good", `attempt #${report.lastGood.buildId.sequence}`, "session store over the client's rules")] : []),
                  ...(report.inFlight.length > 0 ? [row("in flight", report.inFlight.map((id) => `#${id.sequence}`).join(", "), "session store over the client's rules")] : []),
                ];
    const outcomeRows =
        lastOutcome === null
            ? []
            : [row("newest issued attempt — outcome", describeOutcome(lastOutcome), "the session line's record for the anchor's BuildId (client's outcome vocabulary, never raw bytes)")];
    const detailRows = lastOutcome === null ? [] : outcomeDetailRows(lastOutcome);
    return [...generatedRow, ...intentRows, ...lineRows, ...outcomeRows, ...detailRows];
}

/** The outcome's stable one-line description (the client's structured
 *  facts, not prose): each distinct, with its own facts carried. */
function describeOutcome(outcome: AttemptOutcome): string {
    switch (outcome.kind) {
        case "succeeded":
            return `succeeded (binary ${outcome.envelope.binaryFormat} ${outcome.envelope.binaryHash.slice(0, 16)}…, cache ${outcome.envelope.fromCache ? "hit" : "miss"})`;
        case "canceled":
            return "canceled (explicit, never lost)";
        case "failed":
            if ("envelope" in outcome) {
                const count = outcome.envelope.diagnostics.length;
                return `failed (tool status "${outcome.envelope.status}", ${count} diagnostic${count === 1 ? "" : "s"} — the diagnostics follow as their own rows)`;
            }
            return `failed (termination: ${outcome.termination.kind}${outcome.termination.kind === "candidate-invalidated" ? `: ${outcome.termination.observation}` : ""})`;
    }
}

/** The failed attempt, made visible — projected from the session
 *  line's OWN outcome record (one source of truth; this module computes
 *  nothing). A tool failure surfaces every structured diagnostic
 *  verbatim (its message, and its location fact when the tool reports
 *  one); a termination that carries structure — the strict reader's
 *  rejection, the channel violation, the host's provenance refutation —
 *  surfaces that structure. `timed-out` and `launch-failed` are
 *  complete as the one-line summary and add no hidden facts. */
function outcomeDetailRows(outcome: AttemptOutcome): BuildInspectorRow[] {
    if (outcome.kind !== "failed") {
        return [];
    }
    if ("envelope" in outcome) {
        const diagnostics = outcome.envelope.diagnostics;
        if (diagnostics.length === 0) {
            return [row("newest issued attempt — diagnostic", "(the tool reported the failure with no structured diagnostic)", "the tool's own failure envelope (carried verbatim)")];
        }
        return diagnostics.map((diagnostic, index) =>
            row(
                `newest issued attempt — diagnostic ${index + 1}/${diagnostics.length}`,
                diagnostic.sourceIdentity !== undefined ? `${diagnostic.message}  [${diagnostic.sourceIdentity}]` : diagnostic.message,
                "the tool's own structured diagnostic (verbatim; location fact when the tool reports one)",
            ),
        );
    }
    const termination = outcome.termination;
    switch (termination.kind) {
        case "machine-document-rejected":
            return [row("newest issued attempt — rejection", `the machine document was rejected (${termination.rejection.reason}: ${termination.rejection.detail})`, "the client's strict reader (the structured refusal)")];
        case "channel-violated": {
            const violation = termination.violation;
            const detail =
                violation.reason === "exit-code-mismatch"
                    ? `exit-code mismatch (document says ${violation.documentExitCode}, process exited ${violation.processExitCode})`
                    : violation.reason === "stderr-non-empty"
                        ? `stderr was not empty (${violation.byteLength} bytes)`
                        : `${violation.reason} (${violation.detail})`;
            return [row("newest issued attempt — channel", `channel rule violated: ${detail}`, "the client's channel judgment over the boundary's raw facts (structured, never prose)")];
        }
        case "candidate-invalidated": {
            const rows = [row("newest issued attempt — invalidation", `the host refuted the candidate's observation at spawn time: ${termination.observation}`, "the host's provenance refutation (their fact, carried verbatim)")];
            if (termination.observedIdentity !== null) {
                rows.push(row("newest issued attempt — observed identity", termination.observedIdentity, "the host's observation fact"));
            }
            return rows;
        }
        case "timed-out":
        case "launch-failed":
            return [];
    }
}

/** The complete inspector: one section per owner's domain, and each row
 *  carrying the name of its single source of truth. */
export function projectBuildInspector(
    flow: NativeBuildFlow,
    descriptor: SurfaceProfileDescriptor | null,
    compatibility: { readonly ok: boolean; readonly detail: string },
    target: BuildTargetConfiguration,
    readiness: NativeBuildReadiness,
    emission: { readonly sourceIdentity: string } | null,
    report: BuildLineReport | null,
    lastOutcome: AttemptOutcome | null,
): BuildInspectorFacts {
    return {
        tool: projectToolFacts(flow.tool),
        descriptor: projectDescriptorFacts(descriptor, compatibility),
        hostAndTarget: projectHostAndTargetFacts(flow, target, readiness),
        build: projectBuildFacts(flow, emission, report, lastOutcome),
    };
}
