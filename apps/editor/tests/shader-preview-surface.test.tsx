import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    type FakeHostBoundary,
    type FakePreviewObservationBoundary,
    type FakePreviewRuntimeBoundary,
    type ToolCandidate,
} from "@gglab/shader-toolchain-client";
import {
    parseSurfaceProfileDescriptor,
    sha256Hex,
    utf8Encode,
    type HlslEmission,
    type ShaderGraphDocument,
} from "@gglab/shader-graph-core";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import type { NativeBuildFlow } from "../src/native-build-flow.js";
import { useShaderPreview } from "../src/useShaderPreview.js";

const previewWorld = vi.hoisted(() => ({
    tool: null as unknown,
    observation: null as unknown,
    runtime: null as unknown,
}));

vi.mock("../src/toolchain-host.js", async () => {
    const {
        FakeHostBoundary: ToolBoundary,
        FakePreviewObservationBoundary: ObservationBoundary,
        FakePreviewRuntimeBoundary: RuntimeBoundary,
    } = await import("@gglab/shader-toolchain-client");
    const candidate = {
        rule: "bundled" as const,
        toolPath: "C:/tools/gglab-shaderc.exe",
        observationIdentity: "candidate-a",
        resolvedAt: 1,
    };
    const publicationId = "b1".repeat(32);
    const bytes = new Uint8Array(90);
    bytes.set([0x47, 0x47, 0x53, 0x48, 0x4f, 0x42, 0x53, 0x56]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 1, true);
    view.setUint32(12, 1, true);
    view.setBigUint64(16, 1n, true);
    for (let index = 0; index < 32; index += 1) {
        const octet = Number.parseInt(publicationId.slice(index * 2, index * 2 + 2), 16);
        bytes[24 + index] = octet;
        bytes[56 + index] = octet;
    }
    bytes[88] = 1;
    bytes[89] = 0;

    return {
        toolBoundaryAvailable: () => true,
        createTauriToolBoundary: async () => {
            const boundary = new ToolBoundary({
                discovery: { kind: "resolved", candidate },
                handshake: { stdout: "", exitCode: 0 },
                compile: [],
                previewHandshake: {
                    stdout: JSON.stringify({
                        command: "describe-preview",
                        success: true,
                        status: "ok",
                        exitCode: 0,
                        processContractVersion: 2,
                        previewBuildContractVersion: 1,
                        compilePolicyRevision: 1,
                        toolIdentity: "gglab-shaderc",
                        toolVersion: "1.3.0",
                        producerKind: "dxc",
                        producerIdentity: "Microsoft Direct3D 12 Shader Compiler",
                        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
                        previewProgramDescriptorVersion: 1,
                        previewProgramDescriptorIdentity:
                            "3bcb22e27e7c2edeaf67dcb25d531cc89dbc443a8b5f19efe4d6885f32a5f8ad",
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
                    }),
                    exitCode: 0,
                },
                previewBuild: [
                    {
                        stdout: JSON.stringify({
                            command: "build-preview",
                            success: true,
                            status: "ok",
                            exitCode: 0,
                            attemptSequence: 1,
                            publicationId,
                            shaderArtifactId: "c2".repeat(32),
                            baseRegistryId: "d3".repeat(32),
                            previewRegistryId: "e4".repeat(32),
                            diagnostics: [],
                        }),
                        exitCode: 0,
                    },
                ],
            });
            previewWorld.tool = boundary;
            return boundary;
        },
        createTauriPreviewObservationBoundary: async () => {
            const boundary = new ObservationBoundary({ reads: [{ kind: "read", bytes }] });
            previewWorld.observation = boundary;
            return boundary;
        },
        createTauriPreviewRuntimeBoundary: async () => {
            const boundary = new RuntimeBoundary({
                launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }],
            });
            previewWorld.runtime = boundary;
            return boundary;
        },
    };
});

const candidate: ToolCandidate = {
    rule: "bundled",
    toolPath: "C:/tools/gglab-shaderc.exe",
    observationIdentity: "candidate-a",
    resolvedAt: 1,
};

