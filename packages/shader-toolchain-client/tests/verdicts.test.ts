import { describe, expect, it } from "vitest";
import { requirementsEqual } from "../src/contract-facts.js";
import type { ToolFacts, ToolRequirement } from "../src/contract-facts.js";
import {
    extractSupportedTargets,
    judgeToolIdentity,
    judgeToolVersion,
} from "../src/verdicts.js";

const REQUIRED: ToolRequirement = {
    identity: "gglab-shaderc",
    minimumVersion: "1.0.0",
    versionComparison: "semver",
};

function facts(version: string, identity = "gglab-shaderc", targets: readonly string[] = ["gglab-dx12", "gglab-vulkan13"]): ToolFacts {
    return {
        toolIdentity: identity,
        toolVersion: version,
        processContractVersion: 1,
        producerKind: "dxc",
        producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
        supportedTargets: targets,
    };
}

describe("the identity verdict", () => {
    it("matches on exact equality", () => {
        expect(judgeToolIdentity(REQUIRED, facts("1.1.0"))).toEqual({ status: "match" });
    });

    it("reports a named mismatch with both sides visible", () => {
        expect(judgeToolIdentity(REQUIRED, facts("1.1.0", "other-tool"))).toEqual({
            status: "mismatch",
            requiredIdentity: "gglab-shaderc",
            reportedIdentity: "other-tool",
        });
    });
});

describe("the requirement value", () => {
    it("is equal only when every judgment input agrees — a re-statement of the same value is no change", () => {
        expect(requirementsEqual(REQUIRED, { ...REQUIRED })).toBe(true);
        expect(requirementsEqual(REQUIRED, { ...REQUIRED, identity: "other-tool" })).toBe(false);
        expect(requirementsEqual(REQUIRED, { ...REQUIRED, minimumVersion: "1.1.0" })).toBe(false);
        expect(requirementsEqual(REQUIRED, { ...REQUIRED, versionComparison: "semver-latest" })).toBe(false);
    });
});

describe("the version verdict", () => {
    it("meets the minimum at the boundary and above", () => {
        expect(judgeToolVersion(REQUIRED, facts("1.0.0"))).toEqual({
            status: "meets-minimum",
            observedVersion: "1.0.0",
            minimumVersion: "1.0.0",
        });
        expect(judgeToolVersion(REQUIRED, facts("1.1.0")).status).toBe("meets-minimum");
        expect(judgeToolVersion(REQUIRED, facts("2.0.0")).status).toBe("meets-minimum");
    });

    it("refuses below the minimum and never guesses", () => {
        expect(judgeToolVersion(REQUIRED, facts("0.9.9"))).toEqual({
            status: "below-minimum",
            observedVersion: "0.9.9",
            minimumVersion: "1.0.0",
        });
        expect(judgeToolVersion(REQUIRED, facts("1.0.9")).status).toBe("meets-minimum");
        expect(judgeToolVersion(REQUIRED, facts("0.x"))).toMatchObject({ status: "unparseable-version" });
    });

    it("refuses an unparseable requirement side explicitly", () => {
        const sloppy: ToolRequirement = { ...REQUIRED, minimumVersion: "v1" };
        const verdict = judgeToolVersion(sloppy, facts("1.1.0"));
        expect(verdict.status).toBe("unparseable-version");
    });

    it("refuses a comparison rule it does not implement — never a silent fallback", () => {
        const other: ToolRequirement = { ...REQUIRED, versionComparison: "semver-latest" };
        expect(judgeToolVersion(other, facts("1.1.0"))).toEqual({
            status: "comparison-rule-unsupported",
            rule: "semver-latest",
        });
    });
});

describe("the supported-target fact", () => {
    it("extracts the tool's published targets verbatim, as a frozen copy", () => {
        const source: string[] = ["gglab-dx12", "gglab-vulkan13"];
        const extracted = extractSupportedTargets(facts("1.1.0", "gglab-shaderc", source));
        expect(extracted).toEqual(["gglab-dx12", "gglab-vulkan13"]);
        source.push("gglab-imaginary");
        expect(extracted).toEqual(["gglab-dx12", "gglab-vulkan13"]);
    });

    it("takes no configuration argument: coverage is never judged here", () => {
        // The signature accepts tool facts only — there is no
        // "configured target" input for the client to judge against.
        expect(extractSupportedTargets(facts("1.1.0", "gglab-shaderc", [])).length).toBe(0);
    });

    it("holds the adjudicated wire name, not the typo seen in discussion threads", () => {
        expect(extractSupportedTargets(facts("1.1.0"))).toContain("gglab-vulkan13");
        expect(extractSupportedTargets(facts("1.1.0"))).not.toContain("gglab-vulkan");
    });
});
