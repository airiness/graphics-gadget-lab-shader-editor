import { describe, expect, it } from "vitest";
import {
    FakeHostBoundary,
    FakePreviewObservationBoundary,
    FakePreviewRuntimeBoundary,
    type BoundaryResult,
    type ToolCandidate,
    type ToolCompatibilityState,
    type ToolFacts,
} from "@gglab/shader-toolchain-client";
import {
    parseSurfaceProfileDescriptor,
    sha256Hex,
    utf8Encode,
    type GraphParameter,
    type HlslEmission,
    type ShaderGraphDocument,
    type SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import { PreviewBuildController, type PreviewBuildGate, type PreviewCompositionInput, type PreviewToolStatePort } from "../src/preview-build-controller.js";
import { AttachedPreviewRuntimeManager } from "../src/preview-runtime-manager.js";
import { previewSessionReport } from "../src/preview-build-session.js";
import { PreviewCoordinator } from "../src/preview-coordinator.js";
import { WorkspaceStore, type WorkspaceAuthoringState } from "../src/workspace-store.js";
import { createDocumentSessionId, createWorkspaceSession } from "../src/workspace-session.js";

function manager(boundary: FakePreviewRuntimeBoundary): AttachedPreviewRuntimeManager {
    return new AttachedPreviewRuntimeManager(boundary, SESSION_ID);
}

/** The Coordinator reads the host bindings through accessors; the test
 * world has both, so simple constant accessors stand in for the live refs. */
function coordinator(manager: AttachedPreviewRuntimeManager, flow: PreviewBuildController): PreviewCoordinator {
    return new PreviewCoordinator(
        () => manager,
        () => flow,
        new WorkspaceStore<WorkspaceAuthoringState>({ session: createWorkspaceSession(), profileDescriptor: null }),
    );
}

/** The UNADORNED controller gate. Production callers go through the
 * PreviewCoordinator (which composes its facts BEFORE this gate); tests of
 * the controller alone must name their gate explicitly — there is no
 * silent uncomposed default to fall into. */
function selfGate(flow: PreviewBuildController): (input: PreviewCompositionInput) => PreviewBuildGate {
    return (input) => flow.buildGate(input);
}

const DESCRIPTOR_IDENTITY = "a7".repeat(32);
const SESSION_ID = "12".repeat(16);
const PUBLICATION_ID = "b1".repeat(32);

const CANDIDATE_A: ToolCandidate = {
    rule: "bundled",
    toolPath: "C:/tools/gglab-shaderc.exe",
    observationIdentity: "candidate-a",
    resolvedAt: 1,
};

const CANDIDATE_B: ToolCandidate = {
    ...CANDIDATE_A,
    observationIdentity: "candidate-b",
    resolvedAt: 2,
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
    state: ToolCompatibilityState = compatible(CANDIDATE_A);
    invalidations: BoundaryResult[] = [];

    current(): ToolCompatibilityState {
        return this.state;
    }

    candidateInvalidated(result: Extract<BoundaryResult, { kind: "candidate-invalidated" }>): void {
        this.invalidations.push(result);
        if (this.state.status !== "unavailable" && this.state.candidate.observationIdentity === result.candidate.observationIdentity) {
            this.state = { status: "unavailable" };
        }
    }
}

function descriptor(): SurfaceProfileDescriptor {
    const parsed = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture));
    if (!parsed.ok || parsed.value === null) {
        throw new Error("test descriptor must parse");
    }
    return parsed.value;
}

function parameter(id: string, parameterClass: string, valueType: GraphParameter["valueType"]): GraphParameter {
    return { id, name: id, class: parameterClass, valueType, unknownFields: {} };
}

function graph(): ShaderGraphDocument {
    return {
        schemaVersion: 1,
        graphId: "preview-flow-test",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [
            parameter("p.tint", "VectorParameter", "float3"),
            parameter("p.metal", "ScalarParameter", "float"),
        ],
        nodes: [],
        connections: [],
        editorMetadata: { nodes: {}, unknownFields: {} },
        unknownFields: {},
    };
}

