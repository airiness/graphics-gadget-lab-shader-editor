import { ENVIRONMENT_ROLES, ENVIRONMENT_STATE_ROLES, environmentCanonical, environmentExact, environmentLocator, environmentObject, environmentRequire, isEnvironmentHash, parseEnvironmentJson } from "./environment-contract.js";

export type EnvironmentOperation = "discover" | "publish" | "verify" | "init-state";
export type EnvironmentRequest =
    | { readonly requestVersion: 1; readonly operation: "discover"; readonly repositoryRoot: string; readonly searchRoots: readonly string[] }
    | { readonly requestVersion: 1; readonly operation: "publish"; readonly repositoryRoot: string; readonly deployment: string; readonly destination: string; readonly cancelFile: string | null }
    | { readonly requestVersion: 1; readonly operation: "verify"; readonly environmentRoot: string }
    | { readonly requestVersion: 1; readonly operation: "init-state"; readonly environmentRoot: string; readonly stateRoot: string };
export function environmentAbsolutePath(value: unknown, field = "$"): string {
    environmentRequire(typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value) && !Array.from(value).some(c => c.charCodeAt(0) < 32) && !value.slice(2).includes(":"), "invalid-path", "Expected a local absolute Windows path", field);
    environmentRequire(!value.slice(3).split(/[\\/]/).some(p => p === "." || p === ".." || /[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(p)), "invalid-path", "Unsafe absolute path", field);
    return value;
}
export function readEnvironmentRequest(value: unknown): EnvironmentRequest {
    const r = environmentObject(value);
    environmentRequire(r.requestVersion === 1, "unsupported-version", "Unsupported requestVersion", "$.requestVersion");
    for (const key of ["repositoryRoot", "destination", "environmentRoot", "stateRoot"]) if (Object.hasOwn(r, key)) environmentAbsolutePath(r[key], `$.${key}`);
    switch (r.operation) {
        case "discover":
            environmentExact(r, ["requestVersion", "operation", "repositoryRoot", "searchRoots"]);
            environmentRequire(Array.isArray(r.searchRoots) && r.searchRoots.length <= 32, "invalid-shape", "Invalid search roots", "$.searchRoots");
            r.searchRoots.forEach((root: unknown) => environmentLocator(root, "$.searchRoots")); break;
        case "publish":
            environmentExact(r, ["requestVersion", "operation", "repositoryRoot", "deployment", "destination", "cancelFile"]);
            environmentLocator(r.deployment, "$.deployment");
            if (r.cancelFile !== null) environmentAbsolutePath(r.cancelFile, "$.cancelFile"); break;
        case "verify": environmentExact(r, ["requestVersion", "operation", "environmentRoot"]); break;
        case "init-state": environmentExact(r, ["requestVersion", "operation", "environmentRoot", "stateRoot"]); break;
        default: environmentRequire(false, "unsupported-operation", "Unknown operation", "$.operation");
    }
    return r as unknown as EnvironmentRequest;
}
export interface EnvironmentBootstrap {
    readonly bootstrapVersion: 1; readonly publisher: string; readonly interpreter: "python";
    readonly minimumPythonVersion: "3.12"; readonly transport: "single-utf8-json-stdin-stdout";
    readonly requestVersions: readonly [1]; readonly resultVersions: readonly [1];
    readonly defaultSearchRoots: readonly string[]; readonly contractStatus: "implemented-pending-owner-review";
}
export function readEnvironmentBootstrap(text: string): EnvironmentBootstrap {
    const b = environmentObject(parseEnvironmentJson(text));
    environmentRequire(b.bootstrapVersion === 1, "unsupported-version", "Unsupported bootstrapVersion");
    environmentExact(b, ["bootstrapVersion", "publisher", "interpreter", "minimumPythonVersion", "transport", "requestVersions", "resultVersions", "defaultSearchRoots", "contractStatus"]);
    environmentLocator(b.publisher, "$.publisher");
    environmentRequire(b.interpreter === "python" && b.minimumPythonVersion === "3.12" && b.transport === "single-utf8-json-stdin-stdout" && environmentCanonical(b.requestVersions) === "[1]" && environmentCanonical(b.resultVersions) === "[1]", "unsupported-version", "Unsupported producer transport");
    environmentRequire(b.contractStatus === "implemented-pending-owner-review", "unsupported-version", "Contract status requires explicit consumer review");
    environmentRequire(Array.isArray(b.defaultSearchRoots) && b.defaultSearchRoots.length <= 32, "invalid-shape", "Invalid search roots");
    b.defaultSearchRoots.forEach((root: unknown) => environmentLocator(root));
    return b as unknown as EnvironmentBootstrap;
}
export interface EnvironmentCandidate { readonly deployment: string; readonly toolSha256: string; readonly runtimeSha256: string }
export interface EnvironmentResults {
    readonly discover: { readonly candidates: readonly EnvironmentCandidate[] };
    readonly publish: { readonly outcome: "published" | "already-present"; readonly environmentRoot: string; readonly environmentId: string };
    readonly verify: { readonly environmentId: string; readonly roles: typeof ENVIRONMENT_ROLES; readonly writableState: { readonly root: "external"; readonly roles: typeof ENVIRONMENT_STATE_ROLES } };
    readonly "init-state": { readonly environmentId: string; readonly stateRoot: string };
}
export type EnvironmentResponse<O extends EnvironmentOperation> =
    | { readonly success: true; readonly result: EnvironmentResults[O] }
    | { readonly success: false; readonly error: { readonly code: string; readonly message: string } };
