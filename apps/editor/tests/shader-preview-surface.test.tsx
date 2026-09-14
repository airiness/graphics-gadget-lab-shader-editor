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
import { WorkspaceStore, type WorkspaceAuthoringState } from "../src/workspace-store.js";
import { createWorkspaceSession } from "../src/workspace-session.js";
import { createDocumentSessionId } from "../src/workspace-session.js";
import { createSession, provenanceFromImport, documentRevision } from "../src/document-session.js";

const workspaceStore = new WorkspaceStore<WorkspaceAuthoringState>({
    session: createWorkspaceSession(),
    profileDescriptor: null,
});

const previewWorld = vi.hoisted(() => ({
    tool: null as unknown,
    observation: null as unknown,
    runtime: null as unknown,
    runtimeSpec: null as unknown,
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
            const spec = (previewWorld.runtimeSpec as ConstructorParameters<typeof RuntimeBoundary>[0] | undefined) ?? {
                launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }],
            };
            const boundary = new RuntimeBoundary(spec);
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

function selectedState(): WorkspaceAuthoringState {
    const owner = createSession(createDocumentSessionId("target"), provenanceFromImport(), document);
    return { session: { ...createWorkspaceSession(), documents: [owner], activeDocumentId: owner.sessionId, preview: { targetDocumentId: owner.sessionId } }, profileDescriptor: descriptor };
}
beforeEach(() => {
    workspaceStore.apply(() => ({ next: selectedState(), result: null }));
    previewWorld.tool = null;
    previewWorld.observation = null;
    previewWorld.runtime = null;
    previewWorld.runtimeSpec = null;
    vi.mocked(nativeFlow.candidateInvalidated).mockReset();
});

describe("attached Shader Preview React surface", () => {
    it("starts the committed target in one action even before React receives its new props", async () => {
        const initial = createSession(createDocumentSessionId("selected-golden"), provenanceFromImport(), document);
        const owner = { ...initial, presentation: { ...initial.presentation, emission } };
        const store = new WorkspaceStore<WorkspaceAuthoringState>({ session: { ...createWorkspaceSession(), documents: [owner], activeDocumentId: owner.sessionId, preview: { targetDocumentId: owner.sessionId } }, profileDescriptor: descriptor });
        const hook = renderHook(() => useShaderPreview({ document: { ...document, graphId: "previous-tab" }, descriptor, descriptorCompatible: true, emission: null, configuredTarget: "gglab-dx12", nativeFlow, workspaceStore: store }));
        await waitFor(() => expect(hook.result.current.flow).not.toBeNull());
        await act(async () => hook.result.current.startPreview(owner.sessionId));
        expect((previewWorld.tool as FakeHostBoundary).previewBuildCalls).toBe(1);
        expect((previewWorld.runtime as FakePreviewRuntimeBoundary).launchCalls).toBe(1);
        hook.unmount();
    });
    it("does not build or launch when the requested graph is no longer the target", async () => {
        const hook = renderHook(() => useShaderPreview({ document, descriptor, descriptorCompatible: true, emission, configuredTarget: "gglab-dx12", nativeFlow, workspaceStore }));
        await waitFor(() => expect(hook.result.current.flow).not.toBeNull());
        await act(async () => hook.result.current.startPreview(createDocumentSessionId("closed-target")));
        expect((previewWorld.tool as FakeHostBoundary).previewBuildCalls).toBe(0);
        expect((previewWorld.runtime as FakePreviewRuntimeBoundary).launchCalls).toBe(0);
        expect(hook.result.current.notes.at(-1)?.level).toBe("refusal");
        hook.unmount();
    });
    it("drops a start request when its target changes during the handshake", async () => {
        const initial = createSession(createDocumentSessionId("pending-target"), provenanceFromImport(), document);
        const owner = { ...initial, presentation: { ...initial.presentation, emission } };
        const store = new WorkspaceStore<WorkspaceAuthoringState>({ session: { ...createWorkspaceSession(), documents: [owner], activeDocumentId: owner.sessionId, preview: { targetDocumentId: owner.sessionId } }, profileDescriptor: descriptor });
        const hook = renderHook(() => useShaderPreview({ document, descriptor, descriptorCompatible: true, emission, configuredTarget: "gglab-dx12", nativeFlow, workspaceStore: store }));
        await waitFor(() => expect(hook.result.current.flow).not.toBeNull());
        const flow = hook.result.current.flow!;
        const handshake = flow.previewHandshake.bind(flow);
        let release!: () => void;
        const delayed = new Promise<void>(resolve => { release = resolve; });
        const spy = vi.spyOn(flow, "previewHandshake").mockImplementation(async input => { const record = await handshake(input); await delayed; return record; });
        let pending!: Promise<void>;
        act(() => { pending = hook.result.current.startPreview(owner.sessionId); });
        await waitFor(() => expect(spy).toHaveBeenCalledOnce());
        store.apply(state => ({ next: { ...state, session: { ...state.session, preview: { targetDocumentId: null } } }, result: null }));
        await act(async () => { release(); await pending; });
        expect((previewWorld.tool as FakeHostBoundary).previewBuildCalls).toBe(0);
        expect((previewWorld.runtime as FakePreviewRuntimeBoundary).launchCalls).toBe(0);
        expect(hook.result.current.notes.at(-1)?.text).toMatch(/changed during compatibility/);
        hook.unmount();
    });
    it("clears live Preview after target close and refuses actions from stale React props", async () => {
        const hook = renderHook(({ selected }: { selected: boolean }) => useShaderPreview({ document: selected ? document : null, descriptor, descriptorCompatible: true, emission, configuredTarget: "gglab-dx12", nativeFlow, workspaceStore }), { initialProps: { selected: true } });
        await waitFor(() => expect(hook.result.current.flow).not.toBeNull());
        await act(async () => { await hook.result.current.previewHandshake(); await hook.result.current.buildPreview(); });
        const flow = hook.result.current.flow!, previous = flow.session;
        expect((previewWorld.runtime as FakePreviewRuntimeBoundary).launchCalls).toBe(1);
        const owner = workspaceStore.getSnapshot().session.documents[0]!;
        await act(async () => {
            expect((await hook.result.current.coordinator.closeTarget(owner.sessionId, "wrong-discard-revision")).ok).toBe(false);
        });
        // Use the owner's canonical revision; a wrong discard revision cannot close it.
        await act(async () => { expect((await hook.result.current.coordinator.closeTarget(owner.sessionId, documentRevision(owner))).ok).toBe(true); });
        expect(flow.history).toContain(previous);
        expect(workspaceStore.getSnapshot().session.preview.targetDocumentId).toBeNull();
        await act(async () => { await hook.result.current.previewHandshake(); await hook.result.current.buildPreview(); await hook.result.current.launchPreview(); });
        expect((previewWorld.tool as FakeHostBoundary).previewBuildCalls).toBe(1);
        expect((previewWorld.runtime as FakePreviewRuntimeBoundary).launchCalls).toBe(1);
        hook.rerender({ selected: false });
        expect(hook.result.current.gate).toMatchObject({ admitted: false, reasons: [{ reason: "preview-target-unavailable" }] });
        expect(hook.result.current.projection).toMatchObject({ freshness: "idle", currentPublicationId: null, lastGoodPublicationId: null });
        expect(hook.result.current.initialPublicationAvailable).toBe(false);
        hook.unmount();
    });
    it("proves, publishes, launches, polls Current, and observes process exit", async () => {
        const hook = renderHook(() =>
            useShaderPreview({
                document,
                descriptor,
                descriptorCompatible: true,
                emission,
                configuredTarget: "gglab-dx12",
                nativeFlow,
                workspaceStore,
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

    it("does not auto-launch from an old build delivered after Workspace Environment selection changes", async () => {
        const store = new WorkspaceStore<WorkspaceAuthoringState>(selectedState());
        const hook = renderHook(() => useShaderPreview({ document, descriptor, descriptorCompatible: true, emission, configuredTarget: "gglab-dx12", nativeFlow, workspaceStore: store }));
        await waitFor(() => expect(hook.result.current.flow).not.toBeNull());
        await act(async () => hook.result.current.previewHandshake());
        let release!: () => void;
        const delivery = new Promise<void>(resolve => { release = resolve; });
        const coordinator = hook.result.current.coordinator;
        const issue = coordinator.buildPreview.bind(coordinator);
        vi.spyOn(coordinator, "buildPreview").mockImplementation(async input => {
            const launch = await issue(input);
            return launch.issued ? { ...launch, outcome: launch.outcome.then(async outcome => { await delivery; return outcome; }) } : launch;
        });
        let pending!: Promise<void>;
        act(() => { pending = hook.result.current.buildPreview(); });
        await waitFor(() => expect(hook.result.current.flow?.initialPublicationAvailable).toBe(true));
        store.apply(state => ({ next: { ...state, session: { ...state.session, activeEnvironment: { environmentId: "sha256:" + "a".repeat(64), environmentRoot: "D:/new", stateRoot: "D:/state", activationSequence: 1, tool: { path: "D:/new/tool.exe", sha256: "b".repeat(64) }, runtime: { path: "D:/new/runtime.exe", sha256: "c".repeat(64) } } } }, result: null }));
        await act(async () => { release(); await pending; });
        expect((previewWorld.runtime as FakePreviewRuntimeBoundary).launchCalls).toBe(0);
        expect(coordinator.hostAdmitted).toBe(false);
        hook.unmount();
    });

    it("unmounts cleanly while a launch is pending and still stops the Runtime that launches after unmount", async () => {
        previewWorld.runtimeSpec = {
            launches: [{ kind: "launched", runtimeIdentity: "runtime-a" }],
            keepLaunchPending: true,
            holdStopUntilRelease: true,
            stopReleaseKind: "stopped",
        };
        const hook = renderHook(() =>
            useShaderPreview({
                document,
                descriptor,
                descriptorCompatible: true,
                emission,
                configuredTarget: "gglab-dx12",
                nativeFlow,
                workspaceStore,
            }),
        );
        await waitFor(() => expect(hook.result.current.flow).not.toBeNull());
        await act(async () => hook.result.current.previewHandshake());

        // Kick off the build; its success auto-launches; the launch
        // STAYS PENDING on purpose.
        act(() => {
            void hook.result.current.buildPreview();
        });
        const runtime = previewWorld.runtime as FakePreviewRuntimeBoundary;
        await waitFor(() => expect(runtime.launchCalls).toBe(1));

        // UNMOUNT while the launch is still pending. The unmount cleanup
        // must NOT be a plain stop() (a no-op during launching — it would
        // orphan the Runtime); it joins the pending launch and then
        // completes the teardown.
        await act(async () => {
            hook.unmount();
        });

        // Let the launch settle, then wait for the (pending) unmount teardown
        // to issue the stop request for the exact just-launched Runtime and
        // release that held settlement.
        expect(runtime.releaseLaunch()).toBe(true);
        await waitFor(() => expect(runtime.releaseStop()).toBe(true));
        expect(runtime.resolvedExits).toBe(1);
    });
});
