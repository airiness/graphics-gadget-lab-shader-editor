import { describe, expect, it } from "vitest";
import { clientSupportedContractRange } from "../src/contract-range-declaration.js";
import { judgeContractSupport } from "../src/contract-range.js";

describe("the client's supported-range declaration", () => {
    it("declares the published machine process contract v1 — exactly", () => {
        expect(clientSupportedContractRange).toEqual({ minimum: 1, maximum: 1 });
    });

    it("supports the published axis and refuses every other axis, never silently", () => {
        expect(judgeContractSupport(1)).toEqual({
            supported: true,
            observedVersion: 1,
            range: { minimum: 1, maximum: 1 },
        });
    });

    it("refuses axes below and above the declared range on both inclusive bounds", () => {
        expect(judgeContractSupport(0)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
            observedVersion: 0,
        });
        expect(judgeContractSupport(2)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
            observedVersion: 2,
        });
        expect(judgeContractSupport(99)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
        });
    });

    it("still keeps the null-declaration world reachable: an explicit refusal, not a default", () => {
        for (const observed of [0, 1, 99]) {
            expect(judgeContractSupport(observed, null)).toEqual({
                supported: false,
                reason: "no-supported-contract-declared",
                observedVersion: observed,
            });
        }
    });

    it("honors an explicitly supplied range on both inclusive bounds", () => {
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
});
