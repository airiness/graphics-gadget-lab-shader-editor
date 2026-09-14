/** Node host for reviewable durable registration. No CLI import command exposes mutation. */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { environmentDiagnostic, environmentRegistryKey, environmentRequire, readEnvironmentRegistryRecord, validateEnvironmentStateRoots, type EnvironmentRegistryEntry, type EnvironmentRegistryStorage } from "@gglab/shader-toolchain-client";
import { assertEnvironmentHostPath } from "./environment-host.js";

/** One nonempty directory per EnvironmentId; private stage -> no-replace Windows rename is the commit point. */
export class NodeEnvironmentRegistryStorage implements EnvironmentRegistryStorage {
    private readonly root: string;
    constructor(root: string) { this.root = resolve(root); assertEnvironmentHostPath(root); }
    private read(key: string): string {
        environmentRequire(/^[0-9a-f]{64}$/.test(key), "registry-conflict", "Invalid registry key", key);
        const directory = join(this.root, key), path = join(directory, "registration.json");
        assertEnvironmentHostPath(path);
        environmentRequire(lstatSync(directory).isDirectory(), "registry-conflict", "Registry entry is not a directory", key);
        const names = readdirSync(directory);
        environmentRequire(names.length === 1 && names[0] === "registration.json", "registry-conflict", "Unexpected registry entry contents", key);
        const fd = openSync(path, "r");
        try {
            const stat = fstatSync(fd);
            environmentRequire(stat.isFile() && stat.nlink === 1, "hard-link", "Registry record must be an independent regular file", key);
            environmentRequire(stat.size <= 65536, "limit-exceeded", "Registry record exceeds 64 KiB", key);
            const bytes = Buffer.alloc(65537); let count = 0;
            while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
            environmentRequire(count <= 65536, "limit-exceeded", "Registry record exceeds 64 KiB", key);
            const content = bytes.subarray(0, count), text = content.toString("utf8");
            environmentRequire(Buffer.from(text, "utf8").equals(content), "invalid-json", "Malformed registry UTF-8", key);
            return text;
        } finally { closeSync(fd); }
    }
    async scan() { return this.scanSync(); }
    scanSync() {
        assertEnvironmentHostPath(this.root);
        if (!existsSync(this.root)) return { entries: [], pending: [] };
        const names = readdirSync(this.root).sort();
        environmentRequire(names.length <= 1024, "limit-exceeded", "Registry exceeds 1024 entries");
        const entries: EnvironmentRegistryEntry[] = [], pending: string[] = [];
        for (const key of names) {
            try {
                const path = join(this.root, key); assertEnvironmentHostPath(path);
                if (/^\.pending-[0-9a-f-]{36}$/.test(key)) {
                    environmentRequire(lstatSync(path).isDirectory(), "registry-conflict", "Pending registry entry is not a directory", key);
                    pending.push(key); continue;
                }
                entries.push({ key, text: this.read(key) });
            } catch (error) { entries.push({ key, diagnostic: { ...environmentDiagnostic(error), dataPath: key } }); }
        }
        return { entries, pending };
    }
    async insert(key: string, text: string) {
        environmentRequire(Buffer.byteLength(text, "utf8") <= 65536, "limit-exceeded", "Registry record exceeds 64 KiB", key);
        const record = readEnvironmentRegistryRecord(text);
        environmentRequire(environmentRegistryKey(record.environmentId) === key, "registry-conflict", "Record/key mismatch", key);
        validateEnvironmentStateRoots(this.root, record.environmentRoot);
        validateEnvironmentStateRoots(this.root, record.stateRoot);
        assertEnvironmentHostPath(this.root);
        mkdirSync(this.root, { recursive: true });
        assertEnvironmentHostPath(this.root);
        environmentRequire(readdirSync(this.root).length < 1024, "limit-exceeded", "Registry exceeds 1024 entries");
        const destination = join(this.root, key);
        if (existsSync(destination)) return { text: this.read(key), inserted: false };
        const stage = join(this.root, ".pending-" + randomUUID());
        mkdirSync(stage);
        const fd = openSync(join(stage, "registration.json"), "wx");
        try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
        // Failed stages are retained for diagnosis, never resumed or automatically deleted.
        try { renameSync(stage, destination); }
        catch (error) {
            if (existsSync(destination)) return { text: this.read(key), inserted: false };
            throw error;
        }
        return { text: this.read(key), inserted: true };
    }
}
