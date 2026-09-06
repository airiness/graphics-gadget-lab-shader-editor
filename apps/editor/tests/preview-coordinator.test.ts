/**
 * PreviewCoordinator authority.
 *
 * Part 1 — target-resolution (guidance §12.1): the Runtime Preview composes
 * from the EXPLICIT Preview target — a distinct Workspace axis — never from
 * the active (editing) document: the target survives a tab switch; retarget
 * moves it; closing a target tab re-seeds it; before an explicit target is
 * chosen, the active document is the bootstrap default. Pure: no React, no
 * Tauri.
 *
 * Part 2 — ownership TRANSITIONS (retarget / target-close) and gate
 * composition, pinned against the frozen contract:
 *
 *   - strict single-flight: one in-flight transition refuses the next
 *     (transition-in-flight), with no queue and no auto-supersede;
 *   - terminateAndJoin() is the transition's last await, and an ownership
 *     transition commits WITHOUT a proven exit NEVER (exit-unproven and the
 *     safety-state rejections refuse and leave the snapshot untouched);
 *     the same-target fast path performs NO teardown;
 *   - COMMIT-TIME semantics: after the teardown settles, exactly one
 *     synchronous store apply revalidates the intent against the CURRENT
 *     snapshot, resolves the CURRENT descriptor + CURRENT target emission,
 *     and commits — a descriptor/emission captured at intent time is never
 *     applied. Required regression: a retarget that starts under descriptor
 *     D1, whose teardown is pending when the descriptor moves to D2,
 *     commits with D2 (or refuses under D2); D1 is never used;
 *   - gate composition: the attached-Runtime refusal facts are mapped
 *     BEFORE the composition/tool gate, in the frozen order.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    FakeHostBoundary,
    FakePreviewObservationBoundary,
    FakePreviewRuntimeBoundary,
    type ToolCandidate,
    type ToolCompatibilityState,
    type ToolFacts,
} from "@gglab/shader-toolchain-client";
import {
    emitHlsl,
    parseShaderGraphDocument,
    parseSurfaceProfileDescriptor,
    type HlslEmission,
    type ShaderGraphDocument,
    type SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";
import {
    createSession,
    documentRevision,
    provenanceFromFile,
    provenanceFromImport,
    recordDocumentChange,
    type DocumentSession,
} from "../src/document-session.js";
import {
    activateWorkspaceDocument,
    canonicalDocumentUriFromHost,
    closeWorkspaceDocument,
    commitWorkspacePreviewTarget,
    createDocumentSessionId,
    createWorkspaceSession,
    openWorkspaceDocument,
    type WorkspaceSession,
} from "../src/workspace-session.js";
import { fileRevisionTokenFromHost } from "../src/host-io.js";
import {
    hasExplicitPreviewTarget,
    PreviewCoordinator,
    resolvePreviewTarget,
} from "../src/preview-coordinator.js";
import {
    PreviewBuildFlow,
    type PreviewCompositionInput,
    type PreviewToolStatePort,
} from "../src/preview-build-flow.js";
import { AttachedPreviewRuntimeManager } from "../src/preview-runtime-manager.js";
import {
    WorkspaceStore,
    type WorkspaceAuthoringState,
} from "../src/workspace-store.js";

const DOC: ShaderGraphDocument = {
    schemaVersion: 1,
    graphId: "g",
    profile: "gglab.surface",
    profileVersion: 1,
    parameters: [],
    nodes: [],
    connections: [],
    editorMetadata: { nodes: {}, unknownFields: {} },
    unknownFields: {},
};

function fileDoc(
    sessionId: string,
    uri: ReturnType<typeof canonicalDocumentUriFromHost>,
    rev: ReturnType<typeof fileRevisionTokenFromHost>,
    path: string,
): DocumentSession {
    return createSession(createDocumentSessionId(sessionId), provenanceFromFile(path), DOC, uri, rev);
}

function twoOpen(): { workspace: WorkspaceSession<DocumentSession>; a: DocumentSession; b: DocumentSession } {
    const a = fileDoc("doc-a", canonicalDocumentUriFromHost("file:///C:/gglab/A.shadergraph"), fileRevisionTokenFromHost("rev-a"), "C:\\gglab\\A.shadergraph");
    const b = fileDoc("doc-b", canonicalDocumentUriFromHost("file:///C:/gglab/B.shadergraph"), fileRevisionTokenFromHost("rev-b"), "C:\\gglab\\B.shadergraph");
    let workspace = createWorkspaceSession<DocumentSession>();
    const oa = openWorkspaceDocument(workspace, a);
    if (oa.accepted === false) throw new Error("open a refused");
    workspace = oa.workspace;
    const ob = openWorkspaceDocument(workspace, b);
    if (ob.accepted === false) throw new Error("open b refused");
    workspace = ob.workspace;
    return { workspace, a, b };
}

describe("resolvePreviewTarget — the Runtime composes from the explicit target", () => {
    it("the first opened document is the Preview target from the start (explicit from the first OPEN, never a live active-follow)", () => {
        const { workspace, a, b } = twoOpen();
        // The fixture opens A first, then B: B is the active tab, but an
        // EXPLICIT Preview target already exists — it was seeded at the first
        // open (a one-time ownership decision), not derived from the active
        // tab. A later open / activation never moves it.
        expect(workspace.activeDocumentId).toBe(b.sessionId);
        expect(hasExplicitPreviewTarget(workspace)).toBe(true);
        const resolved = resolvePreviewTarget(workspace);
        expect(resolved?.sessionId).toBe(a.sessionId);
    });

    it("an explicit target is pinned even when the active tab differs", () => {
        const { workspace, a, b } = twoOpen();
        // Explicitly target A.
        const targeted = commitWorkspacePreviewTarget(workspace, a.sessionId);
        expect(targeted.accepted).toBe(true);
        const withTarget = targeted.accepted ? targeted.workspace : workspace;
        // Now activate B (editing B) — the target must stay A.
        const switched = activateWorkspaceDocument(withTarget, b.sessionId);
        expect(switched.accepted).toBe(true);
        const afterSwitch = switched.accepted ? switched.workspace : withTarget;
        expect(afterSwitch.activeDocumentId).toBe(b.sessionId);
        expect(resolvePreviewTarget(afterSwitch)?.sessionId).toBe(a.sessionId);
        expect(hasExplicitPreviewTarget(afterSwitch)).toBe(true);
    });

    it("retarget moves the resolved target; a second retarget moves it again", () => {
        const { workspace, a, b } = twoOpen();
        const t1 = commitWorkspacePreviewTarget(workspace, a.sessionId);
        expect(t1.accepted).toBe(true);
        const w1 = t1.accepted ? t1.workspace : workspace;
        expect(resolvePreviewTarget(w1)?.sessionId).toBe(a.sessionId);
        // Retarget to B (the only way to move it).
        const t2 = commitWorkspacePreviewTarget(w1, b.sessionId);
        expect(t2.accepted).toBe(true);
        const w2 = t2.accepted ? t2.workspace : w1;
        expect(resolvePreviewTarget(w2)?.sessionId).toBe(b.sessionId);
    });

    it("closing a tab that is the target RE-SEEDS it onto the surviving active (no live fallback); closing a non-target keeps it", () => {
        const { workspace, a, b } = twoOpen();
        // Target A, close A → ownership re-seeds, as a one-time close-time
        // decision, onto the surviving active document (B). It is still an
        // explicit target — never a live re-coupling to whatever tab is open.
        const tA = commitWorkspacePreviewTarget(workspace, a.sessionId);
        expect(tA.accepted).toBe(true);
        const wA = tA.accepted ? tA.workspace : workspace;
        const cA = closeWorkspaceDocument(wA, a.sessionId);
        expect(cA.accepted).toBe(true);
        const afterCloseA = cA.accepted ? cA.workspace : wA;
        expect(hasExplicitPreviewTarget(afterCloseA)).toBe(true);
        expect(afterCloseA.preview.targetDocumentId).toBe(b.sessionId);
        expect(resolvePreviewTarget(afterCloseA)?.sessionId).toBe(b.sessionId);

        // Fresh: target B, close A (non-target) → target stays B.
        const { workspace: ws2, a: a2, b: b2 } = twoOpen();
        const tB = commitWorkspacePreviewTarget(ws2, b2.sessionId);
        expect(tB.accepted).toBe(true);
        const wB = tB.accepted ? tB.workspace : ws2;
        const cA2 = closeWorkspaceDocument(wB, a2.sessionId);
        expect(cA2.accepted).toBe(true);
        const afterClose = cA2.accepted ? cA2.workspace : wB;
        expect(hasExplicitPreviewTarget(afterClose)).toBe(true);
        expect(resolvePreviewTarget(afterClose)?.sessionId).toBe(b2.sessionId);
    });
});

// ---- Part 2 — ownership transitions + gate composition ----

const SESSION_ID = "34".repeat(16);

const CANDIDATE_A: ToolCandidate = {
    rule: "bundled",
    toolPath: "C:/tools/gglab-shaderc.exe",
    observationIdentity: "candidate-a",
    resolvedAt: 1,
};

const CANDIDATE_C: ToolCandidate = {
    ...CANDIDATE_A,
    toolPath: "D:/other/gglab-shaderc.exe",
    observationIdentity: "candidate-c",
    resolvedAt: 3,
};

const TOOL_FACTS: ToolFacts = {
    toolIdentity: "gglab-shaderc",
    toolVersion: "1.3.0",
    processContractVersion: 2,
    compilePolicyRevision: 1,
    producerKind: "dxc",
    producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
    supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
};

function compatible(candidate: ToolCandidate): ToolCompatibilityState {
    return {
        status: "compatible",
        candidate,
        provenFacts: TOOL_FACTS,
        proof: { processContractVersion: 2, compilePolicyRevision: 1 },
    };
}

class TestToolPort implements PreviewToolStatePort {
    state: ToolCompatibilityState = { status: "unavailable" };

    current(): ToolCompatibilityState {
        return this.state;
    }

    candidateInvalidated(): void {
        // The transitions under test never invalidate; a call here is a
        // test-environment defect.
        throw new Error("candidate invalidation is not scripted in this scenario");
    }
}

function fixture(name: string): string {
    return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/shader-graph-core/tests/fixtures", name), "utf8");
}

function parsedFixture(name: string): ShaderGraphDocument {
    const parsed = parseShaderGraphDocument(fixture(name));
    if (parsed.ok === false || parsed.value === null) {
        throw new Error(`fixture must parse: ${name}`);
    }
    return parsed.value;
}

function parsedDocument(raw: unknown): ShaderGraphDocument {
    const parsed = parseShaderGraphDocument(JSON.stringify(raw));
    if (parsed.ok === false || parsed.value === null) {
        throw new Error("test document must parse");
    }
    return parsed.value;
}

const D1: SurfaceProfileDescriptor = (() => {
    const parsed = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture));
    if (!parsed.ok || parsed.value === null) {
        throw new Error("v1 fixture descriptor must parse");
    }
    return parsed.value;
})();

const D2: SurfaceProfileDescriptor = (() => {
    const parsed = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV2Fixture));
    if (!parsed.ok || parsed.value === null) {
        throw new Error("v2 fixture descriptor must parse");
    }
    return parsed.value;
})();

/** A v1-line graph (legal under the D1 profile line only) — the app's
 * known-emittable seed shape. */
