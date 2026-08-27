import { describe, expect, it } from "vitest";
import { initialToolState, admitCompile, admitHandshake, type ToolCompatibilityState } from "../src/tool-compatibility.js";
import type { BoundaryOutput, ToolCandidate } from "../src/host-boundary.js";
import { applyCompatibilityEvent } from "../src/tool-compatibility.js";
import { readHandshakeOutput } from "../src/process-output.js";
import { utf8Encode } from "../src/utf8.js";

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

const HANDSHAKE_TEXT =
    '{"command":"describe","success":true,"status":"ok","exitCode":0,"processContractVersion":1,"toolIdentity":"gglab-shaderc","toolVersion":"1.1.0","producerKind":"dxc","producerIdentity":"Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)","supportedTargets":["gglab-dx12","gglab-vulkan13"],"diagnostics":[]}';

function outputOf(text: string): BoundaryOutput {
    return {
        stdout: utf8Encode(text),
        stderr: new Uint8Array(0),
        exitCode: 0,
        timedOut: false,
        canceled: false,
    };
}

function compatibleState(candidate: ToolCandidate = CANDIDATE): ToolCompatibilityState {
    const state = applyCompatibilityEvent(
        { status: "discovered", candidate },
        { kind: "handshake", candidate, result: { kind: "spawned", process: readHandshakeOutput(outputOf(HANDSHAKE_TEXT)) } },
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
            { status: "unproven", candidate: CANDIDATE, reasons: [{ reason: "handshake-facts-absent", detail: "x", diagnostics: [] }] },
            { status: "incompatible", candidate: CANDIDATE, mismatches: [] },
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
                reason: "proof-not-for-this-candidate",
                detail:
                    "the proof was taken under a different candidate observation (path or provenance changed); " +
                    "re-resolve and re-handshake this candidate",
            },
        ]);
        // And the state itself keeps owning the candidate the proof
        // belongs to — one authority for "which candidate".
        if (state.status !== "compatible") {
            throw new Error("test setup: the tool must be compatible here");
        }
        expect(state.candidate).toEqual(CANDIDATE);
        expect(state.proof).toEqual({ processContractVersion: 1 });
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
            candidate: CANDIDATE,
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
            candidate: CANDIDATE,
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
