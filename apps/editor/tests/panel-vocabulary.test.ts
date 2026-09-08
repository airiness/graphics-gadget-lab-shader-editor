/**
 * The bottom-panel presentation vocabulary, headless: the shared correlation
 * identity vocabulary, the typed projections over each owner's records
 * (build session, preview session, enclosing attempt), the Output
 * presentation line, and the replaceable Problems snapshot — plus the
 * boundary that this vocabulary stays a NON-authority (no React, no host,
 * no sealed-ownership internals, no invented state or severity facts).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DiagnosticSeverity, ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import type {
    AttemptRecord,
    BuildIntent,
    CompileFailureDocument,
    CompileSuccessDocument,
    PendingPreviewAttempt,
    PreviewBuildExecutionFailureDocument,
    PreviewBuildIntent,
    PreviewBuildSuccessDocument,
    SettledPreviewAttempt,
    ToolCandidate,
} from "@gglab/shader-toolchain-client";
import type { InFlightBuild, NativeBuildSession } from "../src/native-build-session.js";
import type { PreviewBuildSession } from "../src/preview-build-session.js";
import {
    EMPTY_EVIDENCE_CORRELATION,
    appendOutputEvent,
    buildChronology,
    correlationRefines,
    correlationsEqual,
    createOutputEvent,
    createProblemSnapshot,
    emptyOutputLine,
    emptyProblemSnapshot,
    nextOutputSequence,
    problemEntriesFromBuildAttempt,
    problemEntriesFromGraphDiagnostics,
    problemEntriesFromPreviewAttempt,
    previewChronology,
    replaceProblemSnapshot,
    type PreviewRow,
    type EvidenceCorrelation,
    type PanelDocumentContext,
    type ProblemSnapshotEntry,
} from "../src/panel-vocabulary.js";
import { createDocumentSessionId, type DocumentSessionId } from "../src/workspace-session.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// --- Owner-shaped fixtures (the owners' exact vocabularies) ----------------

const session: DocumentSessionId = createDocumentSessionId("document-session-vocabulary");
const context: PanelDocumentContext = { documentSessionId: session, documentRevision: "revision-current" };

const intentOne: BuildIntent = {
    sourceIdentity: "generated-source-1",
    target: "gglab.surface",
    stage: "vertex",
    entry: "main",
    defines: [],
    includes: [],
    tool: { identity: "gglab-shaderc", version: "1.0.0", processContractVersion: 2, compilePolicyRevision: 1, producerIdentity: "dx-prod-1" },
};
const intentTwo: BuildIntent = { ...intentOne, stage: "fragment" };
const intentThree: BuildIntent = { ...intentOne, entry: "alt_main" };
const buildFailureEnvelope: CompileFailureDocument = {
    command: "compile",
    success: false,
    status: "compile-failed",
    exitCode: 1,
    diagnostics: [
        { message: "HLSL declaration error", sourceIdentity: "generated-source-1" },
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
const settledOne: AttemptRecord = { buildId: { sequence: 1 }, intent: intentOne, outcome: { kind: "failed", envelope: buildFailureEnvelope } };
const settledTwo: AttemptRecord = { buildId: { sequence: 2 }, intent: intentOne, outcome: { kind: "canceled" } };
const settledFour: AttemptRecord = { buildId: { sequence: 4 }, intent: intentOne, outcome: { kind: "succeeded", envelope: buildSuccessEnvelope } };
const settledSix: AttemptRecord = { buildId: { sequence: 6 }, intent: intentThree, outcome: { kind: "succeeded", envelope: buildSuccessEnvelope } };
const settledSeven: AttemptRecord = { buildId: { sequence: 7 }, intent: intentTwo, outcome: { kind: "succeeded", envelope: buildSuccessEnvelope } };
const inFlightThree: InFlightBuild = { buildId: { sequence: 3 }, intent: intentOne };
// The owner's own session shape. The line's state mix exercises the owner's
// full attempt-state vocabulary against the issued anchor (intentOne):
// #1 failed, #2 canceled, #4 current (newest success within the anchor
// intent), #6 stale (a success outside that), #7 last-good (newest success
// overall), #3 in flight.
const buildSession: NativeBuildSession = {
    line: { attempts: [settledTwo, settledSeven, settledOne, settledSix, settledFour] },
    inFlight: [inFlightThree],
    lastIssued: inFlightThree,
};

const sessionIdA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const sessionIdB = "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0";
const previewIntent: PreviewBuildIntent = {
    targetProfile: "gglab.preview",
    profileId: "gglab.surface",
    profileVersion: 1,
    previewInputContractId: "preview-contract-1",
    previewProgramDescriptorIdentity: "descriptor-1",
    generatedSourceIdentity: "generated-source-1",
    toolIdentity: "gglab-shaderc",
    toolVersion: "1.0.0",
    processContractVersion: 2,
    previewBuildContractVersion: 1,
    compilePolicyRevision: 1,
    producerKind: "dx",
    producerIdentity: "dx-prod-1",
};
const candidate: ToolCandidate = { rule: "explicit-config", toolPath: "C:\\tool\\gglab-shaderc.exe", observationIdentity: "observation-1", resolvedAt: 0 };
const publication: PreviewBuildSuccessDocument = {
    command: "build-preview",
    success: true,
    status: "ok",
    exitCode: 0,
    attemptSequence: 1,
    publicationId: "publication-1",
    shaderArtifactId: "artifact-1",
    baseRegistryId: "base-registry-1",
    previewRegistryId: "preview-registry-1",
    // A successful settlement can carry structured notes: they stay owner
    // facts on the outcome — the Problems view must not re-label them.
    diagnostics: [{ message: "preview advisory note" }],
};
const previewFailureEnvelope: PreviewBuildExecutionFailureDocument = {
    command: "build-preview",
    success: false,
    status: "compile-failed",
    exitCode: 1,
    attemptSequence: 2,
    diagnostics: [
        { message: "HLSL type error", sourceIdentity: "generated-source-1" },
        { message: "preview writer unavailable" },
    ],
};
const previewOne: SettledPreviewAttempt = { attemptSequence: 1, buildId: { sequence: 1 }, candidate, intent: previewIntent, state: "settled", outcome: { kind: "published", envelope: publication } };
const previewFailed: SettledPreviewAttempt = { attemptSequence: 2, buildId: { sequence: 2 }, candidate, intent: previewIntent, state: "settled", outcome: { kind: "failed", envelope: previewFailureEnvelope } };
const previewPending: PendingPreviewAttempt = { attemptSequence: 3, buildId: { sequence: 3 }, candidate, intent: previewIntent, state: "pending" };
const previewSessionA: PreviewBuildSession = {
    sessionId: sessionIdA,
    line: { attempts: [previewPending, previewOne, previewFailed] }, // arrival order
    nextAttemptSequence: 4,
};
const previewFailB: SettledPreviewAttempt = { attemptSequence: 1, buildId: { sequence: 1 }, candidate, intent: previewIntent, state: "settled", outcome: { kind: "failed", envelope: previewFailureEnvelope } };
const previewSessionB: PreviewBuildSession = {
    sessionId: sessionIdB,
    line: { attempts: [previewFailB] },
    nextAttemptSequence: 2,
};

const graphDiagnostic: ShaderGraphDiagnostic = { code: "TYPE_MISMATCH", severity: "error", message: "input types do not agree", dataPath: "$.nodes[3].inputs[1]" };
const graphDuplicate: ShaderGraphDiagnostic = { code: "TYPE_MISMATCH", severity: "warning", message: "second report on the same port", dataPath: "$.nodes[3].inputs[1]" };

describe("the shared correlation identity vocabulary", () => {
    it("is fully empty by default, and refines nothing specific", () => {
        for (const value of Object.values(EMPTY_EVIDENCE_CORRELATION)) {
            expect(value).toBeNull();
        }
        const anyCorr: EvidenceCorrelation = { ...EMPTY_EVIDENCE_CORRELATION, publicationId: "publication-1" };
        expect(correlationRefines(EMPTY_EVIDENCE_CORRELATION, anyCorr)).toBe(true);
        expect(correlationRefines(anyCorr, EMPTY_EVIDENCE_CORRELATION)).toBe(false);
    });

    it("compares BuildId by its sequence, not by object identity", () => {
        const left = { ...EMPTY_EVIDENCE_CORRELATION, buildId: { sequence: 7 } };
        const right = { ...EMPTY_EVIDENCE_CORRELATION, buildId: { sequence: 7 } };
        expect(correlationsEqual(left, right)).toBe(true);
        expect(correlationsEqual(left, { ...left, buildId: { sequence: 8 } })).toBe(false);
    });

    it("does not stamp historical attempt rows with today's document context", () => {
        const buildRow = buildChronology(buildSession)[0];
        const previewRow = previewChronology(previewSessionA)[0];
        expect(buildRow).not.toBeUndefined();
        expect(previewRow).not.toBeUndefined();
        if (buildRow !== undefined && previewRow !== undefined) {
            expect(buildRow.correlation.documentSessionId).toBeNull();
            expect(buildRow.correlation.documentRevision).toBeNull();
            expect(previewRow.correlation.documentSessionId).toBeNull();
            expect(previewRow.correlation.documentRevision).toBeNull();
        }
    });

    it("keeps Build #1 and Preview attempt #1 in distinct namespaces", () => {
        const buildRow = buildChronology(buildSession).find((row) => row.buildId.sequence === 1);
        const previewRow = previewChronology(previewSessionA).find((row) => row.record.attemptSequence === 1);
        expect(buildRow).not.toBeUndefined();
        expect(previewRow).not.toBeUndefined();
        if (buildRow !== undefined && previewRow !== undefined) {
            expect(buildRow.correlation.buildId?.sequence).toBe(1);
            expect(previewRow.correlation.buildId?.sequence).toBe(1);
            expect(buildRow.correlation.generatedSourceIdentity).toBe("generated-source-1");
            expect(previewRow.correlation.generatedSourceIdentity).toBe("generated-source-1");
            // A preview row always co-carries the preview axes; a build row
            // never does:
            expect(buildRow.correlation.previewAttemptSequence).toBeNull();
            expect(buildRow.correlation.previewSessionId).toBeNull();
            expect(previewRow.correlation.previewAttemptSequence).toBe(1);
            expect(previewRow.correlation.previewSessionId).toBe(sessionIdA);
            expect(correlationsEqual(buildRow.correlation, previewRow.correlation)).toBe(false);
            expect(correlationRefines(previewRow.correlation, buildRow.correlation)).toBe(false);
            expect(correlationRefines({ ...EMPTY_EVIDENCE_CORRELATION, buildId: { sequence: 1 } }, previewRow.correlation)).toBe(true);
        }
    });
});

describe("the Build projection (over the owner's build session)", () => {
    it("keeps in-flight attempts visible, ordered by BuildId sequence", () => {
        const projection = buildChronology(buildSession);
        expect(projection.map((row) => row.buildId.sequence)).toEqual([1, 2, 3, 4, 6, 7]);
    });

    it("carries the owner's full attempt-state vocabulary — the UI will render it, not re-derive it", () => {
        const projection = buildChronology(buildSession);
        expect(projection.map((row) => row.state)).toEqual([
            "failed", // #1: a failed settlement is a failed state
            "canceled", // #2: an explicit cancellation is its own state
            "in-flight", // #3: issued, not yet settled
            "current", // #4: newest success within the anchor intent
            "stale", // #6: a success outside the anchor's currentness
            "last-good", // #7: the newest success overall
        ]);
    });

    it("carries the owner's records by reference — settled as AttemptRecord, in-flight as the owner's in-flight fact", () => {
        const projection = buildChronology(buildSession);
        const first = projection[0];
        const third = projection[2];
        expect(first).not.toBeUndefined();
        expect(third).not.toBeUndefined();
        if (first !== undefined && first.state === "failed" && third !== undefined && third.state === "in-flight") {
            expect(first.record).toBe(settledOne);
            expect(first.outcome).toBe(settledOne.outcome);
            expect(third.record).toBe(inFlightThree);
        }
    });

    it("derives each row's correlation from the record — owner facts only, no invented axes", () => {
        const row = buildChronology(buildSession)[0];
        expect(row).not.toBeUndefined();
        if (row !== undefined) {
            expect(row.correlation.generatedSourceIdentity).toBe("generated-source-1");
            expect(row.correlation.buildId?.sequence).toBe(1);
            expect(row.correlation.previewAttemptSequence).toBeNull();
            expect(row.correlation.publicationId).toBeNull();
        }
    });

    it("projects with value semantics: the owner's session stays untouched", () => {
        buildChronology(buildSession);
        expect(buildSession.line.attempts).toHaveLength(5);
        expect(buildSession.line.attempts[0]?.buildId.sequence).toBe(2); // arrival order preserved
        expect(buildSession.inFlight).toHaveLength(1);
    });
});

describe("the Preview projection (over the owner's Preview session)", () => {
    it("orders the chronology by attempt sequence, not arrival position", () => {
        const projection = previewChronology(previewSessionA);
        expect(projection.map((row) => row.record.attemptSequence)).toEqual([1, 2, 3]);
    });

    it("derives the correlation from the record and the owning session identity", () => {
        const row = previewChronology(previewSessionA)[0];
        expect(row).not.toBeUndefined();
        if (row !== undefined) {
            expect(row.correlation.buildId?.sequence).toBe(1);
            expect(row.correlation.generatedSourceIdentity).toBe("generated-source-1");
            expect(row.correlation.previewAttemptSequence).toBe(1);
            expect(row.correlation.previewSessionId).toBe(sessionIdA);
            expect(row.record).toBe(previewOne);
        }
    });

    it("carries the publication identity only on the attempt that published", () => {
        const projection = previewChronology(previewSessionA);
        expect(projection[0]?.correlation.publicationId).toBe("publication-1");
        expect(projection[1]?.correlation.publicationId).toBeNull();
        expect(projection[2]?.correlation.publicationId).toBeNull();
    });

    it("projects with value semantics: the owner's session stays untouched", () => {
        previewChronology(previewSessionA);
        expect(previewSessionA.line.attempts).toHaveLength(3);
        expect(previewSessionA.line.attempts[0]).toBe(previewPending); // arrival order preserved
    });

    it("is a branded projection value: a hand-assembled record/correlation pairing cannot satisfy the row type", () => {
        const row = previewChronology(previewSessionA)[0];
        expect(row).not.toBeUndefined();
        if (row !== undefined) {
            // Type-level pin: the directive below makes typecheck fail if
            // this assignment ever stops erroring — i.e. if the module's
            // projection brand disappears and the normal typed path to
            // forge a row opens again.
            // @ts-expect-error a PreviewRow carries the projection's module-private brand, which a literal cannot carry
            const forged: PreviewRow = { record: previewOne, correlation: row.correlation };
            expect(forged).toBeDefined();
        }
    });
});

describe("the toolchain diagnostics, projected from the enclosing attempt", () => {
    it("projects a failure attempt's diagnostics as errors, correlated to that attempt", () => {
        const entries = problemEntriesFromBuildAttempt(settledOne);
        expect(entries).toHaveLength(2);
        for (const entry of entries) {
            expect(entry.severity).toBe("error");
            expect(entry.code).toBeNull();
            // The generated-source axis comes from the ENCLOSING attempt's
            // intent, even when the diagnostic has no location fact…
            expect(entry.correlation.generatedSourceIdentity).toBe("generated-source-1");
            expect(entry.correlation.buildId?.sequence).toBe(1);
            expect(entry.correlation.previewAttemptSequence).toBeNull();
            // …and is never stamped with today's document context.
            expect(entry.correlation.documentSessionId).toBeNull();
            expect(entry.correlation.documentRevision).toBeNull();
        }
        const located = entries[0];
        const unlocated = entries[1];
        expect(located).not.toBeUndefined();
        expect(unlocated).not.toBeUndefined();
        if (located !== undefined && unlocated !== undefined) {
            expect(located.location).toEqual({ kind: "generated-source", sourceIdentity: "generated-source-1" });
            expect(unlocated.location).toEqual({ kind: "unplaced" });
            expect(located.identity).toBe("build:1:generated-source-1@0");
            expect(unlocated.identity).toBe("build:1:unplaced@1");
        }
    });

    it("projects zero entries where there is no failure envelope (canceled, successful)", () => {
        expect(problemEntriesFromBuildAttempt(settledTwo)).toHaveLength(0);
        expect(problemEntriesFromBuildAttempt(settledFour)).toHaveLength(0);
    });

    it("projects a failed preview's diagnostics as errors, correlated to attempt AND session", () => {
        const row = previewChronology(previewSessionA).find((candidate) => candidate.record.attemptSequence === 2);
        expect(row).not.toBeUndefined();
        if (row !== undefined) {
            const entries = problemEntriesFromPreviewAttempt(row);
            expect(entries).toHaveLength(2);
            for (const entry of entries) {
                expect(entry.severity).toBe("error");
                expect(entry.correlation.previewAttemptSequence).toBe(2);
                expect(entry.correlation.previewSessionId).toBe(sessionIdA);
                expect(entry.correlation.publicationId).toBeNull();
                expect(entry.correlation.generatedSourceIdentity).toBe("generated-source-1");
            }
            const located = entries[0];
            const unlocated = entries[1];
            expect(located).not.toBeUndefined();
            expect(unlocated).not.toBeUndefined();
            if (located !== undefined && unlocated !== undefined) {
                expect(located.location).toEqual({ kind: "generated-source", sourceIdentity: "generated-source-1" });
                expect(unlocated.location).toEqual({ kind: "unplaced" });
            }
        }
    });

    it("does NOT project a successful preview's notes as Problems — they stay owner evidence on the outcome", () => {
        const row = previewChronology(previewSessionA)[0];
        expect(row).not.toBeUndefined();
        if (row !== undefined) {
            // The published envelope's advisory note exists (owner fact)…
            expect(row.record.state === "settled" && row.record.outcome.kind === "published").toBe(true);
            // …and projects zero Problems entries: no severity contract, no
            // invented severity.
            expect(problemEntriesFromPreviewAttempt(row)).toHaveLength(0);
        }
    });

    it("keeps a row's session binding: a session A row can never carry session B's identity", () => {
        const rowA = previewChronology(previewSessionA).find((candidate) => candidate.record.attemptSequence === 2);
        const rowB = previewChronology(previewSessionB)[0];
        expect(rowA).not.toBeUndefined();
        expect(rowB).not.toBeUndefined();
        if (rowA !== undefined && rowB !== undefined) {
            const entriesA = problemEntriesFromPreviewAttempt(rowA);
            const entriesB = problemEntriesFromPreviewAttempt(rowB);
            for (const entry of entriesA) {
                expect(entry.correlation.previewSessionId).toBe(sessionIdA);
            }
            for (const entry of entriesB) {
                expect(entry.correlation.previewSessionId).toBe(sessionIdB);
            }
            expect(entriesA.length).toBeGreaterThan(0);
            expect(entriesB.length).toBeGreaterThan(0);
        }
    });

    it("projects zero entries for a pending preview attempt", () => {
        const row = previewChronology(previewSessionA).find((candidate) => candidate.record.attemptSequence === 3);
        expect(row).not.toBeUndefined();
        if (row !== undefined) {
            expect(problemEntriesFromPreviewAttempt(row)).toHaveLength(0);
        }
    });
});

describe("the graph-native diagnostics (the CURRENT authoring snapshot)", () => {
    it("projects code, severity, message, and dataPath verbatim, under the document context", () => {
        const entries = problemEntriesFromGraphDiagnostics([graphDiagnostic], context);
        expect(entries).toHaveLength(1);
        const entry = entries[0];
        expect(entry).not.toBeUndefined();
        if (entry !== undefined) {
            expect(entry.severity).toBe("error");
            expect(entry.code).toBe("TYPE_MISMATCH");
            expect(entry.text).toBe("input types do not agree");
            expect(entry.location).toEqual({ kind: "graph", dataPath: "$.nodes[3].inputs[1]" });
            expect(entry.correlation.documentSessionId).toBe(session);
            expect(entry.correlation.documentRevision).toBe("revision-current");
            expect(entry.correlation.generatedSourceIdentity).toBeNull();
            expect(entry.identity).toBe(problemEntriesFromGraphDiagnostics([graphDiagnostic, graphDiagnostic], context)[1]?.identity);
        }
    });

    it("keeps logical identity across aggregation order and separates different facts", () => {
        const entries = problemEntriesFromGraphDiagnostics([graphDiagnostic, graphDuplicate, graphDiagnostic], context);
        expect(entries[0]?.identity).toBe(entries[2]?.identity);
        expect(entries[0]?.identity).not.toBe(entries[1]?.identity);
        expect(problemEntriesFromGraphDiagnostics([graphDuplicate, graphDiagnostic], context).map(entry => entry.identity)).toEqual([entries[1]?.identity, entries[0]?.identity]);
        expect(problemEntriesFromGraphDiagnostics([graphDiagnostic], { ...context, documentRevision: "next" })[0]?.identity).not.toBe(entries[0]?.identity);
    });
});

describe("the Output presentation line", () => {
    it("numbers its events from 1, monotonically, in order by construction", () => {
        let line = emptyOutputLine();
        expect(nextOutputSequence(line)).toBe(1);
        line = appendOutputEvent(line, createOutputEvent("session opened", { ...EMPTY_EVIDENCE_CORRELATION, documentSessionId: session }));
        line = appendOutputEvent(line, createOutputEvent("document revision changed"));
        expect(line.map((event) => event.sequence)).toEqual([1, 2]);
        expect(nextOutputSequence(line)).toBe(3);
    });

    it("appends with value semantics: the input line is untouched", () => {
        const first = appendOutputEvent(emptyOutputLine(), createOutputEvent("one"));
        const grown = appendOutputEvent(first, createOutputEvent("two"));
        expect(grown).not.toBe(first);
        expect(first).toHaveLength(1);
        expect(grown).toHaveLength(2);
    });

    it("keeps the event's summary and correlation verbatim", () => {
        const correlation: EvidenceCorrelation = { ...EMPTY_EVIDENCE_CORRELATION, documentSessionId: session, documentRevision: "revision-current" };
        const line = appendOutputEvent(emptyOutputLine(), createOutputEvent("note text", correlation));
        const event = line[0];
        expect(event).not.toBeUndefined();
        if (event !== undefined) {
            expect(event.text).toBe("note text");
            expect(correlationsEqual(event.correlation, correlation)).toBe(true);
        }
    });
});

describe("the replaceable current Problems snapshot", () => {
    it("copies the caller's entries: later mutation of the input cannot reach the view", () => {
        const source: ProblemSnapshotEntry[] = [...problemEntriesFromGraphDiagnostics([graphDiagnostic], context)];
        const snapshot = createProblemSnapshot(source);
        expect(snapshot.entries).not.toBe(source);
        source.push(...problemEntriesFromGraphDiagnostics([graphDuplicate], context));
        expect(snapshot.entries).toHaveLength(1);
    });

    it("replaces the snapshot wholesale — never appends into the previous one", () => {
        const first = createProblemSnapshot(problemEntriesFromGraphDiagnostics([graphDiagnostic], context));
        const second = replaceProblemSnapshot(problemEntriesFromBuildAttempt(settledOne));
        expect(second.entries).not.toBe(first.entries);
        // The previous snapshot is simply no longer the current one:
        // untouched, unextended — replacement, not accumulation.
        expect(first.entries).toHaveLength(1);
        expect(second.entries.map((entry) => entry.severity)).toEqual<DiagnosticSeverity[]>(["error", "error"]);
    });

    it("clears into a fresh empty snapshot", () => {
        const first = createProblemSnapshot(problemEntriesFromGraphDiagnostics([graphDiagnostic], context));
        const cleared = emptyProblemSnapshot();
        expect(cleared.entries).toHaveLength(0);
        expect(first.entries).toHaveLength(1);
    });
});

describe("the vocabulary boundary", () => {
    it("stays headless and projects owner facts without touching sealed ownership internals", () => {
        const source = read("../src/panel-vocabulary.ts");
        expect(source).not.toContain('from "react"');
        expect(source).not.toContain("window.");
        // It is typed on the owners' session types…
        expect(source).toContain("NativeBuildSession");
        expect(source).toContain("PreviewBuildSession");
        // …and the record/session binding is produced inside the projection
        // only: the per-record preview entry point is private…
        expect(source).not.toContain("export function previewRowFromAttempt");
        // …and the row type is a branded projection value (normal typed
        // construction of a forged pairing is closed).
        expect(source).toContain("declare const previewRowBrand: unique symbol");
        // …but does not reach into the sealed ownership internals:
        expect(source).not.toContain("preview-coordinator");
        expect(source).not.toContain("workspace-store");
        expect(source).not.toContain("preview-runtime-manager");
    });
});
