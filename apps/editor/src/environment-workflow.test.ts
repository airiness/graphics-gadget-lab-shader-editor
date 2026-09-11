import { beforeEach, expect, it, vi } from "vitest";
import { createEnvironmentWorkflow } from "./environment-workflow.js";
import type { PreviewCoordinator } from "./preview-coordinator.js";

const mocks = vi.hoisted(() => ({ storage: { snapshot: vi.fn(), verify: vi.fn(), choose: vi.fn(), openRegistered: vi.fn() }, mutation: { list: vi.fn(), inspect: vi.fn(), preparePublish: vi.fn(), prepareState: vi.fn(), settle: vi.fn(), cancel: vi.fn() }, discovery: { chooseRepository: vi.fn(), discover: vi.fn(), cancel: vi.fn() }, activation: { activate: vi.fn(), cancel: vi.fn(), close: vi.fn() } }));
vi.mock("./environment-storage-host.js", () => ({ createEnvironmentStorageHost: () => mocks.storage }));
vi.mock("./environment-mutation-host.js", () => ({ createEnvironmentMutationHost: () => mocks.mutation }));
vi.mock("./environment-host.js", () => ({ createEnvironmentDiscoveryHost: () => mocks.discovery }));
vi.mock("./environment-activation-host.js", () => ({ createEnvironmentActivationHost: () => mocks.activation }));
const environment = { directoryId: "environment-directory:1", root: "D:/environment", kind: "environment" };
const state = { directoryId: "environment-directory:2", root: "D:/state", kind: "state" };
const candidate = { deployment: "Debug", toolSha256: "a".repeat(64), runtimeSha256: "b".repeat(64) };
const publication = { operation: "publish", operationId: "1".repeat(32), targetRoot: environment.root };
const initialization = { operation: "init-state", operationId: "2".repeat(32), environmentRoot: environment.root, targetRoot: state.root };
function setup() {
    let current = true; const emit = vi.fn();
    const workflow = createEnvironmentWorkflow(vi.fn(), vi.fn(), { coordinator: () => ({} as PreviewCoordinator), capture: () => () => current, begin: () => emit });
    return { workflow, emit, replace: () => { current = false; } };
}
beforeEach(() => {
    vi.resetAllMocks();
    mocks.storage.snapshot.mockResolvedValue({ records: [], diagnostics: [], pending: [] });
    mocks.storage.verify.mockResolvedValue({ manifest: { environmentId: "sha256:" + "a".repeat(64) } });
    mocks.storage.choose.mockImplementation(async kind => kind === "state" ? state : environment);
    mocks.mutation.list.mockResolvedValue([]);
    mocks.mutation.inspect.mockImplementation(async id => ({ intent: id === publication.operationId ? publication : initialization, target: id === publication.operationId ? environment : state, environment: id === publication.operationId ? null : environment, terminationUnproven: false }));
    mocks.mutation.preparePublish.mockResolvedValue(publication); mocks.mutation.prepareState.mockResolvedValue(initialization);
    mocks.mutation.settle.mockResolvedValue({ status: "integrity-verified" });
    mocks.discovery.chooseRepository.mockResolvedValue({ repositoryId: "repository:1" });
    mocks.discovery.discover.mockResolvedValue({ discoveryId: "discovery:1", completion: Promise.resolve({ status: "discovered", candidates: [candidate] }) });
    mocks.activation.activate.mockResolvedValue({ ok: true });
});
it("requires an explicit discovered candidate and retains state through failed proof and retry", async () => {
    const { workflow } = setup(); await workflow.publish(candidate);
    expect(mocks.mutation.preparePublish).not.toHaveBeenCalled();
    await workflow.discover(); expect(mocks.mutation.preparePublish).not.toHaveBeenCalled();
    mocks.activation.activate.mockResolvedValueOnce({ ok: false, refusal: { reason: "environment-activation-refused", detail: "Proof failed" } });
    await workflow.publish(workflow.getSnapshot().candidates[0]!);
    expect(workflow.getSnapshot().canRetry).toBe(true);
    expect(mocks.mutation.settle).toHaveBeenCalledTimes(2);
    await workflow.retry();
    expect(mocks.activation.activate).toHaveBeenCalledTimes(2);
    expect(mocks.mutation.prepareState).toHaveBeenCalledOnce();
    expect(mocks.mutation.preparePublish).toHaveBeenCalledOnce();
    expect(workflow.getSnapshot().canRetry).toBe(false);
});
it("does not activate into a Workspace that changed during publication", async () => {
    const w = setup(); await w.workflow.discover();
    mocks.mutation.settle.mockImplementationOnce(async () => { w.replace(); return { status: "integrity-verified" }; });
    await w.workflow.publish(candidate);
    expect(mocks.activation.activate).not.toHaveBeenCalled(); expect(mocks.mutation.prepareState).not.toHaveBeenCalled();
    expect(w.emit).toHaveBeenLastCalledWith(expect.objectContaining({ diagnostic: expect.objectContaining({ code: "cancelled" }) }));
});
it("reconciles the original durable publication and state operations after restart", async () => {
    const { workflow } = setup(); mocks.mutation.list.mockResolvedValue([publication.operationId, initialization.operationId]);
    await workflow.refresh(); await workflow.resume(workflow.getSnapshot().operations[0]!);
    expect(mocks.mutation.preparePublish).not.toHaveBeenCalled(); expect(mocks.mutation.prepareState).not.toHaveBeenCalled();
    expect(mocks.mutation.settle.mock.calls.map(c => c[0].operationId)).toEqual([publication.operationId, initialization.operationId]);
    expect(mocks.activation.activate).toHaveBeenCalledOnce();
});
it("cancels admission and prevents duplicate execution while publication is pending", async () => {
    const { workflow } = setup(); await workflow.discover();
    let release!: (value: unknown) => void;
    mocks.mutation.settle.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = workflow.publish(candidate); await vi.waitFor(() => expect(mocks.mutation.settle).toHaveBeenCalledOnce());
    await workflow.publish(candidate); await workflow.cancel();
    expect(mocks.mutation.cancel).toHaveBeenCalledWith(publication.operationId);
    release({ status: "integrity-verified" }); await pending;
    expect(mocks.mutation.preparePublish).toHaveBeenCalledOnce(); expect(mocks.activation.activate).not.toHaveBeenCalled();
    expect(workflow.getSnapshot()).toMatchObject({ busy: false, canRetry: true });
});
it("imports explicit published Environment/state without consulting a source repository", async () => {
    const { workflow } = setup(); await workflow.importPublished();
    expect(mocks.discovery.chooseRepository).not.toHaveBeenCalled(); expect(mocks.mutation.prepareState).not.toHaveBeenCalled();
    expect(mocks.activation.activate).toHaveBeenCalledWith(expect.anything(), environment, state, expect.any(Array), expect.any(Function), expect.any(Function));
});
it("retries a failed state operation with the same durable ID", async () => {
    const { workflow } = setup(); await workflow.discover();
    mocks.mutation.settle.mockResolvedValueOnce({ status: "integrity-verified" }).mockResolvedValueOnce({ status: "refused", diagnostic: { code: "cancelled", message: "Cancelled after creating state" } });
    await workflow.publish(candidate); expect(mocks.activation.activate).not.toHaveBeenCalled();
    await workflow.retry();
    expect(mocks.mutation.prepareState).toHaveBeenCalledOnce();
    expect(mocks.mutation.settle.mock.calls.map(c => c[0].operationId)).toEqual([publication.operationId, initialization.operationId, initialization.operationId]);
    expect(mocks.activation.activate).toHaveBeenCalledOnce();
});
it("refuses ambiguous recovered states without creating or choosing another state", async () => {
    const { workflow } = setup(); await workflow.discover();
    mocks.mutation.list.mockResolvedValue([initialization.operationId, "3".repeat(32)]);
    await workflow.publish(candidate);
    expect(workflow.getSnapshot().message).toMatch(/Multiple state operations/);
    expect(mocks.mutation.prepareState).not.toHaveBeenCalled(); expect(mocks.activation.activate).not.toHaveBeenCalled();
});
it("keeps usable registry entries visible when an unrelated operation is corrupt", async () => {
    const { workflow } = setup();
    const records = [{ record: { environmentId: "saved" }, readiness: "unverified" }];
    mocks.storage.snapshot.mockResolvedValue({ records, diagnostics: [], pending: [] });
    mocks.mutation.list.mockResolvedValue([publication.operationId, initialization.operationId]);
    mocks.mutation.inspect.mockRejectedValueOnce({ code: "invalid-shape", message: "Corrupt journal", dataPath: publication.operationId });
    await workflow.refresh();
    expect(workflow.getSnapshot().registry?.records).toEqual(records);
    expect(workflow.getSnapshot().registry?.diagnostics).toHaveLength(1);
    expect(workflow.getSnapshot().operations).toEqual([initialization]);
});
it("retries retained proof cleanup before allowing another activation", async () => {
    const { workflow } = setup();
    mocks.activation.close.mockRejectedValueOnce({ code: "runtime-unavailable", message: "Exit unproven" });
    await workflow.importPublished(); expect(mocks.activation.activate).not.toHaveBeenCalled();
    await workflow.retry(); expect(mocks.activation.close).toHaveBeenCalledTimes(2);
    expect(mocks.activation.activate).toHaveBeenCalledOnce();
    expect(mocks.mutation.prepareState).not.toHaveBeenCalled();
});
