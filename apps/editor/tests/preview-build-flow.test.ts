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
import { PreviewBuildFlow, type PreviewCompositionInput, type PreviewToolStatePort } from "../src/preview-build-flow.js";
import { previewSessionReport } from "../src/preview-build-session.js";

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
): FakePreviewRuntimeBoundary {
    return new FakePreviewRuntimeBoundary({ launches, keepLaunchPending, holdStopUntilRelease });
}

async function prove(flow: PreviewBuildFlow, input = composition()): Promise<void> {
    const record = await flow.previewHandshake(input);
    expect(record).toMatchObject({ kind: "settled", eligibility: { status: "eligible" }, stale: false });
}

async function publish(flow: PreviewBuildFlow, input = composition()): Promise<void> {
    await prove(flow, input);
    const launch = await flow.buildPreview(input);
    if (!launch.issued) {
        throw new Error("test Preview build must issue");
    }
    await expect(launch.outcome).resolves.toMatchObject({ kind: "published" });
}

describe("Preview handshake orchestration", () => {
    it("joins one candidate + requirement lane and closes it on settlement", async () => {
        const boundary = fake({ keepPreviewHandshakePending: true });
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtimes());
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
        const flow = new PreviewBuildFlow(boundary, port, SESSION_ID, observations(), runtimes());
        const input = composition();
        await prove(flow, input);

        port.state = compatible(CANDIDATE_B);
        expect(flow.buildGate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "preview-proof-missing" }],
            request: null,
        });
        expect((await flow.buildPreview(input)).issued).toBe(false);
        expect(boundary.previewBuildCalls).toBe(0);
    });

    it("refuses source-identity drift before the handshake or request boundary", async () => {
        const boundary = fake();
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtimes());
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
        const flow = new PreviewBuildFlow(boundary, port, SESSION_ID, observations(), runtimes());

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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtimes());
        const input = composition();
        await prove(flow, input);

        const launch = await flow.buildPreview(input);
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtimes());
        const input = composition();
        await prove(flow, input);

        const first = await flow.buildPreview(input);
        if (!first.issued) {
            throw new Error("first attempt must issue");
        }
        expect(flow.activeBuildId).toEqual(first.buildId);
        const secondPending = flow.buildPreview(input);
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtimes());
        const input = composition();
        await prove(flow, input);

        const firstPending = flow.buildPreview(input);
        const secondPending = flow.buildPreview(input);
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtimes());
        const input = composition();
        await prove(flow, input);

        const first = await flow.buildPreview(input);
        if (!first.issued) {
            throw new Error("first attempt must issue");
        }
        await first.outcome;
        const second = await flow.buildPreview({ ...input, emission: emission(`${input.emission?.source}// revision 2`) });
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtimes());
        const input = composition();
        await prove(flow, input);

        const launch = await flow.buildPreview(input);
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observation, runtimes());
        const input = composition();
        await prove(flow, input);
        const launch = await flow.buildPreview(input);
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
        expect(flow.runtimeProjection(input)).toEqual({
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observation, runtimes());
        const input = composition();
        await prove(flow, input);
        const first = await flow.buildPreview(input);
        if (!first.issued) {
            throw new Error("first attempt must issue");
        }
        await first.outcome;
        await flow.refreshObservation();

        const revised = { ...input, emission: emission(`${input.emission?.source}// revision 2`) };
        const second = await flow.buildPreview(revised);
        if (!second.issued) {
            throw new Error("second attempt must issue");
        }
        await second.outcome;
        expect(flow.runtimeProjection(revised)).toMatchObject({
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
        const flow = new PreviewBuildFlow(fake(), new TestToolPort(), SESSION_ID, observation, runtimes());
        const input = composition();
        await prove(flow, input);
        const launch = await flow.buildPreview(input);
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
        const flow = new PreviewBuildFlow(fake(), port, SESSION_ID, observation, runtimes());
        const input = composition();
        await prove(flow, input);
        const launch = await flow.buildPreview(input);
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
        const flow = new PreviewBuildFlow(boundary, port, SESSION_ID, observation, runtimes());
        const input = composition();

        await publish(flow, input);
        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "accepted" });
        expect(flow.acceptedObservation?.loadedPublicationRef).toBe(PUBLICATION_ID);

        port.state = compatible(CANDIDATE_C);
        expect(flow.acceptedObservation).toBeNull();
        expect(flow.runtimeProjection(input)).toMatchObject({
            freshness: "idle",
            lastGoodPublicationId: null,
            observationBinding: "none",
        });

        await prove(flow, input);
        const next = await flow.buildPreview(input);
        if (!next.issued) {
            throw new Error("the second deployment's Preview build must issue");
        }
        await next.outcome;
        expect(flow.runtimeProjection(input)).toMatchObject({
            freshness: "pending",
            lastGoodPublicationId: null,
            observationBinding: "none",
        });

        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "accepted" });
        expect(observation.lastRead).toEqual({ candidate: CANDIDATE_C, sessionId: SESSION_ID });
        expect(flow.runtimeProjection(input)).toMatchObject({
            freshness: "current",
            currentPublicationId: nextPublication,
            lastGoodPublicationId: nextPublication,
            observationBinding: "bound",
        });
    });
});

