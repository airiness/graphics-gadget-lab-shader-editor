import { graph, descriptor, emission, source } from "./evidence-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { emitHlsl, validateShaderGraph, serializeShaderGraphDocument } from "@gglab/shader-graph-core";
import type { AttemptOutcome, BuildIntent } from "@gglab/shader-toolchain-client";
import { createSession, documentRevision, provenanceFromImport, recordDocumentChange, type DocumentSession } from "../src/document-session.js";
import { activateWorkspaceDocument, closeWorkspaceDocument, createDocumentSessionId, createWorkspaceSession, openWorkspaceDocument, updateWorkspaceDocument } from "../src/workspace-session.js";
import { captureDocumentEvidence } from "../src/document-evidence.js";
import { EditorOutput } from "../src/editor-output.js";
import { OutputPanelView, ProblemsPanelView } from "../src/bottom-panel-views.js";
import { EMPTY_EVIDENCE_CORRELATION, problemEntriesFromGraphDiagnostics, problemEntriesFromBuildAttempt, buildChronology } from "../src/panel-vocabulary.js";
import { resolveProblemNavigation } from "../src/problem-navigation.js";
import { composeWorkspaceProblemSnapshot } from "../src/problems-composition.js";
import { createNativeBuildSession, sessionIssue, sessionSettle } from "../src/native-build-session.js";

const a = createSession(createDocumentSessionId("document-a"), provenanceFromImport(), graph);
const b = createSession(createDocumentSessionId("document-b"), provenanceFromImport(), graph);
const workspace = openWorkspaceDocument(openWorkspaceDocument(createWorkspaceSession<DocumentSession>(), a).workspace, b).workspace;
const diagnostic = { code: "INVALID_VALUE", severity: "error" as const, message: "Invalid node value", dataPath: "$.nodes[1].properties.value" };
const graphEntry = problemEntriesFromGraphDiagnostics([diagnostic], { documentSessionId: a.sessionId, documentRevision: documentRevision(a) })[0]!;
const intent: BuildIntent = {
    sourceIdentity: source, target: "gglab-dx12", stage: "pixel", entry: "main", defines: [], includes: [],
    tool: { identity: "gglab-shaderc", version: "1.0.0", processContractVersion: 2, compilePolicyRevision: 1, producerIdentity: "test" },
};
const failure: AttemptOutcome = { kind: "failed", envelope: { command: "compile", success: false, status: "compile-failed", exitCode: 1, diagnostics: [{ message: "Shader error", sourceIdentity: source }] } };

