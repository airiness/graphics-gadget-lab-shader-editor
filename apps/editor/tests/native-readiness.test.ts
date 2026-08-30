import { describe, expect, it } from "vitest";
import { initialToolState, type ToolCompatibilityState, type UnprovenReason } from "@gglab/shader-toolchain-client";
import {
    composeNativeBuildReadiness,
    readinessAdmitsCompile,
    type NativeBuildReadiness,
    type NativeReadinessInput,
} from "../src/native-build-readiness.js";

/*
 * The product gate, one rung at a time (design authority: the toolchain
 * integration design, section 14 "the gate ... for EACH NotReady reason
 * type nothing is issued and the reason is visible"). These tests pin
 * the COMPOSITION itself — one reason per violated input, the complete
 * visible list otherwise — over the client's tool state space; the
 * "nothing is issued" half of the guarantee is the flow's, and
 * native-build-flow.test.ts pins it at the boundary with fakes.
 */

type CompatibleState = Extract<ToolCompatibilityState, { readonly status: "compatible" }>;

function compatibleTool(): CompatibleState {
    return {
        status: "compatible",
        candidate: { rule: "bundled", toolPath: "C:\\tools\\gglab-shaderc.exe", observationIdentity: "obs-1", resolvedAt: 1000 },
        provenFacts: {
            toolIdentity: "gglab-shaderc",
            toolVersion: "1.2.0",
            processContractVersion: 2,
            compilePolicyRevision: 1,
            producerKind: "dxc",
            producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
            supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
        },
        proof: { processContractVersion: 2, compilePolicyRevision: 1 },
    } as unknown as CompatibleState;
}

/** A resolved candidate as the client states carry it. */
function candidateOf(state: ToolCompatibilityState) {
    return (state as { candidate?: Unknown }).candidate;
}
type Unknown = unknown;

// The base world is the MECHANISM's ready world — a caller that OWNS a
// complete program composition (the flow's machinery is generic over
// that fact). The editor surface's product state (generated function
// only) is pinned by the dedicated describe below, where the fact is
// false and the composition must never be Ready.
function baseInput(overrides: Partial<NativeReadinessInput> = {}): NativeReadinessInput {
    return {
        programCompositionAvailable: true,
        programCompositionDetail: "",
        tool: compatibleTool(),
        descriptorLoaded: true,
        descriptorCompatible: true,
        descriptorDetail: "",
        hostAvailable: true,
        hostDetail: "",
        configuredTarget: "gglab-dx12",
        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
        ...overrides,
    };
}

function reasonsOf(readiness: NativeBuildReadiness): readonly string[] {
    return readiness.status === "Ready" ? [] : readiness.reasons.map((reason) => reason.reason);
}

describe("the NativeBuildReadiness composition — one reason per violated input", () => {
    it("composes Ready when every input is ready (the only Ready)", () => {
        expect(composeNativeBuildReadiness(baseInput())).toEqual({ status: "Ready" });
    });

    it("ToolUnavailable: no valid resolved candidate — the reason is visible with a detail", () => {
        const readiness = composeNativeBuildReadiness(baseInput({ tool: initialToolState, supportedTargets: null }));
        expect(reasonsOf(readiness)).toEqual(["ToolUnavailable"]);
        if (readiness.status === "NotReady") {
            expect(readiness.reasons[0]?.detail).toEqual(expect.stringContaining("candidate"));
        }
    });

    it("ToolDiscovered: a candidate resolved, proof not yet established", () => {
        const readiness = composeNativeBuildReadiness(
            baseInput({
                tool: { status: "discovered", candidate: candidateOf(compatibleTool()) } as unknown as ToolCompatibilityState,
                supportedTargets: null,
            }),
        );
        expect(reasonsOf(readiness)).toEqual(["ToolDiscovered"]);
    });

    it("ToolUnproven: structured reasons carried on the reason", () => {
        const unproven: UnprovenReason = {
            reason: "contract-not-supported",
            contract: { supported: false, reason: "no-supported-contract-declared", observedVersion: 4 },
        };
        const readiness = composeNativeBuildReadiness(
            baseInput({
                tool: { status: "unproven", candidate: candidateOf(compatibleTool()), reasons: [unproven] } as unknown as ToolCompatibilityState,
                supportedTargets: null,
            }),
        );
        expect(reasonsOf(readiness)).toEqual(["ToolUnproven"]);
        if (readiness.status === "NotReady") {
            const reason = readiness.reasons[0];
            expect(reason).toMatchObject({ reason: "ToolUnproven", unprovenDetails: [{ code: "contract-not-supported" }] });
        }
    });

    it("ToolIncompatible: the tool's own facts contradict (target mismatch is NOT one of these)", () => {
        const readiness = composeNativeBuildReadiness(
            baseInput({
                tool: {
                    status: "incompatible",
                    candidate: candidateOf(compatibleTool()),
                    mismatches: [{ kind: "identity", identity: { required: "gglab-shaderc", reported: "other-tool", verdict: "mismatch" } }],
                } as unknown as ToolCompatibilityState,
                supportedTargets: null,
            }),
        );
        expect(reasonsOf(readiness)).toEqual(["ToolIncompatible"]);
    });

    it("DescriptorIncompatible: no instance loaded, and a failed core verdict (the core's own detail carried)", () => {
        const unloaded = composeNativeBuildReadiness(baseInput({ descriptorLoaded: false }));
        expect(reasonsOf(unloaded)).toEqual(["DescriptorIncompatible"]);
        const incompatible = composeNativeBuildReadiness(baseInput({ descriptorCompatible: false, descriptorDetail: "profile-descriptor-incompatible: the profile and the descriptor instance disagree" }));
        expect(reasonsOf(incompatible)).toEqual(["DescriptorIncompatible"]);
        if (incompatible.status === "NotReady") {
            expect(incompatible.reasons[0]?.detail).toEqual(expect.stringContaining("profile and the descriptor instance disagree"));
        }
    });

    it("HostUnavailable: the service is not reachable in this shell, with the detail", () => {
        const readiness = composeNativeBuildReadiness(baseInput({ hostAvailable: false, hostDetail: "web shell — no desktop service" }));
        expect(reasonsOf(readiness)).toEqual(["HostUnavailable"]);
        if (readiness.status === "NotReady") {
            expect(readiness.reasons[0]?.detail).toContain("web shell");
        }
    });

    it("TargetNotConfigured: the target is ALWAYS an explicit configuration", () => {
        expect(reasonsOf(composeNativeBuildReadiness(baseInput({ configuredTarget: null })))).toEqual(["TargetNotConfigured"]);
        expect(reasonsOf(composeNativeBuildReadiness(baseInput({ configuredTarget: "" })))).toEqual(["TargetNotConfigured"]);
    });

    it("TargetUnsupported: the tool stays what it is — this is the BUILD's compatibility, not the tool's", () => {
        const readiness = composeNativeBuildReadiness(
            baseInput({ configuredTarget: "gglab-vulkan99", supportedTargets: ["gglab-dx12", "gglab-vulkan13"] }),
        );
        expect(reasonsOf(readiness)).toEqual(["TargetUnsupported"]);
        if (readiness.status === "NotReady") {
            expect(readiness.reasons[0]).toMatchObject({ reason: "TargetUnsupported", configuredTarget: "gglab-vulkan99", supportedTargets: ["gglab-dx12", "gglab-vulkan13"] });
        }
    });

    it("several violated inputs: the reason list is COMPLETE (every class visible, stable order)", () => {
        const readiness = composeNativeBuildReadiness(
            baseInput({
                tool: initialToolState,
                descriptorLoaded: false,
                hostAvailable: false,
                hostDetail: "no service",
                configuredTarget: null,
                supportedTargets: null,
            }),
        );
        expect(reasonsOf(readiness)).toEqual(["ToolUnavailable", "DescriptorIncompatible", "HostUnavailable", "TargetNotConfigured"]);
    });
});