const V1_GRAPH = parsedDocument({
    schemaVersion: 1,
    graphId: "coordinator-test-v1",
    profile: "gglab.surface",
    profileVersion: 1,
    parameters: [{ id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" }],
    nodes: [
        { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
        { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
    ],
    connections: [{ id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } }],
    editorMetadata: { nodes: {} },
});

/** A v1-line graph that claims ALL FIVE required outputs: fully emittable
 * under the D1 profile line (and therefore NOT under the v2 line). */
const V1_EMIT = parsedDocument({
    schemaVersion: 1,
    graphId: "coordinator-test-v1-emit",
    profile: "gglab.surface",
    profileVersion: 1,
    parameters: [
        { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" },
        { id: "p.factor", name: "Factor", class: "ScalarParameter", valueType: "float" },
    ],
    nodes: [
        { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
        { id: "n.f", type: "ScalarParameter", version: 1, properties: { parameterId: "p.factor" } },
        { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
    ],
    connections: [
        { id: "c.base", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
        { id: "c.emis", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
        { id: "c.metal", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
        { id: "c.rough", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
        { id: "c.alpha", from: { nodeId: "n.f", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
    ],
    editorMetadata: { nodes: {} },
});

/** The golden v2-line graph: legal under the D2 profile line only. */
const V2_GRAPH = parsedFixture("SurfaceTextureGolden.shadergraph");

// The scenario logic depends on the profile-line legality of these pairs.
// Assert the invariants once, loudly, at module load.
if (emitHlsl(V1_EMIT, D1).ok === false) {
    throw new Error("fixture invariant broken: the fully-emittable v1 graph must emit under the v1 descriptor");
}
if (emitHlsl(V2_GRAPH, D2).ok === false) {
    throw new Error("fixture invariant broken: the golden v2 graph must emit under the v2 descriptor");
}
if (emitHlsl(V2_GRAPH, D1).ok !== false) {
    throw new Error("fixture invariant broken: the v2 golden must NOT emit under the v1 descriptor");
}

function docSession(id: string, document: ShaderGraphDocument, emission: HlslEmission | null = null): DocumentSession {
    const base = createSession(createDocumentSessionId(id), provenanceFromImport(), document);
    return { ...base, presentation: { ...base.presentation, emission } };
}

interface World {
    readonly runtime: FakePreviewRuntimeBoundary;
    readonly manager: AttachedPreviewRuntimeManager;
    readonly flow: PreviewBuildFlow;
    readonly port: TestToolPort;
    readonly coordinator: PreviewCoordinator;
    readonly store: WorkspaceStore<WorkspaceAuthoringState>;
}

async function attach(world: World): Promise<void> {
    const launch = await world.manager.launch(CANDIDATE_A);
    if (launch.launched === false) {
        throw new Error("test Preview Runtime must launch");
    }
}

function makeWorld(
    state: WorkspaceAuthoringState,
    runtimeSpec: ConstructorParameters<typeof FakePreviewRuntimeBoundary>[0],
): World {
    const runtime = new FakePreviewRuntimeBoundary(runtimeSpec);
    const manager = new AttachedPreviewRuntimeManager(runtime, SESSION_ID);
    const tool = new FakeHostBoundary({
        discovery: { kind: "resolved", candidate: CANDIDATE_A },
        handshake: { stdout: "", exitCode: 0 },
        previewHandshake: { stdout: "", exitCode: 1 },
        previewBuild: [],
        compile: [],
    });
    const observation = new FakePreviewObservationBoundary({ reads: [{ kind: "not-found" }] });
    const port = new TestToolPort();
    const flow = new PreviewBuildFlow(tool, port, SESSION_ID, observation, manager);
    const store = new WorkspaceStore<WorkspaceAuthoringState>(state);
    // This world HAS a host (real manager + flow); the accessors stand in
    // for the hook's live refs.
    const coordinator = new PreviewCoordinator(() => manager, () => flow, store);
    return { runtime, manager, flow, port, coordinator, store };
}

function readyComposition(): PreviewCompositionInput {
    return {
        document: V1_GRAPH,
        descriptor: D1,
        descriptorCompatible: true,
        emission: null,
        configuredTarget: "gglab-dx12",
        previewProgramDescriptorIdentity: "a7".repeat(32),
    };
}

function nonReadyComposition(): PreviewCompositionInput {
    return { ...readyComposition(), descriptor: null, descriptorCompatible: false, emission: null };
}

describe("PreviewCoordinator — commit-time CURRENT revalidation", () => {
    it("commits a retarget with the descriptor CURRENT after the teardown settles — D1 -> D2 uses D2, and D1 never is", async () => {
        // The target B is on the v2 profile line: D1 (v1) CANNOT legally
        // emit it, D2 (v2) can. So a commit applied against the
        // descriptor-at-intent-time (D1) would be a refusal — the only
        // successful reading of this scenario is the CURRENT descriptor.
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D1,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        const retarget = world.coordinator.retargetTo(B.sessionId);
        // The stop request was issued and held (teardown pending)...
        expect(world.runtime.releaseStop()).toBe(true);
        // ...while it is pending the descriptor moves D1 -> D2 (an ordinary
        // Workspace application), and the teardown then settles PROVEN.
        world.store.apply((current) => ({ next: { ...current, profileDescriptor: D2 }, result: null }));

        const result = await retarget;
        expect(result).toMatchObject({
            ok: true,
            identity: { kind: "retarget", targetDocumentId: B.sessionId },
            targetChanged: true,
        });

        const snapshot = world.store.getSnapshot();
        const [docA, docB] = snapshot.session.documents;
        expect(snapshot.session.preview.targetDocumentId).toBe(B.sessionId);
        // The committed emission is f(B, D2) — the descriptor CURRENT at
        // commit time, resolved inside the same synchronous application.
        const expectedUnderD2 = emitHlsl(V2_GRAPH, D2);
        expect(expectedUnderD2.ok).toBe(true);
        expect(docB?.presentation.emission).toEqual(expectedUnderD2);
        // And D1 is UNUSABLE for this commit: under the descriptor the
        // retarget started with, the target cannot legally emit at all —
        // had D1 been captured and applied, this transition would have
        // refused.
        expect(emitHlsl(V2_GRAPH, D1).ok).toBe(false);
        // The source tab's presentation is untouched.
        expect(docA).toBe(A);
    });

    it("commits a retarget that the CURRENT descriptor cannot emit as a refusal, leaving the snapshot UNCHANGED", async () => {
        // C is on the v1 line; by commit time the descriptor is D2 (v2):
        // the pair cannot legally emit — refuse, and keep the snapshot.
        const A = docSession("A", V1_GRAPH, { ok: true, source: "A under D1" } as unknown as HlslEmission);
        const C = docSession("C", V1_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, C],
                    activeDocumentId: C.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D1,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        const retarget = world.coordinator.retargetTo(C.sessionId);
        expect(world.runtime.releaseStop()).toBe(true);
        world.store.apply((current) => ({ next: { ...current, profileDescriptor: D2 }, result: null }));

        const result = await retarget;
        expect(result).toMatchObject({ ok: false, refusal: { reason: "target-emission-unavailable" } });

        const snapshot = world.store.getSnapshot();
        // The snapshot is UNCHANGED: the target did not move, the refused
        // emission was stored NOWHERE, and the source emission is intact.
        expect(snapshot.session.preview.targetDocumentId).toBe(A.sessionId);
        const [docA, docC] = snapshot.session.documents;
        expect(docC?.presentation.emission).toBeNull();
        expect(docA?.presentation.emission).toBe(A.presentation.emission);
    });

    it("refuses a retarget while the Workspace has NO descriptor (nothing to emit under)", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V1_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: null,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }] },
        );

        await attach(world);
        const result = await world.coordinator.retargetTo(B.sessionId);
        expect(result).toMatchObject({ ok: false, refusal: { reason: "target-emission-unavailable" } });
        expect(world.store.getSnapshot().session.preview.targetDocumentId).toBe(A.sessionId);
    });

    it("performs NO teardown on the same-target fast path and still refreshes the emission against the CURRENT descriptor", async () => {
        const A = docSession("A", V2_GRAPH, { ok: true, source: "stale A emission" } as unknown as HlslEmission);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: B.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true },
        );

        await attach(world);
        const result = await world.coordinator.retargetTo(B.sessionId);

        expect(result).toMatchObject({
            ok: true,
            identity: { kind: "retarget", targetDocumentId: B.sessionId },
            targetChanged: false,
        });
        // NO stop was ever requested for the attached Runtime.
        expect(world.runtime.releaseStop()).toBe(false);
        // targetChanged: false does NOT mean the Workspace was unchanged:
        // the target's emission was refreshed against the current
        // descriptor (D2), while the other tab keeps its emission.
        const [docA, docB] = world.store.getSnapshot().session.documents;
        expect(docB?.presentation.emission).toEqual(emitHlsl(V2_GRAPH, D2));
        expect(docA?.presentation.emission).toBe(A.presentation.emission);
    });

    it("holds exactly one in-flight transition at a time (no queue, no auto-supersede), and releases the slot after", async () => {
        // A: the v1 seed (target at start; emission refused under any line
        // claim — irrelevant, it is never the committed target); B: the
        // golden v2 target; C: the fully-emittable v1 target.
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const C = docSession("C", V1_EMIT);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B, C],
                    activeDocumentId: C.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D1,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        const first = world.coordinator.retargetTo(C.sessionId);

        // A second arrival while the first is in flight refuses IMMEDIATELY
        // — it is not queued and does not supersede.
        const second = await world.coordinator.retargetTo(B.sessionId);
        expect(second).toMatchObject({
            ok: false,
            refusal: {
                reason: "transition-in-flight",
                inFlight: { kind: "retarget", targetDocumentId: C.sessionId, sequence: 1 },
            },
        });

        expect(world.runtime.releaseStop()).toBe(true);
        const firstResult = await first;
        expect(firstResult).toMatchObject({
            ok: true,
            identity: { kind: "retarget", targetDocumentId: C.sessionId, sequence: 1 },
            targetChanged: true,
        });

        // Slot released: retries proceed, never refused as in-flight.
        // After the descriptor moves D1 -> D2, the v1-line C CANNOT emit
        // (the slot was released and the intent revalidated), while the
        // v2-line B commits under D2.
        world.store.apply((current) => ({ next: { ...current, profileDescriptor: D2 }, result: null }));
        const third = await world.coordinator.retargetTo(C.sessionId);
        // CLAIMED and revalidated against the CURRENT descriptor — refused
        // as emission-unavailable (v1 line under D2), NOT as in-flight.
        expect(third).toMatchObject({ ok: false, refusal: { reason: "target-emission-unavailable" } });
        // An in-flight refusal does NOT consume a sequence (it never
        // claimed): first=1, third=2, fourth=3.
        const fourth = await world.coordinator.retargetTo(B.sessionId);
        expect(fourth).toMatchObject({
            ok: true,
            identity: { kind: "retarget", targetDocumentId: B.sessionId, sequence: 3 },
            targetChanged: true,
        });
    });
});

describe("PreviewCoordinator — target-close transition", () => {
    it("refuses to close the Preview target on an UNPROVEN exit, and the tab remains open", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "wait-failed" },
        );

        await attach(world);
        const close = world.coordinator.closeTarget(A.sessionId, documentRevision(A));
        expect(world.runtime.releaseStop()).toBe(true); // wait-failed settlement

        const result = await close;
        expect(result).toMatchObject({ ok: false, refusal: { reason: "exit-unproven" } });

        // The tab REMAINS OPEN and the target did not move: an ownership
        // transition did not commit on an unproven exit.
        const snapshot = world.store.getSnapshot();
        expect(snapshot.session.documents.map((document) => document.sessionId)).toEqual([A.sessionId, B.sessionId]);
        expect(snapshot.session.preview.targetDocumentId).toBe(A.sessionId);
    });

    it("closes the target only after a PROVEN exit, in one transaction with the target re-seed", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        const close = world.coordinator.closeTarget(A.sessionId, documentRevision(A));
        expect(world.runtime.releaseStop()).toBe(true);
        const result = await close;

        expect(result).toMatchObject({
            ok: true,
            identity: { kind: "close-target", targetDocumentId: A.sessionId, sequence: 1 },
        });
        const snapshot = world.store.getSnapshot();
        expect(snapshot.session.documents.map((document) => document.sessionId)).toEqual([B.sessionId]);
        // The reducer re-seeded the Preview target from the surviving
        // ACTIVE document.
        expect(snapshot.session.preview.targetDocumentId).toBe(B.sessionId);
    });

    it("refuses a NON-target close here (that path is a plain Workspace reducer operation) without touching the Runtime", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true },
        );

        await attach(world);
        const result = await world.coordinator.closeTarget(B.sessionId, documentRevision(B));
        expect(result).toMatchObject({
            ok: false,
            refusal: { reason: "document-not-preview-target", documentSessionId: B.sessionId },
        });
        // No stop was issued for the attached Runtime.
        expect(world.runtime.releaseStop()).toBe(false);
        expect(world.store.getSnapshot().session.documents).toHaveLength(2);
    });

    it("refuses to retarget a tab that is not open (claim -> guard -> release)", async () => {
        const A = docSession("A", V1_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A],
                    activeDocumentId: A.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }] },
        );

        const missing = createDocumentSessionId("missing");
        const result = await world.coordinator.retargetTo(missing);
        expect(result).toMatchObject({ ok: false, refusal: { reason: "target-not-open", targetDocumentId: missing } });
        // The slot is released even after the guard refusal: a valid
        // transition can now proceed (A is the active + target; under D2
        // its v1 line cannot emit — the structured refusal is the proof
        // the transition was CLAIMED, not refused as in-flight).
        const again = await world.coordinator.retargetTo(A.sessionId);
        expect(again).toMatchObject({ ok: false, refusal: { reason: "target-emission-unavailable" } });
    });

    it("does NOT close a NEWER revision a pending teardown raced with: the close binds to the revision the user confirmed discarding (document-changed-during-close)", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        // The revision the (dirty-confirmed) user saw when closing: A's
        // CURRENT content.
        const confirmedRevision = documentRevision(A);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        const close = world.coordinator.closeTarget(A.sessionId, confirmedRevision);
        // The strict teardown was issued and is held pending (terminating —
        // read without consuming the hold), so the commit cannot have run yet.
        expect(world.manager.state).toMatchObject({ kind: "terminating" });
        // While it is pending, A is edited into a NEWER revision (the exact
        // data-loss race: the user confirmed discarding the OLD one). V1_EMIT
        // is a distinct, valid document → a different canonical revision.
        const revised = V1_EMIT;
        const revisedA = recordDocumentChange(A, revised, "edit while close is pending");
        world.store.apply((current) => ({
            next: {
                ...current,
                session: { ...current.session, documents: current.session.documents.map((document) => (document.sessionId === A.sessionId ? revisedA : document)) },
            },
            result: null,
        }));
        // The teardown then settles PROVEN. Commit-time revalidation must see
        // the NEWER revision and REFUSE — never silently close it.
        expect(world.runtime.releaseStop()).toBe(true);
        const result = await close;
        expect(result).toMatchObject({
            ok: false,
            refusal: { reason: "document-changed-during-close", documentSessionId: A.sessionId },
        });
        // A REMAINS OPEN with the newer revision preserved — and the target
        // did not move.
        const snapshot = world.store.getSnapshot();
        expect(snapshot.session.documents.map((document) => document.sessionId)).toEqual([A.sessionId, B.sessionId]);
        expect(snapshot.session.documents.find((document) => document.sessionId === A.sessionId)?.history.present).toBe(revised);
        expect(snapshot.session.preview.targetDocumentId).toBe(A.sessionId);
    });
});

