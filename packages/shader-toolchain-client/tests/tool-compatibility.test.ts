import { describe, expect, it } from "vitest";
import type { ToolRequirement } from "../src/contract-facts.js";
import { readHandshakeDocument } from "../src/handshake-document.js";
import {
    applyCompatibilityEvent,
    initialToolState,
    type CompatibilityEvent,
    type CompatibilityJudgment,
    type ToolCompatibilityState,
} from "../src/tool-compatibility.js";
import { DESCRIBE_COMPILER_UNAVAILABLE, DESCRIBE_SUCCESS } from "./fixtures/envelope-goldens.js";

const REQUIRED: ToolRequirement = {
    identity: "gglab-shaderc",
    minimumVersion: "1.0.0",
    versionComparison: "semver",
};

/** Today's world: the client declares no supported contract. */
const WORLD: CompatibilityJudgment = { requirement: REQUIRED, supportedRange: null };
const SUPPORTS_V1: CompatibilityJudgment = { requirement: REQUIRED, supportedRange: { minimum: 1, maximum: 1 } };
const SUPPORTS_V2_3: CompatibilityJudgment = { requirement: REQUIRED, supportedRange: { minimum: 2, maximum: 3 } };

function mutatedDescribeSuccess(change: (base: Record<string, unknown>) => Record<string, unknown>): string {
    const base = JSON.parse(DESCRIBE_SUCCESS) as Record<string, unknown>;
    return JSON.stringify(change(base));
}

function handshake(text: string): CompatibilityEvent {
    return { kind: "handshake", read: readHandshakeDocument(text) };
}

