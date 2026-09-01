import { describe, expect, it } from "vitest";
import {
    canonicalPreviewBuildFormOf,
    isWellFormedPreviewBuildRequest,
    previewBuildRequestsEqual,
    type NativePreviewBuildRequest,
} from "../src/native-preview-build-request.js";
import { utf8Encode } from "../src/utf8.js";

const SOURCE_IDENTITY = "12".repeat(32);
const DESCRIPTOR_IDENTITY = "ab".repeat(32);

function request(
    change: (base: Record<string, unknown>) => Record<string, unknown> = (base) => base,
): NativePreviewBuildRequest {
    const base: Record<string, unknown> = {
        sessionId: "00112233445566778899aabbccddeeff",
        targetProfile: "gglab-dx12",
        profileId: "gglab.surface",
        profileVersion: 2,
        previewInputContractId: "gglab.preview-input.surface.texture2d",
        previewProgramDescriptorIdentity: DESCRIPTOR_IDENTITY,
        generatedSourceIdentity: SOURCE_IDENTITY,
        generatedSourceBytes: utf8Encode("/* exact generated HLSL bytes */"),
        attemptSequence: 1,
    };
    return change(base) as unknown as NativePreviewBuildRequest;
}

describe("the NativePreviewBuildRequest value", () => {
    it("contains Preview intent and identities only", () => {
        expect(isWellFormedPreviewBuildRequest(request())).toEqual({ ok: true });
        expect(Object.keys(canonicalPreviewBuildFormOf(request())).sort()).toEqual([
            "attemptSequence",
            "generatedSourceIdentity",
            "previewInputContractId",
            "previewProgramDescriptorIdentity",
            "profileId",
            "profileVersion",
            "sessionId",
            "targetProfile",
        ]);
        expect(request()).not.toHaveProperty("entry");
        expect(request()).not.toHaveProperty("stage");
        expect(request()).not.toHaveProperty("adapter");
        expect(request()).not.toHaveProperty("artifactRoot");
        expect(request()).not.toHaveProperty("argv");
    });

    it("requires canonical identities, a bounded sequence, and exact bytes", () => {
        expect(isWellFormedPreviewBuildRequest(request((base) => ({ ...base, sessionId: "AB".repeat(16) })))).toMatchObject({ ok: false, reason: "sessionId" });
        expect(isWellFormedPreviewBuildRequest(request((base) => ({ ...base, generatedSourceIdentity: "AB".repeat(32) })))).toMatchObject({ ok: false, reason: "generatedSourceIdentity" });
        expect(isWellFormedPreviewBuildRequest(request((base) => ({ ...base, previewProgramDescriptorIdentity: "nope" })))).toMatchObject({ ok: false, reason: "previewProgramDescriptorIdentity" });
        expect(isWellFormedPreviewBuildRequest(request((base) => ({ ...base, profileVersion: 0 })))).toMatchObject({ ok: false, reason: "profileVersion" });
        expect(isWellFormedPreviewBuildRequest(request((base) => ({ ...base, attemptSequence: 0 })))).toMatchObject({ ok: false, reason: "attemptSequence" });
        expect(isWellFormedPreviewBuildRequest(request((base) => ({ ...base, attemptSequence: Number.MAX_SAFE_INTEGER + 1 })))).toMatchObject({ ok: false, reason: "attemptSequence" });
        expect(isWellFormedPreviewBuildRequest(request((base) => ({ ...base, generatedSourceBytes: "text" })))).toMatchObject({ ok: false, reason: "generatedSourceBytes" });
    });

    it("compares the complete request value, including exact bytes and ordering identity", () => {
        expect(previewBuildRequestsEqual(request(), request())).toBe(true);
        expect(previewBuildRequestsEqual(request(), request((base) => ({ ...base, attemptSequence: 2 })))).toBe(false);
        expect(previewBuildRequestsEqual(request(), request((base) => ({ ...base, targetProfile: "gglab-vulkan13" })))).toBe(false);
        expect(previewBuildRequestsEqual(request(), request((base) => ({ ...base, generatedSourceBytes: utf8Encode("different") })))).toBe(false);
    });
});
