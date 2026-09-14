import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentRegistry, environmentCanonical, type EnvironmentRegistryRecord } from "@gglab/shader-toolchain-client";
import { NodeEnvironmentRegistryStorage } from "../src/environment-registry-storage.js";
import { dispatch } from "../src/index.js";
const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
    const root = mkdtempSync(join(tmpdir(), "gglab-registry-")); temporary.push(root);
    const registryRoot = join(root, "registry");
    const key = "1".repeat(64);
    const record: EnvironmentRegistryRecord = { registryVersion: 1, environmentId: "sha256:" + key, environmentRoot: join(root, "environment"), stateRoot: join(root, "state") };
    return { root, registryRoot, key, record, text: environmentCanonical(record) + "\n", storage: new NodeEnvironmentRegistryStorage(registryRoot) };
}
describe.runIf(process.platform === "win32")("Windows registry storage", () => {
    it("writes a complete record atomically and restores it as unverified", async () => {
        const f = setup();
        expect(await f.storage.scan()).toEqual({ entries: [], pending: [] });
        expect(JSON.parse(dispatch("environment-registry", [f.registryRoot]).sinkText).payload.records).toEqual([]);
        expect(readdirSync(f.root)).toEqual([]);
        expect(await f.storage.insert(f.key, f.text)).toEqual({ text: f.text, inserted: true });
        expect(readdirSync(f.registryRoot)).toEqual([f.key]);
        const restarted = new EnvironmentRegistry(new NodeEnvironmentRegistryStorage(f.registryRoot));
        expect((await restarted.snapshot()).records).toEqual([{ record: f.record, readiness: "unverified" }]);
        expect(await f.storage.insert(f.key, f.text)).toEqual({ text: f.text, inserted: false });
        expect(readFileSync(join(f.registryRoot, f.key, "registration.json"), "utf8")).toBe(f.text);
        const inspected = JSON.parse(dispatch("environment-registry", [f.registryRoot]).sinkText);
        expect(inspected.ok).toBe(true); expect(inspected.payload.records[0].readiness).toBe("unverified");
    }, 30000);
    it("preserves a committed record and reports abandoned stages without resuming them", async () => {
        const f = setup(); await f.storage.insert(f.key, f.text);
        const name = ".pending-00000000-0000-0000-0000-000000000000";
        mkdirSync(join(f.registryRoot, name)); writeFileSync(join(f.registryRoot, name, "registration.json"), f.text);
        const snapshot = await new EnvironmentRegistry(new NodeEnvironmentRegistryStorage(f.registryRoot)).snapshot();
        expect(snapshot.records).toHaveLength(1); expect(snapshot.pending).toEqual([name]);
        expect(readFileSync(join(f.registryRoot, name, "registration.json"), "utf8")).toBe(f.text);
    }, 30000);
    it("never replaces a corrupt destination and isolates it from valid records", async () => {
        const f = setup(); await f.storage.insert(f.key, f.text);
        const key = "2".repeat(64), destination = join(f.registryRoot, key); mkdirSync(destination);
        writeFileSync(join(destination, "unexpected"), "preserve me");
        const text = environmentCanonical({ ...f.record, environmentId: "sha256:" + key });
        await expect(f.storage.insert(key, text)).rejects.toThrow("Unexpected registry entry contents");
        const snapshot = await new EnvironmentRegistry(f.storage).snapshot();
        expect(snapshot.records).toHaveLength(1); expect(snapshot.diagnostics).toHaveLength(1);
        expect(readFileSync(join(destination, "unexpected"), "utf8")).toBe("preserve me");
        expect(dispatch("environment-registry", [f.registryRoot]).code).toBe(1);
    }, 30000);
    it("rejects linked records and roots overlapping Environment/state", async () => {
        const f = setup(); await f.storage.insert(f.key, f.text);
        linkSync(join(f.registryRoot, f.key, "registration.json"), join(f.root, "alias.json"));
        expect((await new EnvironmentRegistry(f.storage).snapshot()).diagnostics[0]?.code).toBe("hard-link");
        const overlap = environmentCanonical({ ...f.record, environmentRoot: f.root });
        await expect(f.storage.insert(f.key, overlap)).rejects.toThrow("disjoint");
        symlinkSync(f.registryRoot, join(f.root, "linked-registry"), "junction");
        expect(() => new NodeEnvironmentRegistryStorage(join(f.root, "linked-registry"))).toThrow("Reparse point");
    }, 30000);
    it("two processes converge on one immutable winner without overwriting", async () => {
        const f = setup();
        const require = createRequire(import.meta.url), tsx = pathToFileURL(require.resolve("tsx")).href;
        const moduleUrl = new URL("../src/environment-registry-storage.ts", import.meta.url).href;
        const source = `import { NodeEnvironmentRegistryStorage } from ${JSON.stringify(moduleUrl)};
            const [root,key,text] = process.argv.slice(1);
            const storage = new NodeEnvironmentRegistryStorage(root);
            process.stdout.write(JSON.stringify(await storage.insert(key,text)));`;
        const run = promisify(execFile);
        const invoke = () => run(process.execPath, ["--import", tsx, "--input-type=module", "-e", source, f.registryRoot, f.key, f.text], { windowsHide: true, timeout: 45000 });
        const results = await Promise.all([invoke(), invoke()]);
        expect(results.map(r => JSON.parse(r.stdout).inserted).sort()).toEqual([false, true]);
        const snapshot = await new EnvironmentRegistry(f.storage).snapshot();
        expect(snapshot.records).toHaveLength(1); expect(snapshot.diagnostics).toEqual([]);
        expect(snapshot.records[0]?.record).toEqual(f.record);
    }, 60000);
});
