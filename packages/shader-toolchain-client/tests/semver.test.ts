import { describe, expect, it } from "vitest";
import { compareSemver, parseSemver } from "../src/semver.js";

describe("the semver rule (SemVer 2.0.0)", () => {
    it("parses the MAJOR.MINOR.PATCH core without leading zeros", () => {
        expect(parseSemver("0.0.0")).toMatchObject({ major: 0, minor: 0, patch: 0, preRelease: null });
        expect(parseSemver("1.1.0")).toMatchObject({ major: 1, minor: 1, patch: 0, preRelease: null });
        expect(parseSemver("10.2.3")).toMatchObject({ major: 10, minor: 2, patch: 3 });
    });

    it("parses pre-release and build metadata as SemVer 2.0.0 grammar", () => {
        expect(parseSemver("1.2.0-beta.1")).not.toBeNull();
        expect(parseSemver("1.2.0+build.7")).not.toBeNull();
        expect(parseSemver("1.2.0-alpha+001")).not.toBeNull();
        // Build identifiers MAY be numeric and carry leading zeros, unlike
        // pre-release identifiers.
        expect(parseSemver("1.2.3+0.3.7")).not.toBeNull();
    });

    it("refuses text outside the SemVer grammar, without guessing", () => {
        expect(parseSemver("")).toBeNull();
        expect(parseSemver("1.1")).toBeNull();
        expect(parseSemver("1.1.0.0")).toBeNull();
        expect(parseSemver("v1.1.0")).toBeNull();
        expect(parseSemver("01.1.0")).toBeNull();
        expect(parseSemver("1.01.0")).toBeNull();
        expect(parseSemver(" 1.1.0")).toBeNull();
        expect(parseSemver("1.1.")).toBeNull();
        expect(parseSemver("latest")).toBeNull();
        // A pre-release numeric identifier with a leading zero is invalid.
        expect(parseSemver("1.0.0-01")).toBeNull();
        // A bare hyphen / plus with an empty tail is invalid.
        expect(parseSemver("1.0.0-")).toBeNull();
        expect(parseSemver("1.0.0+")).toBeNull();
    });

    it("orders the cores by major, then minor, then patch", () => {
        const versions = ["1.1.0", "1.1.1", "1.2.0", "2.0.0"].map((version) => {
            const parsed = parseSemver(version);
            if (parsed === null) {
                throw new Error(`test setup: ${version} is a valid core`);
            }
            return parsed;
        });
        const [oneOne, oneOneOne, oneTwo, twoZero] = versions;
        if (oneOne === undefined || oneOneOne === undefined || oneTwo === undefined || twoZero === undefined) {
            throw new Error("test setup: the cores above must parse");
        }
        expect(compareSemver(oneOne, oneOne)).toBe(0);
        expect(compareSemver(oneOneOne, oneOne)).toBe(1);
        expect(compareSemver(oneOne, oneOneOne)).toBe(-1);
        expect(compareSemver(oneTwo, oneOne)).toBe(1);
        expect(compareSemver(twoZero, oneTwo)).toBe(1);
    });

    it("orders pre-releases per the SemVer 2.0.0 section 11 chain", () => {
        const chain = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ];
        const versions = chain.map((version) => {
            const parsed = parseSemver(version);
            if (parsed === null) {
                throw new Error(`test setup: ${version} is valid SemVer`);
            }
            return parsed;
        });
        for (let index = 0; index < versions.length - 1; index += 1) {
            const lower = versions[index];
            const higher = versions[index + 1];
            if (lower === undefined || higher === undefined) {
                throw new Error("test setup: the chain must parse in order");
            }
            expect(compareSemver(higher, lower), `chain step ${index}`).toBe(1);
            expect(compareSemver(lower, higher), `chain step ${index}`).toBe(-1);
        }
    });

    it("compares numeric pre-release identifiers by value, below alphanumeric ones", () => {
        const betaTwo = parseSemver("1.0.0-beta.2");
        const betaEleven = parseSemver("1.0.0-beta.11");
        if (betaTwo === null || betaEleven === null) {
            throw new Error("test setup: both pre-releases are valid");
        }
        expect(compareSemver(betaTwo, betaEleven)).toBe(-1);
        const alpha = parseSemver("1.0.0-alpha");
        const beta = parseSemver("1.0.0-beta");
        if (alpha === null || beta === null) {
            throw new Error("test setup: both pre-releases are valid");
        }
        expect(compareSemver(alpha, beta)).toBe(-1);
    });

    it("treats build metadata as identity, never precedence", () => {
        const plain = parseSemver("1.2.0");
        const built = parseSemver("1.2.0+build.7");
        if (plain === null || built === null) {
            throw new Error("test setup: both are valid");
        }
        expect(compareSemver(plain, built)).toBe(0);
        expect(compareSemver(built, plain)).toBe(0);
    });

    it("a pre-release of the minimum is BELOW the release minimum — a release minimum means no pre-release suffices", () => {
        const beta = parseSemver("1.0.0-beta");
        const release = parseSemver("1.0.0");
        if (beta === null || release === null) {
            throw new Error("test setup: both are valid");
        }
        expect(compareSemver(beta, release), "a pre-release sorts below its release").toBe(-1);
    });
});
