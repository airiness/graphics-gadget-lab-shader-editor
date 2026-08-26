import { describe, expect, it } from "vitest";
import { clientSupportedContractRange } from "../src/contract-range-declaration.js";
import { judgeContractSupport } from "../src/contract-range.js";
import { DESCRIBE_SUCCESS, DESCRIBE_INTERNAL_ERROR } from "./fixtures/envelope-goldens.js";
import { readHandshakeDocument } from "../src/handshake-document.js";

describe("the client's supported-range declaration", () => {
    it("declares no supported handshake contract today — the explicit empty state", () => {
        expect(clientSupportedContractRange).toBeNull();
    });

    it("refuses every observed contract axis under the empty declaration, never silently accepting", () => {
        expect(judgeContractSupport(0)).toEqual({
            supported: false,
            reason: "no-supported-contract-declared",
            observedVersion: 0,
        });
        expect(judgeContractSupport(1)).toEqual({
            supported: false,
            reason: "no-supported-contract-declared",
            observedVersion: 1,
        });
        expect(judgeContractSupport(99)).toEqual({
            supported: false,
            reason: "no-supported-contract-declared",
            observedVersion: 99,
        });
    });

    it("honors an explicitly supplied range on both inclusive bounds", () => {
        const range = { minimum: 1, maximum: 1 };
        expect(judgeContractSupport(1, range).supported).toBe(true);
        expect(judgeContractSupport(0, range)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
        });
        expect(judgeContractSupport(2, range)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
        });

        const wider = { minimum: 2, maximum: 3 };
        expect(judgeContractSupport(2, wider).supported).toBe(true);
        expect(judgeContractSupport(3, wider).supported).toBe(true);
        expect(judgeContractSupport(1, wider)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
        });
        expect(judgeContractSupport(4, wider)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
        });
    });

    it("keeps reading and consuming visibly separate: a published v1 document reads, its axis is still unsupported", () => {
        // A success document and a failure document of the published v1
        // contract both read strictly under the golden shapes…
        for (const text of [DESCRIBE_SUCCESS, DESCRIBE_INTERNAL_ERROR]) {
            const outcome = readHandshakeDocument(text);
            expect(outcome.status).toBe("read");
        }
        // …while the client's declared range still refuses the axis:
        const read = readHandshakeDocument(DESCRIBE_SUCCESS);
        if (read.status === "read") {
            expect(judgeContractSupport(read.document.processContractVersion)).toEqual({
                supported: false,
                reason: "no-supported-contract-declared",
                observedVersion: 1,
            });
        }
    });
});
