/**
 * The bottom-panel presentation vocabulary, headless: the shared correlation
 * identity vocabulary, the chronological event line and its per-view
 * projections, the replaceable Problems snapshot, and the boundary that this
 * vocabulary stays a NON-authority (no React, no host, no owner internals).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import type {
    AttemptOutcome,
    BuildId,
    BuildIntent,
    PreviewAttemptOutcome,
    PreviewBuildIntent,
    ToolCandidate,
    ToolDiagnostic,
} from "@gglab/shader-toolchain-client";
import {
    EMPTY_EVIDENCE_CORRELATION,
    appendEvent,
    correlationRefines,
    correlationsEqual,
    createProblemSnapshot,
    emptyEventLine,
    emptyProblemSnapshot,
    eventInView,
    eventsForView,
    nextEventSequence,
    problemEntryFromGraphDiagnostic,
    problemEntryFromToolDiagnostic,
    replaceProblemSnapshot,
    type EditorEvent,
    type EvidenceCorrelation,
    type ProblemSnapshotEntry,
} from "../src/panel-vocabulary.js";
import { createDocumentSessionId, type DocumentSessionId } from "../src/workspace-session.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// --- Owner-shaped fixtures (the owners' exact vocabularies) ----------------

const session: DocumentSessionId = createDocumentSessionId("document-session-vocabulary");
const buildOne: BuildId = { sequence: 1 };
const buildIntent: BuildIntent = {
    sourceIdentity: "generated-source-1",
    target: "gglab.surface",
    stage: "vertex",
    entry: "main",
    defines: [],
    includes: [],
    tool: { identity: "gglab-shaderc", version: "1.0.0", processContractVersion: 2, compilePolicyRevision: 1, producerIdentity: "dx-prod-1" },
};
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
const buildCanceled: AttemptOutcome = { kind: "canceled" };
const previewCanceled: PreviewAttemptOutcome = { kind: "canceled" };
const graphDiagnostic: ShaderGraphDiagnostic = { code: "TYPE_MISMATCH", severity: "error", message: "input types do not agree", dataPath: "$.nodes[3].inputs[1]" };
const toolDiagnosticLocated: ToolDiagnostic = { message: "HLSL declaration error", sourceIdentity: "generated-source-1" };
const toolDiagnosticUnlocated: ToolDiagnostic = { message: "compiler process could not run" };

// --- Owner-shaped correlations ---------------------------------------------

const corrSession: EvidenceCorrelation = { ...EMPTY_EVIDENCE_CORRELATION, documentSessionId: session };
const corrBuildOne: EvidenceCorrelation = {
    ...EMPTY_EVIDENCE_CORRELATION,
    documentSessionId: session,
    generatedSourceIdentity: "generated-source-1",
    buildAttempt: 1,
    buildId: buildOne,
};
const corrPreviewOne: EvidenceCorrelation = {
    ...EMPTY_EVIDENCE_CORRELATION,
    generatedSourceIdentity: "generated-source-1",
    buildAttempt: 1,
    previewSessionId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
};
const corrPublication: EvidenceCorrelation = {
    ...corrPreviewOne,
    publicationId: "publication-1",
};

// --- One chronological line over all five kinds ------------------------------

const lineNote = appendEvent(emptyEventLine(), { kind: "note", text: "session opened" }, corrSession);
const lineIssue = appendEvent(lineNote, { kind: "build-issue", intent: buildIntent }, corrBuildOne);
const lineSettle = appendEvent(lineIssue, { kind: "build-settlement", outcome: buildCanceled }, corrBuildOne);
const linePreviewIssue = appendEvent(lineSettle, { kind: "preview-issue", attemptSequence: 1, candidate, intent: previewIntent }, corrPreviewOne);
const line = appendEvent(linePreviewIssue, { kind: "preview-settlement", outcome: previewCanceled }, corrPreviewOne);

function kindsOf(events: readonly EditorEvent[]): string[] {
    return events.map((event) => event.payload.kind);
}

describe("the shared correlation identity vocabulary", () => {
    it("is fully empty by default and refines nothing specific", () => {
        for (const value of Object.values(EMPTY_EVIDENCE_CORRELATION)) {
            expect(value).toBeNull();
        }
        // The empty filter matches every correlation…
        expect(correlationRefines(EMPTY_EVIDENCE_CORRELATION, corrPublication)).toBe(true);
        // …but a correlation that names nothing refines a filter that names
        // something: absence of an identity is not that identity.
        expect(correlationRefines(corrPublication, EMPTY_EVIDENCE_CORRELATION)).toBe(false);
    });

    it("compares BuildId by its sequence, not by object identity", () => {
        const sameSequence = { sequence: 1 };
        expect(correlationsEqual(corrBuildOne, { ...corrBuildOne, buildId: sameSequence })).toBe(true);
        expect(correlationsEqual(corrBuildOne, { ...corrBuildOne, buildId: { sequence: 2 } })).toBe(false);
    });

    it("is equal only when every specified axis agrees", () => {
        expect(correlationsEqual(corrBuildOne, { ...corrBuildOne })).toBe(true);
        expect(correlationsEqual(corrBuildOne, corrPreviewOne)).toBe(false);
        expect(correlationsEqual(corrPreviewOne, corrPublication)).toBe(false);
    });

    it("refines one-way: the correlation must agree on every axis the filter fixes", () => {
        expect(correlationRefines({ ...EMPTY_EVIDENCE_CORRELATION, publicationId: "publication-1" }, corrPublication)).toBe(true);
        expect(correlationRefines(corrPublication, corrPreviewOne)).toBe(false);
        expect(correlationRefines(corrBuildOne, corrPublication)).toBe(false);
    });
});

describe("the chronological event line (Output / Build / Preview projections)", () => {
    it("numbers rows from 1 and onward, monotonically", () => {
        expect(nextEventSequence(emptyEventLine())).toBe(1);
        expect(nextEventSequence(line)).toBe(6);
    });

    it("appends with value semantics: the input line is untouched", () => {
        const grown = appendEvent(line, { kind: "note", text: "session closed" }, corrSession);
        expect(grown).not.toBe(line);
        expect(line).toHaveLength(5);
        expect(grown).toHaveLength(6);
    });

    it("keeps the owners' facts intact by reference inside the row", () => {
        const event = lineSettle[lineSettle.length - 1];
        expect(event?.payload.kind).toBe("build-settlement");
        if (event !== undefined && event.payload.kind === "build-settlement") {
            expect(event.payload.outcome).toBe(buildCanceled);
        }
    });

    it("projects each view in chronological order, from a shared line", () => {
        const output = eventsForView(line, "output");
        const build = eventsForView(line, "build");
        const preview = eventsForView(line, "preview");
        expect(kindsOf(output)).toEqual(["note", "build-issue", "build-settlement", "preview-issue", "preview-settlement"]);
        expect(kindsOf(build)).toEqual(["build-issue", "build-settlement"]);
        expect(kindsOf(preview)).toEqual(["preview-issue", "preview-settlement"]);
        // Projections are fresh arrays — never aliased onto the line.
        expect(output).not.toBe(line);
        expect(build).not.toBe(line);
        expect(preview).not.toBe(line);
    });

    it("restores chronological order even when the line arrived out of order", () => {
        const shuffled: EditorEvent[] = [
            { sequence: 3, payload: { kind: "build-settlement", outcome: buildCanceled }, correlation: corrBuildOne },
            { sequence: 1, payload: { kind: "note", text: "first" }, correlation: corrSession },
            { sequence: 2, payload: { kind: "build-issue", intent: buildIntent }, correlation: corrBuildOne },
        ];
        expect(eventsForView(shuffled, "build").map((event) => event.sequence)).toEqual([2, 3]);
        expect(eventsForView(shuffled, "output").map((event) => event.sequence)).toEqual([1, 2, 3]);
    });

    it("assigns view membership per kind: note is Output-only, build and preview lines carry over to Output", () => {
        const note: EditorEvent = { sequence: 1, payload: { kind: "note", text: "x" }, correlation: EMPTY_EVIDENCE_CORRELATION };
        expect(eventInView(note, "output")).toBe(true);
        expect(eventInView(note, "build")).toBe(false);
        expect(eventInView(note, "preview")).toBe(false);
        const issue = lineIssue[lineIssue.length - 1];
        expect(issue).not.toBeUndefined();
        if (issue !== undefined) {
            expect(eventInView(issue, "build")).toBe(true);
            expect(eventInView(issue, "preview")).toBe(false);
        }
    });

    it("clears the presentation into a fresh empty line", () => {
        const cleared = emptyEventLine();
        expect(cleared).toHaveLength(0);
        expect(cleared).not.toBe(line);
    });
});

describe("the replaceable current Problems snapshot", () => {
    it("projects a graph-native diagnostic with the core's location authority", () => {
        const entry = problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, corrSession);
        expect(entry.severity).toBe("error");
        expect(entry.code).toBe("TYPE_MISMATCH");
        expect(entry.text).toBe("input types do not agree");
        expect(entry.location).toEqual({ kind: "graph", dataPath: "$.nodes[3].inputs[1]" });
        expect(entry.correlation).toEqual(corrSession);
    });

    it("projects a toolchain diagnostic verbatim, with an honest location", () => {
        const located = problemEntryFromToolDiagnostic("tool-1", toolDiagnosticLocated, "error", corrBuildOne);
        expect(located.code).toBeNull();
        expect(located.location).toEqual({ kind: "generated-source", sourceIdentity: "generated-source-1" });
        const unlocated = problemEntryFromToolDiagnostic("tool-2", toolDiagnosticUnlocated, "warning", EMPTY_EVIDENCE_CORRELATION);
        expect(unlocated.severity).toBe("warning");
        expect(unlocated.location).toEqual({ kind: "unplaced" });
    });

    it("copies the caller's entries: later mutation of the input cannot reach the view", () => {
        const source: ProblemSnapshotEntry[] = [problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, corrSession)];
        const snapshot = createProblemSnapshot(source);
        expect(snapshot.entries).not.toBe(source);
        source.push(problemEntryFromGraphDiagnostic("graph-2", graphDiagnostic, corrSession));
        expect(snapshot.entries).toHaveLength(1);
    });

    it("replaces the snapshot wholesale — never appends into the previous one", () => {
        const first = createProblemSnapshot([problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, corrSession)]);
        const second = replaceProblemSnapshot([
            problemEntryFromToolDiagnostic("tool-1", toolDiagnosticLocated, "error", corrBuildOne),
        ]);
        expect(second.entries).not.toBe(first.entries);
        expect(second.entries.map((entry) => entry.identity)).toEqual(["tool-1"]);
        // The previous snapshot is simply no longer the current one:
        // untouched, unextended — replacement, not accumulation.
        expect(first.entries).toHaveLength(1);
        expect(first.entries.map((entry) => entry.identity)).toEqual(["graph-1"]);
    });

    it("clears into a fresh empty snapshot", () => {
        const first = createProblemSnapshot([problemEntryFromGraphDiagnostic("graph-1", graphDiagnostic, corrSession)]);
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
