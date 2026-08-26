import { describe, expect, it } from "vitest";
import { initialToolState, admitCompile, admitHandshake, type ToolCompatibilityState } from "../src/tool-compatibility.js";
import type { ToolCandidate } from "../src/host-boundary.js";
import { applyCompatibilityEvent } from "../src/tool-compatibility.js";
import { readHandshakeDocument } from "../src/handshake-document.js";

const CANDIDATE: ToolCandidate = {
    rule: "sibling-build",
    toolPath: "C:/gglab/build/output/x64/Debug/gglab-shaderc.exe",
    observationIdentity: "file-identity:sha256:9c",
    resolvedAt: 1_700_000_000_000,
};

const OTHER_OBSERVATION: ToolCandidate = { ...CANDIDATE, observationIdentity: "file-identity:replaced-binary" };

const REASONABLE = {
    requirement: { identity: "gglab-shaderc", minimumVersion: "1.0.0", versionComparison: "semver" },
} as const;

function compatibleState(candidate: ToolCandidate = CANDIDATE): ToolCompatibilityState {
    const state = applyCompatibilityEvent(
        { status: "discovered", candidate },
        { kind: "handshake", candidate, read: readHandshakeDocument('{"command":"describe","success":true,"status":"ok","exitCode":0,"processContractVersion":1,"toolIdentity":"gglab-shaderc","toolVersion":"1.1.0","producerKind":"dxc","producerIdentity":"Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)","supportedTargets":["gglab-dx12","gglab-vulkan13"],"diagnostics":[]}') },
        REASONABLE,
    );
    if (state.status !== "compatible") {
        throw new Error("test setup: the handshake must prove the tool");
    }
    return state;
}

describe("the handshake gate", () => {
    it("is legal for every resolved candidate state", () => {
        const states: readonly ToolCompatibilityState[] = [
            { status: "discovered", candidate: CANDIDATE },
            { status: "unproven", reasons: [{ reason: "handshake-facts-absent", detail: "x", diagnostics: [] }] },
            { status: "incompatible", mismatches: [] },
            compatibleState(),
        ];
        for (const state of states) {
            expect(admitHandshake(state)).toEqual({ admitted: true });
        }
    });

    it("is refused only while unavailable — no candidate to handshake", () => {
        expect(admitHandshake(initialToolState)).toEqual({
            admitted: false,
            reasons: [{ reason: "tool-unavailable" }],
        });
    });
});

describe("the compile gate", () => {
    it("admits a compile request only for the candidate observation its proof was taken under", () => {
        const state = compatibleState();
        expect(admitCompile(state, CANDIDATE)).toEqual({ admitted: true });
    });

    it("keeps the proof valid for a re-observation of the SAME executable — resolvedAt is metadata, not identity", () => {
        const state = compatibleState();
        // Looked at later, and found by a different rule — but the path
        // and the observed file identity are unchanged: the same
        // candidate, and the proof still applies.
        const reSeen = { ...CANDIDATE, resolvedAt: 1_750_000_000_000, rule: "bundled" as const };
        expect(admitCompile(state, reSeen)).toEqual({ admitted: true });
    });

    it("refuses a different candidate observation for a proven tool — proof does not travel", () => {
        const state = compatibleState();
        const refused = admitCompile(state, OTHER_OBSERVATION);
        expect(refused.admitted).toBe(false);
        if (refused.admitted !== false) {
            throw new Error("test setup: the refusal is expected");
        }
        expect(refused.reasons).toEqual([
            {
                reason: "tool-unproven",
                reasons: [
                    {
                        reason: "proof-not-for-this-candidate",
                        detail:
                            "the proof was taken under a different candidate observation (path or provenance changed); " +
                            "re-resolve and re-handshake this candidate",
                    },
                ],
            },
        ]);
    });

    it("refuses every other resolved state with its own structured reasons", () => {
        expect(admitCompile(initialToolState, CANDIDATE)).toEqual({
            admitted: false,
            reasons: [{ reason: "tool-unavailable" }],
        });

        const discovered = { status: "discovered", candidate: CANDIDATE } as ToolCompatibilityState;
        const discoveredRefusal = admitCompile(discovered, CANDIDATE);
        expect(discoveredRefusal.admitted).toBe(false);
        if (discoveredRefusal.admitted !== false) {
            throw new Error("test setup: the refusal is expected");
        }
        const discoveredReason = discoveredRefusal.reasons[0];
        if (discoveredReason === undefined || discoveredReason.reason !== "tool-discovered") {
            throw new Error("test setup: the tool-discovered reason is expected");
        }
        expect(discoveredReason.detail).toContain("handshake");

        const unproven: ToolCompatibilityState = {
            status: "unproven",
            reasons: [
                {
                    reason: "contract-not-supported",
                    contract: { supported: false, reason: "no-supported-contract-declared", observedVersion: 1 },
                },
            ],
        };
        expect(admitCompile(unproven, CANDIDATE).admitted).toBe(false);

        const incompatible: ToolCompatibilityState = {
            status: "incompatible",
            mismatches: [
                {
                    kind: "identity",
                    identity: { status: "mismatch", requiredIdentity: "gglab-shaderc", reportedIdentity: "other-tool" },
                },
            ],
        };
        const incompatibleRefusal = admitCompile(incompatible, CANDIDATE);
        expect(incompatibleRefusal.admitted).toBe(false);
        if (incompatibleRefusal.admitted !== false) {
            throw new Error("test setup: the refusal is expected");
        }
        expect(incompatibleRefusal.reasons).toEqual([
            {
                reason: "tool-incompatible",
                mismatches: [
                    {
                        kind: "identity",
                        identity: { status: "mismatch", requiredIdentity: "gglab-shaderc", reportedIdentity: "other-tool" },
                    },
                ],
            },
        ]);
    });
});
