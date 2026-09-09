import { environmentAbsolutePath, readEnvironmentResponse, type EnvironmentCandidate } from "./environment-protocol.js";
import { EnvironmentContractError, environmentDiagnostic, environmentCanonical, environmentExact, environmentRequire, isEnvironmentHash, type EnvironmentDiagnostic } from "./environment-contract.js";
import { readEnvironmentBytes } from "./environment-proof.js";
import { utf8Decode } from "./utf8.js";
import type { EnvironmentStateBinding, VerifiedEnvironmentClosure } from "./environment-import.js";

export interface EnvironmentMutationIntent {
    readonly intentVersion: 1; readonly operationId: string; readonly operation: "publish" | "init-state";
    readonly repositoryRoot: string; readonly publisherSha256: string; readonly candidate: EnvironmentCandidate | null;
    readonly environmentRoot: string | null; readonly environmentId: string | null; readonly targetRoot: string;
}
export function readEnvironmentMutationId(raw: unknown): string {
    environmentRequire(typeof raw === "string" && /^[0-9a-f]{32}$/.test(raw), "invalid-handle", "Invalid producer operation ID"); return raw;
}
export function readEnvironmentMutationIntent(raw: unknown): EnvironmentMutationIntent {
    const r = environmentExact(raw, ["intentVersion", "operationId", "operation", "repositoryRoot", "publisherSha256", "candidate", "environmentRoot", "environmentId", "targetRoot"]);
    environmentRequire(r.intentVersion === 1, "unsupported-version", "Unsupported operation intent version"); readEnvironmentMutationId(r.operationId);
    environmentAbsolutePath(r.repositoryRoot); environmentAbsolutePath(r.targetRoot);
    environmentRequire(isEnvironmentHash(r.publisherSha256), "invalid-shape", "Invalid publisher identity");
    if (r.operation === "publish") {
        environmentRequire(r.environmentRoot === null && r.environmentId === null, "invalid-shape", "Unexpected publication input binding");
        const c = environmentExact(r.candidate, ["deployment", "toolSha256", "runtimeSha256"]);
        // Reuse the producer's own candidate response reader, including locator rules.
        readEnvironmentResponse(JSON.stringify({ resultVersion: 1, operation: "discover", success: true, result: { candidates: [c] }, error: null }), 0, "discover");
    } else {
        environmentRequire(r.operation === "init-state" && r.candidate === null && typeof r.environmentId === "string" && /^sha256:[0-9a-f]{64}$/.test(r.environmentId), "invalid-shape", "Invalid state intent");
        environmentAbsolutePath(r.environmentRoot);
    }
    return r as unknown as EnvironmentMutationIntent;
}
export interface EnvironmentMutationHost {
    execute(): Promise<unknown>;
    /** Must establish an idle host before observing the saved destination. Never trusts stdout alone. */
    inspect(): Promise<{ readonly intent: EnvironmentMutationIntent; readonly terminationUnproven: boolean; readonly closure: VerifiedEnvironmentClosure | null; readonly state: EnvironmentStateBinding | null }>;
}
export type EnvironmentMutationOutcome =
    | { readonly status: "integrity-verified"; readonly intent: EnvironmentMutationIntent; readonly closure: VerifiedEnvironmentClosure; readonly state: EnvironmentStateBinding | null; readonly recovered: boolean; readonly nativeReadiness: "unproven" }
    | { readonly status: "refused"; readonly intent: EnvironmentMutationIntent; readonly diagnostic: EnvironmentDiagnostic; readonly targetMayExist: true };

