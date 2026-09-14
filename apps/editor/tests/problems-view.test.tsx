/**
 * The Problems view and its composition — the replaceable CURRENT
 * diagnostic snapshot, and the CURRENT diagnostic coordinate rule:
 *
 * - the view renders the snapshot's entries as a SET (severity, owner
 *   code, message, location authority) keyed by stable identity, and
 *   Clear is a presentation action only (the snapshot value — and the
 *   owners behind it — stay untouched),
 * - the composition binds each owner line to ONE current coordinate —
 *   its newest SETTLED attempt, only when that settlement was a failure
 *   envelope: a newer settlement (success or not) drops the older
 *   failure's diagnostics, a pending attempt does not (while it is in
 *   flight the latest settlement's diagnostics remain current; the
 *   moment it settles, its settlement becomes the coordinate),
 * - the composition re-reacts on EVERY render from the CURRENT owner
 *   facts: the owner object keeps its identity across issue / settle
 *   while its session moves underneath, and a re-render must reflect the
 *   new diagnostic state (no stable-object-identity memo staleness),
 * - load / import operation diagnostics are NOT composed under the
 *   current document's identity (they have their own surface; had they
 *   entered Problems they would need their own provenance).
 *
 * Fixtures are owner-shaped; entries are composed ONLY through the
 * frozen vocabulary's projectors.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import type { DiagnosticSeverity, ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import type {
    AttemptOutcome,
    AttemptRecord,
    CompileFailureDocument,
    CompileSuccessDocument,
    PendingPreviewAttempt,
    PreviewBuildIntent,
    PreviewBuildSuccessDocument,
    SettledPreviewAttempt,
    ToolCandidate,
} from "@gglab/shader-toolchain-client";
import type { InFlightBuild, NativeBuildSession } from "../src/native-build-session.js";
import type { PreviewBuildSession } from "../src/preview-build-session.js";
import { createDocumentSessionId, type DocumentSessionId } from "../src/workspace-session.js";
import {
    composeProblemSnapshot,
    currentBuildFailureRecord,
    currentPreviewFailureRow,
} from "../src/problems-composition.js";
import {
    createProblemSnapshot,
    emptyProblemSnapshot,
    problemEntriesFromGraphDiagnostics,
    type ProblemSnapshot,
} from "../src/panel-vocabulary.js";
import { ProblemsPanelView } from "../src/bottom-panel-views.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// --- Owner-shaped fixtures ---------------------------------------------------

const documentSessionId: DocumentSessionId = createDocumentSessionId("document-session-problems-view");
const context = { documentSessionId, documentRevision: "revision-current-problems" };

const graphDiagnostics: readonly ShaderGraphDiagnostic[] = [
    { code: "connection-type-mismatch", severity: "error" as DiagnosticSeverity, message: "Port types do not match on the connection", dataPath: "edges[2]" },
    { code: "unknown-node-type", severity: "warning" as DiagnosticSeverity, message: "Node type is unknown and was retained", dataPath: "nodes[5]" },
];

const intent = {
    sourceIdentity: "generated-source-problems",
    target: "gglab.surface",
    stage: "vertex",
    entry: "main",
    defines: [],
    includes: [],
    tool: { identity: "gglab-shaderc", version: "1.0.0", processContractVersion: 2, compilePolicyRevision: 1, producerIdentity: "dx-prod-1" },
};
const buildFailureEnvelope: CompileFailureDocument = {
    command: "compile",
    success: false,
    status: "compile-failed",
    exitCode: 1,
    diagnostics: [
        { message: "HLSL declaration error", sourceIdentity: "generated-source-problems" },
        { message: "include not found" },
    ],
};
const buildSuccessEnvelope: CompileSuccessDocument = {
    command: "compile",
    success: true,
    status: "ok",
    exitCode: 0,
    recipeId: "recipe-1",
    buildKey: "build-key-1",
    binaryHash: "binary-hash-1",
    binaryFormat: "dxil",
    target: "gglab.surface",
    binaryPath: "C:\\art\\artifact.bin",
    cacheRecordPath: "C:\\art\\cache-record.bin",
    fromCache: false,
    diagnostics: [],
};
function buildRecord(sequence: number, outcome: AttemptOutcome): AttemptRecord {
    return { buildId: { sequence }, intent, outcome };
}
const failedOne: AttemptRecord = buildRecord(1, { kind: "failed", envelope: buildFailureEnvelope });
const succeededTwo: AttemptRecord = buildRecord(2, { kind: "succeeded", envelope: buildSuccessEnvelope });

/** A live owner line: the same session object whose attempts array the
 *  owner would extend on a settlement (the app must re-read it on every
 *  render — the object keeps its identity across settlements). */
