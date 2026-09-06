/**
 * The Build and Preview bottom-panel views: presentation over the panel
 * vocabulary's projections (the sealed boundary) fed with the OWNERS'
 * session values. The pins:
 *
 * - every row renders in the projection's order with the OWNER's own
 *   state (a row whose outcome SUCCEEDED still renders as `stale`, and an
 *   in-flight row renders as `in-flight` — the view never re-judges a
 *   state, derives one from an outcome, or invents a severity),
 * - the structured outcome FACTS render verbatim (the tool's diagnostics
 *  with their location facts, the success envelope's binary evidence,
 *  the termination's own structure — carried, not recomputed),
 * - the structured absence states (no host boundary; an empty line),
 * - the surfaces' operation notes render as given,
 * - and the display migration is pinned: the inspector surface no longer
 *   carries a line projection of its own, and the app wires exactly the
 *   owners' session values into the two views.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import type {
    AttemptRecord,
    BuildIntent,
    CompileFailureDocument,
    CompileSuccessDocument,
    PendingPreviewAttempt,
    PreviewBuildFailureDocument,
    PreviewBuildIntent,
    PreviewBuildSuccessDocument,
    SettledPreviewAttempt,
    ToolCandidate,
} from "@gglab/shader-toolchain-client";
import type { InFlightBuild, NativeBuildSession } from "../src/native-build-session.js";
import type { PreviewBuildSession } from "../src/preview-build-session.js";
import { BuildPanelView, PreviewPanelView, describeBuildOutcome, type PanelNote } from "../src/bottom-panel-views.js";

const read = (relative: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), relative), "utf8");

// --- Owner-shaped fixtures (the owners' exact vocabularies) ----------------

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
const failureEnvelope: CompileFailureDocument = {
    command: "compile",
    success: false,
    status: "compile-failed",
    exitCode: 1,
    diagnostics: [
        { message: "HLSL declaration error", sourceIdentity: "generated-source-1" },
        { message: "include not found" },
    ],
};
const successEnvelope: CompileSuccessDocument = {
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
    fromCache: true,
    diagnostics: [],
};
const settledOne: AttemptRecord = { buildId: { sequence: 1 }, intent: intentOne, outcome: { kind: "failed", envelope: failureEnvelope } };
const settledTwo: AttemptRecord = { buildId: { sequence: 2 }, intent: intentOne, outcome: { kind: "canceled" } };
const settledFour: AttemptRecord = { buildId: { sequence: 4 }, intent: intentOne, outcome: { kind: "succeeded", envelope: successEnvelope } };
const settledSix: AttemptRecord = { buildId: { sequence: 6 }, intent: intentTwo, outcome: { kind: "succeeded", envelope: successEnvelope } };
const inFlightThree: InFlightBuild = { buildId: { sequence: 3 }, intent: intentOne };
// The line's state mix against the issued anchor (intentOne): #1 failed,
// #2 canceled, #4 current (newest success within the anchor intent),
// #6 last-good (a success outside that — the newest success overall), #3 in
// flight.
const buildSession: NativeBuildSession = {
    line: { attempts: [settledTwo, settledSix, settledOne, settledFour] },
    inFlight: [inFlightThree],
    lastIssued: inFlightThree,
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
    // facts — the view renders them without relabeling a severity.
    diagnostics: [{ message: "preview advisory note" }],
};
const previewFailureEnvelope: PreviewBuildFailureDocument = {
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
const previewSession: PreviewBuildSession = {
    sessionId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    line: { attempts: [previewPending, previewOne, previewFailed] }, // arrival order
    nextAttemptSequence: 4,
};

const refusalNote: PanelNote = { level: "refusal", text: "Preview refused: no compatible publication." };
const infoNote: PanelNote = { level: "info", text: "Proof established against the pinned candidate." };

function buildRowList(view: HTMLElement): HTMLElement[] {
    const list = view.querySelector(".gglab-bottom-view-rows");
    if (list === null) {
        throw new Error("the view rendered no attempt list");
    }
    return Array.from(list.querySelectorAll(".gglab-bottom-view-row"));
}

/** The row's state WORD as the view renders it (its own text). */
function renderedState(view: HTMLElement, attemptLabel: string): string {
    const row = buildRowList(view).find((entry) => entry.textContent?.includes(attemptLabel));
    if (row === undefined) {
        throw new Error(`no row rendered for ${attemptLabel}`);
    }
    const state = row.querySelector(".gglab-view-state");
    if (state === null) {
        throw new Error(`no state word rendered for ${attemptLabel}`);
    }
    return state.textContent ?? "";
}

// --- The Build view ----------------------------------------------------------