describe("document-owned diagnostic navigation", () => {
    it("selects the owning tab and node, never a different document with the same graph and HLSL", () => {
        expect(workspace.activeDocumentId).toBe(b.sessionId);
        const result = resolveProblemNavigation(workspace, graphEntry);
        expect(result).toMatchObject({ available: true, document: { sessionId: a.sessionId }, focus: { nodeHighlights: [{ nodeId: "value", portIds: [] }] } });
        expect(workspace.activeDocumentId).toBe(b.sessionId);
        expect(workspace.preview.targetDocumentId).toBe(a.sessionId);
    });

    it("rechecks revision before resolving an indexed node anchor", () => {
        const changed = updateWorkspaceDocument(workspace, a.sessionId, (document) => recordDocumentChange(document, { ...graph, nodes: [{ ...graph.nodes[0]!, id: "different-node" }] }, "replace node")).workspace;
        expect(resolveProblemNavigation(changed, graphEntry)).toMatchObject({ available: true, focus: null });
        expect(resolveProblemNavigation(closeWorkspaceDocument(workspace, a.sessionId).workspace, graphEntry)).toMatchObject({ available: false });
    });

    it("keeps unowned diagnostics unowned instead of searching for equal source identities", () => {
        expect(resolveProblemNavigation(workspace, { ...graphEntry, correlation: EMPTY_EVIDENCE_CORRELATION })).toMatchObject({ available: false });
    });

    it("captures source-map and revision at issue and keeps them through late settlements", () => {
        const firstId = { sequence: 1 };
        const secondId = { sequence: 2 };
        const originA = captureDocumentEvidence(a, descriptor)!;
        const originB = captureDocumentEvidence(b, descriptor)!;
        let builds = sessionIssue(createNativeBuildSession(), firstId, intent, originA);
        builds = sessionIssue(builds, secondId, intent, originB);
        builds = sessionSettle(builds, secondId, failure);
        builds = sessionSettle(builds, { sequence: firstId.sequence }, failure);
        const record = builds.line.attempts.find((attempt) => attempt.buildId.sequence === firstId.sequence)!;
        const entry = problemEntriesFromBuildAttempt(record, builds)[0]!;
        expect(entry.origin).toBe(originA);
        expect(entry.origin?.sourceMap).toEqual(emission.sourceMap);
        expect(entry.correlation.documentRevision).toBe(serializeShaderGraphDocument(graph));
        expect(entry.correlation.documentSessionId).toBe(a.sessionId);
        // The tool contract has no line/column: document navigation is useful,
        // but guessing a source-map range would fabricate a node location.
        expect(resolveProblemNavigation(workspace, entry)).toMatchObject({ available: true, document: { sessionId: a.sessionId }, focus: null });
        builds = { ...builds, line: { ...builds.line, attempts: builds.line.attempts.map(record => ({ ...record, buildId: { sequence: record.buildId.sequence } })) } };
        expect(buildChronology(builds).map((row) => row.correlation.documentSessionId)).toEqual([a.sessionId, b.sessionId]);
    });

    it("refuses hand-built origins and cross-owner session/document splicing", () => {
        const origin = captureDocumentEvidence(a, descriptor)!;
        expect(() => sessionIssue(createNativeBuildSession(), { sequence: 1 }, intent, { ...origin } as typeof origin)).toThrow("origin");
        expect(() => captureDocumentEvidence({ ...b, sessionId: a.sessionId }, descriptor)).toThrow("owner");
        const changed = recordDocumentChange(b, { ...graph, graphId: "other" }, "Edit");
        expect(() => captureDocumentEvidence({ ...a, history: changed.history }, descriptor)).toThrow("owner");
        expect(Object.isFrozen(origin)).toBe(true);
        expect(Object.isFrozen(origin.sourceMap)).toBe(true);
    });

    it("deduplicates validation diagnostics repeated by failed emission", () => {
        const invalid = { ...graph, connections: [] };
        const validation = validateShaderGraph(invalid).diagnostics;
        const failed = emitHlsl(invalid, descriptor);
        expect(failed.ok).toBe(false);
        const repeated = validation.find(diagnostic => failed.diagnostics.some(other => JSON.stringify(other) === JSON.stringify(diagnostic)));
        expect(repeated).toBeDefined();
        const owner = createSession(createDocumentSessionId("invalid-graph"), provenanceFromImport(), invalid);
        const withEmission = { ...owner, presentation: { ...owner.presentation, emission: failed } };
        const open = openWorkspaceDocument(createWorkspaceSession<DocumentSession>(), withEmission).workspace;
        const result = composeWorkspaceProblemSnapshot(open, descriptor, null, null);
        expect(result.entries.filter(entry => entry.code === repeated!.code && entry.text === repeated!.message && entry.location.kind === "graph" && entry.location.dataPath === repeated!.dataPath)).toHaveLength(1);
        const context = { documentSessionId: owner.sessionId, documentRevision: documentRevision(owner) };
        expect(problemEntriesFromGraphDiagnostics([repeated!], context)[0]?.identity).toBe(problemEntriesFromGraphDiagnostics([...validation, repeated!], context).at(-1)?.identity);
    });

    it("deduplicates the entire workspace snapshot while retaining chronology", () => {
        const result = composeWorkspaceProblemSnapshot(workspace, null, null, null, [graphEntry, graphEntry]);
        expect(result.entries.filter(entry => entry.identity === graphEntry.identity)).toHaveLength(1);
        expect(new Set(result.entries.map(entry => entry.identity)).size).toBe(result.entries.length);
    });

    it("rejects a mismatched source origin and a record paired with another owner", () => {
        const origin = captureDocumentEvidence(a, descriptor)!;
        expect(() => sessionIssue(createNativeBuildSession(), { sequence: 1 }, { ...intent, sourceIdentity: "other" }, origin)).toThrow("origin");
        const id = { sequence: 1 };
        const built = sessionSettle(sessionIssue(createNativeBuildSession(), id, intent, origin), id, failure);
        expect(() => problemEntriesFromBuildAttempt(built.line.attempts[0]!, createNativeBuildSession())).toThrow("owning session");
    });

    it("replaces each document's diagnostic coordinate independently and excludes closed documents", () => {
        const firstId = { sequence: 1 };
        const secondId = { sequence: 2 };
        let builds = sessionIssue(createNativeBuildSession(), firstId, intent, captureDocumentEvidence(a, descriptor));
        builds = sessionSettle(builds, { sequence: firstId.sequence }, failure);
        builds = sessionIssue(builds, secondId, intent, captureDocumentEvidence(b, descriptor));
        builds = sessionSettle(builds, secondId, { kind: "canceled" });
        const snapshot = composeWorkspaceProblemSnapshot(workspace, null, builds, null);
        expect(snapshot.entries.filter((entry) => entry.correlation.buildId !== null).map((entry) => entry.correlation.documentSessionId)).toEqual([a.sessionId]);
        const switched = activateWorkspaceDocument(workspace, a.sessionId).workspace;
        expect(composeWorkspaceProblemSnapshot(switched, null, builds, null)).toEqual(snapshot);
        const closed = closeWorkspaceDocument(workspace, a.sessionId).workspace;
        expect(composeWorkspaceProblemSnapshot(closed, null, builds, null).entries.some((entry) => entry.correlation.documentSessionId === a.sessionId)).toBe(false);
        expect(buildChronology(builds)).toHaveLength(2);
    });

    it("forwards the structured diagnostic entry and exposes unavailable navigation", () => {
        const navigate = vi.fn();
        const view = render(<ProblemsPanelView snapshot={{ entries: [graphEntry] }} onClear={() => undefined} onNavigate={navigate} navigation={() => ({ available: true, detail: "Show node" })} />);
        fireEvent.click(view.getByRole("button", { name: "Open owning document" }));
        expect(navigate).toHaveBeenCalledWith(graphEntry);
        view.rerender(<ProblemsPanelView snapshot={{ entries: [graphEntry] }} onClear={() => undefined} onNavigate={navigate} navigation={() => ({ available: false, detail: "Document closed" })} />);
        expect(view.getByRole("button", { name: "Open owning document" }).hasAttribute("disabled")).toBe(true);
        view.unmount();
    });
});