function liveBuildLine(startingAttempts: readonly AttemptRecord[]): { attempts: AttemptRecord[]; session: NativeBuildSession } {
    const attempts: AttemptRecord[] = [...startingAttempts];
    const session: NativeBuildSession = {
        line: { attempts },
        inFlight: [],
        lastIssued: attempts.length === 0 ? null : attempts[attempts.length - 1] ?? null,
    };
    return { attempts, session };
}

const previewIntent: PreviewBuildIntent = {
    targetProfile: "gglab.preview",
    profileId: "gglab.surface",
    profileVersion: 1,
    previewInputContractId: "preview-contract-1",
    previewProgramDescriptorIdentity: "descriptor-1",
    generatedSourceIdentity: "generated-source-problems",
    toolIdentity: "gglab-shaderc",
    toolVersion: "1.0.0",
    processContractVersion: 2,
    previewBuildContractVersion: 1,
    compilePolicyRevision: 1,
    producerKind: "dx",
    producerIdentity: "dx-prod-1",
};
const candidate: ToolCandidate = { rule: "explicit-config", toolPath: "C:\\tool\\gglab-shaderc.exe", observationIdentity: "observation-1", resolvedAt: 0 };
const previewPublication: PreviewBuildSuccessDocument = {
    command: "build-preview",
    success: true,
    status: "ok",
    exitCode: 0,
    attemptSequence: 2,
    publicationId: "publication-two",
    shaderArtifactId: "artifact-two",
    baseRegistryId: "base-registry-two",
    previewRegistryId: "preview-registry-two",
    diagnostics: [],
};
function previewAttempt(sequence: number, outcome: SettledPreviewAttempt["outcome"]): SettledPreviewAttempt {
    return { attemptSequence: sequence, buildId: { sequence }, candidate, intent: previewIntent, state: "settled", outcome };
}
const previewFailedOne: SettledPreviewAttempt = previewAttempt(1, {
    kind: "failed",
    envelope: {
        command: "build-preview",
        success: false,
        status: "compile-failed",
        exitCode: 1,
        attemptSequence: 1,
        diagnostics: [{ message: "preview writer unavailable" }],
    },
});
const previewPublishedTwo: SettledPreviewAttempt = previewAttempt(2, { kind: "published", envelope: previewPublication });
const previewPendingThree: PendingPreviewAttempt = { attemptSequence: 3, buildId: { sequence: 3 }, candidate, intent: previewIntent, state: "pending" };
function previewLine(attempts: readonly (SettledPreviewAttempt | PendingPreviewAttempt)[]): PreviewBuildSession {
    return {
        sessionId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
        line: { attempts },
        nextAttemptSequence: 4,
    };
}

// --- The view: a set, with presentation-only Clear ---------------------------

