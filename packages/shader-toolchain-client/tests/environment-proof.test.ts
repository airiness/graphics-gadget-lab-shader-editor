import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { syntheticEnvironmentManifest } from "../../../tests/environment-synthetic.js";
import { proveEnvironmentFinal, readEnvironmentNativeOutput, type EnvironmentProofExecution } from "../src/environment-proof.js";
import { DESCRIBE_SUCCESS, COMPILE_SUCCESS } from "./fixtures/envelope-goldens.js";
import { DESCRIBE_PREVIEW_SUCCESS, BUILD_PREVIEW_SUCCESS, PREVIEW_PUBLICATION_ID } from "./fixtures/preview-envelope-goldens.js";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const output = (text: string) => ({ stdout: new TextEncoder().encode(text), stderr: new Uint8Array(), exitCode: 0, timedOut: false, canceled: false });
function fixture() {
    const manifest = syntheticEnvironmentManifest(), closure = { root: "D:/final", manifest }, state = { root: "D:/state", environmentId: manifest.environmentId };
    const memberHash = (role: "tool" | "runtime" | "previewProgram") => manifest.members.find(m => m.path === manifest.roles[role])!.sha256;
    const observation = new Uint8Array(90), view = new DataView(observation.buffer);
    observation.set(new TextEncoder().encode("GGSHOBSV")); view.setUint32(8, 1, true); view.setUint32(12, 1, true); view.setBigUint64(16, 1n, true);
    observation.set(Buffer.from(PREVIEW_PUBLICATION_ID, "hex"), 24); observation.set(Buffer.from(PREVIEW_PUBLICATION_ID, "hex"), 56); observation[88] = 1;
    let sequence = 0, time = 0, canceled = false;
    const host: EnvironmentProofExecution = {
        candidate: { rule: "explicit-config", toolPath: closure.root + "/" + manifest.roles.tool, observationIdentity: memberHash("tool"), resolvedAt: 1 },
        runtime: { path: closure.root + "/" + manifest.roles.runtime, sha256: memberHash("runtime") }, previewDescriptorSha256: memberHash("previewProgram"),
        handshake: vi.fn(async () => output(JSON.stringify({ ...JSON.parse(DESCRIBE_SUCCESS), toolVersion: "1.3.0" }))),
        previewHandshake: vi.fn(async () => output(JSON.stringify({ ...JSON.parse(DESCRIBE_PREVIEW_SUCCESS), previewProgramDescriptorIdentity: memberHash("previewProgram") }))),
        compileProbe: vi.fn(async (_profile, target) => output(JSON.stringify({ ...JSON.parse(COMPILE_SUCCESS), target }))),
        buildPreview: vi.fn(async () => output(JSON.stringify({ ...JSON.parse(BUILD_PREVIEW_SUCCESS), attemptSequence: 1 }))),
        launch: vi.fn(async () => ({ runtimeIdentity: memberHash("runtime") })), observation: vi.fn(async () => observation), stop: vi.fn(async () => {}),
        sessionId: () => (++sequence).toString(16).padStart(32, "0"), now: () => time, wait: async () => { time += 10000; },
    };
    const probes = ([1, 2] as const).map(profileVersion => ({ profileVersion, requirement: { identity: "gglab-shaderc", minimumVersion: "1.3.0", versionComparison: "semver" }, generatedSourceBytes: new Uint8Array([1]), generatedSourceIdentity: hash(new Uint8Array([1])) }));
    return { host, observation, probes, cancel: () => { canceled = true; }, run: () => proveEnvironmentFinal(closure, state, probes, host, hash, () => canceled) };
}
describe("Environment final proof orchestration (synthetic, not native evidence)", () => {
    it("requires all four paths and joins every Runtime", async () => {
        const f = fixture(); expect((await f.run()).runs).toHaveLength(4); expect(f.host.stop).toHaveBeenCalledTimes(4);
    });
    it("rejects stale observation and still joins", async () => {
        const f = fixture(); new DataView(f.observation.buffer).setBigUint64(16, 2n, true);
        await expect(f.run()).rejects.toThrow(/this session/); expect(f.host.stop).toHaveBeenCalledOnce();
    });
    it("rejects a different executable before native work", async () => {
        const f = fixture(); Object.assign(f.host.runtime, { sha256: "0".repeat(64) });
        await expect(f.run()).rejects.toThrow(/Executable/); expect(f.host.handshake).not.toHaveBeenCalled();
    });
    it("rejects a successful compile for the wrong target", async () => {
        const f = fixture(); f.host.compileProbe = async () => output(JSON.stringify({ ...JSON.parse(COMPILE_SUCCESS), target: "other" }));
        await expect(f.run()).rejects.toThrow(/Ordinary native/); expect(f.host.launch).not.toHaveBeenCalled();
    });
    it("cannot return proof after cancellation during launch", async () => {
        const f = fixture(); const launch = f.host.launch; f.host.launch = async (...args) => { f.cancel(); return launch(...args); };
        await expect(f.run()).rejects.toThrow(/cancelled/); expect(f.host.stop).toHaveBeenCalledOnce();
    });
    it("cannot return proof when stop is unproven or observation times out", async () => {
        const f = fixture(); f.host.stop = async () => { throw new Error("unproven"); };
        await expect(f.run()).rejects.toThrow(/unproven/);
        const g = fixture(); g.host.observation = async () => null;
        await expect(g.run()).rejects.toThrow(/timed out/); expect(g.host.stop).toHaveBeenCalledOnce();
    });
    it("refuses incomplete profiles and unsupported handshakes", async () => {
        const f = fixture(); f.probes.pop(); await expect(f.run()).rejects.toThrow(/Both frozen/);
        const g = fixture(); g.host.handshake = async () => output(JSON.stringify({ ...JSON.parse(DESCRIBE_SUCCESS), processContractVersion: 99 }));
        await expect(g.run()).rejects.toThrow(/Ordinary handshake/); expect(g.host.launch).not.toHaveBeenCalled();
    });
    it("rejects malformed IPC rather than coercing bytes", () => {
        expect(() => readEnvironmentNativeOutput({ kind: "spawned", output: { ...output("{}"), stdout: [256], stderr: [] } })).toThrow(/bytes/);
    });
});