describe("Output event lifecycle", () => {
    it("retains structured operation diagnostics without assigning them to the active graph", () => {
        const output = new EditorOutput();
        output.append("document", "refusal", "Import failed", EMPTY_EVIDENCE_CORRELATION, [diagnostic]);
        const view = render(<OutputPanelView events={output.getSnapshot()} onClear={output.clear} />);
        expect(view.getByText(/INVALID_VALUE/)).toBeDefined();
        expect(output.getSnapshot()[0]?.correlation.documentSessionId).toBeNull();
        expect(output.getSnapshot()[0]?.diagnostics).toEqual([diagnostic]);
        view.unmount();
    });

    it("Clear only clears presentation, preserves old snapshot values, and does not reuse event identities", () => {
        const output = new EditorOutput();
        const correlation = { ...EMPTY_EVIDENCE_CORRELATION, documentSessionId: a.sessionId, documentRevision: documentRevision(a) };
        output.append("authoring", "info", "Edited A", correlation);
        const old = output.getSnapshot();
        function Surface() {
            const events = useSyncExternalStore(output.subscribe, output.getSnapshot);
            return <><OutputPanelView events={events} onClear={output.clear} /><button onClick={() => output.append("discovery", "info", "Tool discovered")}>Discover</button></>;
        }
        const view = render(<Surface />);
        fireEvent.click(view.getByRole("button", { name: "Clear output" }));
        expect(view.queryByText("Edited A")).toBeNull();
        expect(old[0]?.correlation).toEqual(correlation);
        expect(workspace.documents[0]).toBe(a);
        fireEvent.click(view.getByRole("button", { name: "Discover" }));
        expect(output.getSnapshot()[0]?.sequence).toBe(2);
        expect(view.getByText("Tool discovered")).toBeDefined();
        view.unmount();
    });
});
