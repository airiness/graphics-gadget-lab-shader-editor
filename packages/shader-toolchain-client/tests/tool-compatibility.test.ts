import { describe, expect, it } from "vitest";
import type { ToolRequirement } from "../src/contract-facts.js";
import { readHandshakeDocument } from "../src/handshake-document.js";
import type { BoundaryOutput, ToolCandidate } from "../src/host-boundary.js";
import { readHandshakeOutput } from "../src/process-output.js";
import {
    applyCompatibilityEvent,
    initialToolState,
    type CompatibilityEvent,
    type CompatibilityJudgment,
    type ToolCompatibilityState,
} from "../src/tool-compatibility.js";
import { utf8Encode } from "../src/utf8.js";
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

/** A clean spawned settlement of the scripted document text — its
 *  process exit code mirrors the document's own, as the contract
 *  requires. */
function outputOf(text: string): BoundaryOutput {
    // The process exit code mirrors the document's own when the document
    // is readable; unreadable scripts carry the plain 0 fact.
    let exitCode = 0;
    try {
        const doc = JSON.parse(text) as Record<string, unknown>;
        if (typeof doc.exitCode === "number") {
            exitCode = doc.exitCode;
        }
    } catch {
        // the script is not a JSON document — that is the point of some
        // of the tests that use it
    }
    return {
        stdout: utf8Encode(text),
        stderr: new Uint8Array(0),
        exitCode,
        timedOut: false,
        canceled: false,
    };
}

function handshake(
    candidate: ToolCandidate,
    text: string,
    range?: Parameters<typeof readHandshakeDocument>[1],
): CompatibilityEvent {
    const process = range === undefined ? readHandshakeOutput(outputOf(text)) : readHandshakeOutput(outputOf(text), range);
    return { kind: "handshake", candidate, result: { kind: "spawned", process } };
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
            if (reason === undefined || reason.reason !== "handshake-unreadable") {
                throw new Error("test setup: the unreadable reason is expected");
            }
            expect(reason.rejection.reason).toBe("not-json");
        }
    });

    it("maps the process-level settlements to explicit structured states", () => {
        const discovered: ToolCompatibilityState = { status: "discovered", candidate: CANDIDATE };

        // A broken channel rule is unproven, with the violation carried
        // verbatim — not folded into a prose reason.
        const channel: CompatibilityEvent = {
            kind: "handshake",
            candidate: CANDIDATE,
            result: {
                kind: "spawned",
                process: {
                    kind: "channel-violated",
                    violation: { reason: "stderr-non-empty", byteLength: 3 },
                },
            },
        };
        expect(applyCompatibilityEvent(discovered, channel, REQUIREMENT)).toEqual({
            status: "unproven",
            reasons: [{ reason: "channel-violated", violation: { reason: "stderr-non-empty", byteLength: 3 } }],
        });

        // Bounded execution ending the attempt is unproven of its own.
        const timedOut: CompatibilityEvent = {
            kind: "handshake",
            candidate: CANDIDATE,
            result: { kind: "spawned", process: { kind: "timed-out" } },
        };
        expect(applyCompatibilityEvent(discovered, timedOut, REQUIREMENT)).toEqual({
            status: "unproven",
            reasons: [{ reason: "handshake-timed-out" }],
        });

        // Bounded execution failing to launch is unproven, even for a
        // previously compatible, proven tool — a fact, not an accident.
        const compatible = applyCompatibilityEvent(discovered, handshake(CANDIDATE, DESCRIBE_SUCCESS), REQUIREMENT);
        const launch: CompatibilityEvent = {
            kind: "handshake",
            candidate: CANDIDATE,
            result: { kind: "launch-failed" },
        };
        expect(applyCompatibilityEvent(compatible, launch, REQUIREMENT)).toEqual({
            status: "unproven",
            reasons: [{ reason: "launch-failed" }],
        });
    });

    it("treats a canceled handshake as NO tool evidence — the state stays exactly as it was", () => {
        const canceled: CompatibilityEvent = {
            kind: "handshake",
            candidate: CANDIDATE,
            result: { kind: "spawned", process: { kind: "canceled" } },
        };
        const states: readonly ToolCompatibilityState[] = [
            { status: "discovered", candidate: CANDIDATE },
            { status: "unproven", reasons: [{ reason: "handshake-timed-out" }] },
            applyCompatibilityEvent({ status: "discovered", candidate: CANDIDATE }, handshake(CANDIDATE, DESCRIBE_SUCCESS), REQUIREMENT),
        ];
        for (const state of states) {
            expect(applyCompatibilityEvent(state, canceled, REQUIREMENT)).toEqual(state);
        }
    });

    it("drops the proof when the host invalidates the candidate's observation — from whatever path it arrived", () => {
        const compatible = applyCompatibilityEvent(
            { status: "discovered", candidate: CANDIDATE },
            handshake(CANDIDATE, DESCRIBE_SUCCESS),
            REQUIREMENT,
        );
        if (compatible.status !== "compatible") {
            throw new Error("test setup: the tool must be compatible");
        }
        expect(compatible.proof.candidate).toEqual(CANDIDATE);

        // Candidate invalidation is a LIFECYCLE event: the host reports it
        // alike on a handshake or on a compile attempt, and the refuted
        // observation stops being a FACT. The tool goes to `unavailable` —
        // no currently valid candidate, nothing to handshake, and the old
        // observation cannot loop back into proof. Re-entry is only a
        // fresh discovery for a new observation + handshake.
        for (const observation of [
            { observation: "changed" as const, observedIdentity: "file-identity:replaced" },
            { observation: "missing" as const, observedIdentity: null },
            { observation: "unreadable" as const, observedIdentity: null },
        ]) {
            const event: CompatibilityEvent = {
                kind: "candidate-invalidated",
                candidate: CANDIDATE,
                observation: observation.observation,
                observedIdentity: observation.observedIdentity,
            };
            expect(applyCompatibilityEvent(compatible, event, REQUIREMENT)).toEqual({
                status: "unavailable",
            });
        }

        // And from any resolved state, not only compatible.
        expect(
            applyCompatibilityEvent({ status: "discovered", candidate: CANDIDATE }, {
                kind: "candidate-invalidated",
                candidate: CANDIDATE,
                observation: "missing",
                observedIdentity: null,
            }, REQUIREMENT),
        ).toEqual({ status: "unavailable" });
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