describe("the problems view — a replaceable current snapshot", () => {
    it("renders the snapshot's entries as structured rows: severity, owner code, message, location authority", () => {
        const { attempts, session } = liveBuildLine([failedOne]);
        void attempts;
        const snapshot = composeProblemSnapshot(graphDiagnostics, context, session, previewLine([previewFailedOne]));
        const view = render(<ProblemsPanelView snapshot={snapshot} onClear={() => undefined} />).container;
        expect(view.textContent).toContain("5 current problems.");
        // One row per entry, keyed by its stable identity:
        const rows = Array.from(view.querySelectorAll(".gglab-bottom-view-row"));
        expect(rows.length).toBe(5);
        // The graph-native layer keeps its owner code and dataPath location:
        expect(rows[0]?.textContent).toContain("connection-type-mismatch");
        expect(rows[0]?.textContent).toContain("graph edges[2]");
        expect(rows[0]?.querySelector(".gglab-view-severity-error")?.textContent).toBe("error");
        expect(rows[1]?.querySelector(".gglab-view-severity-warning")?.textContent).toBe("warning");
        // The toolchain layer reports NO code (none is invented), and its
        // generated-source location keeps the identity:
        expect(rows[2]?.textContent).toContain("HLSL declaration error");
        expect(rows[2]?.textContent).toContain("generated source generated-so…");
        // A diagnostic with no location fact of its own stays honestly unplaced:
        expect(rows[3]?.textContent).toContain("include not found");
        expect(rows[3]?.textContent).toContain("no location reported");
        // The preview coordinate's entry renders under its own row too:
        expect(rows[4]?.textContent).toContain("preview writer unavailable");
    });

    it("wholesale replacement is the lifecycle: a second snapshot shows exactly that set, never an extension of the first", () => {
        const first = composeProblemSnapshot(graphDiagnostics, context, liveBuildLine([failedOne]).session, null);
        const initial = render(<ProblemsPanelView snapshot={first} onClear={() => undefined} />).container;
        expect(initial.querySelectorAll(".gglab-bottom-view-row").length).toBe(4);
        // A DIFFERENT snapshot becomes the view: exactly that set (one
        // row), the old entries gone — replacement, not accumulation.
        const second = createProblemSnapshot(problemEntriesFromGraphDiagnostics(graphDiagnostics.slice(0, 1), context));
        const swapped = render(<ProblemsPanelView snapshot={second} onClear={() => undefined} />).container;
        expect(swapped.querySelectorAll(".gglab-bottom-view-row").length).toBe(1);
        expect(swapped.textContent).toContain("connection-type-mismatch");
        expect(swapped.textContent).not.toContain("HLSL declaration error");
    });

    it("an empty snapshot says exactly that, and Clear is disabled (there is nothing to clear)", () => {
        const view = render(<ProblemsPanelView snapshot={emptyProblemSnapshot()} onClear={() => undefined} />).container;
        expect(view.textContent).toContain("No current problems.");
        const clear = view.querySelector<HTMLButtonElement>(".gglab-bottom-view-clear");
        expect(clear?.disabled).toBe(true);
    });

    it("Clear is a PRESENTATION action only: it calls the handler and leaves the snapshot value (and the owners behind it) untouched", () => {
        let cleared = 0;
        const snapshot = composeProblemSnapshot(graphDiagnostics, context, liveBuildLine([failedOne]).session, null);
        const frozenEntries: readonly { readonly identity: string }[] = snapshot.entries;
        const view = render(
            <ProblemsPanelView
                snapshot={snapshot}
                onClear={() => {
                    cleared += 1;
                }}
            />,
        ).container;
        expect(view.querySelectorAll(".gglab-bottom-view-row").length).toBe(4);
        const clear = view.querySelector<HTMLButtonElement>(".gglab-bottom-view-clear");
        expect(clear).not.toBeNull();
        expect(clear?.disabled).toBe(false);
        fireEvent.click(clear as HTMLElement);
        expect(cleared).toBe(1);
        // THE PIN: the view never mutated the snapshot it was given —
        // clearing the presentation is the caller replacing the value,
        // never a write path through the view.
        expect(snapshot.entries).toBe(frozenEntries);
        expect(snapshot.entries.length).toBe(4);
    });
});

// --- The CURRENT diagnostic coordinate (a snapshot, not a history) ----------

