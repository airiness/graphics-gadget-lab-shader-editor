import { ENVIRONMENT_JSON_LIMIT, EnvironmentContractError, environmentDiagnostic, environmentExact, environmentObject, environmentRequire, isEnvironmentHash, type EnvironmentDiagnostic } from "./environment-contract.js";
import { readEnvironmentBootstrap, readEnvironmentResponse, type EnvironmentCandidate } from "./environment-protocol.js";
import { utf8Decode } from "./utf8.js";

export interface EnvironmentRepositoryHandle {
    readonly repositoryId: string; readonly displayPath: string; readonly bootstrapText: string; readonly publisherSha256: string;
}
export type EnvironmentDiscoveryOutcome =
    | { readonly status: "discovered"; readonly repositoryId: string; readonly discoveryId: string; readonly publisherSha256: string; readonly interpreterSha256: string; readonly candidates: readonly EnvironmentCandidate[]; readonly nativeReadiness: "unproven" }
    | { readonly status: "refused"; readonly diagnostic: EnvironmentDiagnostic };
export interface EnvironmentDiscoveryAttempt {
    readonly discoveryId: string; readonly completion: Promise<EnvironmentDiscoveryOutcome>;
}
export interface EnvironmentDiscoveryHost {
    chooseRepository(): Promise<EnvironmentRepositoryHandle | null>;
    discover(repository: EnvironmentRepositoryHandle): Promise<EnvironmentDiscoveryAttempt>;
    cancel(discoveryId: string): Promise<boolean>;
}
export function readEnvironmentRepositoryHandle(value: unknown): EnvironmentRepositoryHandle {
    const r = environmentExact(value, ["repositoryId", "displayPath", "bootstrapText", "publisherSha256"]);
    environmentRequire(typeof r.repositoryId === "string" && /^environment-repository:[1-9][0-9]*$/.test(r.repositoryId), "invalid-handle", "Invalid repository handle");
    environmentRequire(typeof r.displayPath === "string" && r.displayPath.length > 0 && typeof r.bootstrapText === "string" && isEnvironmentHash(r.publisherSha256), "invalid-shape", "Invalid repository observation");
    readEnvironmentBootstrap(r.bootstrapText);
    return r as unknown as EnvironmentRepositoryHandle;
}
export function readEnvironmentDiscoveryId(value: unknown): string {
    environmentRequire(typeof value === "string" && /^environment-discovery:[1-9][0-9]*$/.test(value), "invalid-handle", "Invalid discovery identity");
    return value;
}
export function environmentHostDiagnostic(value: unknown): EnvironmentDiagnostic {
    if (value !== null && typeof value === "object" && "code" in value && "message" in value && "dataPath" in value) {
        const e = value as Record<string, unknown>;
        if (typeof e.code === "string" && typeof e.message === "string" && typeof e.dataPath === "string") return { code: e.code, message: e.message, dataPath: e.dataPath, severity: "error" };
    }
    return environmentDiagnostic(value);
}
function bytes(value: unknown): Uint8Array {
    environmentRequire(Array.isArray(value) && value.length <= ENVIRONMENT_JSON_LIMIT && value.every(b => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255), "invalid-shape", "Invalid process bytes");
    return new Uint8Array(value);
}
/** Raw IPC never becomes proof by a type assertion. Validate admission correlation before reading producer output. */
export function readEnvironmentDiscoverySettlement(repository: EnvironmentRepositoryHandle, discoveryId: string, value: unknown): EnvironmentDiscoveryOutcome {
    try {
        const s = environmentObject(value);
        environmentRequire(s.repositoryId === repository.repositoryId && s.discoveryId === discoveryId, "proof-mismatch", "Discovery settlement belongs to another admission");
        if (s.kind === "failed") {
            environmentExact(s, ["kind", "repositoryId", "discoveryId", "error"]);
            const e = environmentExact(s.error, ["code", "message", "dataPath"]);
            environmentRequire(typeof e.code === "string" && typeof e.message === "string" && typeof e.dataPath === "string", "invalid-shape", "Invalid host failure");
            throw new EnvironmentContractError(e.code, e.message, e.dataPath);
        }
        environmentRequire(s.kind === "settled", "invalid-shape", "Unknown discovery settlement");
        environmentExact(s, ["kind", "repositoryId", "discoveryId", "publisherSha256", "interpreterSha256", "output"]);
        environmentRequire(s.publisherSha256 === repository.publisherSha256 && isEnvironmentHash(s.interpreterSha256), "proof-mismatch", "Discovery publisher observation changed");
        const o = environmentExact(s.output, ["stdout", "stderr", "exitCode", "timedOut", "canceled", "outputLimitExceeded"]);
        environmentRequire(typeof o.timedOut === "boolean" && typeof o.canceled === "boolean" && typeof o.outputLimitExceeded === "boolean" && (o.exitCode === null || (typeof o.exitCode === "number" && Number.isSafeInteger(o.exitCode))), "invalid-shape", "Invalid process outcome");
        environmentRequire(!o.canceled, "cancelled", "Discovery cancelled");
        environmentRequire(!o.timedOut, "producer-timeout", "Discovery exceeded its host budget");
        environmentRequire(!o.outputLimitExceeded, "limit-exceeded", "Discovery process output exceeded 16 MiB");
        bytes(o.stderr);
        const decoded = utf8Decode(bytes(o.stdout));
        environmentRequire(decoded.ok, "invalid-json", "Producer stdout is not valid UTF-8");
        const response = readEnvironmentResponse(decoded.text, o.exitCode as number | null, "discover");
        if (!response.success) throw new EnvironmentContractError(response.error.code, response.error.message);
        return { status: "discovered", repositoryId: repository.repositoryId, discoveryId, publisherSha256: repository.publisherSha256, interpreterSha256: s.interpreterSha256, candidates: response.result.candidates, nativeReadiness: "unproven" };
    } catch (error) { return { status: "refused", diagnostic: environmentDiagnostic(error) }; }
}
