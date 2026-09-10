// @vitest-environment node
import { describe, expect, it } from "vitest";
import { sha256Hex } from "@gglab/shader-graph-core";
import { ENVIRONMENT_STATE_ROLES, environmentIdentity, utf8Encode, type NativePreviewBuildRequest } from "@gglab/shader-toolchain-client";
import { syntheticEnvironmentManifest } from "../../../tests/environment-synthetic.js";
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";
import { graph } from "../tests/environment-probe-documents.js";
import { createEnvironmentAuthoringHost } from "./environment-authoring-host.js";

function fixture() {
    const descriptors = [canonicalV1Fixture, canonicalV2Fixture].map(d => JSON.stringify(d));
    const hash = (text: string) => sha256Hex(utf8Encode(text));
    const base = syntheticEnvironmentManifest();
    const members = base.members.map(m => {
        const i = [base.roles.surfaceProfile1, base.roles.surfaceProfile2].findIndex(path => path === m.path);
        return i < 0 ? m : { ...m, size: utf8Encode(descriptors[i]!).length, sha256: hash(descriptors[i]!) };
    });
    const manifest = { ...base, members, environmentId: environmentIdentity({ ...base, members }, hash) };
    const environment = { directoryId: "environment-directory:1", root: "D:/environment", kind: "environment" as const };
    const state = { directoryId: "environment-directory:2", root: "D:/state", kind: "state" as const };
    const executable = (role: "tool" | "runtime") => ({ path: environment.root + "/" + manifest.roles[role], sha256: manifest.members.find(m => m.path === manifest.roles[role])!.sha256 });
    const selection = { environmentId: manifest.environmentId, environmentRoot: environment.root, stateRoot: state.root, activationSequence: 1, tool: executable("tool"), runtime: executable("runtime") };
    const candidate = { rule: "explicit-config" as const, toolPath: selection.tool.path, observationIdentity: selection.tool.sha256, resolvedAt: 1 };
    const admission = { ...selection, executionId: "environment-execution:1", candidate, runtimePath: selection.runtime.path, runtimeSha256: selection.runtime.sha256, descriptors, previewDescriptorSha256: manifest.members.find(m => m.path === manifest.roles.previewProgram)!.sha256 };
    const { activationSequence: _sequence, tool: _tool, runtime: _runtime, ...wireAdmission } = admission;
    void _sequence; void _tool; void _runtime;
    const calls: string[] = [];
    let settle = false, canceled = false, stopped = false, closeFailures = 0;
    let malformed = false;
    const output = { kind: "spawned", output: { stdout: [65], stderr: [], exitCode: 0, timedOut: false, canceled: false } };
    const invoke = async (command: string, args?: Record<string, unknown>) => {
        calls.push(command);
        if (command === "shader-environment-observe-directory") {
            if (args?.directoryId === environment.directoryId) return { ...environment, metadataText: JSON.stringify(manifest), entries: [{ path: "environment.json", kind: "file", reparsePoint: false, linkCount: 1, size: 0, sha256: "0".repeat(64) }, ...members.map(m => ({ ...m, kind: "file", reparsePoint: false, linkCount: 1 }))] };
            return { ...state, metadataText: JSON.stringify({ stateVersion: 1, environmentId: manifest.environmentId }), entries: [{ path: "state.json", kind: "file", reparsePoint: false, linkCount: 1, size: null, sha256: null }, ...[...new Set(Object.values(ENVIRONMENT_STATE_ROLES))].map(path => ({ path, kind: "directory", reparsePoint: false, linkCount: 1, size: null, sha256: null }))] };
        }
        if (command === "shader-environment-open-execution") return wireAdmission;
        if (command === "shader-environment-cancel-execution") { canceled = true; stopped = true; return null; }
        if (command === "shader-environment-close-execution") { if (closeFailures-- > 0) throw { code: "runtime-unavailable", message: "Join unproven", dataPath: "$" }; return null; }
        const op = args?.operation as Record<string, unknown>; calls.push(String(op.operation));
        switch (op.operation) {
            case "handshake": case "preview-handshake": return malformed ? { ...output, output: { ...output.output, stdout: [256] } } : output;
            case "start-preview": case "start-compile": return { sequence: 7 };
            case "build-result": return settle || canceled ? { ...output, output: { ...output.output, canceled } } : null;
            case "cancel-build": canceled = true; return { buildId: op.buildId, canceled: true, alreadySettled: false };
            case "launch": stopped = false; return { kind: "launched", runtimeId: { sequence: 8 }, runtimeIdentity: selection.runtime.sha256 };
            case "runtime-exit": return stopped ? { runtimeId: { sequence: 8 }, kind: "stopped", exitCode: 0 } : null;
            case "stop-runtime": stopped = true; return { runtimeId: op.runtimeId, stopRequested: true, alreadySettled: false };
            default: throw new Error("Unexpected request");
        }
    };
    const host = createEnvironmentAuthoringHost(invoke);
    const request: NativePreviewBuildRequest = { sessionId: "a".repeat(32), targetProfile: "gglab-dx12", profileId: "gglab.surface", profileVersion: 1, previewInputContractId: "input", previewProgramDescriptorIdentity: "a".repeat(64), generatedSourceIdentity: "b".repeat(64), generatedSourceBytes: new Uint8Array([65]), attemptSequence: 1 };
    return { host, environment, state, selection, candidate, request, calls, admission: wireAdmission, finish: () => { settle = true; }, malformed: () => { malformed = true; }, failClose: () => { closeFailures = 1; } };
}

