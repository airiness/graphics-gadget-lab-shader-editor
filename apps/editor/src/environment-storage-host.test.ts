import { describe, expect, it, vi } from "vitest";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";
import { syntheticEnvironmentManifest } from "../../../tests/environment-synthetic.js";
import { ENVIRONMENT_STATE_ROLES } from "@gglab/shader-toolchain-client";

describe("Tauri Environment storage composition", () => {
    it("uses host selection and IDs only, pins observations before awaiting IPC", async () => {
        const handle = { directoryId: "environment-directory:1", root: "D:/environment", kind: "environment" as const };
        let resolve!: (value: unknown) => void;
        const invoke = vi.fn(async (command: string) => {
            if (command === "shader-environment-choose-directory") return handle;
            return new Promise(r => { resolve = r; });
        });
        const host = createEnvironmentStorageHost(invoke);
        expect(await host.choose("environment")).toEqual(handle);
        const pending = host.verify(handle);
        handle.root = "D:/changed";
        resolve({ ...handle, entries: [], metadataText: null });
        await expect(pending).rejects.toThrow(/another selection/);
        expect(invoke).toHaveBeenLastCalledWith("shader-environment-observe-directory", { directoryId: handle.directoryId });
    });
    it("returns unverified snapshots and preserves structured host failures", async () => {
        const host = createEnvironmentStorageHost(async command => {
            if (command === "shader-environment-registry-scan") return { entries: [], pending: [] };
            throw { code: "reparse-point", message: "Linked directory", dataPath: "$" };
        });
        expect(await host.snapshot()).toEqual({ records: [], diagnostics: [], pending: [] });
        await expect(host.choose("state")).rejects.toMatchObject({ diagnostic: { code: "reparse-point" } });
    });
    it("does not invoke proof when cancellation is requested or a saved binding changes", async () => {
        const record = { registryVersion: 1 as const, environmentId: "sha256:" + "1".repeat(64), environmentRoot: "D:/environment", stateRoot: "D:/state" };
        const proof = vi.fn();
        const host = createEnvironmentStorageHost(async () => ({ recordText: JSON.stringify({ ...record, stateRoot: "D:/other" }), environment: {}, state: {} }));
        await expect(host.recover(record, proof, () => false)).rejects.toThrow(/Saved binding changed/);
        await expect(host.recover(record, proof, () => true)).rejects.toThrow(/cancelled/);
        expect(proof).not.toHaveBeenCalled();
    });
    it("rechecks the saved registration after fresh proof and refuses a changed binding", async () => {
        const manifest = syntheticEnvironmentManifest();
        const record = { registryVersion: 1 as const, environmentId: manifest.environmentId, environmentRoot: "D:/environment", stateRoot: "D:/state" };
        const environment = { directoryId: "environment-directory:1", root: record.environmentRoot, kind: "environment" };
        const state = { directoryId: "environment-directory:2", root: record.stateRoot, kind: "state" };
        let replaced = false, observations = 0;
        const host = createEnvironmentStorageHost(async (command, args) => {
            if (command === "shader-environment-registry-open") return { recordText: JSON.stringify(record), environment, state };
            if (command === "shader-environment-registry-scan") return { entries: [{ key: manifest.environmentId.slice(7), text: JSON.stringify(replaced ? { ...record, stateRoot: "D:/replaced" } : record) }], pending: [] };
            observations++;
            if (args?.directoryId === environment.directoryId) return { ...environment, metadataText: JSON.stringify(manifest), entries: [{ path: "environment.json", kind: "file", reparsePoint: false, linkCount: 1, size: 0, sha256: "0".repeat(64) }, ...manifest.members.map(m => ({ ...m, kind: "file", reparsePoint: false, linkCount: 1 }))] };
            return { ...state, metadataText: JSON.stringify({ stateVersion: 1, environmentId: manifest.environmentId }), entries: [{ path: "state.json", kind: "file", reparsePoint: false, linkCount: 1, size: null, sha256: null }, ...[...new Set(Object.values(ENVIRONMENT_STATE_ROLES))].map(path => ({ path, kind: "directory", reparsePoint: false, linkCount: 1, size: null, sha256: null }))] };
        });
        const proof = vi.fn(async () => {
            replaced = true;
            const executable = (role: "tool" | "runtime") => ({ path: record.environmentRoot + "/" + manifest.roles[role], sha256: manifest.members.find(m => m.path === manifest.roles[role])!.sha256 });
            return { environmentRoot: record.environmentRoot, stateRoot: record.stateRoot, environmentId: record.environmentId, tool: executable("tool"), runtime: executable("runtime"), ordinaryHandshake: "compatible" as const, previewHandshake: "compatible" as const, profiles: [1, 2] as const, runtimeObservation: "loaded" as const };
        });
        expect(await host.recover(record, proof, () => false)).toMatchObject({ status: "refused", diagnostic: { code: "registry-conflict" }, registrationMayHaveCommitted: false });
        expect(observations).toBe(3); expect(proof).toHaveBeenCalledOnce();
    });
});
