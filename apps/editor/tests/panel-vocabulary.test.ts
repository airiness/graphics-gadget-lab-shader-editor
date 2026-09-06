/**
 * The bottom-panel presentation vocabulary, headless: the shared correlation
 * identity vocabulary, the typed projections over each owner's record, the
 * Output presentation line, and the replaceable Problems snapshot — plus
 * the boundary that this vocabulary stays a NON-authority (no React, no
 * host, no owner internals).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import type {
    AttemptRecord,
    BuildIntent,
    BuildLine,
    PendingPreviewAttempt,
    PreviewBuildIntent,
    PreviewBuildLine,
    PreviewBuildSuccessDocument,
    SettledPreviewAttempt,
    ToolCandidate,
    ToolDiagnostic,
} from "@gglab/shader-toolchain-client";
import {
    EMPTY_EVIDENCE_CORRELATION,
    appendOutputEvent,
    buildChronology,
    buildRowFromAttempt,
    correlationRefines,
    correlationsEqual,
    createOutputEvent,
    createProblemSnapshot,
    emptyOutputLine,
    emptyProblemSnapshot,
    nextOutputSequence,
    problemEntryFromGraphDiagnostic,
    problemEntryFromToolDiagnostic,
    previewChronology,
    previewRowFromAttempt,
    replaceProblemSnapshot,
    type EvidenceCorrelation,
    type PanelProjectionContext,
    type ProblemSnapshotEntry,
    type PreviewBuildSessionFacts,
} from "../src/panel-vocabulary.js";
import { createDocumentSessionId, type DocumentSessionId } from "../src/workspace-session.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// --- Owner-shaped fixtures (the owners' exact vocabularies) ----------------

const session: DocumentSessionId = createDocumentSessionId("document-session-vocabulary");
const context: PanelProjectionContext = { documentSessionId: session, documentRevision: "revision-1" };

const buildIntent: BuildIntent = {
    sourceIdentity: "generated-source-1",
    target: "gglab.surface",
    stage: "vertex",
    entry: "main",
    defines: [],
    includes: [],
    tool: { identity: "gglab-shaderc", version: "1.0.0", processContractVersion: 2, compilePolicyRevision: 1, producerIdentity: "dx-prod-1" },
};
const attemptOne: AttemptRecord = { buildId: { sequence: 1 }, intent: buildIntent, outcome: { kind: "canceled" } };
const attemptTwo: AttemptRecord = { buildId: { sequence: 2 }, intent: buildIntent, outcome: { kind: "failed", termination: { kind: "timed-out" } } };
// Arrival order is NOT chronology: the slower older attempt settled first.
const buildLine: BuildLine = { attempts: [attemptTwo, attemptOne] };

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
    diagnostics: [],
};
const previewOne: SettledPreviewAttempt = { attemptSequence: 1, buildId: { sequence: 1 }, candidate, intent: previewIntent, state: "settled", outcome: { kind: "published", envelope: publication } };
const previewTwo: PendingPreviewAttempt = { attemptSequence: 2, buildId: { sequence: 2 }, candidate, intent: previewIntent, state: "pending" };
const previewLine: PreviewBuildLine = { attempts: [previewTwo, previewOne] }; // arrival order
const previewSession: PreviewBuildSessionFacts = { sessionId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", line: previewLine };

const graphDiagnostic: ShaderGraphDiagnostic = { code: "TYPE_MISMATCH", severity: "error", message: "input types do not agree", dataPath: "$.nodes[3].inputs[1]" };
const toolDiagnosticLocated: ToolDiagnostic = { message: "HLSL declaration error", sourceIdentity: "generated-source-1" };
const toolDiagnosticUnlocated: ToolDiagnostic = { message: "compiler process could not run" };

describe("the shared correlation identity vocabulary", () => {
    it("is fully empty by default, and refines nothing specific", () => {
        for (const value of Object.values(EMPTY_EVIDENCE_CORRELATION)) {
            expect(value).toBeNull();
        }
        // The empty filter matches every correlation…
        const anyCorr: EvidenceCorrelation = { ...EMPTY_EVIDENCE_CORRELATION, publicationId: "publication-1" };
        expect(correlationRefines(EMPTY_EVIDENCE_CORRELATION, anyCorr)).toBe(true);
        // …but a correlation that names nothing refines a filter that names
        // something: absence of an identity is not that identity.
        expect(correlationRefines(anyCorr, EMPTY_EVIDENCE_CORRELATION)).toBe(false);
    });

    it("compares BuildId by its sequence, not by object identity", () => {
        const left = { ...EMPTY_EVIDENCE_CORRELATION, buildId: { sequence: 7 } };
        const right = { ...EMPTY_EVIDENCE_CORRELATION, buildId: { sequence: 7 } };
        expect(correlationsEqual(left, right)).toBe(true);
        expect(correlationsEqual(left, { ...left, buildId: { sequence: 8 } })).toBe(false);
    });

    it("keeps Build #1 and Preview attempt #1 in distinct namespaces", () => {
        const buildRow = buildRowFromAttempt(context, attemptOne);
        const previewRow = previewRowFromAttempt(context, previewSession, previewOne);
        // The two rows share the build id and the generated source…
        expect(buildRow.correlation.buildId?.sequence).toBe(1);
        expect(previewRow.correlation.buildId?.sequence).toBe(1);
        expect(buildRow.correlation.generatedSourceIdentity).toBe("generated-source-1");
        expect(previewRow.correlation.generatedSourceIdentity).toBe("generated-source-1");
        // …but a preview row always co-carries the preview axes, and a
        // build row never does:
        expect(buildRow.correlation.previewAttemptSequence).toBeNull();
        expect(buildRow.correlation.previewSessionId).toBeNull();
        expect(previewRow.correlation.previewAttemptSequence).toBe(1);
        expect(previewRow.correlation.previewSessionId).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
        expect(correlationsEqual(buildRow.correlation, previewRow.correlation)).toBe(false);
        // A preview-namespace filter must NOT match the build row…
        expect(correlationRefines(previewRow.correlation, buildRow.correlation)).toBe(false);
        // …while the preview row DOES refine a build-id filter:
        expect(correlationRefines({ ...EMPTY_EVIDENCE_CORRELATION, buildId: { sequence: 1 } }, previewRow.correlation)).toBe(true);
    });
});

describe("the Build projection (over the client's build line)", () => {
    it("orders the chronology by the line's own authority: BuildId sequence, not arrival position", () => {
        expect(buildChronology(context, buildLine).map((row) => row.correlation.buildId?.sequence)).toEqual([1, 2]);
    });

    it("derives each row's correlation from the record — the owner's facts, none invented", () => {
        const row = buildRowFromAttempt(context, attemptOne);
        expect(row.correlation.documentSessionId).toBe(session);
        expect(row.correlation.documentRevision).toBe("revision-1");
        expect(row.correlation.generatedSourceIdentity).toBe("generated-source-1");
        expect(row.correlation.publicationId).toBeNull();
        // The owner's record, carried by reference — the projection does
        // not re-encode it, it presents it.
        expect(row.record).toBe(attemptOne);
    });

    it("projects with value semantics: the owner's line stays arrival-ordered and untouched", () => {
        const projection = buildChronology(context, buildLine);
        expect(projection).toHaveLength(2);
        expect(projection).not.toBe(buildLine.attempts);
        expect(buildLine.attempts).toHaveLength(2);
        expect(buildLine.attempts[0]?.buildId.sequence).toBe(2);
        expect(buildLine.attempts[1]?.buildId.sequence).toBe(1);
    });
});

describe("the Preview projection (over the client's preview line)", () => {
    it("orders the chronology by attempt sequence, not arrival position", () => {
        const projection = previewChronology(context, previewSession);
        expect(projection.map((row) => row.correlation.previewAttemptSequence)).toEqual([1, 2]);
    });

    it("derives the correlation from the record and the owning session identity", () => {
        const row = previewChronology(context, previewSession)[0];
        expect(row).not.toBeUndefined();
        if (row !== undefined) {
            expect(row.correlation.buildId?.sequence).toBe(1);
            expect(row.correlation.generatedSourceIdentity).toBe("generated-source-1");
            expect(row.correlation.previewSessionId).toBe("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
            expect(row.record).toBe(previewOne);
        }
    });

    it("carries the publication identity only on the attempt that published", () => {
        const projection = previewChronology(context, previewSession);
        const first = projection[0];
        const second = projection[1];
        expect(first?.correlation.publicationId).toBe("publication-1");
        expect(second?.correlation.publicationId).toBeNull();
        const secondRecord = second?.record;
        expect(secondRecord !== undefined && secondRecord.state === "pending").toBe(true);
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
        const correlation: EvidenceCorrelation = { ...EMPTY_EVIDENCE_CORRELATION, documentSessionId: session, documentRevision: "revision-1" };
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
    it("projects a graph-native diagnostic with the core's location authority and a document-context correlation", () => {
        const entry = problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, context);
        expect(entry.severity).toBe("error");
        expect(entry.code).toBe("TYPE_MISMATCH");
        expect(entry.text).toBe("input types do not agree");
        expect(entry.location).toEqual({ kind: "graph", dataPath: "$.nodes[3].inputs[1]" });
        expect(entry.correlation.documentSessionId).toBe(session);
        expect(entry.correlation.documentRevision).toBe("revision-1");
        // The diagnostic carries no emission identity: the axis stays absent,
        // not invented.
        expect(entry.correlation.generatedSourceIdentity).toBeNull();
    });

    it("projects a toolchain diagnostic verbatim: location AND generated-source axis from the diagnostic's own fact", () => {
        const located = problemEntryFromToolDiagnostic("tool-1", toolDiagnosticLocated, "error", context);
        expect(located.code).toBeNull();
        expect(located.location).toEqual({ kind: "generated-source", sourceIdentity: "generated-source-1" });
        expect(located.correlation.generatedSourceIdentity).toBe("generated-source-1");
        const unlocated = problemEntryFromToolDiagnostic("tool-2", toolDiagnosticUnlocated, "warning", context);
        expect(unlocated.severity).toBe("warning");
        expect(unlocated.location).toEqual({ kind: "unplaced" });
        expect(unlocated.correlation.generatedSourceIdentity).toBeNull();
    });

    it("copies the caller's entries: later mutation of the input cannot reach the view", () => {
        const source: ProblemSnapshotEntry[] = [problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, context)];
        const snapshot = createProblemSnapshot(source);
        expect(snapshot.entries).not.toBe(source);
        source.push(problemEntryFromGraphDiagnostic("graph-2", graphDiagnostic, context));
        expect(snapshot.entries).toHaveLength(1);
    });

    it("replaces the snapshot wholesale — never appends into the previous one", () => {
        const first = createProblemSnapshot([problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, context)]);
        const second = replaceProblemSnapshot([
            problemEntryFromToolDiagnostic("tool-1", toolDiagnosticLocated, "error", context),
        ]);
        expect(second.entries).not.toBe(first.entries);
        expect(second.entries.map((entry) => entry.identity)).toEqual(["tool-1"]);
        // The previous snapshot is simply no longer the current one:
        // untouched, unextended — replacement, not accumulation.
        expect(first.entries).toHaveLength(1);
        expect(first.entries.map((entry) => entry.identity)).toEqual(["graph-1"]);
    });

    it("clears into a fresh empty snapshot", () => {
        const first = createProblemSnapshot([problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, context)]);
        const cleared = emptyProblemSnapshot();
        expect(cleared.entries).toHaveLength(0);
        expect(first.entries).toHaveLength(1);
    });
});

describe("the vocabulary boundary", () => {
    it("stays headless and projects owner facts without touching owner internals", () => {
        const source = read("../src/panel-vocabulary.ts");
        // No frontend or host surface: the vocabulary is presentation data.
        expect(source).not.toContain('from "react"');
        expect(source).not.toContain("window.");
        // No sealed ownership internals: it carries their identities, it does
        // not reach into them.
        expect(source).not.toContain("preview-coordinator");
        expect(source).not.toContain("workspace-store");
        expect(source).not.toContain("preview-runtime-manager");
    });
});
