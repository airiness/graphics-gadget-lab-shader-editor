import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { environmentProducerFixtures } from "../../../tests/environment-producer.js";
import { describe, expect, it } from "vitest";
import { EnvironmentContractError, environmentIdentity, parseEnvironmentJson, readEnvironmentManifest, type EnvironmentManifest } from "../src/environment-contract.js";
import { readEnvironmentBootstrap, readEnvironmentRequest, readEnvironmentResponse, callEnvironmentProducer } from "../src/environment-protocol.js";
import { verifyEnvironmentClosure, type EnvironmentEntry } from "../src/environment-closure.js";
import { prepareEnvironmentImport, validateEnvironmentStateRoots, ENVIRONMENT_IMPORT_AVAILABILITY, type EnvironmentFinalProof, type EnvironmentImportHost, type EnvironmentRegistration } from "../src/environment-import.js";

// The producer owns these vectors; require the pinned clean revision.
const fixtureRoot = environmentProducerFixtures();
const text = (name: string): string => readFileSync(`${fixtureRoot}/${name}`, "utf8");
const hash = (value: string): string => createHash("sha256").update(value, "ascii").digest("hex");
const valid = (): EnvironmentManifest => readEnvironmentManifest(text("valid.json"), hash);
function rejects(code: string, operation: () => unknown): void {
    try { operation(); throw new Error("Expected rejection"); }
    catch (error) { expect(error).toBeInstanceOf(EnvironmentContractError); expect((error as EnvironmentContractError).diagnostic.code).toBe(code); }
}
const fixtures = JSON.parse(text("index.json")) as { cases: { file: string; accept: boolean; error?: string; environmentId?: string }[] };
describe("producer-owned manifest vectors", () => {
    for (const vector of fixtures.cases) it(vector.file, () => {
        if (vector.accept) expect(readEnvironmentManifest(text(vector.file), hash).environmentId).toBe(vector.environmentId);
        else rejects(vector.error!, () => readEnvironmentManifest(text(vector.file), hash));
    });
    it("checks duplicate escaped keys, malformed JSON, non-finite and float version tokens", () => {
        for (const input of ['{"a":1,"\\u0061":2}', '\ufeff{}', '{"a":NaN}', '{"a":1e999}', '{"a":1.0}', '{}{}', '[1,]', '{"a":1,}', '"\u0000"']) rejects("invalid-json", () => parseEnvironmentJson(input));
        rejects("limit-exceeded", () => parseEnvironmentJson(" ".repeat(16 * 1024 * 1024 + 1)));
    });
    it("rejects malformed member fields, unsafe locators and file/directory conflicts before identity", () => {
        for (const path of ["payload/../escape", "payload/CON.txt", "payload/a.", "payload/a:b", "payload/a//b", "payload/a\\b"]) {
            const m = structuredClone(valid()); (m.members[0] as { path: string }).path = path;
            rejects("invalid-path", () => readEnvironmentManifest(JSON.stringify(m), hash));
        }
        const m = structuredClone(valid()); (m.members[0] as { size: number }).size = -1;
        rejects("invalid-member", () => readEnvironmentManifest(JSON.stringify(m), hash));
        const conflict = structuredClone(valid());
        const members = [...conflict.members, { ...conflict.members[0]!, path: "payload/Assets" }].sort((a,b) => a.path < b.path ? -1 : 1);
        rejects("path-conflict", () => readEnvironmentManifest(JSON.stringify({ ...conflict, members }), hash));
    });
    it("identity is independently derived and formatting/order insensitive", () => {
        const m = valid(); expect(environmentIdentity(m, hash)).toBe(m.environmentId);
        expect(readEnvironmentManifest(JSON.stringify(Object.fromEntries(Object.entries(m).reverse()), null, 4), hash)).toEqual(m);
    });
});
function closureHost() {
    const m = valid();
    const files = new Map(m.members.map(member => [member.path, "synthetic fixture; not executable\n"]));
    files.set("environment.json", text("valid.json"));
    const entries: EnvironmentEntry[] = [...files.keys()].map(path => ({ path, kind: "file", reparsePoint: false, linkCount: 1 }));
    const host = {
        hashAscii: hash, assertOrdinaryRoot: (root: string) => root,
        entries: () => entries.filter(e => files.has(e.path)),
        readManifest: () => files.get("environment.json") ?? null,
        hashMember: (_root: string, path: string) => ({ size: Buffer.byteLength(files.get(path)!), sha256: hash(files.get(path)!) }),
    };
    return { host, files, entries };
}
describe("producer-owned filesystem vectors through closure verifier", () => {
    const vectors = JSON.parse(text("filesystem-cases.json")) as { cases: { name: string; mutation: string; path: string; replacementUtf8?: string; error: string }[] };
    it("accepts materialized synthetic closure without claiming readiness", () => expect(verifyEnvironmentClosure(closureHost().host, "D:/environment").manifest.environmentId).toBe(valid().environmentId));
    for (const v of vectors.cases) it(v.name, () => {
        const h = closureHost();
        if (v.mutation === "remove") h.files.delete(v.path);
        else {
            h.files.set(v.path, v.replacementUtf8!);
            if (!h.entries.some(e => e.path === v.path)) h.entries.push({ path: v.path, kind: "file", reparsePoint: false, linkCount: 1 });
        }
        rejects(v.error, () => verifyEnvironmentClosure(h.host, "D:/environment"));
    });
    it("rejects reparse points, hardlinks, case conflicts and staging", () => {
        for (const [patch, code] of [[{ reparsePoint: true }, "reparse-point"], [{ linkCount: 2 }, "hard-link"]] as const) {
            const h = closureHost(); h.entries[0] = { ...h.entries[0]!, ...patch };
            rejects(code, () => verifyEnvironmentClosure(h.host, "D:/environment"));
        }
        const h = closureHost(), first = h.entries[0]!;
        h.entries.push({ ...first, path: first.path.toUpperCase() }); h.files.set(first.path.toUpperCase(), "x");
        rejects("path-conflict", () => verifyEnvironmentClosure(h.host, "D:/environment"));
        const staging = JSON.parse(text("staging-cases.json")) as { pathSpellings: string[]; expected: { verify: { errorCode: string } } };
        for (const name of staging.pathSpellings) rejects(staging.expected.verify.errorCode, () => verifyEnvironmentClosure(closureHost().host, "D:/" + name));
    });
});
describe("producer process protocol", () => {
    const vectors = JSON.parse(text("process-cases.json")) as { cases: { request: unknown; error: string }[] };
    for (const [index, v] of vectors.cases.entries()) it(`request vector ${index}`, () => rejects(v.error, () => readEnvironmentRequest(v.request)));
    it("retains multiple explicit candidates and rejects exit/operation mismatch", async () => {
        const result = { candidates: ["Build/Debug", "Build/Release"].map(deployment => ({ deployment, toolSha256: "1".repeat(64), runtimeSha256: "2".repeat(64) })) };
        const stdout = JSON.stringify({ resultVersion: 1, operation: "discover", success: true, result, error: null });
        expect(await callEnvironmentProducer({ exchange: async () => ({ stdout, exitCode: 0 }) }, { requestVersion: 1, operation: "discover", repositoryRoot: "D:/main", searchRoots: ["Build"] })).toEqual({ success: true, result });
        rejects("invalid-shape", () => readEnvironmentResponse(stdout, 2, "discover"));
        rejects("invalid-shape", () => readEnvironmentResponse(stdout, 0, "verify"));
        rejects("invalid-json", () => readEnvironmentResponse("", null, "publish"));
    });
    it("preserves producer failure codes without treating prose as success", () => {
        const error = { code: "cancelled", message: "Published successfully (diagnostic text is not authority)" };
        expect(readEnvironmentResponse(JSON.stringify({ resultVersion: 1, operation: "publish", success: false, result: null, error }), 2, "publish")).toEqual({ success: false, error });
    });
    it("reads the actual bootstrap and keeps approval pending", () => {
        const bootstrapPath = resolve(fixtureRoot, "../../../Scripts/Environment/bootstrap.json");
        expect(readEnvironmentBootstrap(readFileSync(bootstrapPath, "utf8")).contractStatus).toBe("implemented-pending-owner-review");
        expect(ENVIRONMENT_IMPORT_AVAILABILITY.enabled).toBe(false);
    });
});
function transaction() {
    const root = "D:/final", stateRoot = "D:/state", manifest = valid();
    const closure = { root, manifest }, state = { root: stateRoot, environmentId: manifest.environmentId };
    const proof: EnvironmentFinalProof = {
        environmentRoot: root, stateRoot, environmentId: manifest.environmentId,
        tool: { path: root + "/" + manifest.roles.tool, sha256: manifest.members.find(m => m.path === manifest.roles.tool)!.sha256 },
        runtime: { path: root + "/" + manifest.roles.runtime, sha256: manifest.members.find(m => m.path === manifest.roles.runtime)!.sha256 },
        ordinaryHandshake: "compatible", previewHandshake: "compatible", profiles: [1,2], runtimeObservation: "loaded",
    };
    let stored: EnvironmentRegistration | null = null; let cancelled = false;
    const host: EnvironmentImportHost = {
        verifyFinal: async () => closure, initializeOrRecoverState: async () => state, proveFinal: async () => proof,
        register: async r => { if (stored) return "already-registered"; stored = r; return "registered"; },
    };
    return { host, root, stateRoot, proof, closure, cancel: () => { cancelled = true; }, run: () => prepareEnvironmentImport(host, root, stateRoot, () => cancelled), stored: () => stored };
}
describe("import transaction without production activation", () => {
    it("registers only after final proof; retry is idempotent", async () => {
        const t = transaction(); expect((await t.run()).status).toBe("registered"); expect((await t.run()).status).toBe("already-registered");
    });
    it("rejects source-path proof even for identical executable hashes", async () => {
        const t = transaction(); t.host.proveFinal = async () => ({ ...t.proof, tool: { ...t.proof.tool, path: "D:/source/gglab-shaderc.exe" } });
        expect(await t.run()).toMatchObject({ status: "refused", diagnostic: { code: "proof-mismatch" }, retainedStateRoot: t.stateRoot }); expect(t.stored()).toBeNull();
    });
    it("preserves last-good registration and recoverable state after proof failure and restart", async () => {
        const t = transaction(); await t.run(); const previous = t.stored(); const prove = t.host.proveFinal;
        t.host.proveFinal = async () => { throw new Error("Runtime unavailable"); };
        expect(await t.run()).toMatchObject({ status: "refused", retainedStateRoot: t.stateRoot }); expect(t.stored()).toBe(previous);
        t.host.proveFinal = prove;
        expect((await prepareEnvironmentImport(t.host, t.root, t.stateRoot, () => false)).status).toBe("already-registered");
    });
    it("cancellation after state creation does not register or delete state", async () => {
        const t = transaction(), initialize = t.host.initializeOrRecoverState;
        t.host.initializeOrRecoverState = async (...args) => { const state = await initialize(...args); t.cancel(); return state; };
        expect(await t.run()).toMatchObject({ status: "refused", diagnostic: { code: "cancelled" }, retainedStateRoot: t.stateRoot }); expect(t.stored()).toBeNull();
    });
    it("reports uncertain state creation and rejects overlapping roots", async () => {
        const t = transaction(); t.host.initializeOrRecoverState = async () => { throw new Error("lost response after commit"); };
        expect(await t.run()).toMatchObject({ status: "refused", retainedStateRoot: t.stateRoot });
        rejects("invalid-path", () => validateEnvironmentStateRoots("D:/final", "d:/FINAL/state"));
    });
    it("rejects changed closure and keeps a committed result despite late cancellation", async () => {
        const t = transaction(); let count = 0;
        t.host.verifyFinal = async () => ++count === 1 ? t.closure : { ...t.closure, manifest: { ...t.closure.manifest, environmentId: "sha256:" + "0".repeat(64) } };
        expect(await t.run()).toMatchObject({ status: "refused", diagnostic: { code: "source-changed" } });
        const t2 = transaction(), register = t2.host.register;
        t2.host.register = async r => { const result = await register(r); t2.cancel(); return result; };
        expect((await t2.run()).status).toBe("registered");
    });
});
