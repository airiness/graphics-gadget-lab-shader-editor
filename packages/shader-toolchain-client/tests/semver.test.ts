import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver } from "../src/semver.js";

describe("the semver rule", () => {
    it("parses strict numeric MAJOR.MINOR.PATCH triples", () => {
        expect(parseSemver("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
        expect(parseSemver("1.1.0")).toEqual({ major: 1, minor: 1, patch: 0 });
        expect(parseSemver("10.2.3")).toEqual({ major: 10, minor: 2, patch: 3 });
    });

    it("refuses anything that is not a strict numeric triple, without guessing", () => {
        expect(parseSemver("")).toBeNull();
        expect(parseSemver("1.1")).toBeNull();
        expect(parseSemver("1.1.0.0")).toBeNull();
        expect(parseSemver("v1.1.0")).toBeNull();
        expect(parseSemver("01.1.0")).toBeNull();
        expect(parseSemver("1.01.0")).toBeNull();
        expect(parseSemver("1.1.0-beta")).toBeNull();
        expect(parseSemver("1.1.0+build.4")).toBeNull();
        expect(parseSemver(" 1.1.0")).toBeNull();
        expect(parseSemver("1.1.")).toBeNull();
        expect(parseSemver("latest")).toBeNull();
    });

    it("orders triples by major, then minor, then patch", () => {
        const oneOne = parseSemver("1.1.0");
        const oneTwo = parseSemver("1.2.0");
        const oneOneOne = parseSemver("1.1.1");
        const twoZero = parseSemver("2.0.0");
        if (oneOne === null || oneTwo === null || oneOneOne === null || twoZero === null) {
            throw new Error("test setup: the versions above are strict triples");
        }
        expect(compareSemver(oneOne, oneOne)).toBe(0);
        expect(compareSemver(oneOneOne, oneOne)).toBe(1);
        expect(compareSemver(oneOne, oneOneOne)).toBe(-1);
        expect(compareSemver(oneTwo, oneOne)).toBe(1);
        expect(compareSemver(twoZero, oneTwo)).toBe(1);
    });
});
