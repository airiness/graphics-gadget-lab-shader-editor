// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@gglab/shader-graph-core";
import { readEnvironmentDirectoryHandle, readPreviewBuildOutput, readPreviewObservation } from "@gglab/shader-toolchain-client";
import { environmentProducerFixtures } from "../../../tests/environment-producer.js";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";
import { graph } from "../tests/environment-probe-documents.js";
import { createEnvironmentAuthoringHost } from "./environment-authoring-host.js";
import { createEnvironmentProofHost } from "./environment-proof-host.js";

describe("Environment final native proof", () => {
    it("refuses concurrent proof and never opens execution for invalid storage facts", async () => {
        const host = createEnvironmentProofHost(async () => ({ malformed: true }));
        const environment = { directoryId: "environment-directory:1", root: "D:/environment", kind: "environment" as const }, state = { ...environment, kind: "state" as const };
        const first = host.prove(environment, state, [graph(1), graph(2)]);
        await expect(host.prove(environment, state, [graph(1), graph(2)])).rejects.toThrow(/Previous/);
        await expect(first).rejects.toThrow();
    });
    it.runIf(process.env.GGLAB_ENVIRONMENT_NATIVE_PROOF === "1")("qualifies both backends and profiles through actual Editor Rust services", async () => {
        environmentProducerFixtures(); // Exact clean producer pin remains mandatory for this opt-in gate.
        const baseline = JSON.parse(readFileSync(new URL("../../../tests/environment-producer-baseline.json", import.meta.url), "utf8")) as { producerRevision: string };
        expect(process.platform).toBe("win32");
        expect(process.env.GGLAB_PROOF_ENVIRONMENT).toBeTruthy(); expect(process.env.GGLAB_PROOF_STATE).toBeTruthy();
        const root = fileURLToPath(new URL("../../../", import.meta.url));
        const child = spawn("cargo", ["test", "--offline", "--manifest-path", "apps/editor/src-tauri/Cargo.toml", "--lib", "environment_execution::tests::real_environment_execution_bridge", "--", "--ignored", "--nocapture"], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let diagnostics = "", pending: { resolve(value: unknown): void; reject(reason: unknown): void } | null = null;
        const exited = new Promise<number | null>((resolve, reject) => { child.once("exit", code => { pending?.reject(new Error(diagnostics)); resolve(code); }); child.once("error", reject); });
        child.stderr.on("data", chunk => { diagnostics += String(chunk); });
        const reader = createInterface({ input: child.stdout });
        reader.on("line", line => { if (!line.startsWith("GGLAB_PROOF_REPLY:")) return; const reply = JSON.parse(line.slice("GGLAB_PROOF_REPLY:".length)) as { value?: unknown; error?: unknown }; const current = pending; pending = null; if (reply.error) current?.reject(reply.error); else current?.resolve(reply.value); });
        const requests: Record<string, unknown>[] = [];
        const invoke = (command: string, args?: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => { if (pending) { reject(new Error("Concurrent test bridge request")); return; } const op = args?.operation as { operation?: string; request?: Record<string, unknown> } | undefined; if (op?.operation === "build-preview" && op.request) requests.push(op.request); pending = { resolve, reject }; child.stdin.write(JSON.stringify({ command, args }) + "\n"); });
        const host = createEnvironmentProofHost(invoke);
        try {
            const selection = await invoke("selections") as { environment: unknown; state: unknown };
            const result = await host.prove(readEnvironmentDirectoryHandle(selection.environment), readEnvironmentDirectoryHandle(selection.state), [graph(1), graph(2)]);
            expect(result.runs).toHaveLength(4);
            const templates = requests.slice();
            const regressions = [];
            for (const template of templates) {
                const backend = template.targetProfile === "gglab-dx12" ? "dx12" : "vulkan";
                const authoring = createEnvironmentAuthoringHost(invoke);
                await authoring.open(readEnvironmentDirectoryHandle(selection.environment), readEnvironmentDirectoryHandle(selection.state), { ...result.proof, activationSequence: 1 }, backend);
                try {
                    const candidate = (await authoring.boundary.discover({ bundled: false })).candidate!;
                    expect(authoring.resolveProfile(graph(template.profileVersion as 1 | 2)).profileVersion).toBe(template.profileVersion);
                    expect((await authoring.boundary.handshake(candidate)).kind).toBe("spawned");
                    expect((await authoring.boundary.previewHandshake(candidate)).kind).toBe("spawned");
                    const sessionId = crypto.randomUUID().replaceAll("-", "");
                    const sessionRoot = `${process.env.GGLAB_PROOF_STATE}/ShaderArtifacts/shader-preview-sessions/${sessionId}`;
                    const request = (attemptSequence: number, bytes: number[]) => ({ ...template, sessionId, attemptSequence, generatedSourceBytes: Uint8Array.from(bytes), generatedSourceIdentity: sha256Hex(Uint8Array.from(bytes)) }) as unknown as import("@gglab/shader-toolchain-client").NativePreviewBuildRequest;
                    const build = async (attemptSequence: number, bytes: number[]) => {
                        const attempt = await authoring.boundary.buildPreview(candidate, request(attemptSequence, bytes));
                        const settled = await attempt.result;
                        if (settled.kind !== "spawned") throw new Error("Authoring build did not spawn");
                        return readPreviewBuildOutput(settled.output);
                    };
                    const bytes = template.generatedSourceBytes as number[];
                    const first = await build(1, bytes); expect(first.kind === "read" && first.document.success).toBe(true);
                    if (first.kind !== "read" || !first.document.success) throw new Error("Initial publication failed");
                    const firstPublication = first.document.publicationId;
                    const waitLoaded = async (attempt: number, publication: string) => {
                        const until = Date.now() + 30000;
                        while (Date.now() < until) {
                            const raw = await authoring.observation.readPreviewObservation(candidate, sessionId);
                            if (raw.kind === "read") {
                                const o = readPreviewObservation(raw.bytes);
                                if (o.status === "read" && o.observation.status === "loaded" && o.observation.observedAttemptSequence === attempt && o.observation.loadedPublicationRef === publication && o.observation.observedPublicationRef === publication) return;
                            }
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        throw new Error("Regression Loaded observation timed out");
                    };
                    const launch = await authoring.runtime.launchAttachedPreview(candidate, sessionId); expect(launch.kind).toBe("launched");
                    if (launch.kind !== "launched") throw new Error("Authoring Runtime did not launch");
                    await waitLoaded(1, firstPublication);
                    const pointer = readFileSync(`${sessionRoot}/active.ggsh.preview-active`);
                    const bad = await build(2, [...new TextEncoder().encode("invalid hlsl probe\n")]);
                    expect(bad.kind === "read" && !bad.document.success && bad.document.exitCode === 4).toBe(true);
                    expect(readFileSync(`${sessionRoot}/active.ggsh.preview-active`)).toEqual(pointer);
                    await waitLoaded(1, firstPublication);
                    const recovered = await build(3, bytes);
                    expect(recovered.kind === "read" && recovered.document.success).toBe(true);
                    if (recovered.kind !== "read" || !recovered.document.success) throw new Error("Recovery publication failed");
                    await waitLoaded(3, recovered.document.publicationId);
                    await authoring.runtime.stopAttachedPreview({ sequence: launch.runtimeId.sequence });
                    expect((await launch.exited).kind).toBe("stopped");
                    const relaunched = await authoring.runtime.launchAttachedPreview(candidate, sessionId);
                    if (relaunched.kind !== "launched") throw new Error("Same-session relaunch failed");
                    // A new publication requires the new process to write an observation;
                    // the previous process's retained record cannot satisfy this check.
                    const afterRelaunch = await build(4, bytes);
                    if (afterRelaunch.kind !== "read" || !afterRelaunch.document.success) throw new Error("Relaunch publication failed");
                    await waitLoaded(4, afterRelaunch.document.publicationId);
                    await authoring.runtime.stopAttachedPreview(relaunched.runtimeId);
                    expect((await relaunched.exited).kind).toBe("stopped");
                    const cancelAttempt = await authoring.boundary.buildPreview(candidate, request(5, bytes));
                    await authoring.boundary.cancel({ sequence: cancelAttempt.buildId.sequence });
                    await cancelAttempt.result;
                    const afterCancel = await build(6, bytes);
                    expect(afterCancel.kind === "read" && afterCancel.document.success).toBe(true);
                    regressions.push({ authoringBoundary: true, sameSessionRelaunch: true, cancelThenBuild: true, backend, profileVersion: template.profileVersion, sessionId, failedAttemptExitCode: 4, retainedPublication: firstPublication, recoveredPublication: recovered.document.publicationId });
                } finally { await authoring.close(); }
            }
            const final = await createEnvironmentStorageHost(invoke).verify(readEnvironmentDirectoryHandle(selection.environment));
            expect(final.manifest.environmentId).toBe(result.proof.environmentId);
            expect(final.manifest.producer.sourceRevision).toBe(baseline.producerRevision);
            const provenance = { producerRevision: baseline.producerRevision, manifestProducer: final.manifest.producer,
                editorBaseRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
                editorTrackedChanges: execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
                qualificationKind: "editor-working-tree-final-location-proof" };

            if (process.env.GGLAB_PROOF_REPORT) writeFileSync(process.env.GGLAB_PROOF_REPORT, JSON.stringify({ provenance, ...result, regressions }, null, 2) + "\n");
        } finally {
            try { await host.close(); } finally { child.stdin.end(); }
            try { expect(await exited, diagnostics).toBe(0); } finally { reader.close(); }
        }
    }, 300000);
});
