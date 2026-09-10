// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readEnvironmentDirectoryHandle } from "@gglab/shader-toolchain-client";
import { environmentProducerFixtures } from "../../../tests/environment-producer.js";
import { graph } from "../tests/environment-probe-documents.js";
import { createEnvironmentImportHost } from "./environment-import-host.js";

describe("Environment import composition", () => {
    const environment = { directoryId: "environment-directory:1", root: "D:/environment", kind: "environment" as const };
    const state = { directoryId: "environment-directory:2", root: "D:/state", kind: "state" as const };
    it("never registers invalid observations or a pre-cancelled import", async () => {
        const calls: string[] = [];
        const host = createEnvironmentImportHost(async command => { calls.push(command); return {}; });
        expect((await host.importSelected(environment, state, [])).status).toBe("refused");
        expect(calls).toEqual(["shader-environment-observe-directory"]);
        calls.length = 0;
        expect(await host.importSelected(environment, state, [], () => true)).toMatchObject({ status: "refused", diagnostic: { code: "cancelled" }, registrationMayHaveCommitted: false });
        expect(calls).toEqual([]);
    });
    it.runIf(process.env.GGLAB_ENVIRONMENT_IMPORT_QUALIFICATION === "1")("registers actual final proof and reconciles lost acknowledgement and restart", async () => {
        environmentProducerFixtures();
        const baseline = JSON.parse(readFileSync(new URL("../../../tests/environment-producer-baseline.json", import.meta.url), "utf8")) as { producerRevision: string };
        expect(process.env.GGLAB_REGISTRATION_ROOT).toBeTruthy();
        const root = fileURLToPath(new URL("../../../", import.meta.url));
        const child = spawn("cargo", ["test", "--offline", "--manifest-path", "apps/editor/src-tauri/Cargo.toml", "--lib", "environment_execution::tests::real_environment_execution_bridge", "--", "--ignored", "--nocapture"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let diagnostics = "", pending: { resolve(value: unknown): void; reject(reason: unknown): void } | null = null;
        const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", code => { pending?.reject(new Error(diagnostics)); resolve(code); }); child.once("error", reject); });
        child.stderr.on("data", chunk => { diagnostics += String(chunk); });
        const reader = createInterface({ input: child.stdout });
        reader.on("line", line => { if (!line.startsWith("GGLAB_PROOF_REPLY:")) return; const reply = JSON.parse(line.slice("GGLAB_PROOF_REPLY:".length)) as { value?: unknown; error?: unknown }; const current = pending; pending = null; if (reply.error) current?.reject(reply.error); else current?.resolve(reply.value); });
        const requests: Record<string, unknown>[] = [];
        const invoke = (command: string, args?: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => { if (pending) { reject(new Error("Concurrent test bridge request")); return; } const op = args?.operation as { operation?: string; request?: Record<string, unknown> } | undefined; if (op?.operation === "build-preview" && op.request) requests.push(op.request); pending = { resolve, reject }; child.stdin.write(JSON.stringify({ command, args }) + "\n"); });
        let commits = 0;
        const lossyInvoke = async (command: string, args?: Record<string, unknown>) => {
            const result = await invoke(command, args);
            if (command === "shader-environment-commit-registration" && ++commits === 1) throw new Error("Injected lost commit acknowledgement");
            return result;
        };
        const host = createEnvironmentImportHost(lossyInvoke);
        try {
            const selections = await invoke("selections") as { environment: unknown; state: unknown };
            const env = readEnvironmentDirectoryHandle(selections.environment), writable = readEnvironmentDirectoryHandle(selections.state);
            const before = await host.snapshot(); expect(before.records).toHaveLength(0);
            const failed = await host.importSelected(env, writable, []);
            expect(failed.status).toBe("refused"); expect(commits).toBe(0); expect((await host.snapshot()).records).toHaveLength(0);
            const phases: string[] = [];
            const first = await host.importSelected(env, writable, [graph(1), graph(2)], () => false, e => phases.push(e.phase));
            expect(first, JSON.stringify(first)).toMatchObject({ status: "already-registered" });
            if (first.status === "refused") throw new Error(first.diagnostic.message);
            expect(first.registration.closure.manifest.producer).toMatchObject({ sourceRevision: baseline.producerRevision, sourceDirty: false });
            expect(phases).toEqual(["verify", "state", "proof", "register", "settled"]);
            expect(commits).toBe(1); expect(requests).toHaveLength(4);
            const restarted = createEnvironmentImportHost(invoke);
            const snapshot = await restarted.snapshot(); expect(snapshot.records).toHaveLength(1);
            expect(snapshot.records[0]).toMatchObject({ readiness: "unverified" });
            const retry = await restarted.importSelected(env, writable, [graph(1), graph(2)]);
            expect(retry, JSON.stringify(retry)).toMatchObject({ status: "already-registered" });
            expect(requests).toHaveLength(8); expect(await restarted.snapshot()).toEqual(snapshot);
            const cancelled = await restarted.importSelected(env, writable, [graph(1), graph(2)], () => true);
            expect(cancelled).toMatchObject({ status: "refused", diagnostic: { code: "cancelled" } });
            expect(await restarted.snapshot()).toEqual(snapshot);
            if (process.env.GGLAB_IMPORT_REPORT) writeFileSync(process.env.GGLAB_IMPORT_REPORT, JSON.stringify({
                producerRevision: baseline.producerRevision,
                editorBaseRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
                kind: "working-tree-import-qualification", first, retry, snapshot, phases,
                nativePreviewRuns: requests.map(r => ({ targetProfile: r.targetProfile, profileVersion: r.profileVersion, sessionId: r.sessionId })),
                failedProof: failed, cancellation: cancelled, lostAcknowledgementRecovered: true,
            }, null, 2) + "\n");
        } finally {
            child.stdin.end();
            try { expect(await exited, diagnostics).toBe(0); } finally { reader.close(); }
        }
    }, 300000);
});

