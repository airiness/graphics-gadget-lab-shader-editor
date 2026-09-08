import { syntheticEnvironmentManifest } from "../../../tests/environment-synthetic.js";
import { describe, expect, it } from "vitest";
import { EnvironmentRegistry, environmentCanonical, environmentRegistryKey, readEnvironmentRegistryRecord, recoverEnvironmentRegistration, prepareEnvironmentImport, withEnvironmentRegistry, type EnvironmentRegistration, type EnvironmentRegistryRecord, type EnvironmentRegistryStorage, type EnvironmentRecoveryHost } from "../src/index.js";
function example(): EnvironmentRegistration {
    const manifest = syntheticEnvironmentManifest();
    const root = "D:/final", stateRoot = "D:/state";
    return { closure: { root, manifest }, state: { root: stateRoot, environmentId: manifest.environmentId }, proof: {
        environmentId: manifest.environmentId, environmentRoot: root, stateRoot,
        tool: { path: root + "/" + manifest.roles.tool, sha256: manifest.members.find(m => m.path === manifest.roles.tool)!.sha256 },
        runtime: { path: root + "/" + manifest.roles.runtime, sha256: manifest.members.find(m => m.path === manifest.roles.runtime)!.sha256 },
        ordinaryHandshake: "compatible", previewHandshake: "compatible", profiles: [1,2], runtimeObservation: "loaded",
    } };
}
function memory() {
    const records = new Map<string, string>();
    const storage: EnvironmentRegistryStorage = {
        scan: async () => ({ entries: [...records].map(([key, text]) => ({ key, text })), pending: [] }),
        insert: async (key, text) => {
            const previous = records.get(key); if (previous !== undefined) return { text: previous, inserted: false };
            records.set(key, text); return { text, inserted: true };
        },
    };
    return { records, storage, registry: new EnvironmentRegistry(storage) };
}
const recordOf = (r: EnvironmentRegistration): EnvironmentRegistryRecord => ({ registryVersion: 1, environmentId: r.closure.manifest.environmentId, environmentRoot: r.closure.root, stateRoot: r.state.root });
describe("durable Environment record semantics", () => {
    it("rejects unknown versions, persisted proof, overlap and staging aliases", () => {
        const record = recordOf(example());
        for (const patch of [{ registryVersion: 2 }, { proof: {} }, { stateRoot: "d:/FINAL/state" }, { environmentRoot: "D:/.STAGING-test" }]) expect(() => readEnvironmentRegistryRecord(JSON.stringify({ ...record, ...patch }))).toThrow();
    });
    it("registers idempotently without persisting proof or active selection", async () => {
        const m = memory(), r = example();
        expect(await m.registry.register(r)).toBe("registered");
        expect(await m.registry.register(r)).toBe("already-registered");
        expect(JSON.parse([...m.records.values()][0]!)).toEqual(recordOf(r));
        const restarted = new EnvironmentRegistry(m.storage);
        expect((await restarted.snapshot()).records).toEqual([{ record: recordOf(r), readiness: "unverified" }]);
    });
    it("concurrent identical registrations converge and conflicting bindings preserve the winner", async () => {
        const m = memory(), r = example();
        expect((await Promise.all([m.registry.register(r), new EnvironmentRegistry(m.storage).register(r)])).sort()).toEqual(["already-registered", "registered"]);
        const before = [...m.records];
        const different = { ...r, state: { ...r.state, root: "D:/another-state" }, proof: { ...r.proof, stateRoot: "D:/another-state" } };
        await expect(m.registry.register(different)).rejects.toThrow("another root/state binding"); expect([...m.records]).toEqual(before);
    });
    it("isolates corrupt records and rejects a mismatched key", async () => {
        const m = memory(), r = example(); await m.registry.register(r);
        m.records.set("0".repeat(64), environmentCanonical(recordOf(r)));
        m.records.set("1".repeat(64), '{"registryVersion":2}');
        const snapshot = await m.registry.snapshot(); expect(snapshot.records).toHaveLength(1); expect(snapshot.diagnostics).toHaveLength(2);
        expect(snapshot.records[0]?.readiness).toBe("unverified");
    });
    it("does not admit a wrong final-path proof to storage", async () => {
        const m = memory(), r = example();
        await expect(m.registry.register({ ...r, proof: { ...r.proof, environmentRoot: "D:/source" } })).rejects.toThrow("different final location");
        expect(m.records.size).toBe(0);
    });
});
describe("restart and uncertain commit recovery", () => {
    it("requires fresh proof and existing state inspection after restart", async () => {
        const m = memory(), r = example(); await m.registry.register(r); let proofs = 0, states = 0;
        const host: EnvironmentRecoveryHost = { verifyFinal: async () => r.closure, recoverExistingState: async () => { states++; return r.state; }, proveFinal: async () => { proofs++; return r.proof; } };
        const result = await recoverEnvironmentRegistration(new EnvironmentRegistry(m.storage), recordOf(r), host, () => false);
        expect(result.status).toBe("already-registered"); expect(proofs).toBe(1); expect(states).toBe(1);
        expect((await m.registry.snapshot()).records[0]?.readiness).toBe("unverified");
    });
    it("missing state or replaced closure never initialize state or overwrite last-good records", async () => {
        const m = memory(), r = example(); await m.registry.register(r); const before = [...m.records];
        const host: EnvironmentRecoveryHost = { verifyFinal: async () => r.closure, recoverExistingState: async () => { throw new Error("State missing"); }, proveFinal: async () => { throw new Error("Must not run"); } };
        expect(await recoverEnvironmentRegistration(m.registry, recordOf(r), host, () => false)).toMatchObject({ status: "refused", registrationMayHaveCommitted: false });
        host.verifyFinal = async () => ({ ...r.closure, manifest: { ...r.closure.manifest, environmentId: "sha256:" + "0".repeat(64) } });
        expect(await recoverEnvironmentRegistration(m.registry, recordOf(r), host, () => false)).toMatchObject({ status: "refused", diagnostic: { code: "identity-mismatch" } });
        expect([...m.records]).toEqual(before);
    });
    it("reports lost acknowledgement after commit and supports read-only reconciliation", async () => {
        const m = memory(), r = example();
        const base = { verifyFinal: async () => r.closure, initializeOrRecoverState: async () => r.state, proveFinal: async () => r.proof };
        const host = withEnvironmentRegistry(base, m.registry), commit = host.register;
        host.register = async registration => { await commit(registration); throw new Error("Lost acknowledgement"); };
        expect(await prepareEnvironmentImport(host, r.closure.root, r.state.root, () => false)).toMatchObject({ status: "refused", registrationMayHaveCommitted: true });
        expect(m.records.has(environmentRegistryKey(r.closure.manifest.environmentId))).toBe(true);
        expect((await recoverEnvironmentRegistration(new EnvironmentRegistry(m.storage), recordOf(r), { verifyFinal: base.verifyFinal, proveFinal: base.proveFinal, recoverExistingState: base.initializeOrRecoverState }, () => false)).status).toBe("already-registered");
    });
    it("rechecks the saved binding after asynchronous proof", async () => {
        const m = memory(), r = example(); await m.registry.register(r);
        const result = await recoverEnvironmentRegistration(m.registry, recordOf(r), {
            verifyFinal: async () => r.closure, recoverExistingState: async () => r.state,
            proveFinal: async () => { m.records.clear(); return r.proof; },
        }, () => false);
        expect(result).toMatchObject({ status: "refused", diagnostic: { code: "registry-conflict" } });
        expect(m.records.size).toBe(0);
    });
});
