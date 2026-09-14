import { EnvironmentContractError, environmentExact, environmentRequire } from "./environment-contract.js";
import { validateEnvironmentFinalProof, type EnvironmentFinalProof, type EnvironmentStateBinding, type VerifiedEnvironmentClosure } from "./environment-import.js";
import { applyCompatibilityEvent } from "./tool-compatibility.js";
import { readHandshakeOutput, readPreviewHandshakeOutput, readCompileOutput, readPreviewBuildOutput } from "./process-output.js";
import { judgePreviewEligibility } from "./preview-compatibility.js";
import { readPreviewObservation } from "./preview-observation.js";
import type { BoundaryOutput, ToolCandidate } from "./host-boundary.js";
import type { ToolRequirement } from "./contract-facts.js";
import type { NativePreviewBuildRequest } from "./native-preview-build-request.js";

/** Retain structured native reader evidence for automation and diagnostic inspection. */
export class EnvironmentNativeProofError extends EnvironmentContractError {
    constructor(message: string, readonly outcome: ReturnType<typeof readCompileOutput> | ReturnType<typeof readPreviewBuildOutput>) {
        super("native-failed", message + (outcome.kind === "read" ? ": " + outcome.document.diagnostics.map(d => d.message).join("; ") : ": " + outcome.kind));
    }
}
export interface EnvironmentProofProbe {
    readonly profileVersion: 1 | 2;
    readonly requirement: ToolRequirement;
    readonly generatedSourceBytes: Uint8Array;
    readonly generatedSourceIdentity: string;
}
export interface EnvironmentProofExecution {
    readonly candidate: ToolCandidate;
    readonly runtime: { readonly path: string; readonly sha256: string };
    readonly previewDescriptorSha256: string;
    handshake(): Promise<BoundaryOutput>;
    previewHandshake(): Promise<BoundaryOutput>;
    compileProbe(profileVersion: 1 | 2, target: string): Promise<BoundaryOutput>;
    buildPreview(request: NativePreviewBuildRequest): Promise<BoundaryOutput>;
    launch(sessionId: string, backend: "dx12" | "vulkan"): Promise<{ runtimeIdentity: string }>;
    observation(sessionId: string): Promise<Uint8Array | null>;
    stop(): Promise<void>;
    sessionId(): string;
    wait(): Promise<void>;
    now(): number;
}
export interface EnvironmentProofRun { readonly backend: "dx12" | "vulkan"; readonly profileVersion: number; readonly sessionId: string; readonly publicationId: string; readonly runtimeIdentity: string }
/** Convert native IPC facts without trusting a cast or interpreting human logs. */
export function readEnvironmentNativeOutput(raw: unknown): BoundaryOutput {
    const r = environmentExact(raw, ["kind", "output"]);
    environmentRequire(r.kind === "spawned", "native-failed", "Native process did not spawn");
    const o = environmentExact(r.output, ["stdout", "stderr", "exitCode", "timedOut", "canceled"]);
    environmentRequire(typeof o.exitCode === "number" && Number.isInteger(o.exitCode) && typeof o.timedOut === "boolean" && typeof o.canceled === "boolean", "invalid-shape", "Invalid native process facts");
    return { stdout: readEnvironmentBytes(o.stdout), stderr: readEnvironmentBytes(o.stderr), exitCode: o.exitCode, timedOut: o.timedOut, canceled: o.canceled };
}
export function readEnvironmentBytes(raw: unknown): Uint8Array {
    environmentRequire(Array.isArray(raw) && raw.length <= 16 * 1024 * 1024 && raw.every(n => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255), "invalid-shape", "Invalid native bytes");
    return Uint8Array.from(raw);
}
/** Probes are core-validated emissions supplied by the authoring frontend; this module owns only native contracts. */
export async function proveEnvironmentFinal(
    closure: VerifiedEnvironmentClosure, state: EnvironmentStateBinding, probes: readonly EnvironmentProofProbe[],
    host: EnvironmentProofExecution, hashBytes: (bytes: Uint8Array) => string,
    cancelled: () => boolean,
): Promise<{ proof: EnvironmentFinalProof; runs: readonly EnvironmentProofRun[] }> {
    probes = probes.map(p => ({ ...p, requirement: { ...p.requirement }, generatedSourceBytes: p.generatedSourceBytes.slice() }));
    const check = () => environmentRequire(!cancelled(), "cancelled", "Environment proof cancelled");
    check();
    environmentRequire(probes.length === 2 && probes[0]?.profileVersion === 1 && probes[1]?.profileVersion === 2, "proof-mismatch", "Both frozen profile lines are required");
    const candidate = { ...host.candidate }, runtime = { ...host.runtime };
    const preliminary: EnvironmentFinalProof = { environmentRoot: closure.root, stateRoot: state.root, environmentId: closure.manifest.environmentId, tool: { path: candidate.toolPath, sha256: candidate.observationIdentity }, runtime, ordinaryHandshake: "compatible", previewHandshake: "compatible", profiles: [1, 2], runtimeObservation: "loaded" };
    // This local coordinate check is not returned as proof until all observations below complete.
    validateEnvironmentFinalProof(closure, state, preliminary);
    const previewMember = closure.manifest.members.find(m => m.path === closure.manifest.roles.previewProgram);
    environmentRequire(previewMember?.sha256 === host.previewDescriptorSha256, "hash-mismatch", "Final Preview descriptor changed");
    const ordinary = readHandshakeOutput(await host.handshake()); check();
    const preview = readPreviewHandshakeOutput(await host.previewHandshake()); check();
    environmentRequire(preview.kind === "read" && preview.document.success, "native-incompatible", "Preview handshake is not compatible");
    const runs: EnvironmentProofRun[] = [];
    for (const probe of probes) {
        environmentRequire(hashBytes(probe.generatedSourceBytes) === probe.generatedSourceIdentity, "identity-mismatch", "Probe source identity mismatch");
        const tool = applyCompatibilityEvent({ status: "discovered", candidate }, { kind: "handshake", candidate, result: { kind: "spawned", process: ordinary } }, { requirement: probe.requirement });
        environmentRequire(tool.status === "compatible", "native-incompatible", "Ordinary handshake is not compatible with the profile");
        const contracts = preview.document.supportedPreviewInputContracts.filter(c => c.profileId === "gglab.surface" && c.profileVersion === probe.profileVersion);
        environmentRequire(contracts.length === 1, "native-incompatible", "Preview input selection is absent or ambiguous");
        const input = contracts[0]!;
        for (const [backend, target] of [["dx12", "gglab-dx12"], ["vulkan", "gglab-vulkan13"]] as const) {
            check();
            const eligibility = judgePreviewEligibility(tool, { candidate, process: preview }, { targetProfile: target, previewProgramDescriptorIdentity: host.previewDescriptorSha256, inputContract: input });
            environmentRequire(eligibility.status === "eligible", "native-incompatible", "Preview target is not eligible");
            const compiled = readCompileOutput(await host.compileProbe(probe.profileVersion, target)); check();
            if (!(compiled.kind === "read" && compiled.document.success && compiled.document.target === target)) throw new EnvironmentNativeProofError("Ordinary native probe failed", compiled);
            const sessionId = host.sessionId();
            environmentRequire(/^[0-9a-f]{32}$/.test(sessionId) && !runs.some(r => r.sessionId === sessionId), "proof-mismatch", "Proof requires a fresh session identity");
            const built = readPreviewBuildOutput(await host.buildPreview({ sessionId, targetProfile: target, profileId: "gglab.surface", profileVersion: probe.profileVersion, previewInputContractId: input.id, previewProgramDescriptorIdentity: host.previewDescriptorSha256, generatedSourceIdentity: probe.generatedSourceIdentity, generatedSourceBytes: probe.generatedSourceBytes, attemptSequence: 1 })); check();
            if (!(built.kind === "read" && built.document.success && built.document.attemptSequence === 1)) throw new EnvironmentNativeProofError("Preview native probe failed", built);
            const publicationId = built.document.publicationId;
            try {
                const launch = await host.launch(sessionId, backend); check();
                environmentRequire(launch.runtimeIdentity === runtime.sha256, "proof-mismatch", "Runtime executable differs from the observed final member");
                const start = host.now(); let loaded = false;
                while (host.now() - start < 30000) {
                    check(); const bytes = await host.observation(sessionId);
                    if (bytes) {
                        const result = readPreviewObservation(bytes);
                        environmentRequire(result.status === "read", "native-failed", "Invalid Runtime observation");
                        const o = result.observation;
                        environmentRequire(o.status === "loaded" && o.observedAttemptSequence === 1 && o.observedPublicationRef === publicationId && o.loadedPublicationRef === publicationId, "proof-mismatch", "Runtime did not load this session's publication");
                        loaded = true; break;
                    }
                    await host.wait();
                }
                environmentRequire(loaded, "native-timeout", "Runtime Loaded observation timed out");
                runs.push({ backend, profileVersion: probe.profileVersion, sessionId, publicationId, runtimeIdentity: launch.runtimeIdentity });
            } finally { await host.stop(); }
        }
    }
    check();
    return { proof: preliminary, runs };
}