describe("Environment authoring lifecycle (synthetic IPC, not native proof)", () => {
    it("resolves the requested profile without upgrades or mutable shared descriptors", async () => {
        const f = fixture(); await f.host.open(f.environment, f.state, f.selection, "dx12");
        expect(f.host.resolveProfile(graph(1)).profileVersion).toBe(1);
        expect(f.host.resolveProfile(graph(2)).profileVersion).toBe(2);
        const p = f.host.resolveProfile(graph(1)); (p as { profileVersion: number }).profileVersion = 2;
        expect(f.host.resolveProfile(graph(1)).profileVersion).toBe(1);
        expect(() => f.host.resolveProfile({ ...graph(1), profileVersion: 3 })).toThrow(/requested profile/);
        await f.host.close();
    });
    it("rejects crossed bindings, candidates and backend intents", async () => {
        const f = fixture(); await expect(f.host.open(f.environment, f.state, { ...f.selection, stateRoot: "D:/other" }, "dx12")).rejects.toThrow(/selection changed/);
        expect(f.calls).not.toContain("shader-environment-open-execution");
        const g = fixture(); await g.host.open(g.environment, g.state, g.selection, "vulkan");
        await expect(g.host.boundary.handshake({ ...g.candidate, toolPath: "D:/other.exe" })).rejects.toThrow(/another authoring host/);
        await expect(g.host.boundary.buildPreview(g.candidate, g.request)).rejects.toThrow(/backend/);
        expect(g.calls).not.toContain("start-preview"); await g.host.close();
    });
    it("cancels by native sequence, settles bytes and keeps the host usable", async () => {
        const f = fixture(); await f.host.open(f.environment, f.state, f.selection, "dx12");
        const build = await f.host.boundary.buildPreview(f.candidate, f.request);
        expect(build.buildId).toEqual({ sequence: 7 });
        await f.host.boundary.cancel({ sequence: 7 });
        expect(await build.result).toMatchObject({ kind: "spawned", output: { stdout: new Uint8Array([65]), canceled: true } });
        expect(await f.host.boundary.handshake(f.candidate)).toMatchObject({ kind: "spawned" });
        await f.host.close();
    });
    it("joins active work before closing and retries failed cleanup without admitting work", async () => {
        const f = fixture(); await f.host.open(f.environment, f.state, f.selection, "dx12");
        const build = await f.host.boundary.buildPreview(f.candidate, f.request);
        const runtime = await f.host.runtime.launchAttachedPreview(f.candidate, f.request.sessionId);
        f.failClose(); await expect(f.host.close()).rejects.toThrow(/Join unproven/);
        expect(await build.result).toMatchObject({ kind: "spawned", output: { canceled: true } });
        expect(runtime.kind).toBe("launched"); if (runtime.kind === "launched") expect(await runtime.exited).toMatchObject({ kind: "stopped" });
        await expect(f.host.boundary.discover({ bundled: false })).rejects.toThrow(/not open/);
        await f.host.close(); expect(f.calls.filter(c => c === "shader-environment-close-execution")).toHaveLength(2);
    });
    it("rejects changed descriptors and malformed byte responses", async () => {
        const f = fixture(); f.admission.descriptors[0] += " ";
        await expect(f.host.open(f.environment, f.state, f.selection, "dx12")).rejects.toThrow(/descriptor changed/);
        expect(f.calls).toContain("shader-environment-close-execution");
        const g = fixture(); await g.host.open(g.environment, g.state, g.selection, "dx12"); g.malformed();
        await expect(g.host.boundary.handshake(g.candidate)).rejects.toThrow(/bytes/); await g.host.close();
    });
    it("coalesces concurrent shutdowns and refuses new work immediately", async () => {
        const f = fixture(); await f.host.open(f.environment, f.state, f.selection, "dx12");
        const first = f.host.close(), second = f.host.close();
        expect(first).toBe(second);
        await expect(f.host.boundary.handshake(f.candidate)).rejects.toThrow(/not open/);
        await Promise.all([first, second]);
        expect(f.calls.filter(c => c === "shader-environment-close-execution")).toHaveLength(1);
    });
});