function emission(source = "// generated\nSurfaceData EvaluateSurface(float p_metal, float3 p_tint, float2 uv0) { return (SurfaceData)0; }\n"): HlslEmission {
    const identity = sha256Hex(utf8Encode(source));
    return { ok: true, diagnostics: [], source, sourceMap: { generatedSourceIdentity: identity, ranges: [] } };
}

function composition(change: Partial<PreviewCompositionInput> = {}): PreviewCompositionInput {
    return {
        document: graph(),
        descriptor: descriptor(),
        descriptorCompatible: true,
        emission: emission(),
        configuredTarget: "gglab-dx12",
        previewProgramDescriptorIdentity: DESCRIPTOR_IDENTITY,
        ...change,
    };
}

function previewHandshakeOk(): string {
    return JSON.stringify({
        command: "describe-preview",
        success: true,
        status: "ok",
        exitCode: 0,
        processContractVersion: 2,
        previewBuildContractVersion: 1,
        compilePolicyRevision: 1,
        toolIdentity: TOOL_FACTS.toolIdentity,
        toolVersion: TOOL_FACTS.toolVersion,
        producerKind: TOOL_FACTS.producerKind,
        producerIdentity: TOOL_FACTS.producerIdentity,
        supportedTargets: [...TOOL_FACTS.supportedTargets],
        previewProgramDescriptorVersion: 1,
        previewProgramDescriptorIdentity: DESCRIPTOR_IDENTITY,
        supportedPreviewInputContracts: [
            {
                id: "gglab.preview-input.surface.numeric",
                profileId: "gglab.surface",
                profileVersion: 1,
            },
        ],
        previewPublicationSchemaVersion: 1,
        previewActivePublicationSchemaVersion: 1,
        previewObservationSchemaVersion: 1,
        diagnostics: [],
    });
}

function previewBuildOk(attemptSequence: number, publicationId = PUBLICATION_ID): string {
    return JSON.stringify({
        command: "build-preview",
        success: true,
        status: "ok",
        exitCode: 0,
        attemptSequence,
        publicationId,
        shaderArtifactId: "c2".repeat(32),
        baseRegistryId: "d3".repeat(32),
        previewRegistryId: "e4".repeat(32),
        diagnostics: [],
    });
}

function previewBuildFailed(attemptSequence: number): string {
    return JSON.stringify({
        command: "build-preview",
        success: false,
        status: "compile-failed",
        exitCode: 4,
        attemptSequence,
        diagnostics: [{ message: "the generated Preview Program did not compile" }],
    });
}

function fake(
    change: Partial<ConstructorParameters<typeof FakeHostBoundary>[0]> = {},
): FakeHostBoundary {
    return new FakeHostBoundary({
        discovery: { kind: "resolved", candidate: CANDIDATE_A },
        handshake: { stdout: "", exitCode: 0 },
        previewHandshake: { stdout: previewHandshakeOk(), exitCode: 0 },
        compile: [],
        previewBuild: [{ stdout: previewBuildOk(1), exitCode: 0 }],
        ...change,
    });
}