describe("PreviewCoordinator — build / transition mutual exclusion", () => {
    it("refuses a Preview build while an ownership transition is in flight — no queue, no auto-supersede", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        // Kick off a retarget whose strict teardown is held pending.
        const retarget = world.coordinator.retargetTo(B.sessionId);
        expect(world.manager.state).toMatchObject({ kind: "terminating" }); // teardown in flight

        // A build arriving while the transition is in flight must be a
        // STRUCTURAL refusal (preview-transition-in-flight), not queued and
        // not superseded — and it opens NO build lifecycle.
        const build = await world.coordinator.buildPreview(readyComposition());
        expect(build).toMatchObject({
            issued: false,
            reason: "gate-refused",
            gate: { admitted: false, reasons: [{ reason: "preview-transition-in-flight" }] },
        });
        expect(world.flow.buildInFlight).toBe(false); // nothing was queued

        // The transition then proceeds and commits once its teardown
        // settles — nothing in the meantime was deferred or superseded.
        expect(world.runtime.releaseStop()).toBe(true);
        const result = await retarget;
        expect(result).toMatchObject({ ok: true, targetChanged: true, identity: { kind: "retarget", targetDocumentId: B.sessionId } });
    });

    it("refuses a target-close (not just a retarget) while a transition is in flight, and vice versa: one slot, both directions", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        // A close-target transition is in flight (teardown held)...
        const close = world.coordinator.closeTarget(A.sessionId, documentRevision(A));
        expect(world.manager.state).toMatchObject({ kind: "terminating" });
        // ...a retarget arriving is refused as in-flight (not queued)...
        const retargetRefused = await world.coordinator.retargetTo(B.sessionId);
        expect(retargetRefused).toMatchObject({ ok: false, refusal: { reason: "transition-in-flight" } });
        // ...and a second close is refused as in-flight too.
        const closeRefused = await world.coordinator.closeTarget(A.sessionId, documentRevision(A));
        expect(closeRefused).toMatchObject({ ok: false, refusal: { reason: "transition-in-flight" } });

        // The teardown settles; the ORIGINAL close commits...
        expect(world.runtime.releaseStop()).toBe(true);
        const result = await close;
        expect(result).toMatchObject({ ok: true, identity: { kind: "close-target", targetDocumentId: A.sessionId } });
    });

    it("gate() and runtimeProjection() agree: while a transition is in flight the composed gate refuses (preview-transition-in-flight) and the projection is suspended — never Ready/current", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" },
        );

        await attach(world);
        // Kick off a retarget whose strict teardown is held pending (the
        // single-flight slot is owned).
        const retarget = world.coordinator.retargetTo(B.sessionId);
        expect(world.manager.state).toMatchObject({ kind: "terminating" });

        // The composed gate is the SAME authority a real Build action would
        // take: it is a STRUCTURAL refusal (preview-transition-in-flight),
        // never "admitted" while the build would be refused.
        const gate = world.coordinator.gate(readyComposition());
        expect(gate.admitted).toBe(false);
        expect(gate.reasons).toEqual([{ reason: "preview-transition-in-flight" }]);

        // And the honest runtime view is SUSPENDED (neutral idle) — it must
        // not project as Ready/current for a build line we cannot admit.
        const projection = world.coordinator.runtimeProjection(readyComposition());
        expect(projection.freshness).not.toBe("current");
        expect(projection).toMatchObject({
            freshness: "idle",
            latestBuildState: null,
            currentPublicationId: null,
            lastGoodPublicationId: null,
            observationBinding: "none",
        });

        // Once the teardown settles and the transition commits, the gate no
        // longer refuses as transition-in-flight (the slot is released).
        expect(world.runtime.releaseStop()).toBe(true);
        await retarget;
        const after = world.coordinator.gate(readyComposition());
        expect(after.reasons.some((reason) => reason.reason === "preview-transition-in-flight")).toBe(false);
    });
});

