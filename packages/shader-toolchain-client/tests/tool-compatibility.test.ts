import { describe, expect, it } from "vitest";
import type { ToolRequirement } from "../src/contract-facts.js";
import { readHandshakeDocument } from "../src/handshake-document.js";
import type { ToolCandidate } from "../src/host-boundary.js";
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

/** The machine's own judgment input: the requirement. The contract-axis
 *  judgment rides in with the reading (the reader gated it against the
 *  declaration), so the worlds are expressed through the reader's range
 *  parameter, not the machine's input. */
const REQUIREMENT: CompatibilityJudgment = { requirement: REQUIRED };

const CANDIDATE: ToolCandidate = {
    rule: "sibling-build",
    toolPath: "C:/gglab/build/output/x64/Debug/gglab-shaderc.exe",
    observationIdentity: "file-identity:sha256:9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c",
    resolvedAt: 1_700_000_000_000,
};

function mutatedDescribeSuccess(change: (base: Record<string, unknown>) => Record<string, unknown>): string {
    const base = JSON.parse(DESCRIBE_SUCCESS) as Record<string, unknown>;
    return JSON.stringify(change(base));
}

function handshake(
    candidate: ToolCandidate,
    text: string,
    range?: Parameters<typeof readHandshakeDocument>[1],
): CompatibilityEvent {
    return { kind: "handshake", candidate, read: range === undefined ? readHandshakeDocument(text) : readHandshakeDocument(text, range) };
}