function observationBytes(
    attemptSequence: number,
    observedPublicationRef: string,
    loadedPublicationRef = observedPublicationRef,
): Uint8Array {
    const bytes = new Uint8Array(90);
    bytes.set([0x47, 0x47, 0x53, 0x48, 0x4f, 0x42, 0x53, 0x56]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 1, true);
    view.setUint32(12, 1, true);
    view.setBigUint64(16, BigInt(attemptSequence), true);
    const writeDigest = (offset: number, digest: string): void => {
        for (let index = 0; index < 32; index += 1) {
            bytes[offset + index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
        }
    };
    writeDigest(24, observedPublicationRef);
    writeDigest(56, loadedPublicationRef);
    bytes[88] = 1;
    bytes[89] = 0;
    return bytes;
}

function observations(
    reads: ConstructorParameters<typeof FakePreviewObservationBoundary>[0]["reads"] = [
        { kind: "not-found" },
    ],
    keepPending = false,
): FakePreviewObservationBoundary {
    return new FakePreviewObservationBoundary({ reads, keepPending });
}

function runtimes(
    launches: ConstructorParameters<typeof FakePreviewRuntimeBoundary>[0]["launches"] = [
        { kind: "launched" },
    ],
    keepLaunchPending = false,
    holdStopUntilRelease = false,
    stopReleaseKind: "stopped" | "wait-failed" = "stopped",
): FakePreviewRuntimeBoundary {
    return new FakePreviewRuntimeBoundary({ launches, keepLaunchPending, holdStopUntilRelease, stopReleaseKind });
}

async function prove(flow: PreviewBuildController, input = composition()): Promise<void> {
    const record = await flow.previewHandshake(input);
    expect(record).toMatchObject({ kind: "settled", eligibility: { status: "eligible" }, stale: false });
}

async function publish(flow: PreviewBuildController, input = composition()): Promise<void> {
    await prove(flow, input);
    const launch = await flow.buildPreview(input, selfGate(flow));
    if (!launch.issued) {
        throw new Error("test Preview build must issue");
    }
    await expect(launch.outcome).resolves.toMatchObject({ kind: "published" });
}

describe("Preview handshake orchestration", () => {
    it("joins one candidate + requirement lane and closes it on settlement", async () => {
        const boundary = fake({ keepPreviewHandshakePending: true });
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager(runtimes()));
        const input = composition();

        const first = flow.previewHandshake(input);
        const second = flow.previewHandshake(input);
        expect(second).toBe(first);
        expect(flow.previewHandshakeInFlight).toBe(true);
        expect(boundary.previewHandshakeCalls).toBe(1);
        expect(boundary.releasePreviewHandshake()).toBe(true);
        await first;
        expect(flow.previewHandshakeInFlight).toBe(false);
    });

    it("does not let proof for candidate A admit candidate B", async () => {
        const boundary = fake();
        const port = new TestToolPort();
        const flow = new PreviewBuildController(boundary, port, SESSION_ID, observations(), manager(runtimes()));
        const input = composition();
        await prove(flow, input);

        port.state = compatible(CANDIDATE_B);
        expect(flow.buildGate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "preview-proof-missing" }],
            request: null,
        });
        expect((await flow.buildPreview(input, selfGate(flow))).issued).toBe(false);
        expect(boundary.previewBuildCalls).toBe(0);
    });

    it("refuses source-identity drift before the handshake or request boundary", async () => {
        const boundary = fake();
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager(runtimes()));
        const valid = emission();
        const changed: HlslEmission = {
            ...valid,
            source: `${valid.source}// drift`,
        };
        const record = await flow.previewHandshake(composition({ emission: changed }));
        expect(record).toMatchObject({
            kind: "refused",
            refusal: { reason: "generated-source-identity-mismatch" },
        });
        expect(boundary.previewHandshakeCalls).toBe(0);
    });

    it("applies a Preview handshake candidate invalidation to the ordinary tool owner", async () => {
        const boundary = fake({
            preSpawn: {
                refusal: "candidate-invalidated",
                observation: "changed",
                observedIdentity: "candidate-b",
            },
        });
        const port = new TestToolPort();
        const flow = new PreviewBuildController(boundary, port, SESSION_ID, observations(), manager(runtimes()));

        const record = await flow.previewHandshake(composition());
        expect(record).toMatchObject({
            kind: "candidate-invalidated",
            result: { observation: "changed", observedIdentity: "candidate-b" },
        });
        expect(port.invalidations).toHaveLength(1);
        expect(port.state).toEqual({ status: "unavailable" });
    });
});

