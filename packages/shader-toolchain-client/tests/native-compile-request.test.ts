import { describe, expect, it } from "vitest";
import type { ToolFacts } from "../src/contract-facts.js";
import {
    buildIntentOf,
    buildIntentsEqual,
    canonicalFormOf,
    isWellFormedRequest,
    nextBuildId,
    requestsEqual,
    type NativeCompileRequest,
} from "../src/native-compile-request.js";
import { utf8Encode } from "../src/utf8.js";

const SOURCE_BYTES = utf8Encode("/* generated */\nvoid GenerateSurface() { }");
const SOURCE_IDENTITY = "ab".repeat(32);

function request(
    change: (base: Record<string, unknown>) => Record<string, unknown> = (base) => base,
): NativeCompileRequest {
    const base = {
        source: SOURCE_BYTES,
        sourceIdentity: SOURCE_IDENTITY,
        target: "gglab-dx12",
        stage: "pixel",
        entry: "GenerateSurface",
        defines: [],
        includes: [],
    } as Record<string, unknown>;
    return change(base) as unknown as NativeCompileRequest;
}

function facts(
    producerIdentity: string = "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
    compilePolicyRevision: number = 1,
): ToolFacts {
    return {
        toolIdentity: "gglab-shaderc",
        toolVersion: "1.1.0",
        processContractVersion: 2,
        compilePolicyRevision,
        producerKind: "dxc",
        producerIdentity,
        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
    };
}

describe("the request value and its well-formedness", () => {
    it("is a value — no argv field exists on it at all", () => {
        const wellFormed = isWellFormedRequest(request());
        expect(wellFormed).toEqual({ ok: true });
        const form = canonicalFormOf(request());
        expect(Object.keys(form).sort()).toEqual(
            ["defines", "entry", "includes", "sourceIdentity", "stage", "target"].sort(),
        );
    });

    it("refuses each mistyped side explicitly, naming it", () => {
        expect(isWellFormedRequest(request((base) => ({ ...base, sourceIdentity: "not-a-digest" })))).toMatchObject({
            ok: false,
            reason: "sourceIdentity",
        });
        expect(isWellFormedRequest(request((base) => ({ ...base, target: "" })))).toMatchObject({
            ok: false,
            reason: "target",
        });
        expect(isWellFormedRequest(request((base) => ({ ...base, entry: "" })))).toMatchObject({
            ok: false,
            reason: "entry",
        });
        expect(
            isWellFormedRequest(
                request((base) => ({
                    ...base,
                    defines: [
                        { name: "B", value: "1" },
                        { name: "A", value: "0" },
                    ],
                })),
            ),
        ).toMatchObject({ ok: false, reason: "defines" });
        expect(isWellFormedRequest(request((base) => ({ ...base, includes: [""] })))).toMatchObject({
            ok: false,
            reason: "includes",
        });
    });

    it("accepts the frozen v2 profile's empty contract slots", () => {
        const emptySlots = request((base) => ({ ...base, defines: [], includes: [] }));
        expect(isWellFormedRequest(emptySlots)).toEqual({ ok: true });
    });

    it("holds determinism: same semantic compile request → same request value", () => {
        const a = request();
        const b = request();
        expect(requestsEqual(a, b)).toBe(true);
        expect(canonicalFormOf(a)).toEqual(canonicalFormOf(b));

        const withDefines = request((base) => ({
            ...base,
            // code-unit order: "GGLAB_SURFACE" < "GGLab_TEX"
            defines: [
                { name: "GGLAB_SURFACE", value: "1" },
                { name: "GGLab_TEX", value: "2" },
            ],
        }));
        expect(isWellFormedRequest(withDefines)).toEqual({ ok: true });

        const targetChanged = request((base) => ({ ...base, target: "gglab-vulkan13" }));
        expect(requestsEqual(a, targetChanged)).toBe(false);
        const otherBytes = request((base) => ({ ...base, source: utf8Encode("different bytes") }));
        expect(requestsEqual(a, otherBytes)).toBe(false);
    });
});

describe("the build intent — three identity concepts, not one", () => {
    it("binds the request value to the proven tool facts", () => {
        const intent = buildIntentOf(request(), facts());
        expect(intent.sourceIdentity).toBe(SOURCE_IDENTITY);
        expect(intent.target).toBe("gglab-dx12");
        expect(intent.tool.identity).toBe("gglab-shaderc");
        expect(intent.tool.version).toBe("1.1.0");
        expect(intent.tool.processContractVersion).toBe(2);
        expect(intent.tool.compilePolicyRevision).toBe(1);
        expect(intent.tool.producerIdentity).toBe("Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)");
    });

    it("is a DIFFERENT intent for the same bytes under a different target", () => {
        const a = buildIntentOf(request(), facts());
        const b = buildIntentOf(request((base) => ({ ...base, target: "gglab-vulkan13" })), facts());
        expect(buildIntentsEqual(a, b)).toBe(false);
    });

    it("is a DIFFERENT intent when the proven producer identity changes (a different DXC, same tool version)", () => {
        const a = buildIntentOf(request(), facts("dxc 1.7.1"));
        const b = buildIntentOf(request(), facts("dxc 1.7.9"));
        expect(buildIntentsEqual(a, b)).toBe(false);
    });

    it("is a DIFFERENT intent when the proven compile-policy revision changes (same recipe, same tool, same producer — the policy can still change the binary)", () => {
        // Docs §22.1.1: the compile-policy axis is a compiler-owned
        // behavior axis — a revision change can alter the produced
        // binary even with the same normalized recipe and DXC. A result
        // must never pass as `current` across that difference.
        const a = buildIntentOf(request(), facts());
        const b = buildIntentOf(request(), facts("Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)", 2));
        expect(buildIntentsEqual(a, b)).toBe(false);
    });

    it("is a DIFFERENT intent under a different stage or entry", () => {
        const a = buildIntentOf(request(), facts());
        const stage = buildIntentOf(request((base) => ({ ...base, stage: "vertex" })), facts());
        const entry = buildIntentOf(request((base) => ({ ...base, entry: "GenerateOther" })), facts());
        expect(buildIntentsEqual(a, stage)).toBe(false);
        expect(buildIntentsEqual(a, entry)).toBe(false);
        expect(buildIntentsEqual(a, a)).toBe(true);
    });
});

describe("the build id — the attempt ordering axis", () => {
    it("orders attempts within one intent", () => {
        expect(nextBuildId([])).toEqual({ sequence: 1 });
        expect(nextBuildId([{ buildId: { sequence: 3 } }])).toEqual({ sequence: 4 });
    });
});