describe("the ToolCompatibility state machine", () => {
    it("starts unavailable: no candidate resolved by the discovery rules", () => {
        expect(initialToolState.status).toBe("unavailable");
    });

    it("has no candidate to handshake while unavailable — the state stays honest", () => {
        const state = applyCompatibilityEvent(initialToolState, handshake(CANDIDATE, DESCRIBE_SUCCESS), REQUIREMENT);
        expect(state.status).toBe("unavailable");
        const discoveryFailed = applyCompatibilityEvent(initialToolState, { kind: "discovery-failed" }, REQUIREMENT);
        expect(discoveryFailed.status).toBe("unavailable");
    });

    it("a resolved candidate is a FACT with its observation, never a readiness claim", () => {
        const state = applyCompatibilityEvent(initialToolState, { kind: "candidate-resolved", candidate: CANDIDATE }, REQUIREMENT);
        expect(state.status).toBe("discovered");
        if (state.status !== "discovered") {
            throw new Error("test setup: the state must be discovered");
        }
        expect(state.candidate).toEqual(CANDIDATE);
    });

    it("proves the published v1 tool compatible under the declaration — the gate opens at the client level", () => {
        const state = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS),
            REQUIREMENT,
        );
        expect(state.status).toBe("compatible");
        if (state.status !== "compatible") {
            throw new Error("test setup: the v1 handshake must prove the tool under the declaration");
        }
        expect(state.provenFacts.toolIdentity).toBe("gglab-shaderc");
        expect(state.provenFacts.toolVersion).toBe("1.1.0");
        expect(state.provenFacts.supportedTargets).toEqual(["gglab-dx12", "gglab-vulkan13"]);
        expect(state.proof.processContractVersion).toBe(1);
        expect(state.proof.candidate).toEqual(CANDIDATE);
    });

    it("keeps the contract-not-supported path for the null-declaration world — unproven, with the refusal visible", () => {
        // The null-declaration world is reached through the reader's
        // range parameter: the axis gate refuses the observation and the
        // machine maps it to unproven with the structured reason.
        const state = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS, null),
            REQUIREMENT,
        );
        expect(state.status).toBe("unproven");
        if (state.status === "unproven") {
            expect(state.reasons).toEqual([
                {
                    reason: "contract-not-supported",
                    contract: {
                        supported: false,
                        reason: "no-supported-contract-declared",
                        observedVersion: 1,
                    },
                },
            ]);
        }
    });

    it("keeps the out-of-range path: a declared range that misses the axis is an incompatibility", () => {
        // …reached the same way: an explicitly supplied range that does
        // not cover the observed v1 axis.
        const state = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS, { minimum: 2, maximum: 3 }),
            REQUIREMENT,
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

    it("a handshake whose facts are absent is unproven, with the tool's own diagnostics preserved", () => {
        const state = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_COMPILER_UNAVAILABLE),
            REQUIREMENT,
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
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, "{ not json"),
            REQUIREMENT,
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

    it("collects every contradicted fact as a visible mismatch", () => {
        const badIdentity = mutatedDescribeSuccess((base) => ({ ...base, toolIdentity: "other-tool" }));
        const fromIdentity = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, badIdentity),
            REQUIREMENT,
        );
        expect(fromIdentity.status).toBe("incompatible");
        if (fromIdentity.status === "incompatible") {
            expect(fromIdentity.mismatches[0]).toMatchObject({ kind: "identity" });
        }

        const belowMinimum = mutatedDescribeSuccess((base) => ({ ...base, toolVersion: "0.9.0" }));
        const fromVersion = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, belowMinimum),
            REQUIREMENT,
        );
        expect(fromVersion.status).toBe("incompatible");
        if (fromVersion.status === "incompatible") {
            const mismatch = fromVersion.mismatches[0];
            if (mismatch === undefined || mismatch.kind !== "version" || mismatch.version.status !== "below-minimum") {
                throw new Error("test setup: the below-minimum version mismatch is expected");
            }
        }

        const both = mutatedDescribeSuccess((base) => ({
            ...base,
            toolIdentity: "other-tool",
            toolVersion: "0.9.0",
        }));
        const fromBoth = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, both),
            REQUIREMENT,
        );
        expect(fromBoth.status).toBe("incompatible");
        if (fromBoth.status === "incompatible") {
            expect(fromBoth.mismatches.map((mismatch) => mismatch.kind).sort()).toEqual(["identity", "version"]);
        }
    });

    it("refuses an unknown comparison rule as an incompatibility — never a silent fallback", () => {
        const otherRule: CompatibilityJudgment = {
            requirement: { ...REQUIRED, versionComparison: "semver-latest" },
        };
        const state = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS),
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

    it("binds the proof to the candidate observation it was taken under", () => {
        const compatible = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS),
            REQUIREMENT,
        );
        if (compatible.status !== "compatible") {
            throw new Error("test setup: the tool must be compatible");
        }
        expect(compatible.proof.candidate).toEqual(CANDIDATE);

        // A re-handshake under a DIFFERENT observation (same path, new
        // binary) re-proves for THAT observation — the old binding is
        // replaced, not extended.
        const otherObservation: ToolCandidate = { ...CANDIDATE, observationIdentity: "file-identity:new-binary" };
        const rebound = applyCompatibilityEvent(compatible, handshake(otherObservation, DESCRIBE_SUCCESS), REQUIREMENT);
        expect(rebound.status).toBe("compatible");
        if (rebound.status === "compatible") {
            expect(rebound.proof.candidate).toEqual(otherObservation);
        }

        // And a candidate-resolved event for a distinct observation drops
        // the proof entirely — back to the FACT.
        const thirdObservation: ToolCandidate = { ...CANDIDATE, observationIdentity: "file-identity:third-binary" };
        const dropped = applyCompatibilityEvent(rebound, { kind: "candidate-resolved", candidate: thirdObservation }, REQUIREMENT);
        expect(dropped).toEqual({ status: "discovered", candidate: thirdObservation });
    });

    it("lets an updated same-path binary lose its proof when its new facts contradict the requirement", () => {
        const compatible = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS),
            REQUIREMENT,
        );
        if (compatible.status !== "compatible") {
            throw new Error("test setup: the tool must be compatible");
        }
        const regressed = applyCompatibilityEvent(
            compatible,
            handshake(CANDIDATE, mutatedDescribeSuccess((base) => ({ ...base, toolVersion: "0.9.9" }))),
            REQUIREMENT,
        );
        expect(regressed.status).toBe("incompatible");
        const factsLost = applyCompatibilityEvent(compatible, handshake(CANDIDATE, DESCRIBE_COMPILER_UNAVAILABLE), REQUIREMENT);
        expect(factsLost.status).toBe("unproven");
    });

    it("drops to unavailable when the tool is no longer resolvable, from any resolved state", () => {
        for (const state of [
            { status: "discovered", candidate: CANDIDATE },
            { status: "unproven", reasons: [{ reason: "handshake-facts-absent" as const, detail: "x", diagnostics: [] }] },
            { status: "incompatible", mismatches: [] },
        ] as readonly ToolCompatibilityState[]) {
            expect(applyCompatibilityEvent(state, { kind: "candidate-lost" }, REQUIREMENT).status).toBe("unavailable");
        }
        const compatible = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS),
            REQUIREMENT,
        );
        if (compatible.status === "compatible") {
            expect(applyCompatibilityEvent(compatible, { kind: "discovery-failed" }, REQUIREMENT).status).toBe("unavailable");
        }
    });

    it("does not judge target coverage: the facts are held, the judgment is the editor's", () => {
        const dx12Only = mutatedDescribeSuccess((base) => ({ ...base, supportedTargets: ["gglab-dx12"] }));
        const state = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, dx12Only),
            REQUIREMENT,
        );
        expect(state.status).toBe("compatible");
        if (state.status === "compatible") {
            expect(state.provenFacts.supportedTargets).toEqual(["gglab-dx12"]);
        }
    });
});