export function readEnvironmentResponse<O extends EnvironmentOperation>(text: string, exitCode: number | null, operation: O): EnvironmentResponse<O> {
    const e = environmentObject(parseEnvironmentJson(text));
    environmentRequire(e.resultVersion === 1, "unsupported-version", "Unsupported resultVersion");
    environmentExact(e, ["resultVersion", "operation", "success", "result", "error"]);
    environmentRequire(e.operation === operation, "invalid-shape", "Response operation mismatch");
    if (e.success === false) {
        environmentRequire(exitCode === 2 && e.result === null, "invalid-shape", "Failure envelope/exit mismatch");
        const error = environmentExact(e.error, ["code", "message"]);
        environmentRequire(typeof error.code === "string" && /^[a-z]+(?:-[a-z]+)*$/.test(error.code) && typeof error.message === "string", "invalid-shape", "Invalid producer error");
        return { success: false, error: { code: error.code, message: error.message } };
    }
    environmentRequire(e.success === true && exitCode === 0 && e.error === null, "invalid-shape", "Success envelope/exit mismatch");
    const r = environmentObject(e.result);
    if (operation === "discover") {
        environmentExact(r, ["candidates"]);
        environmentRequire(Array.isArray(r.candidates), "invalid-shape", "Invalid candidates");
        let prior = "";
        for (const raw of r.candidates) {
            const c = environmentExact(raw, ["deployment", "toolSha256", "runtimeSha256"]);
            const path = environmentLocator(c.deployment);
            environmentRequire(path > prior && isEnvironmentHash(c.toolSha256) && isEnvironmentHash(c.runtimeSha256), "invalid-shape", "Invalid or unsorted candidates");
            prior = path;
        }
    } else {
        environmentRequire(typeof r.environmentId === "string" && /^sha256:[0-9a-f]{64}$/.test(r.environmentId), "identity-mismatch", "Invalid result identity");
        if (operation === "publish") {
            environmentExact(r, ["outcome", "environmentRoot", "environmentId"]);
            environmentRequire(r.outcome === "published" || r.outcome === "already-present", "invalid-shape", "Unknown publication outcome");
            environmentAbsolutePath(r.environmentRoot);
        } else if (operation === "init-state") {
            environmentExact(r, ["environmentId", "stateRoot"]); environmentAbsolutePath(r.stateRoot);
        } else {
            environmentExact(r, ["environmentId", "roles", "writableState"]);
            environmentRequire(environmentCanonical(r.roles) === environmentCanonical(ENVIRONMENT_ROLES) && environmentCanonical(r.writableState) === environmentCanonical({ root: "external", roles: ENVIRONMENT_STATE_ROLES }), "invalid-role", "Unexpected verification roles");
        }
    }
    return { success: true, result: r as unknown as EnvironmentResults[O] };
}
/** Host owns observation, argv, cancellation and process lifetime. Lost stdout is an uncertain commit, not rollback proof. */
export interface EnvironmentProducerTransport {
    exchange(request: EnvironmentRequest): Promise<{ readonly stdout: string; readonly exitCode: number | null }>;
}
export async function callEnvironmentProducer<O extends EnvironmentOperation>(transport: EnvironmentProducerTransport, request: EnvironmentRequest & { readonly operation: O }): Promise<EnvironmentResponse<O>> {
    readEnvironmentRequest(request);
    const result = await transport.exchange(request);
    return readEnvironmentResponse(result.stdout, result.exitCode, request.operation);
}