describe("the current diagnostic coordinate", () => {
    it("build: failure #1 carries current diagnostics, and a SUCCESS settlement #2 drops them (history stays on the chronology)", () => {
        expect(currentBuildFailureRecord(liveBuildLine([failedOne]).session)?.buildId.sequence).toBe(1);
        // THE REQUIRED REGRESSION: failure #1 -> success #2 -> #1's
        // diagnostics no longer current (the coordinate is #2, and it
        // projects no failure entries).
        const after = liveBuildLine([failedOne, succeededTwo]).session;
        expect(currentBuildFailureRecord(after)).toBeNull();
        const snapshot = composeProblemSnapshot([], context, after, null);
        expect(snapshot.entries).toHaveLength(0);
    });

    it("build: a PENDING newest attempt keeps the latest settlement's diagnostics (explicit policy), and drops them the moment that attempt settles as a success", () => {
        // Newer attempt still in flight: the latest SETTLED attempt
        // remains the current coordinate (a pending attempt states no
        // diagnostic yet).
        const pendingInFlight: InFlightBuild[] = [{ buildId: { sequence: 3 }, intent }];
        expect(currentBuildFailureRecord({ ...liveBuildLine([failedOne]).session, inFlight: pendingInFlight })?.buildId.sequence).toBe(1);
        // The moment #3 settles as a success, #1's diagnostics drop out:
        const settledSuccess = buildRecord(3, { kind: "succeeded", envelope: buildSuccessEnvelope });
        expect(currentBuildFailureRecord(liveBuildLine([failedOne, settledSuccess]).session)).toBeNull();
    });

    it("preview: failure #1 carries current diagnostics, and a PUBLISHED settlement #2 drops them", () => {
        expect(currentPreviewFailureRow(previewLine([previewFailedOne]))?.record.attemptSequence).toBe(1);
        // THE REQUIRED REGRESSION: failure #1 -> published #2 -> #1's
        // diagnostics no longer current.
        const after = previewLine([previewFailedOne, previewPublishedTwo]);
        expect(currentPreviewFailureRow(after)).toBeNull();
        const snapshot = composeProblemSnapshot([], context, null, after);
        expect(snapshot.entries).toHaveLength(0);
    });

    it("preview: a PENDING newest attempt keeps the latest settlement's diagnostics (the same explicit policy)", () => {
        // Pending #3 in flight: latest SETTLED (#1, failed) is the
        // current coordinate — its diagnostics remain the current state.
        expect(currentPreviewFailureRow(previewLine([previewFailedOne, previewPendingThree]))?.record.attemptSequence).toBe(1);
        // And once #3 settles (as a publication), they drop out:
        expect(currentPreviewFailureRow(previewLine([previewFailedOne, previewPublishedTwo, previewPendingThree]))).toBeNull();
    });

    it("a settled CANCELLATION or a termination without an envelope projects no current problem (the vocabulary refuses to invent one)", () => {
        const canceled = buildRecord(2, { kind: "canceled" });
        expect(composeProblemSnapshot([], context, liveBuildLine([failedOne, canceled]).session, null).entries).toHaveLength(0);
        const terminated = buildRecord(2, { kind: "failed", termination: { kind: "timed-out" } });
        expect(composeProblemSnapshot([], context, liveBuildLine([failedOne, terminated]).session, null).entries).toHaveLength(0);
        const previewTerminated = previewAttempt(2, { kind: "failed", termination: { kind: "timed-out" } });
        expect(currentPreviewFailureRow(previewLine([previewFailedOne, previewTerminated]))).toBeNull();
    });
});

// --- Re-derivation on render (no stable-object-identity staleness) ----------