const nativeFlow = {
    tool: {
        status: "compatible",
        candidate,
        provenFacts: {
            toolIdentity: "gglab-shaderc",
            toolVersion: "1.3.0",
            processContractVersion: 2,
            compilePolicyRevision: 1,
            producerKind: "dxc",
            producerIdentity: "Microsoft Direct3D 12 Shader Compiler",
            supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
        },
        proof: { processContractVersion: 2, compilePolicyRevision: 1 },
    },
    candidateInvalidated: vi.fn(),
} as unknown as NativeBuildFlow;

const descriptor = (() => {
    const parsed = parseSurfaceProfileDescriptor(JSON.stringify(canonicalV1Fixture));
    if (!parsed.ok || parsed.value === null) {
        throw new Error("test descriptor must parse");
    }
    return parsed.value;
})();

const source = "// generated\nSurfaceData EvaluateSurface(float p_metal, float3 p_tint, float2 uv0) { return (SurfaceData)0; }\n";
const emission: HlslEmission = {
    ok: true,
    diagnostics: [],
    source,
    sourceMap: { generatedSourceIdentity: sha256Hex(utf8Encode(source)), ranges: [] },
};
const document: ShaderGraphDocument = {
    schemaVersion: 1,
    graphId: "preview-surface-test",
    profile: "gglab.surface",
    profileVersion: 1,
    parameters: [
        { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3", unknownFields: {} },
        { id: "p.metal", name: "Metal", class: "ScalarParameter", valueType: "float", unknownFields: {} },
    ],
    nodes: [],
    connections: [],
    editorMetadata: { nodes: {}, unknownFields: {} },
    unknownFields: {},
};

beforeEach(() => {
    previewWorld.tool = null;
    previewWorld.observation = null;
    previewWorld.runtime = null;
    vi.mocked(nativeFlow.candidateInvalidated).mockReset();
});

describe("attached Shader Preview React surface", () => {
    it("proves, publishes, launches, polls Current, and observes process exit", async () => {
        const hook = renderHook(() =>
            useShaderPreview({
                document,
                descriptor,
                descriptorCompatible: true,
                emission,
                configuredTarget: "gglab-dx12",
                nativeFlow,
            }),
        );
        await waitFor(() => expect(hook.result.current.flow).not.toBeNull());
        expect(hook.result.current.sessionId).toMatch(/^[0-9a-f]{32}$/);
        expect(hook.result.current.gate).toMatchObject({
            admitted: false,
            reasons: [{ reason: "preview-proof-missing" }],
        });

        await act(async () => hook.result.current.previewHandshake());
        expect(hook.result.current.gate?.admitted).toBe(true);
        await act(async () => hook.result.current.buildPreview());

        await waitFor(() => expect(hook.result.current.runtime.kind).toBe("running"));
        await waitFor(() => expect(hook.result.current.projection?.freshness).toBe("current"));
        const tool = previewWorld.tool as FakeHostBoundary;
        const observation = previewWorld.observation as FakePreviewObservationBoundary;
        const runtime = previewWorld.runtime as FakePreviewRuntimeBoundary;
        expect(tool.previewBuildCalls).toBe(1);
        expect(runtime.launchCalls).toBe(1);
        expect(runtime.lastLaunch).toEqual({ candidate, sessionId: hook.result.current.sessionId });
        expect(observation.readCalls).toBeGreaterThanOrEqual(1);
        expect(hook.result.current.projection).toMatchObject({
            freshness: "current",
            currentPublicationId: "b1".repeat(32),
            lastGoodPublicationId: "b1".repeat(32),
            observationBinding: "bound",
        });

        expect(runtime.exit({ sequence: 1 }, 0)).toBe(true);
        // A PROVEN natural exit releases ownership: the state is `idle`
        // (no `exited` state; `exit-unproven` exists only for wait-failed).
        await waitFor(() => expect(hook.result.current.runtime.kind).toBe("idle"));
        hook.unmount();
    });
});