// The client's tool verdict never oscillates with the target — the
// composition must not leak target-coverage into the tool domain: the
// SAME tool state composes Ready/NotReady(only the target reason) as the
// configuration flips, with no other reason moving.
it("target flip: the tool's verdict is untouched and the ONLY reason that appears is TargetUnsupported", () => {
    const before = composeNativeBuildReadiness(baseInput({ configuredTarget: "gglab-dx12", supportedTargets: ["gglab-dx12"] }));
    const after = composeNativeBuildReadiness(baseInput({ configuredTarget: "gglab-vulkan13", supportedTargets: ["gglab-dx12"] }));
    expect(before).toEqual({ status: "Ready" });
    expect(reasonsOf(after)).toEqual(["TargetUnsupported"]);
    expect(readinessAdmitsCompile(before)).toBe(true);
    expect(readinessAdmitsCompile(after)).toBe(false);
});

describe("the gate admits ONLY Ready", () => {
    it("admits the Ready composition and refuses every NotReady", () => {
        expect(readinessAdmitsCompile({ status: "Ready" })).toBe(true);
        const notReady = composeNativeBuildReadiness(baseInput({ hostAvailable: false, hostDetail: "x" }));
        expect(readinessAdmitsCompile(notReady)).toBe(false);
    });
});

/*
 * The generated-function-only state (Preview Program design v1.0): the
 * surface's own program-composition fact is FALSE, and that alone keeps
 * the composition NotReady — the native production path is closed FOR
 * THE SURFACE, structurally, however ready the mechanism's other inputs
 * are. The gate therefore refuses, and nothing is issued.
 */
describe("the generated-function-only state — ProgramCompositionUnavailable", () => {
    it("unavailable composition alone (the mechanism fully ready): NotReady, its reason only, detail visible, gate refuses", () => {
        const readiness = composeNativeBuildReadiness(
            baseInput({
                programCompositionAvailable: false,
                programCompositionDetail: "the surface owns no complete-program composition for the generated function",
            }),
        );
        expect(reasonsOf(readiness)).toEqual(["ProgramCompositionUnavailable"]);
        if (readiness.status === "NotReady") {
            expect(readiness.reasons[0]?.detail).toEqual(
                "the surface owns no complete-program composition for the generated function",
            );
        }
        expect(readinessAdmitsCompile(readiness), "no request may be issued for a generated-function-only surface").toBe(false);
    });

    it("unavailable composition + other failures: first, in the stable order, the complete list otherwise", () => {
        const readiness = composeNativeBuildReadiness(
            baseInput({
                programCompositionAvailable: false,
                programCompositionDetail: "the surface owns no complete-program composition for the generated function",
                tool: initialToolState,
                supportedTargets: null,
                configuredTarget: null,
            }),
        );
        expect(reasonsOf(readiness)).toEqual(["ProgramCompositionUnavailable", "ToolUnavailable", "TargetNotConfigured"]);
        expect(readinessAdmitsCompile(readiness)).toBe(false);
    });
});
