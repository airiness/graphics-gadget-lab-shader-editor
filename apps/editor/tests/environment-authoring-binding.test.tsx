import { act, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DescriptorPanel } from "@gglab/editor-ui";
import { parseSurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";
import { createWorkspaceEnvironmentBinding, useEnvironmentAuthoring } from "../src/use-environment-authoring.js";
import { useNativeBuild } from "../src/useNativeBuild.js";
import { useShaderPreview } from "../src/useShaderPreview.js";
import { composeWorkspaceProblemSnapshot } from "../src/problems-composition.js";
import { PreviewCoordinator } from "../src/preview-coordinator.js";
import { WorkspaceStore, type WorkspaceAuthoringState } from "../src/workspace-store.js";
import { createWorkspaceSession, createDocumentSessionId, type WorkspaceEnvironmentSelection } from "../src/workspace-session.js";
import { createSession, provenanceFromImport } from "../src/document-session.js";
import { graph } from "./environment-probe-documents.js";

const control = vi.hoisted(() => ({ opens: [] as ReturnType<typeof vi.fn>[], closes: [] as ReturnType<typeof vi.fn>[], nextOpen: null as Promise<void> | null, failClose: false, legacy: vi.fn() }));
const candidate = { rule: "explicit-config" as const, toolPath: "D:/environment/tool.exe", observationIdentity: "a".repeat(64), resolvedAt: 1 };
const profiles = [canonicalV1Fixture, canonicalV2Fixture].map(d => parseSurfaceProfileDescriptor(JSON.stringify(d)).value!);
vi.mock("../src/environment-authoring-host.js", () => ({ createEnvironmentAuthoringHost: () => {
    const wait = control.nextOpen; control.nextOpen = null;
    const open = vi.fn(async () => { await wait; });
    const close = vi.fn(async () => { if (control.failClose) throw new Error("Close unproven"); });
    control.opens.push(open); control.closes.push(close);
    return { open, close, resolveProfile: (d: { profileVersion: number }) => profiles[d.profileVersion - 1],
        boundary: { discover: async () => ({ candidate, failures: [] }), handshake: async () => ({ kind: "launch-failed", candidate }), previewHandshake: async () => ({ kind: "launch-failed", candidate }) },
        observation: {}, runtime: {},
    };
} }));
vi.mock("../src/toolchain-host.js", () => ({ toolBoundaryAvailable: () => true, createTauriToolBoundary: control.legacy }));
const selection: WorkspaceEnvironmentSelection = { environmentId: "sha256:" + "a".repeat(64), environmentRoot: "D:/environment", stateRoot: "D:/state", activationSequence: 1, tool: { path: candidate.toolPath, sha256: candidate.observationIdentity }, runtime: { path: "D:/environment/runtime.exe", sha256: "b".repeat(64) } };
const invoke = async () => ({ recordText: JSON.stringify({ registryVersion: 1, environmentId: selection.environmentId, environmentRoot: selection.environmentRoot, stateRoot: selection.stateRoot }), environment: { directoryId: "environment-directory:1", kind: "environment", root: selection.environmentRoot }, state: { directoryId: "environment-directory:2", kind: "state", root: selection.stateRoot } });
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => invoke() }));
function store() {
    const a = createSession(createDocumentSessionId("a"), provenanceFromImport(), graph(1));
    const b = createSession(createDocumentSessionId("b"), provenanceFromImport(), graph(2));
    return new WorkspaceStore<WorkspaceAuthoringState>({ session: { ...createWorkspaceSession<typeof a>(), documents: [a, b], activeDocumentId: a.sessionId, preview: { targetDocumentId: a.sessionId }, activeEnvironment: selection }, profileDescriptor: null });
}
beforeEach(() => { control.opens.length = 0; control.closes.length = 0; control.nextOpen = null; control.failClose = false; control.legacy.mockClear(); });