describe("Preview build orchestration", () => {
    it("derives and issues the exact candidate-bound request after the gate", async () => {
        const boundary = fake();
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager(runtimes()));
        const input = composition();
        await prove(flow, input);

        const launch = await flow.buildPreview(input, selfGate(flow));
        expect(launch.issued).toBe(true);
        if (!launch.issued) {
            throw new Error("test gate must issue");
        }
        await expect(launch.outcome).resolves.toMatchObject({ kind: "published" });
        expect(boundary.lastPreviewBuild?.candidate).toEqual(CANDIDATE_A);
        expect(boundary.lastPreviewBuild?.request).toEqual({
            sessionId: SESSION_ID,
            targetProfile: "gglab-dx12",
            profileId: "gglab.surface",
            profileVersion: 1,
            previewInputContractId: "gglab.preview-input.surface.numeric",
            previewProgramDescriptorIdentity: DESCRIPTOR_IDENTITY,
            generatedSourceIdentity: input.emission?.sourceMap?.generatedSourceIdentity,
            generatedSourceBytes: utf8Encode(input.emission?.source ?? ""),
            attemptSequence: 1,
        });
        expect(previewSessionReport(flow.session).states).toMatchObject([
            { attemptSequence: 1, state: "published" },
        ]);
    });

    it("cancels and terminally settles attempt N before issuing N+1", async () => {
        const boundary = fake({
            previewBuild: [
                { stdout: previewBuildOk(1), exitCode: 0 },
                { stdout: previewBuildOk(2), exitCode: 0 },
            ],
            keepCompilePending: true,
        });
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager(runtimes()));
        const input = composition();
        await prove(flow, input);

        const first = await flow.buildPreview(input, selfGate(flow));
        if (!first.issued) {
            throw new Error("first attempt must issue");
        }
        expect(flow.activeBuildId).toEqual(first.buildId);
        const secondPending = flow.buildPreview(input, selfGate(flow));
        await expect(first.outcome).resolves.toEqual({ kind: "canceled" });
        const second = await secondPending;
        expect(second).toMatchObject({ issued: true, attemptSequence: 2 });
        expect(boundary.previewBuildCalls).toBe(2);
        expect(previewSessionReport(flow.session).states).toMatchObject([
            { attemptSequence: 2, state: "pending" },
            { attemptSequence: 1, state: "canceled" },
        ]);
        if (!second.issued) {
            throw new Error("second attempt must issue");
        }
        expect(boundary.releasePending(second.buildId)).toBe(true);
        await expect(second.outcome).resolves.toMatchObject({ kind: "published" });
    });

    it("coalesces synchronous duplicate launch requests before either can issue", async () => {
        const boundary = fake();
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager(runtimes()));
        const input = composition();
        await prove(flow, input);

        const firstPending = flow.buildPreview(input, selfGate(flow));
        const secondPending = flow.buildPreview(input, selfGate(flow));
        const first = await firstPending;
        const second = await secondPending;
        expect(first).toMatchObject({ issued: false, reason: "superseded-before-issue" });
        expect(second).toMatchObject({ issued: true, attemptSequence: 1 });
        expect(boundary.previewBuildCalls).toBe(1);
        if (second.issued) {
            await second.outcome;
        }
    });

    it("keeps the last publication after a newer failure", async () => {
        const boundary = fake({
            previewBuild: [
                { stdout: previewBuildOk(1), exitCode: 0 },
                { stdout: previewBuildFailed(2), exitCode: 4 },
            ],
        });
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager(runtimes()));
        const input = composition();
        await prove(flow, input);

        const first = await flow.buildPreview(input, selfGate(flow));
        if (!first.issued) {
            throw new Error("first attempt must issue");
        }
        await first.outcome;
        const second = await flow.buildPreview({ ...input, emission: emission(`${input.emission?.source}// revision 2`) }, selfGate(flow));
        if (!second.issued) {
            throw new Error("second attempt must issue");
        }
        await expect(second.outcome).resolves.toMatchObject({ kind: "failed", envelope: { status: "compile-failed" } });

        const report = previewSessionReport(flow.session);
        expect(report.latest?.attemptSequence).toBe(2);
        expect(report.latestPublished?.attemptSequence).toBe(1);
        expect(report.states.map((state) => state.state)).toEqual(["failed", "published"]);
    });

    it("turns a mismatched result AttemptSequence into a failed binding, never a publication", async () => {
        const boundary = fake({ previewBuild: [{ stdout: previewBuildOk(9), exitCode: 0 }] });
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager(runtimes()));
        const input = composition();
        await prove(flow, input);

        const launch = await flow.buildPreview(input, selfGate(flow));
        if (!launch.issued) {
            throw new Error("attempt must issue");
        }
        await expect(launch.outcome).resolves.toEqual({
            kind: "failed",
            termination: { kind: "attempt-sequence-mismatch", expected: 1, observed: 9 },
        });
        expect(previewSessionReport(flow.session).latestPublished).toBeUndefined();
    });
});

