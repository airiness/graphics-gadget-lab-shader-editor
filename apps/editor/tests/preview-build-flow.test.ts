import { describe, expect, it } from "vitest";
import {
    FakeHostBoundary,
    FakePreviewObservationBoundary,
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

function previewBuildOk(attemptSequence: number): string {
    return JSON.stringify({
        command: "build-preview",
        success: true,
        status: "ok",
        exitCode: 0,
        attemptSequence,
        publicationId: PUBLICATION_ID,
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

async function prove(flow: PreviewBuildFlow, input = composition()): Promise<void> {
    const record = await flow.previewHandshake(input);
    expect(record).toMatchObject({ kind: "settled", eligibility: { status: "eligible" }, stale: false });
}

describe("Preview handshake orchestration", () => {
    it("joins one candidate + requirement lane and closes it on settlement", async () => {
        const boundary = fake({ keepPreviewHandshakePending: true });
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, port, SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, port, SESSION_ID, observations());

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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observations());
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observation);
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
        const flow = new PreviewBuildFlow(boundary, new TestToolPort(), SESSION_ID, observation);
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
        const flow = new PreviewBuildFlow(fake(), new TestToolPort(), SESSION_ID, observation);
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
        const flow = new PreviewBuildFlow(fake(), port, SESSION_ID, observation);
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
});