describe("Workspace authoring hook ownership (synthetic host)", () => {
    it("retires a late admission before installing its replacement", async () => {
        let release!: () => void; control.nextOpen = new Promise<void>(r => { release = r; });
        const workspace = store();
        const hook = renderHook(({ selected }) => useEnvironmentAuthoring(workspace, selected), { initialProps: { selected: selection } });
        await waitFor(() => expect(control.opens[0]).toHaveBeenCalledOnce());
        const next = { ...selection, activationSequence: 2 };
        act(() => { workspace.apply(s => ({ next: { ...s, session: { ...s.session, activeEnvironment: next } }, result: null })); hook.rerender({ selected: next }); });
        expect(hook.result.current.binding).toBeNull();
        expect(control.opens).toHaveLength(1);
        await act(async () => { release(); });
        await waitFor(() => expect(hook.result.current.binding?.selection).toBe(next));
        expect(control.closes[0]).toHaveBeenCalled();
        hook.unmount();
    });
    it("retains a failed-close owner, blocks replacement and permits explicit retry", async () => {
        const workspace = store();
        const hook = renderHook(({ selected }) => useEnvironmentAuthoring(workspace, selected), { initialProps: { selected: selection } });
        await waitFor(() => expect(hook.result.current.binding).not.toBeNull());
        const next = { ...selection, activationSequence: 2 }; control.failClose = true;
        act(() => { workspace.apply(s => ({ next: { ...s, session: { ...s.session, activeEnvironment: next } }, result: null })); hook.rerender({ selected: next }); });
        await waitFor(() => expect(hook.result.current.error).toContain("Close unproven"));
        expect(control.opens).toHaveLength(1); expect(hook.result.current.binding).toBeNull();
        control.failClose = false; act(() => hook.result.current.retry());
        await waitFor(() => expect(hook.result.current.binding?.selection).toBe(next));
        expect(control.opens).toHaveLength(2); hook.unmount();
    });
    it("does not fall back to a legacy host while Environment cleanup is unproven", async () => {
        const workspace = store();
        const hook = renderHook(({ selected }) => useEnvironmentAuthoring(workspace, selected), { initialProps: { selected: selection as WorkspaceEnvironmentSelection | null } });
        await waitFor(() => expect(hook.result.current.binding).not.toBeNull());
        control.failClose = true;
        act(() => { workspace.apply(s => ({ next: { ...s, session: { ...s.session, activeEnvironment: null } }, result: null })); hook.rerender({ selected: null }); });
        await waitFor(() => expect(hook.result.current.error).toContain("Close unproven"));
        expect(hook.result.current.legacyAdmitted).toBe(false);
        control.failClose = false; act(() => hook.result.current.retry());
        await waitFor(() => expect(hook.result.current.legacyAdmitted).toBe(true));
        hook.unmount();
    });
    it("shares actual controller owners across both hooks without constructing a legacy host", async () => {
        const workspace = store();
        const owner = createWorkspaceEnvironmentBinding(invoke, selection, () => workspace.getSnapshot().session.activeEnvironment === selection, "dx12"); await owner.open();
        const hook = renderHook(() => {
            const native = useNativeBuild({ environment: owner, descriptor: profiles[0]!, descriptorCompatible: true, descriptorDetail: "compatible", emission: null });
            const preview = useShaderPreview({ environment: owner, document: graph(1), descriptor: profiles[0]!, descriptorCompatible: true, emission: null, configuredTarget: "gglab-dx12", nativeFlow: native.flow, workspaceStore: workspace });
            return { native, preview };
        });
        await waitFor(() => expect(hook.result.current.preview.flow).toBe(owner.preview));
        expect(hook.result.current.native.flow).toBe(owner.native);
        expect(hook.result.current.preview.coordinator.hostAdmitted).toBe(true);
        workspace.apply(s => ({ next: { ...s, session: { ...s.session, activeEnvironment: { ...selection, activationSequence: 2 } } }, result: null }));
        expect(hook.result.current.preview.coordinator.hostAdmitted).toBe(false);
        expect(() => owner.resolveProfile(graph(1))).toThrow(/no longer current/);
        expect(control.legacy).not.toHaveBeenCalled(); hook.unmount(); await owner.close();
    });
    it("refuses backend replacement while Runtime owns the binding, then retires it before reopening", async () => {
        const workspace = store();
        const hook = renderHook(() => useEnvironmentAuthoring(workspace, selection));
        await waitFor(() => expect(hook.result.current.binding).not.toBeNull());
        const owner = hook.result.current.binding!;
        const state = vi.spyOn(owner.manager, "state", "get").mockReturnValue({ kind: "running", runtimeId: { sequence: 1 }, runtimeIdentity: "a".repeat(64) });
        expect(hook.result.current.setTarget("gglab-vulkan13")).toBe(false);
        expect(owner.current()).toBe(true);
        state.mockRestore();
        act(() => { expect(hook.result.current.setTarget("gglab-vulkan13")).toBe(true); expect(owner.current()).toBe(false); });
        await waitFor(() => expect(hook.result.current.binding?.backend).toBe("vulkan"));
        expect(control.closes[0]).toHaveBeenCalled(); hook.unmount();
    });
    it("shows the supplied descriptor without admitting manual replacement", () => {
        const open = vi.fn(), change = vi.fn();
        const view = render(<DescriptorPanel state={{ kind: "ready", descriptor: profiles[1]! }} readOnly openDescriptorFile={open} onStateChange={change} />);
        const button = view.getByRole("button", { name: "Open descriptor file…" });
        expect((button as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(button); expect(open).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
        view.unmount();
    });
    it("resolves the Preview target profile at commit time independently of the active tab", async () => {
        const workspace = store();
        const coordinator = new PreviewCoordinator(() => null, () => null, workspace, () => true, d => profiles[d.profileVersion - 1]!);
        const target = workspace.getSnapshot().session.documents[1]!;
        expect(await coordinator.retargetTo(target.sessionId)).toMatchObject({ ok: true });
        expect(workspace.getSnapshot().session.activeDocumentId).not.toBe(target.sessionId);
        expect(workspace.getSnapshot().session.documents[1]!.presentation.emission?.ok).toBe(true);
        expect(composeWorkspaceProblemSnapshot(workspace.getSnapshot().session, null, null, null, [], d => profiles[d.profileVersion - 1]!)).toEqual({ entries: [] });
    });
});