describe("Preview Runtime observation orchestration", () => {
    it("joins one candidate/session read and projects a loaded publication as Current", async () => {
        const boundary = fake();
        const observation = observations(
            [{ kind: "read", bytes: observationBytes(1, PUBLICATION_ID) }],
            true,
        );
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observation, manager(runtimes()));
        const input = composition();
        await prove(flow, input);
        const launch = await flow.buildPreview(input, selfGate(flow));
        if (!launch.issued) {
            throw new Error("attempt must issue");
        }
        await launch.outcome;

        const first = flow.refreshObservation();
        const second = flow.refreshObservation();
        expect(second).toBe(first);
        expect(observation.readCalls).toBe(1);
        expect(observation.lastRead).toEqual({ candidate: CANDIDATE_A, sessionId: SESSION_ID });
        expect(observation.releasePending()).toBe(true);
        await expect(first).resolves.toMatchObject({ kind: "accepted", changed: true });
        expect(flow.runtimeProjection(input, selfGate(flow))).toEqual({
            freshness: "current",
            latestBuildState: "published",
            currentPublicationId: PUBLICATION_ID,
            lastGoodPublicationId: PUBLICATION_ID,
            rejectionCode: null,
            observationBinding: "bound",
        });
    });

    it("keeps an accepted LastGood stale after a newer build fails", async () => {
        const boundary = fake({
            previewBuild: [
                { stdout: previewBuildOk(1), exitCode: 0 },
                { stdout: previewBuildFailed(2), exitCode: 4 },
            ],
        });
        const observation = observations([{ kind: "read", bytes: observationBytes(1, PUBLICATION_ID) }]);
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observation, manager(runtimes()));
        const input = composition();
        await prove(flow, input);
        const first = await flow.buildPreview(input, selfGate(flow));
        if (!first.issued) {
            throw new Error("first attempt must issue");
        }
        await first.outcome;
        await flow.refreshObservation();

        const revised = { ...input, emission: emission(`${input.emission?.source}// revision 2`) };
        const second = await flow.buildPreview(revised, selfGate(flow));
        if (!second.issued) {
            throw new Error("second attempt must issue");
        }
        await second.outcome;
        expect(flow.runtimeProjection(revised, selfGate(flow))).toMatchObject({
            freshness: "stale",
            latestBuildState: "failed",
            currentPublicationId: null,
            lastGoodPublicationId: PUBLICATION_ID,
        });
    });

    it("rejects an unbound newer record without poisoning the accepted observation", async () => {
        const unknownPublication = "f5".repeat(32);
        const observation = observations([
            { kind: "read", bytes: observationBytes(1, PUBLICATION_ID) },
            { kind: "read", bytes: observationBytes(2, unknownPublication) },
        ]);
        const flow = new PreviewBuildController(fake(), new TestToolPort(), SESSION_ID, observation, manager(runtimes()));
        const input = composition();
        await prove(flow, input);
        const launch = await flow.buildPreview(input, selfGate(flow));
        if (!launch.issued) {
            throw new Error("attempt must issue");
        }
        await launch.outcome;

        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "accepted" });
        await expect(flow.refreshObservation()).resolves.toEqual({
            kind: "binding-rejected",
            binding: "attempt-not-published",
        });
        expect(flow.acceptedObservation?.observedPublicationRef).toBe(PUBLICATION_ID);
    });

    it("routes observation candidate invalidation to the ordinary tool owner", async () => {
        const port = new TestToolPort();
        const observation = observations([
            {
                kind: "candidate-invalidated",
                candidate: CANDIDATE_A,
                observation: "changed",
                observedIdentity: "candidate-b",
            },
        ]);
        const flow = new PreviewBuildController(fake(), port, SESSION_ID, observation, manager(runtimes()));
        const input = composition();
        await prove(flow, input);
        const launch = await flow.buildPreview(input, selfGate(flow));
        if (!launch.issued) {
            throw new Error("attempt must issue");
        }
        await launch.outcome;

        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "candidate-invalidated" });
        expect(port.invalidations).toHaveLength(1);
        expect(port.state).toEqual({ status: "unavailable" });
        expect(flow.acceptedObservation).toBeNull();
    });

    it("scopes accepted observations and LastGood projection to one deployment", async () => {
        const nextPublication = "b2".repeat(32);
        const boundary = fake({
            previewBuild: [
                { stdout: previewBuildOk(1), exitCode: 0 },
                { stdout: previewBuildOk(2, nextPublication), exitCode: 0 },
            ],
        });
        const observation = observations([
            { kind: "read", bytes: observationBytes(1, PUBLICATION_ID) },
            { kind: "read", bytes: observationBytes(2, nextPublication) },
        ]);
        const port = new TestToolPort();
        const flow = new PreviewBuildController(boundary, port, SESSION_ID, observation, manager(runtimes()));
        const input = composition();

        await publish(flow, input);
        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "accepted" });
        expect(flow.acceptedObservation?.loadedPublicationRef).toBe(PUBLICATION_ID);

        port.state = compatible(CANDIDATE_C);
        expect(flow.acceptedObservation).toBeNull();
        expect(flow.runtimeProjection(input, selfGate(flow))).toMatchObject({
            freshness: "idle",
            lastGoodPublicationId: null,
            observationBinding: "none",
        });

        await prove(flow, input);
        const next = await flow.buildPreview(input, selfGate(flow));
        if (!next.issued) {
            throw new Error("the second deployment's Preview build must issue");
        }
        await next.outcome;
        expect(flow.runtimeProjection(input, selfGate(flow))).toMatchObject({
            freshness: "pending",
            lastGoodPublicationId: null,
            observationBinding: "none",
        });

        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "accepted" });
        expect(observation.lastRead).toEqual({ candidate: CANDIDATE_C, sessionId: SESSION_ID });
        expect(flow.runtimeProjection(input, selfGate(flow))).toMatchObject({
            freshness: "current",
            currentPublicationId: nextPublication,
            lastGoodPublicationId: nextPublication,
            observationBinding: "bound",
        });
    });
});
describe("Attached Preview Runtime authority - composition facts read by the flow", () => {
    it("exposes the published launch candidate only after an initial successful publication", async () => {
        const runtime = runtimes();
        const manager = new AttachedPreviewRuntimeManager(runtime, SESSION_ID);
        const flow = new PreviewBuildController(fake(), new TestToolPort(), SESSION_ID, observations(), manager);

        expect(flow.launchCandidate()).toBeNull();
        expect(runtime.launchCalls).toBe(0);

        await publish(flow);
        // build success is the only initial-publication proof
        expect(flow.initialPublicationAvailable).toBe(true);
        expect(flow.launchCandidate()).toEqual(CANDIDATE_A);
    });

    it("freezes Preview builds while an attached Runtime launch is in flight", async () => {
        const runtime = runtimes([{ kind: "launched", runtimeIdentity: "runtime-a" }], true);
        const manager = new AttachedPreviewRuntimeManager(runtime, SESSION_ID);
        const flow = new PreviewBuildController(fake(), new TestToolPort(), SESSION_ID, observations(), manager);
        const input = composition();

        await publish(flow);
        const launching = manager.launch(CANDIDATE_A);
        expect(manager.launchInFlight).toBe(true);
        expect(coordinator(manager, flow).gate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-launching" }],
        });
        expect(runtime.releaseLaunch()).toBe(true);
        const launched = await launching;
        expect(launched.launched).toBe(true);
        expect(manager.launchInFlight).toBe(false);
        // the build-side verdict is back once the launch settles
        expect(coordinator(manager, flow).gate(input)).toMatchObject({ admitted: true });
    });

    it("keeps a live session on its launch deployment and refuses cross-deployment updates", async () => {
        const runtime = runtimes([{ kind: "launched", runtimeIdentity: "runtime-a" }]);
        const manager = new AttachedPreviewRuntimeManager(runtime, SESSION_ID);
        const port = new TestToolPort();
        const observation = observations([{ kind: "read", bytes: observationBytes(1, PUBLICATION_ID) }]);
        const flow = new PreviewBuildController(fake(), port, SESSION_ID, observation, manager);
        const input = composition();

        await publish(flow);
        const launched = await manager.launch(CANDIDATE_A);
        if (!launched.launched) {
            throw new Error("test Preview Runtime must launch");
        }

        port.state = compatible(CANDIDATE_C);
        expect(coordinator(manager, flow).gate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-deployment-mismatch" }],
        });
        // session-scoped facts stay bound to the LAUNCH deployment (A),
        // not the now-current C tool
        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "accepted" });
        expect(observation.lastRead).toEqual({ candidate: CANDIDATE_A, sessionId: SESSION_ID });

        await expect(manager.terminateAndJoin()).resolves.toEqual({ outcome: "terminated" });
        expect(manager.ownedRuntime).toBeNull();
    });

    it("keeps enforcing attached-runtime-deployment-mismatch even from a sticky unproven exit", async () => {
        const runtime = runtimes([{ kind: "launched", runtimeIdentity: "runtime-a" }], false, true, "wait-failed");
        const manager = new AttachedPreviewRuntimeManager(runtime, SESSION_ID);
        const port = new TestToolPort();
        const flow = new PreviewBuildController(fake(), port, SESSION_ID, observations(), manager);
        const input = composition();

        await publish(flow);
        const launched = await manager.launch(CANDIDATE_A);
        if (!launched.launched) {
            throw new Error("test Preview Runtime must launch");
        }
        // Sticky unproven teardown on deployment A
        const teardown = manager.terminateAndJoin();
        expect(runtime.releaseStop()).toBe(true);
        await expect(teardown).resolves.toMatchObject({ outcome: "exit-unproven" });
        expect(manager.state).toMatchObject({ kind: "exit-unproven" });

        // The current tool has since moved to a DIFFERENT deployment (C):
        // the build gate still refuses against the owned deployment A.
        port.state = compatible(CANDIDATE_C);
        expect(coordinator(manager, flow).gate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-deployment-mismatch" }],
        });
        // And a launch on the new deployment is structurally refused.
        await expect(manager.launch(CANDIDATE_C)).resolves.toMatchObject({
            launched: false,
            reason: "exit-unproven",
        });
        expect(runtime.launchCalls).toBe(1);
    });

    it("refuses Preview builds with attached-runtime-ownership-conflict (never a deployment mismatch)", async () => {
        const runtime = runtimes([{ kind: "session-already-running", runtimeId: { sequence: 42 } }]);
        const manager = new AttachedPreviewRuntimeManager(runtime, SESSION_ID);
        const flow = new PreviewBuildController(fake(), new TestToolPort(), SESSION_ID, observations(), manager);
        const input = composition();

        await publish(flow);
        await manager.launch(CANDIDATE_A);
        expect(manager.state).toMatchObject({ kind: "runtime-ownership-conflict" });

        // A single, exact structured refusal — not deployment-mismatch
        // (there is no owned binding to compare against).
        expect(coordinator(manager, flow).gate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-ownership-conflict" }],
        });
    });

    it("refuses Preview builds while a launch outcome is unproven", async () => {
        const fakeRuntime = new FakePreviewRuntimeBoundary({ launches: [{ kind: "launched" }], rejectLaunch: true });
        const manager = new AttachedPreviewRuntimeManager(fakeRuntime, SESSION_ID);
        const flow = new PreviewBuildController(fake(), new TestToolPort(), SESSION_ID, observations(), manager);
        const input = composition();

        await publish(flow);
        await expect(manager.launch(CANDIDATE_A)).rejects.toThrow();
        expect(manager.state).toMatchObject({
            kind: "launch-outcome-unproven",
            attemptedDeploymentToolPath: CANDIDATE_A.toolPath,
        });

        // One exact structured refusal — never admission on the assumption
        // that no Runtime exists.
        expect(coordinator(manager, flow).gate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-launch-outcome-unproven" }],
        });
        // And structurally no second Runtime launch.
        await expect(manager.launch(CANDIDATE_A)).resolves.toMatchObject({ launched: false, reason: "launch-outcome-unproven" });
        expect(fakeRuntime.launchCalls).toBe(1);
    });

    it("routes a launch candidate-invalidated host fact to the ordinary tool owner", async () => {
        const runtime = runtimes([
            {
                kind: "candidate-invalidated",
                candidate: CANDIDATE_A,
                observation: "changed",
                observedIdentity: "observed-1",
            },
        ]);
        const manager = new AttachedPreviewRuntimeManager(runtime, SESSION_ID);
        const port = new TestToolPort();
        const flow = new PreviewBuildController(fake(), port, SESSION_ID, observations(), manager);

        const refused = await manager.launch(CANDIDATE_A);
        if (refused.launched || refused.reason !== "host-refused" || refused.result.kind !== "candidate-invalidated") {
            throw new Error("test launch must be host-refused as candidate-invalidated");
        }
        expect(manager.state).toMatchObject({ kind: "launch-refused" });
        expect(manager.ownedRuntime).toBeNull();
        flow.reportCandidateInvalidation(refused.result);
        expect(port.invalidations).toHaveLength(1);
        expect(port.state).toEqual({ status: "unavailable" });
    });
});