describe("Attached Preview Runtime lifecycle", () => {
    it("requires an initial successful publication before launch", async () => {
        const runtime = runtimes();
        const flow = new PreviewBuildFlow(fake(), new TestToolPort(), SESSION_ID, observations(), runtime);

        await expect(flow.launchAttachedPreview()).resolves.toEqual({
            launched: false,
            reason: "initial-publication-unavailable",
        });
        expect(runtime.launchCalls).toBe(0);
        expect(flow.runtimeState).toEqual({ kind: "idle" });
    });

    it("joins one candidate/session launch and observes a clean process exit", async () => {
        const runtime = runtimes([{ kind: "launched", runtimeIdentity: "runtime-a" }], true);
        const flow = new PreviewBuildFlow(fake(), new TestToolPort(), SESSION_ID, observations(), runtime);
        await publish(flow);

        const first = flow.launchAttachedPreview();
        const second = flow.launchAttachedPreview();
        expect(second).toBe(first);
        expect(flow.runtimeState).toEqual({ kind: "launching" });
        expect(runtime.launchCalls).toBe(1);
        expect(runtime.lastLaunch).toEqual({ candidate: CANDIDATE_A, sessionId: SESSION_ID });
        expect(runtime.releaseLaunch()).toBe(true);
        const launched = await first;
        expect(launched).toMatchObject({
            launched: true,
            runtimeId: { sequence: 1 },
            runtimeIdentity: "runtime-a",
        });
        expect(flow.runtimeState).toEqual({
            kind: "running",
            runtimeId: { sequence: 1 },
            runtimeIdentity: "runtime-a",
        });
        expect(runtime.exit({ sequence: 1 }, 0)).toBe(true);
        if (launched.launched) {
            await launched.exited;
        }
        expect(flow.runtimeState).toEqual({
            kind: "exited",
            runtimeIdentity: "runtime-a",
            exit: { runtimeId: { sequence: 1 }, kind: "exited", exitCode: 0 },
        });
    });

    it("freezes Preview builds until an attached Runtime finishes launching", async () => {
        const boundary = fake();
        const runtime = runtimes([{ kind: "launched", runtimeIdentity: "runtime-a" }], true);
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations(), runtime);
        const input = composition();
        await publish(flow, input);
        const buildCallsBeforeLaunch = boundary.previewBuildCalls;

        const pendingLaunch = flow.launchAttachedPreview();
        expect(flow.runtimeState).toEqual({ kind: "launching" });
        expect(flow.buildGate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-launching" }],
        });
        await expect(flow.buildPreview(input)).resolves.toMatchObject({
            issued: false,
            reason: "gate-refused",
        });
        expect(boundary.previewBuildCalls).toBe(buildCallsBeforeLaunch);

        expect(runtime.releaseLaunch()).toBe(true);
        const launched = await pendingLaunch;
        expect(flow.buildGate(input).admitted).toBe(true);
        if (launched.launched) {
            await flow.stopAttachedPreview();
            await launched.exited;
        }
    });

    it("stops only the host-issued runtime and transitions through stopping", async () => {
        const runtime = runtimes();
        const flow = new PreviewBuildFlow(fake(), new TestToolPort(), SESSION_ID, observations(), runtime);
        await publish(flow);
        const launched = await flow.launchAttachedPreview();
        if (!launched.launched) {
            throw new Error("test Preview Runtime must launch");
        }

        const stop = flow.stopAttachedPreview();
        expect(flow.runtimeState).toEqual({
            kind: "stopping",
            runtimeId: launched.runtimeId,
            runtimeIdentity: launched.runtimeIdentity,
        });
        await expect(stop).resolves.toEqual({
            runtimeId: launched.runtimeId,
            stopRequested: true,
            alreadySettled: false,
        });
        await launched.exited;
        expect(flow.runtimeState).toEqual({
            kind: "exited",
            runtimeIdentity: launched.runtimeIdentity,
            exit: { runtimeId: launched.runtimeId, kind: "stopped", exitCode: null },
        });
    });

    it("ownership transitions complete only when the Runtime has exited, and the next launch attaches after that exit", async () => {
        const runtime = runtimes(
            [
                { kind: "launched", runtimeIdentity: "runtime-old" },
                { kind: "launched", runtimeIdentity: "runtime-new" },
            ],
            false,
            true, // stop request acknowledged; the process stays "stopping" until released
        );
        const flow = new PreviewBuildFlow(fake(), new TestToolPort(), SESSION_ID, observations(), runtime);
        await publish(flow);

        const old = await flow.launchAttachedPreview();
        if (old.launched === false) {
            throw new Error("test Preview Runtime must launch for the prior target");
        }

        // A stop is requested, but the old process has NOT actually exited yet.
        const stop = flow.stopAttachedPreview();
        expect(flow.runtimeState).toMatchObject({ kind: "stopping", runtimeId: old.runtimeId });

        // While the old Runtime is still up, a launch for the next target must
        // QUEUE (waiting for the old exit) — never be refused as
        // "already-running" and strand the Preview with no Runtime.
        const next = flow.launchAttachedPreview();

        // And the ownership transition (stop-and-wait) is NOT complete yet.
        const teardown = flow.stopAttachedPreviewAndWait();
        let teardownSettled = false;
        void teardown.then(() => {
            teardownSettled = true;
        });
        expect(teardownSettled).toBe(false);

        // The old process exits now — and only THEN does everything finish.
        // (The queued launch for the next target may start immediately once
        // the old Runtime is gone, so the "exited" state is superseded by the
        // new ownership rather than observed as a resting state.)
        expect(runtime.releaseStop()).toBe(true);
        await expect(stop).resolves.toMatchObject({ stopRequested: true, alreadySettled: false });
        await expect(teardown).resolves.toEqual({
            runtimeId: old.runtimeId,
            kind: "stopped",
            exitCode: null,
        });
        expect(teardownSettled).toBe(true);

        const nextResult = await next;
        expect(nextResult).toMatchObject({
            launched: true,
            runtimeId: { sequence: 2 },
            runtimeIdentity: "runtime-new",
        });
        expect(runtime.launchCalls).toBe(2);
        if (nextResult.launched) {
            // The next Runtime's own teardown obeys the same wait-and rule.
            const finalTeardown = flow.stopAttachedPreviewAndWait();
            expect(runtime.releaseStop()).toBe(true);
            expect(await finalTeardown).toMatchObject({ runtimeId: { sequence: 2 } });
        }
        expect(flow.runtimeState).toMatchObject({ kind: "exited" });
    });

    it("treats a stop-and-wait as complete when no attached Runtime is up", async () => {
        const runtime = runtimes();
        const flow = new PreviewBuildFlow(fake(), new TestToolPort(), SESSION_ID, observations(), runtime);
        await publish(flow);
        await expect(flow.stopAttachedPreviewAndWait()).resolves.toBeNull();
        expect(flow.runtimeState).toEqual({ kind: "idle" });
        expect(runtime.launchCalls).toBe(0);
    });

    it("routes launch-time candidate invalidation to the ordinary tool owner", async () => {
        const port = new TestToolPort();
        const runtime = runtimes([
            {
                kind: "candidate-invalidated",
                candidate: CANDIDATE_A,
                observation: "changed",
                observedIdentity: "candidate-b",
            },
        ]);
        const flow = new PreviewBuildFlow(fake(), port, SESSION_ID, observations(), runtime);
        await publish(flow);

        await expect(flow.launchAttachedPreview()).resolves.toMatchObject({
            launched: false,
            reason: "host-refused",
            result: { kind: "candidate-invalidated" },
        });
        expect(port.invalidations).toHaveLength(1);
        expect(port.state).toEqual({ status: "unavailable" });
        expect(flow.runtimeState).toMatchObject({
            kind: "launch-refused",
            result: { kind: "candidate-invalidated" },
        });
    });

    it("keeps a live session on its launch deployment and refuses cross-deployment updates", async () => {
        const port = new TestToolPort();
        const observation = observations([{ kind: "read", bytes: observationBytes(1, PUBLICATION_ID) }]);
        const flow = new PreviewBuildFlow(fake(), port, SESSION_ID, observation, runtimes());
        const input = composition();
        await publish(flow, input);
        const launched = await flow.launchAttachedPreview();
        if (!launched.launched) {
            throw new Error("test Preview Runtime must launch");
        }

        port.state = compatible(CANDIDATE_C);
        expect(flow.buildGate(input)).toMatchObject({
            admitted: false,
            reasons: [{ reason: "attached-runtime-deployment-mismatch" }],
        });
        await expect(flow.refreshObservation()).resolves.toMatchObject({ kind: "accepted" });
        expect(observation.lastRead).toEqual({ candidate: CANDIDATE_A, sessionId: SESSION_ID });
        await flow.stopAttachedPreview();
        await launched.exited;
    });
});
