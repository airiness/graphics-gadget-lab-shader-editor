import { describe, expect, it } from "vitest";
import { clientSupportedCompilePolicyRange, clientSupportedContractRange } from "../src/contract-range-declaration.js";
import { judgeContractSupport } from "../src/contract-range.js";

describe("the client's supported-range declaration", () => {
    it("declares the published machine process contract v2 — exactly (docs §22.1.4 declaration policy: only the currently published axis, never 1..2)", () => {
        expect(clientSupportedContractRange).toEqual({ minimum: 2, maximum: 2 });
    });

    it("declares the compile-policy axis exactly: the currently published value 1, nothing more, nothing less", () => {
        expect(clientSupportedCompilePolicyRange).toEqual({ minimum: 1, maximum: 1 });
    });

    it("supports the published axis and refuses every other axis, never silently", () => {
        expect(judgeContractSupport(2)).toEqual({
            supported: true,
            observedVersion: 2,
            range: { minimum: 2, maximum: 2 },
        });
    });

    it("refuses axes below (the legacy v1) and above (a hypothetical v3) the declared range, both visible", () => {
        expect(judgeContractSupport(0)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
            observedVersion: 0,
        });
        expect(judgeContractSupport(1)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
            observedVersion: 1,
        });
        expect(judgeContractSupport(3)).toMatchObject({
            supported: false,
            reason: "observed-version-outside-range",
            observedVersion: 3,
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