describe("PreviewCoordinator — proven no Runtime (no host) still commits Workspace transitions", () => {
    // A coordinator whose host bindings are ABSENT (the manager and flow
    // accessors return null). The distinction that must hold: proven no
    // Runtime (no host) ALLOWS the pure Workspace transition, while a
    // host's safety state (unproven exit / conflict) BLOCKS it.
    function hostless(state: WorkspaceAuthoringState): { coordinator: PreviewCoordinator; store: WorkspaceStore<WorkspaceAuthoringState> } {
        const store = new WorkspaceStore<WorkspaceAuthoringState>(state);
        return { coordinator: new PreviewCoordinator(() => null, () => null, store), store };
    }

    const twoDocs = (targetDoc: DocumentSession, otherDoc: DocumentSession) => ({
        session: {
            workspaceRoot: null,
            documents: [targetDoc, otherDoc],
            activeDocumentId: otherDoc.sessionId,
            preview: { targetDocumentId: targetDoc.sessionId },
        },
        profileDescriptor: D1,
    });

    it("commits a retarget with NO teardown (no host) — a pure Workspace commit under the CURRENT descriptor", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V1_EMIT);
        const { coordinator, store } = hostless(twoDocs(A, B));

        const result = await coordinator.retargetTo(B.sessionId);
        expect(result).toMatchObject({ ok: true, targetChanged: true, identity: { kind: "retarget", targetDocumentId: B.sessionId } });
        // The commit re-resolved the CURRENT target emission under the
        // CURRENT descriptor — no Runtime was involved at all.
        const snapshot = store.getSnapshot();
        expect(snapshot.session.preview.targetDocumentId).toBe(B.sessionId);
        const docB = snapshot.session.documents.find((document) => document.sessionId === B.sessionId);
        expect(docB?.presentation.emission).toEqual(emitHlsl(V1_EMIT, D1));
    });

    it("commits a target-close (with the target re-seed) with NO teardown (no host)", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V1_EMIT);
        const { coordinator, store } = hostless(twoDocs(A, B));

        const result = await coordinator.closeTarget(A.sessionId, documentRevision(A));
        expect(result).toMatchObject({ ok: true, identity: { kind: "close-target", targetDocumentId: A.sessionId } });
        const snapshot = store.getSnapshot();
        expect(snapshot.session.documents.map((document) => document.sessionId)).toEqual([B.sessionId]);
        expect(snapshot.session.preview.targetDocumentId).toBe(B.sessionId);
    });

    it("is a STRUCTURAL refusal for the build and the gate (preview-host-unavailable), and a neutral projection", async () => {
        const A = docSession("A", V1_GRAPH);
        const { coordinator } = hostless({
            session: { workspaceRoot: null, documents: [A], activeDocumentId: A.sessionId, preview: { targetDocumentId: A.sessionId } },
            profileDescriptor: D1,
        });

        expect(coordinator.gate(readyComposition())).toMatchObject({
            admitted: false,
            reasons: [{ reason: "preview-host-unavailable" }],
        });
        const build = await coordinator.buildPreview(readyComposition());
        expect(build).toMatchObject({
            issued: false,
            reason: "gate-refused",
            gate: { admitted: false, reasons: [{ reason: "preview-host-unavailable" }] },
        });
        expect(coordinator.runtimeProjection(readyComposition())).toMatchObject({ freshness: "idle" });
    });
});

