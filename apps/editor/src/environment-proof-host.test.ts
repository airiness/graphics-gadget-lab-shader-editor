// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseShaderGraphDocument, sha256Hex } from "@gglab/shader-graph-core";
import { readEnvironmentDirectoryHandle, readEnvironmentNativeOutput, readPreviewBuildOutput, readEnvironmentBytes, readPreviewObservation } from "@gglab/shader-toolchain-client";
import { environmentProducerFixtures } from "../../../tests/environment-producer.js";
import { createEnvironmentStorageHost } from "./environment-storage-host.js";
import { createEnvironmentProofHost } from "./environment-proof-host.js";

function baseDocument(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.emit",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [
            { id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" },
            { id: "p.metal", name: "Metal Factor", class: "ScalarParameter", valueType: "float" },
        ],
        nodes: [
            { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
            { id: "n.sf", type: "ScalarParameter", version: 1, properties: { parameterId: "p.metal" } },
            { id: "n.c", type: "Float3", version: 1, properties: { value: [1, 1, 1] } },
            { id: "n.r", type: "Float", version: 1, properties: { value: 0.5 } },
            { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
            { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
            { id: "c2", from: { nodeId: "n.c", portId: "value" }, to: { nodeId: "n.out", portId: "BaseColor" } },
            { id: "c3", from: { nodeId: "n.sf", portId: "value" }, to: { nodeId: "n.out", portId: "Metallic" } },
            { id: "c4", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
            { id: "c5", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
        ],
        editorMetadata: { nodes: {} },
    };
}

function textureDocument(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        graphId: "graph.texture2d",
        profile: "gglab.surface",
        profileVersion: 2,
        parameters: [
            { id: "p.tex", name: "Texture", class: "Texture2DParameter", valueType: "Texture2D" },
            { id: "p.rough", name: "Roughness Factor", class: "ScalarParameter", valueType: "float" },
        ],
        nodes: [
            { id: "n.tp", type: "Texture2DParameter", version: 1, properties: { parameterId: "p.tex" } },
            { id: "n.uv", type: "UV0", version: 1, properties: {} },
            { id: "n.smp", type: "SampleTexture2D", version: 1, properties: {} },
            { id: "n.e", type: "Float3", version: 1, properties: { value: [0, 0, 0] } },
            { id: "n.r", type: "ScalarParameter", version: 1, properties: { parameterId: "p.rough" } },
            { id: "n.o", type: "Float", version: 1, properties: { value: 1 } },
            { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [
            { id: "c1", from: { nodeId: "n.tp", portId: "value" }, to: { nodeId: "n.smp", portId: "texture" } },
            { id: "c2", from: { nodeId: "n.uv", portId: "value" }, to: { nodeId: "n.smp", portId: "uv" } },
            { id: "c3", from: { nodeId: "n.smp", portId: "RGB" }, to: { nodeId: "n.out", portId: "BaseColor" } },
            { id: "c4", from: { nodeId: "n.smp", portId: "B" }, to: { nodeId: "n.out", portId: "Metallic" } },
            { id: "c5", from: { nodeId: "n.e", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } },
            { id: "c6", from: { nodeId: "n.r", portId: "value" }, to: { nodeId: "n.out", portId: "Roughness" } },
            { id: "c7", from: { nodeId: "n.o", portId: "value" }, to: { nodeId: "n.out", portId: "Opacity" } },
        ],
        editorMetadata: { nodes: {} },
    };
}

function graph(profileVersion: number) {
    const parsed = parseShaderGraphDocument(JSON.stringify(profileVersion === 1 ? baseDocument() : textureDocument()));
    if (!parsed.ok || !parsed.value) throw new Error(JSON.stringify(parsed.diagnostics)); return parsed.value;
}

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
            const admission = await invoke("shader-environment-open-execution", { environmentDirectoryId: readEnvironmentDirectoryHandle(selection.environment).directoryId, stateDirectoryId: readEnvironmentDirectoryHandle(selection.state).directoryId }) as { executionId: string };
            const execute = (operation: Record<string, unknown>) => invoke("shader-environment-execute", { executionId: admission.executionId, operation });
            const regressions = [];
            try {
                for (const template of templates) {
                    const sessionId = crypto.randomUUID().replaceAll("-", "");
                    const sessionRoot = `${process.env.GGLAB_PROOF_STATE}/ShaderArtifacts/shader-preview-sessions/${sessionId}`;
                    const build = async (attemptSequence: number, bytes: number[]) => readPreviewBuildOutput(readEnvironmentNativeOutput(await execute({ operation: "build-preview", request: { ...template, sessionId, attemptSequence, generatedSourceBytes: bytes, generatedSourceIdentity: sha256Hex(Uint8Array.from(bytes)) } })));
                    const bytes = template.generatedSourceBytes as number[];
                    const first = await build(1, bytes); expect(first.kind === "read" && first.document.success).toBe(true);
                    if (first.kind !== "read" || !first.document.success) throw new Error("Initial publication failed");
                    const firstPublication = first.document.publicationId;
                    const waitLoaded = async (attempt: number, publication: string) => {
                        const until = Date.now() + 30000;
                        while (Date.now() < until) {
                            const raw = await execute({ operation: "observe", sessionId }) as { kind: string; bytes?: unknown };
                            if (raw.kind === "read") {
                                const o = readPreviewObservation(readEnvironmentBytes(raw.bytes));
                                if (o.status === "read" && o.observation.status === "loaded" && o.observation.observedAttemptSequence === attempt && o.observation.loadedPublicationRef === publication && o.observation.observedPublicationRef === publication) return;
                            }
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        throw new Error("Regression Loaded observation timed out");
                    };
                    const backend = template.targetProfile === "gglab-dx12" ? "dx12" : "vulkan";
                    const launch = await execute({ operation: "launch", sessionId, backend }) as { kind: string }; expect(launch.kind).toBe("launched");
                    try {
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
                        regressions.push({ backend, profileVersion: template.profileVersion, sessionId, failedAttemptExitCode: 4, retainedPublication: firstPublication, recoveredPublication: recovered.document.publicationId });
                    } finally { await execute({ operation: "stop" }); }
                }
            } finally { await invoke("shader-environment-close-execution", { executionId: admission.executionId }); }
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
