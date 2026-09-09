// @vitest-environment node
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readEnvironmentRepositoryHandle, readEnvironmentDiscoverySettlement } from "@gglab/shader-toolchain-client";
import { environmentProducerFixtures } from "../../../tests/environment-producer.js";
import { createEnvironmentMutationHost } from "./environment-mutation-host.js";

describe("Environment mutation adapter", () => {
    it("rejects malformed operation lists and cancellation results", async () => {
        const host = createEnvironmentMutationHost(async () => ["not-an-id"]);
        await expect(host.list()).rejects.toThrow();
        await expect(host.cancel("1".repeat(32))).rejects.toThrow(/cancellation/);
    });
    it.runIf(process.env.GGLAB_ENVIRONMENT_MUTATION_QUALIFICATION === "1")("publishes and initializes state through actual Editor services and reconciles duplicate requests", async () => {
        environmentProducerFixtures(); expect(process.platform).toBe("win32"); expect(process.env.GGLAB_MUTATION_ROOT).toBeTruthy();
        const root = fileURLToPath(new URL("../../../", import.meta.url));
        const child = spawn("cargo", ["test", "--offline", "--manifest-path", "apps/editor/src-tauri/Cargo.toml", "--lib", "real_mutation_bridge", "--", "--ignored", "--nocapture"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let diagnostic = "", pending: { resolve(value: unknown): void; reject(reason: unknown): void } | null = null;
        child.stderr.on("data", bytes => { diagnostic += String(bytes); });
        const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", code => { pending?.reject(new Error(diagnostic)); resolve(code); }); });
        const lines = createInterface({ input: child.stdout });
        lines.on("line", line => { if (!line.startsWith("GGLAB_MUTATION_REPLY:")) return; const r = JSON.parse(line.slice("GGLAB_MUTATION_REPLY:".length)) as { error?: unknown; value?: unknown }; const p = pending; pending = null; if (r.error) p?.reject(r.error); else p?.resolve(r.value); });
        const invoke = (command: string, args?: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => { if (pending) { reject(new Error("Concurrent bridge request")); return; } pending = { resolve, reject }; child.stdin.write(JSON.stringify({ command, args }) + "\n"); });
        try {
            const repository = readEnvironmentRepositoryHandle(await invoke("repository"));
            const raw = await invoke("discover") as { discoveryId: string };
            const discovered = readEnvironmentDiscoverySettlement(repository, raw.discoveryId, raw);
            expect(discovered.status).toBe("discovered"); if (discovered.status !== "discovered") throw new Error(discovered.diagnostic.message);
            // Qualification selects a named configuration explicitly; production never selects the first result.
            const configuration = process.env.GGLAB_MUTATION_CONFIGURATION ?? "Debug";
            const candidates = discovered.candidates.filter(c => c.deployment.endsWith("/" + configuration)); expect(candidates).toHaveLength(1);
            const host = createEnvironmentMutationHost(invoke), publication = await host.preparePublish(repository, candidates[0]!);
            const published = await host.settle(publication, repository);
            expect(published.status, JSON.stringify(published)).toBe("integrity-verified");
            const duplicate = await host.settle(publication, repository); expect(duplicate.status).toBe("integrity-verified");
            if (duplicate.status === "integrity-verified") expect(duplicate.recovered).toBe(true);
            const selected = await host.inspect(publication.operationId); expect(selected.target).not.toBeNull();
            const stateIntent = await host.prepareState(repository, selected.target!);
            // The producer really finalizes state; only the transport reply is deliberately discarded.
            const lostReplyHost = createEnvironmentMutationHost(async (command, args) => {
                const value = await invoke(command, args);
                if (command === "shader-environment-run-mutation") throw new Error("Injected IPC loss after native settlement");
                return value;
            });
            const initialized = await lostReplyHost.settle(stateIntent, repository);
            expect(initialized.status, JSON.stringify(initialized)).toBe("integrity-verified");
            if (initialized.status === "integrity-verified") expect(initialized.recovered).toBe(true);
            const reused = await host.settle(stateIntent, repository); expect(reused.status).toBe("integrity-verified");
            const recovered = await createEnvironmentMutationHost(invoke).settle(stateIntent, null); expect(recovered.status).toBe("integrity-verified");
            const ids = await host.list(); expect(ids).toContain(publication.operationId); expect(ids).toContain(stateIntent.operationId);
            if (process.env.GGLAB_MUTATION_REPORT) writeFileSync(process.env.GGLAB_MUTATION_REPORT, JSON.stringify({ editorBaseRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(), kind: "working-tree-producer-adapter-qualification", configuration, publisherSha256: repository.publisherSha256, publication, published, stateIntent, initialized, duplicate: duplicate.status, reused: reused.status, recovered: recovered.status }, null, 2) + "\n");
        } finally { child.stdin.end(); try { expect(await exited, diagnostic).toBe(0); } finally { lines.close(); } }
    }, 1200000);
});