describe("the build view — chronology projection as the owner holds it", () => {
    it("renders every attempt in BuildId order with the OWNER's own state — success never re-derives `current`", () => {
        const view = render(<BuildPanelView session={buildSession} notes={[]} />).container;
        const rows = buildRowList(view);
        expect(rows.map((row) => row.querySelector(".mono")?.textContent)).toEqual(["#1", "#2", "#3", "#4", "#6"]);
        expect(renderedState(view, "#1")).toBe("failed");
        expect(renderedState(view, "#2")).toBe("canceled");
        expect(renderedState(view, "#3")).toBe("in-flight");
        expect(renderedState(view, "#4")).toBe("current");
        // THE NO-RE-JUDGMENT PIN: #6 SUCCEEDED (that outcome renders in its
        // own row) yet the owner's line holds it LAST-GOOD — the view
        // renders the owner's word, not a state derived from the outcome's
        // kind (a success is not automatically `current`).
        const six = rows[4];
        expect(six?.textContent).toContain("succeeded");
        expect(six?.querySelector(".gglab-view-state")?.textContent).toBe("last-good");
    });

    it("a tool failure renders EVERY structured diagnostic verbatim, with its location fact when the tool reports one", () => {
        const view = render(<BuildPanelView session={buildSession} notes={[]} />).container;
        const row = buildRowList(view)[0];
        expect(row?.textContent).toContain("HLSL declaration error");
        expect(row?.textContent).toContain("generated-source-1");
        expect(row?.textContent).toContain("include not found");
        expect(row?.textContent).toContain(`tool status "compile-failed"`);
    });

    it("canceled and succeeded render their own facts (the binary evidence, the cache axis)", () => {
        const view = render(<BuildPanelView session={buildSession} notes={[]} />).container;
        const rows = buildRowList(view);
        expect(rows[1]?.textContent).toContain("canceled (explicit, never lost)");
        expect(rows[1]?.textContent).not.toContain("HLSL");
        expect(rows[3]?.textContent).toContain("succeeded — artifact produced");
        expect(rows[3]?.textContent).toContain("binary dxil binary-hash-1");
        expect(rows[3]?.textContent).toContain("cache hit");
    });

    it("an in-flight row is visible, with the honest not-yet (no outcome is invented for it)", () => {
        const view = render(<BuildPanelView session={buildSession} notes={[]} />).container;
        const rows = buildRowList(view);
        expect(rows[2]?.textContent).toContain("issued — not yet settled");
        expect(rows[2]?.textContent).not.toContain("succeeded");
    });

    it("renders no host as a structured absence — and an empty line as exactly that", () => {
        const noHost = render(<BuildPanelView session={null} notes={[infoNote]} />).container;
        expect(noHost.textContent).toContain("No desktop build host in this shell");
        const empty: NativeBuildSession = { line: { attempts: [] }, inFlight: [], lastIssued: null };
        const noAttempts = render(<BuildPanelView session={empty} notes={[]} />).container;
        expect(noAttempts.textContent).toContain("No build attempts yet");
        expect(noAttempts.querySelector(".gglab-bottom-view-rows")).toBeNull();
    });

    it("renders the surface's operation notes as given (their levels, their text)", () => {
        const view = render(<BuildPanelView session={buildSession} notes={[refusalNote, infoNote]} />).container;
        const notes = view.querySelector(".gglab-native-notes");
        expect(notes).not.toBeNull();
        expect(notes?.textContent).toContain(refusalNote.text);
        expect(notes?.textContent).toContain(infoNote.text);
        expect(notes?.querySelector(".gglab-note-refusal")?.textContent).toContain(refusalNote.text);
    });

    it("the composed request identity renders per row (its owner's intent fields)", () => {
        const view = render(<BuildPanelView session={buildSession} notes={[]} />).container;
        const rows = buildRowList(view);
        expect(rows[0]?.textContent).toContain("gglab.surface · vertex · main");
        expect(rows[4]?.textContent).toContain("gglab.surface · fragment · main");
        expect(rows[0]?.textContent).toContain("generated source");
    });
});

