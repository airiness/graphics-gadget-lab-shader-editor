/**
 * The Problems view — the replaceable CURRENT diagnostic snapshot:
 *
 * - it renders the snapshot's entries as a SET (severity, the owner's
 *   stable code when the layer has one, the message, the location
 *   authority), keyed by each entry's stable identity (future
 *   document / node navigation resolves from the entry's own location
 *   and correlation values, never parsed from display text),
 * - replacement is its lifecycle: rendering a second snapshot shows
 *   exactly that set, never an extension of the first,
 * - Clear is a presentation action only: it calls the caller's handler
 *   and leaves the snapshot value (and therefore every owner record
 *   behind it) untouched,
 * - and the wiring is pinned: the app composes the snapshot from the
 *   owners' structured facts through the frozen vocabulary's projectors,
 *   replaces it wholesale (no append path over the snapshot), and exposes
 *   the presentation-only Clear.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render } from "@testing-library/react";
import type { AttemptRecord, CompileFailureDocument, PreviewBuildIntent, SettledPreviewAttempt, ToolCandidate } from "@gglab/shader-toolchain-client";
import {
    createDocumentSessionId,
    type DocumentSessionId,
} from "../src/workspace-session.js";
import {
    createProblemSnapshot,
    emptyProblemSnapshot,
    problemEntriesFromBuildAttempt,
    problemEntriesFromGraphDiagnostics,
    problemEntriesFromPreviewAttempt,
    previewChronology,
    type ProblemSnapshot,
} from "../src/panel-vocabulary.js";
import { ProblemsPanelView } from "../src/bottom-panel-views.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// --- Fixtures composed ONLY through the frozen vocabulary's projectors -----

const documentSessionId: DocumentSessionId = createDocumentSessionId("document-session-problems-view");
const context = { documentSessionId, documentRevision: "revision-current-problems" };

const graphDiagnostics = [
    { code: "connection-type-mismatch", severity: "error" as const, message: "Port types do not match on the connection", dataPath: "edges[2]" },
    { code: "unknown-node-type", severity: "warning" as const, message: "Node type is unknown and was retained", dataPath: "nodes[5]" },
];
const loadDiagnostics = [{ code: "missing-field", severity: "error" as const, message: 'the document is missing the required field "outputs"', dataPath: "" }];

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
const buildRecord: AttemptRecord = {
    buildId: { sequence: 7 },
    intent: {
        sourceIdentity: "generated-source-problems",
        target: "gglab.surface",
        stage: "vertex",
        entry: "main",
        defines: [],
        includes: [],
        tool: { identity: "gglab-shaderc", version: "1.0.0", processContractVersion: 2, compilePolicyRevision: 1, producerIdentity: "dx-prod-1" },
    },
    outcome: { kind: "failed", envelope: buildFailureEnvelope },
};

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
const previewAttempt: SettledPreviewAttempt = {
    attemptSequence: 2,
    buildId: { sequence: 8 },
    candidate,
    intent: previewIntent,
    state: "settled",
    outcome: {
        kind: "failed",
        envelope: {
            command: "build-preview",
            success: false,
            status: "compile-failed",
            exitCode: 1,
            attemptSequence: 2,
            diagnostics: [{ message: "preview writer unavailable" }],
        },
    },
};

function composedSnapshot(diagnostics: readonly { code: string; severity: "error" | "warning" | "info"; message: string; dataPath: string }[]): ProblemSnapshot {
    const entries = [
        ...problemEntriesFromGraphDiagnostics(diagnostics, context),
        ...problemEntriesFromBuildAttempt(buildRecord),
        ...previewChronology({
            sessionId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
            line: { attempts: [previewAttempt] },
            nextAttemptSequence: 3,
        }).map((row) => problemEntriesFromPreviewAttempt(row)),
    ].flat();
    return createProblemSnapshot(entries);
}

describe("the problems view — a replaceable current snapshot", () => {
    it("renders the snapshot's entries as structured rows: severity, owner code, message, location authority", () => {
        const snapshot = composedSnapshot(graphDiagnostics);
        const view = render(<ProblemsPanelView snapshot={snapshot} onClear={() => undefined} />).container;
        expect(view.textContent).toContain("5 current problems.");
        // Each entry is one row, keyed by its stable identity:
        const rows = Array.from(view.querySelectorAll(".gglab-bottom-view-row"));
        expect(rows.length).toBe(5);
        // The graph-native layer keeps its owner code and dataPath location:
        const first = rows[0];
        expect(first?.textContent).toContain("connection-type-mismatch");
        expect(first?.textContent).toContain("graph edges[2]");
        expect(first?.querySelector(".gglab-view-severity-error")?.textContent).toBe("error");
        // The warning entry keeps its severity word:
        expect(rows[1]?.querySelector(".gglab-view-severity-warning")?.textContent).toBe("warning");
        // The toolchain layer reports NO code (the view must not invent one),
        // and its generated-source location keeps the identity:
        const buildRow = rows[2];
        expect(buildRow?.textContent).toContain("HLSL declaration error");
        expect(buildRow?.textContent).toContain("generated source generated-so…");
        // A diagnostic with no location fact of its own stays honestly unplaced:
        const unplacedRow = rows[3];
        expect(unplacedRow?.textContent).toContain("include not found");
        expect(unplacedRow?.textContent).toContain("no location reported");
        // The preview failure entry renders under its own row too:
        expect(rows[4]?.textContent).toContain("preview writer unavailable");
    });

    it("wholesale replacement is the lifecycle: a second snapshot shows exactly that set, never an extension of the first", () => {
        const first = composedSnapshot(graphDiagnostics);
        const initial = render(<ProblemsPanelView snapshot={first} onClear={() => undefined} />).container;
        expect(initial.querySelectorAll(".gglab-bottom-view-row").length).toBe(5);
        // A DIFFERENT snapshot becomes the view: it shows exactly that set
        // (one row), with the old entries gone — replacement, not
        // accumulation (the append-only anti-pattern).
        const second = createProblemSnapshot(problemEntriesFromGraphDiagnostics(loadDiagnostics, context));
        const swapped = render(<ProblemsPanelView snapshot={second} onClear={() => undefined} />).container;
        expect(swapped.querySelectorAll(".gglab-bottom-view-row").length).toBe(1);
        expect(swapped.textContent).toContain("missing-field");
        expect(swapped.textContent).not.toContain("HLSL declaration error");
        expect(swapped.textContent).not.toContain("connection-type-mismatch");
    });

    it("an empty snapshot says exactly that, and Clear is disabled (there is nothing to clear)", () => {
        const view = render(<ProblemsPanelView snapshot={emptyProblemSnapshot()} onClear={() => undefined} />).container;
        expect(view.textContent).toContain("No current problems.");
        const clear = view.querySelector<HTMLButtonElement>(".gglab-bottom-view-clear");
        expect(clear?.disabled).toBe(true);
    });

    it("Clear is a PRESENTATION action only: it calls the handler and leaves the snapshot value (and the owners behind it) untouched", () => {
        let cleared = 0;
        const snapshot = composedSnapshot(graphDiagnostics);
        const frozenEntries: readonly { readonly identity: string }[] = snapshot.entries;
        const view = render(
            <ProblemsPanelView
                snapshot={snapshot}
                onClear={() => {
                    cleared += 1;
                }}
            />,
        ).container;
        expect(view.querySelectorAll(".gglab-bottom-view-row").length).toBe(5);
        const clear = view.querySelector<HTMLButtonElement>(".gglab-bottom-view-clear");
        expect(clear).not.toBeNull();
        expect(clear?.disabled).toBe(false);
        fireEvent.click(clear as HTMLElement);
        expect(cleared).toBe(1);
        // THE PIN: the view never mutated the snapshot it was given — the
        // entries are exactly the value the caller handed over (clearing
        // the presentation can only ever be the caller replacing it with
        // the empty snapshot; the view holds no write path of its own).
        expect(snapshot.entries).toBe(frozenEntries);
        expect(snapshot.entries.length).toBe(5);
    });
});

// --- The app wiring is pinned (composition, replacement, presentation only) -

describe("the problems wiring in the composition root", () => {
    it("composes the snapshot from the owners' structured facts through the frozen projectors — no append path, no display-string parsing", () => {
        const app = read("../src/app.tsx");
        // Composition through the frozen vocabulary's projectors:
        expect(app).toContain("problemEntriesFromGraphDiagnostics");
        expect(app).toContain("problemEntriesFromBuildAttempt");
        expect(app).toContain("problemEntriesFromPreviewAttempt");
        // Whole-snapshot replacement (the vocabulary's two snapshot
        // constructors) and the presentation-only Clear:
        expect(app).toContain("replaceProblemSnapshot");
        expect(app).toContain("emptyProblemSnapshot()");
        expect(app).toContain("<ProblemsPanelView snapshot={problemsSnapshot} onClear={clearProblemsPresentation} />");
        // NO append / extend path over the snapshot (its lifecycle is
        // replacement), and no back-parsing of display text:
        expect(app).not.toContain("problemsSnapshot.entries.push");
        expect(app).not.toContain("[...problemsSnapshot.entries");
        expect(app).not.toContain("match(/");
    });
});
