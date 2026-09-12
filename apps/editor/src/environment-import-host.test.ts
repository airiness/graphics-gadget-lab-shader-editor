// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readEnvironmentDirectoryHandle } from "@gglab/shader-toolchain-client";
import { environmentProducerFixtures } from "../../../tests/environment-producer.js";
import { graph } from "../tests/environment-probe-documents.js";
import { createEnvironmentActivationHost } from "./environment-activation-host.js";
import { PreviewCoordinator } from "./preview-coordinator.js";
import { WorkspaceStore, type WorkspaceAuthoringState } from "./workspace-store.js";
import { createWorkspaceSession } from "./workspace-session.js";
import { emitHlsl, parseShaderGraphDocument } from "@gglab/shader-graph-core";
import { createWorkspaceEnvironmentBinding } from "./use-environment-authoring.js";
import { createEnvironmentWorkflow } from "./environment-workflow.js";
import { createSession, provenanceFromImport } from "./document-session.js";
import { createDocumentSessionId } from "./workspace-session.js";
import { previewProgramDescriptorIdentity } from "./preview-program-contract.js";
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
        const exchange = (command: string, args?: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => { if (pending) { reject(new Error("Concurrent test bridge request")); return; } const op = args?.operation as { operation?: string; request?: Record<string, unknown> } | undefined; if (op?.operation === "build-preview" && op.request) requests.push(op.request); pending = { resolve, reject }; child.stdin.write(JSON.stringify({ command, args }) + "\n"); });
        // Unlike Tauri IPC, this line bridge has no response IDs. Runtime exit polling and
        // foreground registration can overlap; serialize transport, not production ownership.
        let transport = Promise.resolve();
        const invoke = (command: string, args?: Record<string, unknown>) => {
            const result = transport.then(() => exchange(command, args));
            transport = result.then(() => {}, () => {});
            return result;
        };
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
            let activationEvidence: unknown = null;
            if (process.env.GGLAB_ENVIRONMENT_ACTIVATION_QUALIFICATION === "1") {
                const workspace = new WorkspaceStore<WorkspaceAuthoringState>({ session: createWorkspaceSession(), profileDescriptor: null });
                const coordinator = new PreviewCoordinator(() => null, () => null, workspace);
                const activation = createEnvironmentActivationHost(invoke);
                const result = await activation.activate(coordinator, env, writable, [graph(1), graph(2)]);
                expect(result).toMatchObject({ ok: true, identity: { kind: "environment" } });
                expect(workspace.getSnapshot().session.activeEnvironment).toMatchObject({ environmentId: first.registration.closure.manifest.environmentId, environmentRoot: env.root, stateRoot: writable.root });
                expect(requests).toHaveLength(12);
                const selection = workspace.getSnapshot().session.activeEnvironment!;
                const authoringRuns = [];
                for (const backend of ["dx12", "vulkan"] as const) for (const version of [1, 2] as const) {
                    const owner = createWorkspaceEnvironmentBinding(invoke, selection, () => workspace.getSnapshot().session.activeEnvironment === selection, backend);
                    try {
                        await owner.open();
                        const sample = parseShaderGraphDocument(readFileSync(new URL("../../../packages/shader-graph-core/tests/fixtures/surface-texture-preview.shadergraph", import.meta.url), "utf8"));
                        if (!sample.ok || !sample.value) throw new Error(JSON.stringify(sample.diagnostics));
                        const documentOwner = createSession(createDocumentSessionId(`native-${backend}-${version}`), provenanceFromImport(), version === 2 ? sample.value : graph(version));
                        const document = documentOwner.history.present, descriptor = owner.resolveProfile(document);
                        owner.native.updateJudgment(descriptor.processContract.tool);
                        await owner.native.discover({ bundled: false }); await owner.native.handshake();
                        const input = { documentOwner, document, descriptor, descriptorCompatible: true, emission: emitHlsl(document, descriptor), configuredTarget: backend === "dx12" ? "gglab-dx12" : "gglab-vulkan13", previewProgramDescriptorIdentity };
                        const bound = new PreviewCoordinator(() => owner.manager, () => owner.preview, workspace, owner.current, d => owner.resolveProfile(d));
                        expect(await owner.preview.previewHandshake(input)).toMatchObject({ kind: "settled", eligibility: { status: "eligible" } });
                        const build = await bound.buildPreview(input);
                        if (!build.issued) throw new Error(`Workspace binding build refused: ${JSON.stringify(build)}`);
                        expect(await build.outcome).toMatchObject({ kind: "published" });
                        const candidate = owner.preview.launchCandidate(); if (candidate === null) throw new Error("Missing launch candidate");
                        expect(await owner.manager.launch(candidate)).toMatchObject({ launched: true });
                        const until = Date.now() + 30000;
                        while (owner.preview.acceptedObservation?.status !== "loaded" && Date.now() < until) {
                            await owner.preview.refreshObservation(); await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        expect(owner.preview.acceptedObservation?.status).toBe("loaded");
                        authoringRuns.push({ backend, profileVersion: version, graphId: document.graphId, generatedSourceIdentity: input.emission.sourceMap?.generatedSourceIdentity, sessionId: owner.preview.session.sessionId, observation: owner.preview.acceptedObservation });
                        if (backend === "vulkan" && version === 2) {
                            const workflow = createEnvironmentWorkflow(async (command, args) => command === "shader-environment-list-mutations" ? [] : invoke(command, args), () => { throw new Error("Registered reuse must not discover a producer"); }, {
                                coordinator: () => bound, capture: () => () => workspace.getSnapshot().session.activeEnvironment === selection, begin: () => () => {},
                            });
                            await workflow.useRegistered(snapshot.records[0]!.record);
                            expect(workflow.getSnapshot(), workflow.getSnapshot().message).toMatchObject({ busy: false, canRetry: false });
                            expect(workflow.getSnapshot().message).toBe("Environment selected. Build and Preview establish their own current readiness.");
                            expect(workspace.getSnapshot().session.activeEnvironment).not.toBe(selection);
                        }
                    } finally { await owner.close(); }
                }
                activationEvidence = { result, selection, previousRuntime: "loaded-vulkan-preview-joined-before-workflow-reverification", nativeAuthoringBinding: "qualified", registeredWorkflowReuse: "qualified", mutationJournalListing: "synthetic-empty", authoringRuns };
            }
            if (process.env.GGLAB_IMPORT_REPORT) writeFileSync(process.env.GGLAB_IMPORT_REPORT, JSON.stringify({
                producerRevision: baseline.producerRevision,
                editorBaseRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(),
                kind: "working-tree-import-qualification", first, retry, snapshot, phases, activationEvidence,
                nativePreviewRuns: requests.map(r => ({ targetProfile: r.targetProfile, profileVersion: r.profileVersion, sessionId: r.sessionId })),
                failedProof: failed, cancellation: cancelled, lostAcknowledgementRecovered: true,
            }, null, 2) + "\n");
        } finally {
            child.stdin.end();
            try { expect(await exited, diagnostics).toBe(0); } finally { reader.close(); }
        }
    }, 300000);
});