describe("the outcome description — a rendering helper over the owner's vocabulary", () => {
    function failedEnveloped(): AttemptRecord["outcome"] {
        return { kind: "failed", envelope: failureEnvelope };
    }

    it("names each outcome form exactly once", () => {
        expect(describeBuildOutcome({ kind: "succeeded", envelope: successEnvelope })).toBe("succeeded — artifact produced");
        expect(describeBuildOutcome({ kind: "canceled" })).toBe("canceled (explicit, never lost)");
        expect(describeBuildOutcome(failedEnveloped())).toBe(`failed (tool status "compile-failed", 2 diagnostics — the diagnostics follow as their own rows)`);
        const bare: CompileFailureDocument = { command: "compile", success: false, status: "artifact-io-failure", exitCode: 5, diagnostics: [] };
        expect(describeBuildOutcome({ kind: "failed", envelope: bare })).toBe(`failed (tool status "artifact-io-failure", 0 diagnostics)`);
        expect(describeBuildOutcome({ kind: "failed", termination: { kind: "timed-out" } })).toBe("failed — timed out (the tool never reported)");
        expect(describeBuildOutcome({ kind: "failed", termination: { kind: "launch-failed" } })).toBe("failed — the candidate could not be launched");
        expect(describeBuildOutcome({ kind: "failed", termination: { kind: "channel-violated", violation: { reason: "stderr-non-empty", byteLength: 12 } } })).toBe("failed — channel violated (stderr-non-empty)");
        expect(describeBuildOutcome({ kind: "failed", termination: { kind: "machine-document-rejected", rejection: { reason: "field-type-mismatch", detail: "the field carried the wrong type" } } })).toBe(
            "failed — the output was rejected as a machine document (field-type-mismatch)",
        );
        expect(describeBuildOutcome({ kind: "failed", termination: { kind: "candidate-invalidated", observation: "changed", observedIdentity: "other-identity" } })).toBe(
            "failed — candidate invalidated (changed)",
        );
    });
});

// --- The Preview view --------------------------------------------------------

describe("the preview view — the owner's Preview session as it holds it", () => {
    it("renders every attempt in attemptSequence order with the OWNER RECORD's own state", () => {
        const view = render(<PreviewPanelView session={previewSession} notes={[]} />).container;
        const rows = buildRowList(view);
        expect(rows.map((row) => row.querySelector(".mono")?.textContent)).toEqual(["#1", "#2", "#3"]);
        expect(rows[0]?.querySelector(".gglab-view-state")?.textContent).toBe("published");
        expect(rows[1]?.querySelector(".gglab-view-state")?.textContent).toBe("failed");
        expect(rows[2]?.querySelector(".gglab-view-state")?.textContent).toBe("pending");
    });

    it("a published row carries its publication identity; a failed row its status and EVERY diagnostic verbatim", () => {
        const view = render(<PreviewPanelView session={previewSession} notes={[]} />).container;
        const rows = buildRowList(view);
        expect(rows[0]?.textContent).toContain("publication publication-1");
        expect(rows[0]?.textContent).toContain("session a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
        expect(rows[1]?.textContent).toContain("Preview attempt #2 failed");
        expect(rows[1]?.textContent).toContain("compile-failed (exit 1)");
        expect(rows[1]?.textContent).toContain("HLSL type error");
        expect(rows[1]?.textContent).toContain("generated-source-1");
        expect(rows[1]?.textContent).toContain("preview writer unavailable");
    });

    it("a success settlement's notes render as the owner's lines — without a severity word invented for them", () => {
        const view = render(<PreviewPanelView session={previewSession} notes={[]} />).container;
        const row = buildRowList(view)[0];
        const text = row?.textContent ?? "";
        expect(text).toContain("preview advisory note");
        expect(text).not.toMatch(/\b(warning|warn|severity)\b/i);
    });

    it("a pending row is visible, with the honest not-yet (no outcome is invented)", () => {
        const view = render(<PreviewPanelView session={previewSession} notes={[]} />).container;
        const rows = buildRowList(view);
        expect(rows[2]?.textContent).toContain("issued — not yet settled");
        expect(rows[2]?.textContent).toContain("generated source");
    });

    it("renders no host as a structured absence, an empty line as exactly that, and the notes as given", () => {
        const noHost = render(<PreviewPanelView session={null} notes={[refusalNote]} />).container;
        expect(noHost.textContent).toContain("No desktop Preview host in this shell");
        expect(noHost.querySelector(".gglab-native-notes")?.textContent).toContain(refusalNote.text);
        const empty: PreviewBuildSession = { sessionId: "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0", line: { attempts: [] }, nextAttemptSequence: 1 };
        const noAttempts = render(<PreviewPanelView session={empty} notes={[infoNote]} />).container;
        expect(noAttempts.textContent).toContain("No Preview attempts yet");
        expect(noAttempts.textContent).toContain(infoNote.text);
    });
});

// --- The display migration is pinned (chronology out of the inspector) ------

describe("the chronology display migration", () => {
    it("the inspector surface no longer carries a line projection, and the app wires the owners' session values into the two views", () => {
        const app = read("../src/app.tsx");
        // THE OWNER'S SESSION VALUES, the sealed getters themselves.
        expect(app).toContain(`session={native.flow?.buildSession ?? null}`);
        expect(app).toContain(`session={preview.flow?.session ?? null}`);
        // The inspector's old chronology display is gone: no line
        // projection on the surface, no old heading, no old notes list.
        expect(app).not.toContain("lineReport");
        expect(app).not.toContain("Build line");
        expect(app).not.toContain("renderNativeNotes");
        const surface = read("../src/useNativeBuild.ts");
        expect(surface).not.toContain("lineReport");
        expect(surface).not.toContain("lastOutcome");
    });
});
