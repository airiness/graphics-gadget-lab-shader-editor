import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { syntheticEnvironmentManifest } from "../../../tests/environment-synthetic.js";
import { ENVIRONMENT_STATE_ROLES, inspectEnvironmentStateObservation, readEnvironmentDirectoryHandle, readEnvironmentRegistryScan, projectEnvironmentRegistrySnapshot, verifyEnvironmentObservation } from "../src/index.js";

const hash = (text: string) => createHash("sha256").update(text, "ascii").digest("hex");
const handle = { directoryId: "environment-directory:1", root: "D:/environment", kind: "environment" as const };
function observation() {
    const manifest = syntheticEnvironmentManifest();
    return { ...handle, metadataText: JSON.stringify(manifest), entries: [
        { path: "environment.json", kind: "file", reparsePoint: false, linkCount: 1, size: 0, sha256: "0".repeat(64) },
        ...manifest.members.map(m => ({ ...m, kind: "file", reparsePoint: false, linkCount: 1 })),
    ] };
}
describe("Environment storage IPC facts", () => {
    it("uses the existing strict reader and rederives identity from native observations", () => {
        const raw = observation();
        expect(verifyEnvironmentObservation(handle, raw, hash).manifest.environmentId).toBe(syntheticEnvironmentManifest().environmentId);
        raw.metadataText = raw.metadataText.replace('"manifestVersion":1', '"manifestVersion":2');
        expect(() => verifyEnvironmentObservation(handle, raw, hash)).toThrow(/manifestVersion/);
    });
    it("rejects rebound handles, forged hashes, missing or extra files, links and staging", () => {
        for (const mutate of [
            (r: ReturnType<typeof observation>) => { r.directoryId = "environment-directory:2"; },
            (r: ReturnType<typeof observation>) => { r.root = "D:/other"; },
            (r: ReturnType<typeof observation>) => { r.entries[1]!.sha256 = "1".repeat(64); },
            (r: ReturnType<typeof observation>) => { r.entries.pop(); },
            (r: ReturnType<typeof observation>) => { r.entries.push({ ...r.entries[1]!, path: "payload/unlisted" }); },
            (r: ReturnType<typeof observation>) => { r.entries[1]!.linkCount = 2; },
            (r: ReturnType<typeof observation>) => { r.entries[1]!.reparsePoint = true; },
        ]) { const raw = observation(); mutate(raw); expect(() => verifyEnvironmentObservation(handle, raw, hash)).toThrow(); }
        const staging = { ...handle, root: "D:/.STAGING-env" };
        expect(() => verifyEnvironmentObservation(staging, { ...observation(), ...staging }, hash)).toThrow(/Staging/);
        expect(() => readEnvironmentDirectoryHandle({ ...handle, arbitraryPath: "D:/other" })).toThrow();
    });
    it("checks existing state roles and identity without initializing anything", () => {
        const closure = verifyEnvironmentObservation(handle, observation(), hash);
        const selected = { directoryId: "environment-directory:2", root: "D:/state", kind: "state" as const };
        const entries = [...new Set(Object.values(ENVIRONMENT_STATE_ROLES))].map(path => ({ path: String(path), kind: "directory", reparsePoint: false, linkCount: 1, size: null, sha256: null }));
        entries.push({ path: "state.json", kind: "file", reparsePoint: false, linkCount: 1, size: null, sha256: null });
        const raw = { ...selected, entries, metadataText: JSON.stringify({ stateVersion: 1, environmentId: closure.manifest.environmentId }) };
        expect(inspectEnvironmentStateObservation(selected, raw, closure).root).toBe(selected.root);
        expect(() => inspectEnvironmentStateObservation(selected, { ...raw, metadataText: null }, closure)).toThrow(/Missing/);
        expect(() => inspectEnvironmentStateObservation(selected, { ...raw, entries: entries.slice(1) }, closure)).toThrow(/Missing/);
        expect(() => inspectEnvironmentStateObservation(selected, { ...raw, metadataText: raw.metadataText.replace("sha256:", "wrong:") }, closure)).toThrow();
    });
    it("projects restart records as unverified and isolates corrupt entries", () => {
        const environmentId = syntheticEnvironmentManifest().environmentId;
        const record = { registryVersion: 1, environmentId, environmentRoot: handle.root, stateRoot: "D:/state" };
        const raw = { entries: [{ key: environmentId.slice(7), text: JSON.stringify(record) }, { key: "corrupt", diagnostic: { code: "hard-link", message: "Linked", dataPath: "corrupt" } }], pending: [".pending-00000000-0000-0000-0000-000000000000"] };
        const snapshot = projectEnvironmentRegistrySnapshot(readEnvironmentRegistryScan(raw));
        expect(snapshot.records).toEqual([{ record, readiness: "unverified" }]); expect(snapshot.diagnostics).toHaveLength(1); expect(snapshot.pending).toHaveLength(1);
        expect(() => readEnvironmentRegistryScan({ entries: [null], pending: [] })).toThrow();
        expect(() => readEnvironmentRegistryScan({ ...raw, ready: true })).toThrow();
    });
});
