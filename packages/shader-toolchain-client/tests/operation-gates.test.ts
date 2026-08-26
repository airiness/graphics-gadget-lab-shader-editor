import { describe, expect, it } from "vitest";
import {
    admitCompile,
    admitHandshake,
    type ToolCompatibilityState,
} from "../src/tool-compatibility.js";
import { initialToolState } from "../src/tool-compatibility.js";

/**
 * The client's tool-operation guarantee, split by gate (toolchain
 * integration design, section 14): a COMPILE request is never formed out
 * of an unavailable / discovered / unproven / incompatible tool — the
 * refusal is a structured result carrying the state's own reasons
 * (named in the design's NotReady reason vocabulary); a HANDSHAKE IS
 * formed for any resolved candidate — refusing it on unproven would make
 * compatible unreachable.
 */
const UNAVAILABLE = initialToolState;
const DISCOVERED: ToolCompatibilityState = { status: "discovered" };
const UNPROVEN: ToolCompatibilityState = {
    status: "unproven",
    reasons: [
        {
            reason: "contract-not-supported",
            contract: { supported: false, reason: "no-supported-contract-declared", observedVersion: 1 },
        },
    ],
};
const INCOMPATIBLE: ToolCompatibilityState = {
    status: "incompatible",
    mismatches: [
        {
            kind: "identity",
            identity: { status: "mismatch", requiredIdentity: "gglab-shaderc", reportedIdentity: "other-tool" },
        },
    ],
};
const COMPATIBLE: ToolCompatibilityState = {
    status: "compatible",
    provenFacts: {
        toolIdentity: "gglab-shaderc",
        toolVersion: "1.1.0",
        processContractVersion: 1,
        producerKind: "dxc",
        producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
    },
    proof: { processContractVersion: 1 },
};

describe("the handshake gate", () => {
    it("is legal for every resolved candidate", () => {
        for (const state of [DISCOVERED, UNPROVEN, INCOMPATIBLE, COMPATIBLE] as readonly ToolCompatibilityState[]) {
            expect(admitHandshake(state)).toEqual({ admitted: true });
        }
    });

    it("is refused only while unavailable — no candidate to handshake", () => {
        expect(admitHandshake(UNAVAILABLE)).toEqual({
            admitted: false,
            reasons: [{ reason: "tool-unavailable" }],
        });
    });
});

describe("the compile gate", () => {
    it("admits a compile request only for a compatible, proven tool", () => {
        expect(admitCompile(COMPATIBLE)).toEqual({ admitted: true });
    });

    it("refuses with the state's own structured reasons, never silently", () => {
        expect(admitCompile(UNAVAILABLE).admitted).toBe(false);
        expect(admitCompile(DISCOVERED).admitted).toBe(false);
        expect(admitCompile(UNPROVEN).admitted).toBe(false);
        expect(admitCompile(INCOMPATIBLE).admitted).toBe(false);
    });

    it("carries the NotReady-reason vocabulary verbatim", () => {
        const refused = admitCompile(UNPROVEN);
        if (refused.admitted !== false) {
            throw new Error("test setup: an unproven tool must be refused");
        }
        expect(refused.reasons).toEqual([
            { reason: "tool-unproven", reasons: UNPROVEN.status === "unproven" ? UNPROVEN.reasons : [] },
        ]);
        const incompatibleRefusal = admitCompile(INCOMPATIBLE);
        if (incompatibleRefusal.admitted !== false) {
            throw new Error("test setup: an incompatible tool must be refused");
        }
        expect(incompatibleRefusal.reasons).toEqual([
            { reason: "tool-incompatible", mismatches: INCOMPATIBLE.status === "incompatible" ? INCOMPATIBLE.mismatches : [] },
        ]);
        const discoveredRefusal = admitCompile(DISCOVERED);
        if (discoveredRefusal.admitted !== false) {
            throw new Error("test setup: a discovered-only tool must be refused");
        }
        const discoveredReason = discoveredRefusal.reasons[0];
        if (discoveredReason === undefined) {
            throw new Error("test setup: exactly one reason is expected");
        }
        expect(discoveredReason.reason).toBe("tool-discovered");
        if (discoveredReason.reason === "tool-discovered") {
            expect(discoveredReason.detail).toContain("handshake");
        }
    });
});