/** Lost/invalid stdout never proves rollback; reconciliation is always read-only. */
export async function settleEnvironmentMutation(intentInput: EnvironmentMutationIntent, host: EnvironmentMutationHost, cancelled: () => boolean, execute = true): Promise<EnvironmentMutationOutcome> {
    const original = readEnvironmentMutationIntent(intentInput);
    const intent = { ...original, candidate: original.candidate === null ? null : { ...original.candidate } };
    let failure: unknown, expectedId: string | null = null, recovered = !execute, nativeCanceled = false;
    try {
        if (execute && !cancelled()) {
            try {
                const raw = await host.execute(), s = environmentExact(raw, (raw as { kind?: unknown })?.kind === "existing-target" ? ["operationId", "kind"] : ["operationId", "kind", "publisherSha256", "interpreterSha256", "output"]);
                environmentRequire(s.operationId === intent.operationId, "proof-mismatch", "Producer settlement belongs to another operation");
                if (s.kind === "existing-target") { recovered = true; }
                else {
                    environmentRequire(s.kind === "settled" && s.publisherSha256 === intent.publisherSha256 && isEnvironmentHash(s.interpreterSha256), "proof-mismatch", "Producer observation changed");
                    const o = environmentExact(s.output, ["stdout", "stderr", "exitCode", "timedOut", "canceled", "outputLimitExceeded"]);
                    environmentRequire(typeof o.timedOut === "boolean" && typeof o.canceled === "boolean" && typeof o.outputLimitExceeded === "boolean" && (o.exitCode === null || typeof o.exitCode === "number" && Number.isSafeInteger(o.exitCode)), "invalid-shape", "Invalid process facts");
                    nativeCanceled = o.canceled;
                    environmentRequire(!o.timedOut && !o.canceled && !o.outputLimitExceeded, "producer-interrupted", "Producer execution interrupted; inspect retained target");
                    environmentRequire(readEnvironmentBytes(o.stderr).length === 0, "invalid-shape", "Unexpected producer stderr");
                    const decoded = utf8Decode(readEnvironmentBytes(o.stdout)); environmentRequire(decoded.ok, "invalid-json", "Invalid producer UTF-8");
                    const response = readEnvironmentResponse(decoded.text, o.exitCode as number | null, intent.operation);
                    if (!response.success) throw new EnvironmentContractError(response.error.code, response.error.message);
                    expectedId = response.result.environmentId;
                    const result = response.result;
                    environmentRequire(("environmentRoot" in result ? result.environmentRoot : result.stateRoot) === intent.targetRoot, "proof-mismatch", "Producer returned another destination");
                }
            } catch (error) { failure = error; recovered = true; }
        }
        const observed = await host.inspect();
        environmentRequire(environmentCanonical(readEnvironmentMutationIntent(observed.intent)) === environmentCanonical(intent), "proof-mismatch", "Saved operation binding changed");
        environmentRequire(!observed.terminationUnproven, "termination-unproven", "Producer termination is unproven; retained target is not admitted");
        environmentRequire(!cancelled() && !nativeCanceled, "cancelled", "Operation cancelled; retained target requires explicit reconciliation");
        const closure = observed.closure;
        if (closure === null) throw failure ?? new EnvironmentContractError("missing-member", "No finalized target; retry this intent explicitly");
        environmentRequire(expectedId === null || expectedId === closure.manifest.environmentId, "identity-mismatch", "Producer result differs from final closure");
        if (intent.operation === "publish") {
            environmentRequire(closure.root === intent.targetRoot && observed.state === null, "proof-mismatch", "Publication target binding mismatch");
            const m = closure.manifest, c = intent.candidate!;
            environmentRequire(m.producer.publisherSha256 === intent.publisherSha256 && m.producer.deployment === c.deployment && ([['tool', c.toolSha256], ['runtime', c.runtimeSha256]] as const).every(([role, hash]) => m.members.find(v => v.path === m.roles[role])?.sha256 === hash), "source-changed", "Published closure differs from selected deployment");
        } else {
            environmentRequire(closure.root === intent.environmentRoot && closure.manifest.environmentId === intent.environmentId && observed.state?.root === intent.targetRoot && observed.state.environmentId === intent.environmentId, "state-conflict", "Final state differs from selected Environment");
        }
        return { status: "integrity-verified", intent, closure, state: observed.state, recovered, nativeReadiness: "unproven" };
    } catch (error) { return { status: "refused", intent, diagnostic: environmentDiagnostic(error), targetMayExist: true }; }
}
