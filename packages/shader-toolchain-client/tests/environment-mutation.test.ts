import { describe, expect, it, vi } from "vitest";
import { syntheticEnvironmentManifest } from "../../../tests/environment-synthetic.js";
import { readEnvironmentMutationIntent, settleEnvironmentMutation, type EnvironmentMutationHost, type EnvironmentMutationIntent } from "../src/environment-mutation.js";
function fixture() {
    const manifest = syntheticEnvironmentManifest();
    const intent: EnvironmentMutationIntent = { intentVersion: 1, operationId: "1".repeat(32), operation: "publish", repositoryRoot: "D:/main", publisherSha256: manifest.producer.publisherSha256, candidate: { deployment: manifest.producer.deployment, toolSha256: manifest.members.find(m => m.path === manifest.roles.tool)!.sha256, runtimeSha256: manifest.members.find(m => m.path === manifest.roles.runtime)!.sha256 }, environmentRoot: null, environmentId: null, targetRoot: "D:/managed/environment" };
    const closure = { root: intent.targetRoot, manifest };
    const observed = { intent, terminationUnproven: false, closure: closure as typeof closure | null, state: null };
    const host: EnvironmentMutationHost = { execute: vi.fn(async () => { throw new Error("Lost stdout after final rename"); }), inspect: vi.fn(async () => observed) };
    return { intent, host, observed, closure };
}
describe("producer mutation reconciliation (synthetic integrity evidence only)", () => {
    it("recovers finalization from lost stdout only by independent closure verification", async () => {
        const f = fixture(); const result = await settleEnvironmentMutation(f.intent, f.host, () => false);
        expect(result.status).toBe("integrity-verified"); if (result.status === "integrity-verified") { expect(result.recovered).toBe(true); expect(result.nativeReadiness).toBe("unproven"); }
    });
    it("never infers rollback or deletes an incomplete target", async () => {
        const f = fixture(); f.observed.closure = null;
        expect(await settleEnvironmentMutation(f.intent, f.host, () => false)).toMatchObject({ status: "refused", targetMayExist: true });
        expect(f.host.execute).toHaveBeenCalledOnce();
    });
    it("reconciles restart without executing the publisher", async () => {
        const f = fixture(); expect((await settleEnvironmentMutation(f.intent, f.host, () => false, false)).status).toBe("integrity-verified"); expect(f.host.execute).not.toHaveBeenCalled();
    });
    it("keeps cancellation explicit even when finalization won the race", async () => {
        const f = fixture(); expect(await settleEnvironmentMutation(f.intent, f.host, () => true)).toMatchObject({ status: "refused", diagnostic: { code: "cancelled" } }); expect(f.host.execute).not.toHaveBeenCalled();
    });
    it("cannot recover while native termination remains unproven", async () => {
        const f = fixture(); f.observed.terminationUnproven = true;
        expect(await settleEnvironmentMutation(f.intent, f.host, () => false)).toMatchObject({ status: "refused", diagnostic: { code: "termination-unproven" } });
    });
    it("requires explicit recovery after native cancellation even if a final target exists", async () => {
        const f = fixture();
        f.host.execute = async () => ({ operationId: f.intent.operationId, kind: "settled", publisherSha256: f.intent.publisherSha256, interpreterSha256: "a".repeat(64), output: { stdout: [], stderr: [], exitCode: null, timedOut: false, canceled: true, outputLimitExceeded: false } });
        expect(await settleEnvironmentMutation(f.intent, f.host, () => false)).toMatchObject({ status: "refused", diagnostic: { code: "cancelled" } });
        expect((await settleEnvironmentMutation(f.intent, f.host, () => false, false)).status).toBe("integrity-verified");
    });
    it("rejects a changed executable and a rebound saved target", async () => {
        const f = fixture(); const changed = { ...f.intent, candidate: { ...f.intent.candidate!, toolSha256: "0".repeat(64) } }; f.observed.intent = changed;
        expect(await settleEnvironmentMutation(changed, f.host, () => false)).toMatchObject({ status: "refused", diagnostic: { code: "source-changed" } });
        const g = fixture(); g.observed.intent = { ...g.intent, targetRoot: "D:/other" };
        expect(await settleEnvironmentMutation(g.intent, g.host, () => false)).toMatchObject({ status: "refused", diagnostic: { code: "proof-mismatch" } });
    });
    it("validates existing state binding instead of repeating init-state", async () => {
        const f = fixture(); const intent: EnvironmentMutationIntent = { ...f.intent, operation: "init-state", candidate: null, environmentRoot: f.closure.root, environmentId: f.closure.manifest.environmentId, targetRoot: "D:/state" };
        const host = { execute: f.host.execute, inspect: async () => ({ intent, terminationUnproven: false, closure: f.closure, state: { root: "D:/state", environmentId: intent.environmentId! } }) };
        expect((await settleEnvironmentMutation(intent, host, () => false, false)).status).toBe("integrity-verified"); expect(host.execute).not.toHaveBeenCalled();
        host.inspect = async () => ({ intent, terminationUnproven: false, closure: f.closure, state: { root: "D:/state", environmentId: "sha256:" + "0".repeat(64) } });
        expect(await settleEnvironmentMutation(intent, host, () => false, false)).toMatchObject({ status: "refused", diagnostic: { code: "state-conflict" } });
    });
    it("strictly rejects versions, extra fields and unsafe locators", () => {
        const { intent } = fixture();
        for (const bad of [{ ...intent, intentVersion: 2 }, { ...intent, args: [] }, { ...intent, candidate: { ...intent.candidate, deployment: "../escape" } }]) expect(() => readEnvironmentMutationIntent(bad)).toThrow();
    });
});
