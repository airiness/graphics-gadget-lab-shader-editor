import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakePreviewRuntimeBoundary, type EnvironmentImportEvent, type ToolCandidate } from "@gglab/shader-toolchain-client";
import { createEnvironmentActivationHost, type PreparedEnvironmentActivation } from "../src/environment-activation-host.js";
import { PreviewCoordinator } from "../src/preview-coordinator.js";
import { AttachedPreviewRuntimeManager } from "../src/preview-runtime-manager.js";
import { WorkspaceStore, descriptorCommit, type WorkspaceAuthoringState } from "../src/workspace-store.js";
import { createDocumentSessionId, createWorkspaceSession, canonicalWorkspaceUriFromHost } from "../src/workspace-session.js";
import { createSession, provenanceFromImport } from "../src/document-session.js";
import type { SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import type { PreviewBuildController, PreviewCompositionInput } from "../src/preview-build-controller.js";
import { graph } from "./environment-probe-documents.js";

const mocks = vi.hoisted(() => ({ importSelected: vi.fn(), cancel: vi.fn(), close: vi.fn() }));
vi.mock("../src/environment-import-host.js", () => ({ createEnvironmentImportHost: () => mocks }));
const environment = { directoryId: "environment-directory:1", root: "D:/environment", kind: "environment" as const };
const state = { directoryId: "environment-directory:2", root: "D:/state", kind: "state" as const };
const candidate: ToolCandidate = { rule: "explicit-config", toolPath: "D:/old/tool.exe", observationIdentity: "a".repeat(64), resolvedAt: 1 };
function setup() {
    const document = createSession(createDocumentSessionId("doc"), provenanceFromImport(), graph(1));
    const session = { ...createWorkspaceSession<typeof document>(), documents: [document], activeDocumentId: document.sessionId, preview: { targetDocumentId: document.sessionId } };
    const store = new WorkspaceStore<WorkspaceAuthoringState>({ session, profileDescriptor: null });
    const runtime = new FakePreviewRuntimeBoundary({ launches: [{ kind: "launched", runtimeIdentity: "old" }], holdStopUntilRelease: true, stopReleaseKind: "stopped" });
    const manager = new AttachedPreviewRuntimeManager(runtime, "a".repeat(32));
    const coordinator = new PreviewCoordinator(() => manager, () => null, store);
    const host = createEnvironmentActivationHost(async () => { throw new Error("No native IPC in synthetic transition tests"); });
    return { document, store, runtime, manager, coordinator, host, activate: () => host.activate(coordinator, environment, state, [graph(1), graph(2)]) };
}
async function reachTeardown() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
beforeEach(() => {
    vi.clearAllMocks();
    mocks.importSelected.mockResolvedValue({ status: "registered", registration: { closure: { root: environment.root, manifest: { environmentId: "sha256:" + "a".repeat(64) } }, state: { root: state.root }, proof: { tool: { path: "D:/environment/tool.exe", sha256: "b".repeat(64) }, runtime: { path: "D:/environment/runtime.exe", sha256: "c".repeat(64) } } } });
});
describe("Workspace Environment ownership transitions (synthetic proof)", () => {
    it("joins the old Runtime and commits current edits once without inheriting Preview readiness", async () => {
        const w = setup(); await w.manager.launch(candidate);
        const pending = w.activate(); await reachTeardown();
        expect(mocks.importSelected).not.toHaveBeenCalled();
        expect(w.store.getSnapshot().session.activeEnvironment).toBeNull();
        expect(w.coordinator.legacyHostAdmitted).toBe(false);
        expect(await w.coordinator.retargetTo(w.document.sessionId)).toMatchObject({ ok: false, refusal: { reason: "transition-in-flight" } });
        w.store.apply(current => ({ next: { ...current, session: { ...current.session, documents: [{ ...w.document, presentation: { ...w.document.presentation, notes: ["Edit while joining"] } }] } }, result: null }));
        let commits = 0; w.store.subscribe(() => { commits++; });
        expect(w.runtime.releaseStop()).toBe(true);
        expect(await pending).toMatchObject({ ok: true, identity: { kind: "environment" } });
        const current = w.store.getSnapshot(); expect(commits).toBe(1);
        expect(current.session.activeEnvironment).toMatchObject({ environmentRoot: environment.root, stateRoot: state.root });
        expect(current.session.documents[0]!.history).toBe(w.document.history);
        expect(current.session.documents[0]!.presentation.notes).toEqual(["Edit while joining"]);
        expect(current.session.preview.targetDocumentId).toBe(w.document.sessionId);
        expect(current.profileDescriptor).toBeNull();
        expect(Object.isFrozen(current.session.activeEnvironment)).toBe(true);
        expect(descriptorCommit(current, {} as SurfaceProfileDescriptor)).toBe(current);
        const oldProjection = vi.fn();
        const oldFlow = { runtimeProjection: oldProjection } as unknown as PreviewBuildController;
        const legacy = new PreviewCoordinator(() => w.manager, () => oldFlow, w.store);
        expect(legacy.runtimeProjection({} as PreviewCompositionInput)).toMatchObject({ freshness: "idle", currentPublicationId: null });
        expect(legacy.gate({} as PreviewCompositionInput)).toMatchObject({ admitted: false, reasons: [{ reason: "preview-host-unavailable" }] });
        expect(oldProjection).not.toHaveBeenCalled();
        expect(legacy.legacyHostAdmitted).toBe(false);
    });
    it("refuses forged admission and failed import without changing selection", async () => {
        const w = setup(), before = w.store.getSnapshot();
        expect(await w.coordinator.activateEnvironment(async () => ({} as PreparedEnvironmentActivation))).toMatchObject({ ok: false });
        mocks.importSelected.mockResolvedValue({ status: "refused", diagnostic: { code: "hash-mismatch", message: "Changed closure" } });
        expect(await w.activate()).toMatchObject({ ok: false }); expect(w.store.getSnapshot()).toBe(before);
    });
    it("honors cancellation before import while teardown is pending", async () => {
        const w = setup(); await w.manager.launch(candidate); const before = w.store.getSnapshot();
        const pending = w.activate(); await reachTeardown(); await w.host.cancel();
        expect(w.runtime.releaseStop()).toBe(true); expect(await pending).toMatchObject({ ok: false });
        expect(w.store.getSnapshot()).toBe(before);
        expect(mocks.importSelected).not.toHaveBeenCalled();
    });
    it("refuses a Workspace replacement during teardown and preserves its newer state", async () => {
        const w = setup(); await w.manager.launch(candidate);
        const pending = w.activate(); await reachTeardown();
        w.store.apply(current => ({ next: { ...current, session: { ...current.session, workspaceRoot: { canonicalWorkspaceUri: canonicalWorkspaceUriFromHost("file:///other"), displayPath: "D:/other" } } }, result: null }));
        const newer = w.store.getSnapshot(); expect(w.runtime.releaseStop()).toBe(true);
        expect(await pending).toMatchObject({ ok: false }); expect(w.store.getSnapshot()).toBe(newer);
    });
    it("retains selection and releases its lease when old Runtime exit is unproven", async () => {
        const w = setup(), before = w.store.getSnapshot();
        vi.spyOn(w.manager, "terminateAndJoin").mockResolvedValue({ outcome: "exit-unproven", runtimeId: { sequence: 1 } });
        expect(await w.activate()).toMatchObject({ ok: false, refusal: { reason: "exit-unproven" } });
        expect(w.store.getSnapshot()).toBe(before);
        vi.spyOn(w.manager, "terminateAndJoin").mockResolvedValue({ outcome: "already-exited" });
        expect(await w.activate()).toMatchObject({ ok: true });
    });
    it("reports unproven exit before importing and ignores evidence sink exceptions", async () => {
        const w = setup(), events: EnvironmentImportEvent[] = [];
        vi.spyOn(w.manager, "terminateAndJoin").mockResolvedValue({ outcome: "exit-unproven", runtimeId: { sequence: 7 } });
        expect(await w.host.activate(w.coordinator, environment, state, [graph(1), graph(2)], () => false, e => events.push(e))).toMatchObject({ ok: false });
        expect(events.map(e => e.phase)).toEqual(["settled"]);
        expect(mocks.importSelected).not.toHaveBeenCalled();
        expect(events.at(-1)?.diagnostic?.code).toBe("exit-unproven");
        vi.spyOn(w.manager, "terminateAndJoin").mockResolvedValue({ outcome: "already-exited" });
        expect(await w.host.activate(w.coordinator, environment, state, [graph(1), graph(2)], () => false, () => { throw new Error("Sink unavailable"); })).toMatchObject({ ok: true });
    });
    it("does not prepare another Environment while activation owns the transition slot", async () => {
        const w = setup(); await w.manager.launch(candidate);
        const pending = w.activate(); await reachTeardown();
        expect(await w.activate()).toMatchObject({ ok: false, refusal: { reason: "transition-in-flight" } });
        expect(mocks.importSelected).not.toHaveBeenCalled();
        expect(w.runtime.releaseStop()).toBe(true); expect(await pending).toMatchObject({ ok: true });
        expect(mocks.importSelected).toHaveBeenCalledTimes(1);
    });
});
