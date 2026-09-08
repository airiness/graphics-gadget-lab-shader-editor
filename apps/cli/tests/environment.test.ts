import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, linkSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENVIRONMENT_STATE_ROLES, environmentExecutionLocations, type EnvironmentManifest } from "@gglab/shader-toolchain-client";
import { verifyEnvironmentDirectory, inspectEnvironmentState } from "../src/environment-host.js";
import { dispatch } from "../src/index.js";
const fixtures = process.env.GGLAB_ENVIRONMENT_FIXTURES ?? fileURLToPath(new URL("../../../../GraphicsGadgetLab/Tests/Environment/fixtures/", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const temp = mkdtempSync(join(tmpdir(), "gglab-editor-environment-")); roots.push(temp);
    const root = join(temp, "environment"); mkdirSync(root);
    const text = readFileSync(join(fixtures, "valid.json"), "utf8"), m = JSON.parse(text) as EnvironmentManifest;
    for (const member of m.members) { const path = join(root, member.path); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "synthetic fixture; not executable\n"); }
    writeFileSync(join(root, "environment.json"), text);
    return { root, temp, m };
}
describe.runIf(process.platform === "win32")("Windows Environment host", () => {
    it("CLI uses the real strict reader and never advertises native readiness", () => {
        const f = fixture(); const result = dispatch("environment-verify", [f.root]);
        expect(result.code).toBe(0); const envelope = JSON.parse(result.sinkText);
        expect(envelope.payload.nativeReadiness).toBe("unproven"); expect(envelope.payload.importAvailability.enabled).toBe(false);
        expect(envelope.payload.manifest.environmentId).toBe(f.m.environmentId);
        // Synthetic files cannot qualify real descriptors or native compatibility.
        expect(dispatch("environment-verify", [f.root, "--profiles"]).code).toBe(1);
    }, 30000);
    it("consumes producer filesystem vectors through actual filesystem reads", () => {
        const vectors = JSON.parse(readFileSync(join(fixtures, "filesystem-cases.json"), "utf8")) as { cases: { mutation: string; path: string; replacementUtf8?: string; error: string }[] };
        for (const v of vectors.cases) {
            const f = fixture(), target = join(f.root, v.path);
            if (v.mutation === "remove") rmSync(target); else writeFileSync(target, v.replacementUtf8!);
            expect(JSON.parse(dispatch("environment-verify", [f.root]).sinkText).diagnostics[0].code).toBe(v.error);
        }
    }, 30000);
    it("rejects real hardlinks, junction entries and junction ancestors", () => {
        const f = fixture(); linkSync(join(f.root, f.m.roles.tool), join(f.temp, "tool-link"));
        expect(() => verifyEnvironmentDirectory(f.root)).toThrow("Hard-linked");
        rmSync(join(f.temp, "tool-link"));
        const external = join(f.temp, "external"); mkdirSync(external);
        symlinkSync(external, join(f.root, "linked"), "junction");
        expect(() => verifyEnvironmentDirectory(f.root)).toThrow("Linked entry");
        rmSync(join(f.root, "linked"));
        const alias = join(f.temp, "alias"); symlinkSync(f.root, alias, "junction");
        expect(() => verifyEnvironmentDirectory(alias)).toThrow("Reparse point");
    }, 30000);
    it("recovers matching state without writes and keeps paths outside immutable payload", () => {
        const f = fixture(), state = join(f.temp, "state"); mkdirSync(state);
        for (const path of Object.values(ENVIRONMENT_STATE_ROLES)) mkdirSync(join(state, path), { recursive: true });
        writeFileSync(join(state, "state.json"), JSON.stringify({ stateVersion: 1, environmentId: f.m.environmentId }));
        const closure = verifyEnvironmentDirectory(f.root), binding = inspectEnvironmentState(closure, state);
        expect(environmentExecutionLocations(closure, binding).artifactRoot).toBe(state + "/ShaderArtifacts");
        writeFileSync(join(state, "state.json"), JSON.stringify({ stateVersion: 1, environmentId: "sha256:" + "0".repeat(64) }));
        expect(() => inspectEnvironmentState(closure, state)).toThrow("another Environment");
        expect(readFileSync(join(state, "state.json"), "utf8")).toContain("0".repeat(64));
    }, 30000);
    it("rejects a Windows case alias of an unfinished staging directory", () => {
        const f = fixture(); renameSync(f.root, join(f.temp, ".staging-review"));
        const envelope = JSON.parse(dispatch("environment-verify", [join(f.temp, ".STAGING-REVIEW")]).sinkText);
        expect(envelope.ok).toBe(false); expect(envelope.diagnostics[0].code).toBe("incomplete-publication");
    }, 30000);
    it("malformed UTF-8 and extra flags fail explicitly", () => {
        const f = fixture(); writeFileSync(join(f.root, "environment.json"), Buffer.from([0xff]));
        expect(JSON.parse(dispatch("environment-verify", [f.root]).sinkText).diagnostics[0].code).toBe("invalid-json");
        expect(dispatch("environment-verify", [f.root, "--import"]).code).toBe(2);
    }, 30000);
});
