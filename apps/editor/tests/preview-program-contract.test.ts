import { describe, expect, it } from "vitest";
import {
    createPreviewSessionId,
    previewProgramDescriptorIdentity,
} from "../src/preview-program-contract.js";

describe("pinned Preview Program contract", () => {
    it("pins the reviewed main-owned descriptor identity", () => {
        expect(previewProgramDescriptorIdentity).toBe(
            "3bcb22e27e7c2edeaf67dcb25d531cc89dbc443a8b5f19efe4d6885f32a5f8ad",
        );
        expect(previewProgramDescriptorIdentity).toMatch(/^[0-9a-f]{64}$/);
    });

    it("encodes exactly 128 random bits as a lowercase SessionId", () => {
        const sessionId = createPreviewSessionId((bytes) => {
            bytes.set(Array.from({ length: 16 }, (_, index) => index));
            return bytes;
        });

        expect(sessionId).toBe("000102030405060708090a0b0c0d0e0f");
        expect(sessionId).toMatch(/^[0-9a-f]{32}$/);
    });

    it("rejects an entropy source that does not return exactly 16 bytes", () => {
        expect(() => createPreviewSessionId(() => new Uint8Array(15))).toThrow(
            "the Preview SessionId entropy source must return exactly 16 bytes",
        );
    });
});