describe("the composition re-reads the CURRENT owner facts on every render", () => {
    function Probe(props: { flow: { readonly buildSession: NativeBuildSession }; settleNext: () => void }) {
        const [, setTick] = useState(0);
        // The app's composition SHAPE: re-derived on every render from
        // the current session value — never memoized on the stable
        // flow object's identity.
        const snapshot: ProblemSnapshot = composeProblemSnapshot(graphDiagnostics, context, props.flow.buildSession, null);
        return (
            <div>
                <ul>
                    {snapshot.entries.map((entry) => (
                        <li key={entry.identity}>{entry.text}</li>
                    ))}
                </ul>
                <button type="button" onClick={() => { props.settleNext(); setTick((value) => value + 1); }}>
                    owner settles
                </button>
            </div>
        );
    }

    it("THE REGRESSION: the owner settles a NEWER attempt under the SAME flow object, and the re-rendered composition reflects the new diagnostic state", () => {
        const live = liveBuildLine([failedOne]);
        const flow = { buildSession: live.session };
        const view = render(
            <Probe
                flow={flow}
                settleNext={() => {
                    // The owner's own settlement under the same session
                    // object: the flow wrapper keeps its identity.
                    live.attempts.push(buildRecord(2, { kind: "succeeded", envelope: buildSuccessEnvelope }));
                }}
            />,
        ).container;
        // Before: the failure #1 coordinate's diagnostics are current.
        expect(view.textContent).toContain("HLSL declaration error");
        expect(view.querySelectorAll("li").length).toBe(4); // 2 graph + 2 build
        // The owner settles success #2 (same flow object; the render tick
        // is the app's own re-render path):
        const button = view.querySelector("button");
        expect(button).not.toBeNull();
        fireEvent.click(button as HTMLButtonElement);
        // After: #1's diagnostics are NO LONGER the current state — the
        // re-render read the CURRENT line, not a memoized copy keyed on
        // the stable flow object.
        expect(view.textContent).not.toContain("HLSL declaration error");
        expect(view.querySelectorAll("li").length).toBe(2); // the 2 graph entries only
        // The graph-native current state (the active document's own facts)
        // is untouched by the build settlement:
        expect(view.textContent).toContain("Port types do not match on the connection");
    });
});

// --- The wiring and the boundary are pinned ---------------------------------

describe("the problems wiring and boundary", () => {
    it("the app composes the snapshot from the owners' structured facts (the current document's set, the lines' current coordinates) — no load-result disguise, no display-string parsing", () => {
        const app = read("../src/app.tsx");
        expect(app).toContain("composeWorkspaceProblemSnapshot");
        const composition = read("../src/problems-composition.ts");
        expect(composition).toContain("validateShaderGraph(graph).diagnostics");
        expect(composition).toContain("checkProfileConformance(graph, selectedDescriptor).diagnostics");
        expect(composition).toContain("document.presentation.emission?.ok === false");
        // THE LOAD-RESULT PIN: kept on its own surface, never composed
        // under the current document's identity:
        expect(app).not.toContain("problemEntriesFromGraphDiagnostics(loadResult");
        // The owners' session values feed the composition:
        expect(app).toContain("native.flow?.buildSession ?? null");
        expect(app).toContain("preview.flow?.session ?? null");
        // Presentation-only Clear through the view:
        expect(app).toContain("<ProblemsPanelView snapshot={shownProblemsSnapshot} onClear={clearProblemsPresentation} navigation={problemNavigation} onNavigate={navigateProblem} />");
        expect(app).toContain("emptyProblemSnapshot()");
    });

    it("the composition module stays headless and owner-boundary-clean (no React, no sealed internals, no append path)", () => {
        const composition = read("../src/problems-composition.ts");
        expect(composition).not.toContain(`from "react"`);
        expect(composition).not.toContain("preview-coordinator");
        expect(composition).not.toContain("preview-runtime-manager");
        expect(composition).not.toContain("workspace-store");
        expect(composition).not.toContain("window");
        // Replacement only (the snapshot's lifecycle), never an append
        // path over a prior snapshot:
        expect(composition).toContain("createProblemSnapshot");
        expect(composition).not.toContain("replaceProblemSnapshot(previous");
        expect(composition).not.toContain("[...snapshot");
        // And it consumes the frozen vocabulary's projectors verbatim:
        expect(composition).toContain("problemEntriesFromGraphDiagnostics");
        expect(composition).toContain("problemEntriesFromBuildAttempt");
        expect(composition).toContain("problemEntriesFromPreviewAttempt");
    });
});
