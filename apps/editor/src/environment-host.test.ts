import { describe, expect, it } from "vitest";
import { utf8Encode } from "@gglab/shader-toolchain-client";
import { createEnvironmentDiscoveryHost } from "./environment-host.js";

const repository = {
    repositoryId: "environment-repository:1", displayPath: "D:/main", publisherSha256: "1".repeat(64),
    bootstrapText: JSON.stringify({ bootstrapVersion: 1, publisher: "Scripts/Environment/publish_environment.py", interpreter: "python", minimumPythonVersion: "3.12", transport: "single-utf8-json-stdin-stdout", requestVersions: [1], resultVersions: [1], defaultSearchRoots: ["Build/Output"], contractStatus: "implemented-pending-owner-review" }),
};
const discoveryId = "environment-discovery:2";
function settlement() {
    return {
        kind: "settled", repositoryId: repository.repositoryId, discoveryId, publisherSha256: repository.publisherSha256, interpreterSha256: "2".repeat(64),
        output: { stdout: [...utf8Encode(JSON.stringify({ resultVersion: 1, operation: "discover", success: true, error: null, result: { candidates: ["Build/Debug", "Build/Release"].map(deployment => ({ deployment, toolSha256: "3".repeat(64), runtimeSha256: "4".repeat(64) })) } }))], stderr: [], exitCode: 0, timedOut: false, canceled: false, outputLimitExceeded: false },
    };
}
describe("Tauri Environment discovery adapter", () => {
    it("buffers early completion, forwards only IDs and preserves multiple candidates as unproven", async () => {
        let receive!: (value: unknown) => void;
        const calls: unknown[] = [];
        const host = createEnvironmentDiscoveryHost(async (command, args) => {
            calls.push({ command, args });
            if (command === "shader-environment-choose-repository") return repository;
            if (command === "shader-environment-discover") { receive(settlement()); return discoveryId; }
            return false;
        }, callback => { receive = callback; return "channel"; });
        expect(await host.chooseRepository()).toEqual(repository);
        const job = await host.discover(repository), result = await job.completion;
        expect(result).toMatchObject({ status: "discovered", nativeReadiness: "unproven" });
        if (result.status === "discovered") expect(result.candidates).toHaveLength(2);
        expect(calls[1]).toEqual({ command: "shader-environment-discover", args: { repositoryId: repository.repositoryId, channel: "channel" } });
        expect(await host.cancel(job.discoveryId)).toBe(false);
    });
    it("pins admission facts and refuses stale or rebound publisher settlements", async () => {
        let receive!: (value: unknown) => void;
        const host = createEnvironmentDiscoveryHost(async () => discoveryId, callback => { receive = callback; return null; });
        const selected = { ...repository }, job = await host.discover(selected);
        selected.publisherSha256 = "9".repeat(64);
        receive({ ...settlement(), publisherSha256: selected.publisherSha256 });
        expect(await job.completion).toMatchObject({ status: "refused", diagnostic: { code: "proof-mismatch" } });
    });
    it("keeps cancellation, timeout, overflow and invalid UTF-8 out of success", async () => {
        for (const [patch, code] of [[{ canceled: true }, "cancelled"], [{ timedOut: true }, "producer-timeout"], [{ outputLimitExceeded: true }, "limit-exceeded"], [{ stdout: [255] }, "invalid-json"], [{ stdout: [-1] }, "invalid-shape"]] as const) {
            let receive!: (value: unknown) => void;
            const host = createEnvironmentDiscoveryHost(async () => discoveryId, callback => { receive = callback; return null; });
            const job = await host.discover(repository), value = settlement(); receive({ ...value, output: { ...value.output, ...patch } });
            expect(await job.completion).toMatchObject({ status: "refused", diagnostic: { code } });
        }
    });
    it("preserves structured host failure and rejects settlement from another admission", async () => {
        let receive!: (value: unknown) => void;
        const host = createEnvironmentDiscoveryHost(async () => discoveryId, callback => { receive = callback; return null; });
        let job = await host.discover(repository);
        receive({ kind: "failed", repositoryId: repository.repositoryId, discoveryId, error: { code: "source-changed", message: "Select again", dataPath: "$" } });
        expect(await job.completion).toMatchObject({ status: "refused", diagnostic: { code: "source-changed" } });
        job = await host.discover(repository); receive({ ...settlement(), discoveryId: "environment-discovery:3" });
        expect(await job.completion).toMatchObject({ status: "refused", diagnostic: { code: "proof-mismatch" } });
    });
    it("handles dialog cancellation and admission failure without inventing a candidate", async () => {
        const host = createEnvironmentDiscoveryHost(async command => {
            if (command === "shader-environment-choose-repository") return null;
            throw { code: "invalid-handle", message: "Select again", dataPath: "$" };
        }, () => null);
        expect(await host.chooseRepository()).toBeNull();
        await expect(host.discover(repository)).rejects.toMatchObject({ diagnostic: { code: "invalid-handle" } });
    });
});