describe("PreviewCoordinator — gate composition and safety-state transitions", () => {
    it("maps an unproven launch outcome BEFORE the composition (one exact Runtime refusal)", async () => {
        const A = docSession("A", V1_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A],
                    activeDocumentId: A.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D1,
            },
            { launches: [{ kind: "launched" }], rejectLaunch: true },
        );

        await expect(world.manager.launch(CANDIDATE_A)).rejects.toThrow();
        expect(world.manager.state).toMatchObject({ kind: "launch-outcome-unproven" });

        // Even with a composition the build gate would refuse for its OWN
        // reason (no descriptor), the exact Runtime fact is the single
        // refusal — it is mapped BEFORE the composition.
        expect(world.coordinator.gate(nonReadyComposition())).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-launch-outcome-unproven" }],
        });
    });

    it("maps the ownership conflict before the composition", async () => {
        const A = docSession("A", V1_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A],
                    activeDocumentId: A.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D1,
            },
            { launches: [{ kind: "session-already-running", runtimeId: { sequence: 42 } }] },
        );

        await world.manager.launch(CANDIDATE_A);
        expect(world.manager.state).toMatchObject({ kind: "runtime-ownership-conflict" });
        expect(world.coordinator.gate(nonReadyComposition())).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-ownership-conflict" }],
        });
    });

    it("refuses a retarget from an ownership-conflict state (terminateAndJoin REJECTS; the snapshot is untouched; the slot is released)", async () => {
        const A = docSession("A", V1_GRAPH);
        const B = docSession("B", V2_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A, B],
                    activeDocumentId: B.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D2,
            },
            { launches: [{ kind: "session-already-running", runtimeId: { sequence: 42 } }] },
        );

        await world.manager.launch(CANDIDATE_A);
        expect(world.manager.state).toMatchObject({ kind: "runtime-ownership-conflict" });

        const result = await world.coordinator.retargetTo(B.sessionId);
        expect(result).toMatchObject({ ok: false, refusal: { reason: "teardown-rejected" } });
        expect(world.store.getSnapshot().session.preview.targetDocumentId).toBe(A.sessionId);

        // And the slot is released: a later transition is attempted again
        // (re-refused by the same safety state — never an in-flight refusal).
        const again = await world.coordinator.retargetTo(B.sessionId);
        expect(again).toMatchObject({ ok: false, refusal: { reason: "teardown-rejected" } });
    });

    it("keeps the deployment equality on exact toolPath (never descriptor identity) in the composed gate", async () => {
        const A = docSession("A", V1_GRAPH);
        const world = makeWorld(
            {
                session: {
                    workspaceRoot: null,
                    documents: [A],
                    activeDocumentId: A.sessionId,
                    preview: { targetDocumentId: A.sessionId },
                },
                profileDescriptor: D1,
            },
            { launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }] },
        );

        await attach(world);
        world.port.state = compatible(CANDIDATE_A);
        expect(world.coordinator.gate(readyComposition())).not.toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-deployment-mismatch" }],
        });
        world.port.state = compatible(CANDIDATE_C);
        expect(world.coordinator.gate(readyComposition())).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-deployment-mismatch" }],
        });
    });
});