describe("Coordinator transition / build mutual exclusion (build-side)", () => {
    it("refuses a retarget AND a target-close while a build lifecycle (issue -> terminal outcome) is open, then releases the exclusion once it settles", async () => {
        const boundary = fake({ keepCompilePending: true });
        const manager = new AttachedPreviewRuntimeManager(runtimes([{ kind: "launched", runtimeIdentity: "runtime-a" }]), SESSION_ID);
        const flow = new PreviewBuildController(boundary, new TestToolPort(), SESSION_ID, observations(), manager);
        const store = new WorkspaceStore<WorkspaceAuthoringState>({ session: createWorkspaceSession(), profileDescriptor: null });
        const coordinator = new PreviewCoordinator(() => manager, () => flow, store);
        const target = createDocumentSessionId("some-target");

        // Prove the build gate, then ISSUE a build whose terminal outcome is
        // held — that is the "build lifecycle in flight" window.
        await prove(flow, composition());
        const build = await flow.buildPreview(composition(), selfGate(flow));
        expect(flow.buildInFlight).toBe(true);

        // Both transition directions are STRUCTURAL refusals — not queued,
        // not superseded — while the build lifecycle is open.
        const retargetRefused = await coordinator.retargetTo(target);
        expect(retargetRefused).toMatchObject({ ok: false, refusal: { reason: "build-in-flight" } });
        const closeRefused = await coordinator.closeTarget(target, "");
        expect(closeRefused).toMatchObject({ ok: false, refusal: { reason: "build-in-flight" } });

        // Settle the build's terminal outcome; the lifecycle closes...
        expect(boundary.releasePending()).toBe(true);
        if (build.issued) {
            await build.outcome;
        }
        // The flow decrements its in-flight counter in a `.finally` queued
        // behind this test's own `await build.outcome` continuation, so
        // yield microtasks until the bookkeeping lands before asserting it.
        await Promise.resolve();
        await Promise.resolve();
        expect(flow.buildInFlight).toBe(false);

        // ...and the exclusion is lifted: the transition is attempted again
        // (it may refuse for an unrelated, store-level reason — the empty
        // session has no such tab — but it is no longer build-in-flight).
        const after = await coordinator.retargetTo(target);
        if (!after.ok) {
            expect(after.refusal.reason).not.toBe("build-in-flight");
        }
    });
});