describe("the ToolCompatibility state machine", () => {
    it("starts unavailable: no candidate resolved by the discovery rules", () => {
        expect(initialToolState.status).toBe("unavailable");
    });

    it("has no candidate to handshake while unavailable — the state stays honest", () => {
        const state = applyCompatibilityEvent(initialToolState, handshake(DESCRIBE_SUCCESS), WORLD);
        expect(state.status).toBe("unavailable");
        const discoveryFailed = applyCompatibilityEvent(initialToolState, { kind: "discovery-failed" }, WORLD);
        expect(discoveryFailed.status).toBe("unavailable");
    });

    it("a resolved candidate is a FACT: discovered, never a readiness claim", () => {
        const state = applyCompatibilityEvent(initialToolState, { kind: "candidate-resolved" }, WORLD);
        expect(state.status).toBe("discovered");
        expect(state).not.toHaveProperty("verdict");
    });

    it("under the empty declaration, a well-read v1 handshake leaves the tool unproven — visible, not a gap", () => {
        const state = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_SUCCESS),
            WORLD,
        );
        expect(state.status).toBe("unproven");
        if (state.status === "unproven") {
            expect(state.reasons).toHaveLength(1);
            const reason = state.reasons[0];
            if (reason === undefined) {
                throw new Error("test setup: exactly one reason is expected");
            }
            expect(reason).toEqual({
                reason: "contract-not-supported",
                contract: {
                    supported: false,
                    reason: "no-supported-contract-declared",
                    observedVersion: 1,
                },
            });
        }
    });

    it("a handshake whose facts are absent is unproven, with the tool's own diagnostics preserved", () => {
        const state = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_COMPILER_UNAVAILABLE),
            WORLD,
        );
        expect(state.status).toBe("unproven");
        if (state.status === "unproven") {
            const reason = state.reasons[0];
            if (reason === undefined) {
                throw new Error("test setup: exactly one reason is expected");
            }
            expect(reason.reason).toBe("handshake-facts-absent");
            if (reason.reason === "handshake-facts-absent") {
                expect(reason.diagnostics).toEqual([
                    { message: "DXC producer runtime could not be resolved" },
                ]);
                expect(reason.detail).toContain("compiler-unavailable");
            }
        }
    });

    it("an unreadable document is unproven with the refusal visible — never a guess", () => {
        const state = applyCompatibilityEvent(
            { status: "discovered" },
            handshake("{ not json"),
            WORLD,
        );
        expect(state.status).toBe("unproven");
        if (state.status === "unproven") {
            const reason = state.reasons[0];
            if (reason === undefined || reason.reason !== "handshake-facts-absent") {
                throw new Error("test setup: the facts-absent reason is expected");
            }
            expect(reason.detail).toContain("not-json");
        }
    });

    it("proves the tool compatible when a declared range covers the axis and the facts meet the requirement", () => {
        const state = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_SUCCESS),
            SUPPORTS_V1,
        );
        expect(state.status).toBe("compatible");
        if (state.status === "compatible") {
            expect(state.provenFacts.toolIdentity).toBe("gglab-shaderc");
            expect(state.provenFacts.toolVersion).toBe("1.1.0");
            expect(state.provenFacts.supportedTargets).toEqual(["gglab-dx12", "gglab-vulkan13"]);
            expect(state.proof.processContractVersion).toBe(1);
        }
    });

    it("collects every contradicted fact as a visible mismatch", () => {
        const badIdentity = mutatedDescribeSuccess((base) => ({ ...base, toolIdentity: "other-tool" }));
        const fromIdentity = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(badIdentity),
            SUPPORTS_V1,
        );
        expect(fromIdentity.status).toBe("incompatible");
        if (fromIdentity.status === "incompatible") {
            expect(fromIdentity.mismatches).toHaveLength(1);
            expect(fromIdentity.mismatches[0]).toMatchObject({ kind: "identity" });
        }

        const belowMinimum = mutatedDescribeSuccess((base) => ({ ...base, toolVersion: "0.9.0" }));
        const fromVersion = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(belowMinimum),
            SUPPORTS_V1,
        );
        expect(fromVersion.status).toBe("incompatible");
        if (fromVersion.status === "incompatible") {
            expect(fromVersion.mismatches[0]).toMatchObject({ kind: "version" });
            if (fromVersion.mismatches[0]?.kind === "version") {
                expect(fromVersion.mismatches[0].version.status).toBe("below-minimum");
            }
        }

        const both = mutatedDescribeSuccess((base) => ({
            ...base,
            toolIdentity: "other-tool",
            toolVersion: "0.9.0",
        }));
        const fromBoth = applyCompatibilityEvent({ status: "discovered" }, handshake(both), SUPPORTS_V1);
        expect(fromBoth.status).toBe("incompatible");
        if (fromBoth.status === "incompatible") {
            expect(fromBoth.mismatches.map((mismatch) => mismatch.kind).sort()).toEqual(["identity", "version"]);
        }
    });

    it("refuses an unknown comparison rule as an incompatibility — never a silent fallback", () => {
        const otherRule: CompatibilityJudgment = {
            requirement: { ...REQUIRED, versionComparison: "semver-latest" },
            supportedRange: { minimum: 1, maximum: 1 },
        };
        const state = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_SUCCESS),
            otherRule,
        );
        expect(state.status).toBe("incompatible");
        if (state.status === "incompatible") {
            const mismatch = state.mismatches[0];
            if (mismatch === undefined || mismatch.kind !== "version" || mismatch.version.status !== "comparison-rule-unsupported") {
                throw new Error("test setup: the rule refusal is expected");
            }
            expect(mismatch.version.rule).toBe("semver-latest");
        }
    });

    it("treats an out-of-range contract axis as the tool's facts contradicting the required ones", () => {
        const state = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_SUCCESS),
            SUPPORTS_V2_3,
        );
        expect(state.status).toBe("incompatible");
        if (state.status === "incompatible") {
            const mismatch = state.mismatches[0];
            if (mismatch === undefined || mismatch.kind !== "contract-axis") {
                throw new Error("test setup: the contract-axis mismatch is expected");
            }
            expect(mismatch.contract).toEqual({
                supported: false,
                reason: "observed-version-outside-range",
                observedVersion: 1,
                range: { minimum: 2, maximum: 3 },
            });
        }
    });

    it("keeps the handshake legal after proof is lost, and re-enters compatible for a same-path update", () => {
        const compatible = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_SUCCESS),
            SUPPORTS_V1,
        );
        if (compatible.status !== "compatible") {
            throw new Error("test setup: the tool must be compatible");
        }
        // The candidate re-resolves (the same path, a new binary): proof
        // is a handshake result, so the state returns to the FACT.
        const updated = applyCompatibilityEvent(compatible, { kind: "candidate-resolved" }, SUPPORTS_V1);
        expect(updated.status).toBe("discovered");
        // And the refreshed handshake proves it again.
        const reentered = applyCompatibilityEvent(updated, handshake(DESCRIBE_SUCCESS), SUPPORTS_V1);
        expect(reentered.status).toBe("compatible");
    });

    it("lets an updated same-path binary lose its proof when its new facts contradict the requirement", () => {
        const compatible = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_SUCCESS),
            SUPPORTS_V1,
        );
        if (compatible.status !== "compatible") {
            throw new Error("test setup: the tool must be compatible");
        }
        const regressed = applyCompatibilityEvent(
            compatible,
            handshake(mutatedDescribeSuccess((base) => ({ ...base, toolVersion: "0.9.9" }))),
            SUPPORTS_V1,
        );
        expect(regressed.status).toBe("incompatible");
        const factsLost = applyCompatibilityEvent(compatible, handshake(DESCRIBE_COMPILER_UNAVAILABLE), SUPPORTS_V1);
        expect(factsLost.status).toBe("unproven");
    });

    it("drops to unavailable when the tool is no longer resolvable, from any resolved state", () => {
        for (const state of [
            { status: "discovered" },
            { status: "unproven", reasons: [{ reason: "handshake-facts-absent" as const, detail: "x", diagnostics: [] }] },
            { status: "incompatible", mismatches: [] },
        ] as readonly ToolCompatibilityState[]) {
            expect(applyCompatibilityEvent(state, { kind: "candidate-lost" }, WORLD).status).toBe("unavailable");
        }
        const compatible = applyCompatibilityEvent(
            { status: "discovered" },
            handshake(DESCRIBE_SUCCESS),
            SUPPORTS_V1,
        );
        if (compatible.status === "compatible") {
            expect(applyCompatibilityEvent(compatible, { kind: "discovery-failed" }, WORLD).status).toBe("unavailable");
        }
    });

    it("does not judge target coverage: the facts are held, the judgment is the editor's", () => {
        // A tool publishing only the dx12 target is still proven
        // compatible here; whether the CONFIGURED target is among them
        // has no place in this verdict.
        const dx12Only = mutatedDescribeSuccess((base) => ({ ...base, supportedTargets: ["gglab-dx12"] }));
        const state = applyCompatibilityEvent({ status: "discovered" }, handshake(dx12Only), SUPPORTS_V1);
        expect(state.status).toBe("compatible");
        if (state.status === "compatible") {
            expect(state.provenFacts.supportedTargets).toEqual(["gglab-dx12"]);
        }
    });
});
