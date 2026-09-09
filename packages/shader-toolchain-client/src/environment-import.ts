import { ENVIRONMENT_STATE_ROLES, environmentDiagnostic, environmentExact, parseEnvironmentJson, environmentRequire, type EnvironmentDiagnostic, type EnvironmentManifest } from "./environment-contract.js";
import { environmentAbsolutePath } from "./environment-protocol.js";

export interface VerifiedEnvironmentClosure { readonly root: string; readonly manifest: EnvironmentManifest }
export interface EnvironmentStateBinding { readonly root: string; readonly environmentId: string }
/** Proof is produced by the host's existing compatibility/descriptor/Runtime services, never by a manifest reader. */
export interface EnvironmentFinalProof {
    readonly environmentRoot: string; readonly stateRoot: string; readonly environmentId: string;
    readonly tool: { readonly path: string; readonly sha256: string };
    readonly runtime: { readonly path: string; readonly sha256: string };
    readonly ordinaryHandshake: "compatible"; readonly previewHandshake: "compatible";
    readonly profiles: readonly [1, 2]; readonly runtimeObservation: "loaded";
}
export interface EnvironmentRegistration { readonly closure: VerifiedEnvironmentClosure; readonly state: EnvironmentStateBinding; readonly proof: EnvironmentFinalProof }
export interface EnvironmentImportHost {
    verifyFinal(root: string): Promise<VerifiedEnvironmentClosure>;
    /** Reuse only a validated, matching state binding after restart; never overwrite or delete existing state. */
    initializeOrRecoverState(closure: VerifiedEnvironmentClosure, stateRoot: string): Promise<EnvironmentStateBinding>;
    proveFinal(closure: VerifiedEnvironmentClosure, state: EnvironmentStateBinding): Promise<EnvironmentFinalProof>;
    /** Atomic durable compare-and-insert; identical retry is a no-op, conflicting binding is refused. Does not activate. */
    register(registration: EnvironmentRegistration): Promise<"registered" | "already-registered">;
}
export interface EnvironmentImportEvent {
    readonly phase: "verify" | "state" | "proof" | "register" | "settled";
    readonly environmentRoot: string; readonly stateRoot: string;
    readonly diagnostic?: EnvironmentDiagnostic;
}
export type EnvironmentImportOutcome =
    | { readonly status: "registered" | "already-registered"; readonly registration: EnvironmentRegistration }
    | { readonly status: "refused"; readonly diagnostic: EnvironmentDiagnostic; readonly retainedStateRoot: string | null; readonly registrationMayHaveCommitted: boolean };
const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export function validateEnvironmentStateRoots(environmentRoot: string, stateRoot: string): void {
    environmentAbsolutePath(environmentRoot); environmentAbsolutePath(stateRoot);
    const a = normalize(environmentRoot), b = normalize(stateRoot);
    environmentRequire(a !== b && !a.startsWith(b + "/") && !b.startsWith(a + "/"), "invalid-path", "State and Environment must be disjoint", "$.stateRoot");
}
export function validateEnvironmentFinalProof(closure: VerifiedEnvironmentClosure, state: EnvironmentStateBinding, proof: EnvironmentFinalProof): void {
    const m = closure.manifest;
    environmentRequire(normalize(proof.environmentRoot) === normalize(closure.root) && normalize(proof.stateRoot) === normalize(state.root) && proof.environmentId === m.environmentId, "proof-mismatch", "Proof belongs to a different final location");
    for (const role of ["tool", "runtime"] as const) {
        const member = m.members.find(member => member.path === m.roles[role]);
        environmentRequire(member && normalize(proof[role].path) === normalize(closure.root + "/" + member.path) && proof[role].sha256 === member.sha256, "proof-mismatch", "Executable proof does not match final member", `$.${role}`);
    }
    environmentRequire(proof.ordinaryHandshake === "compatible" && proof.previewHandshake === "compatible" && proof.profiles.length === 2 && proof.profiles[0] === 1 && proof.profiles[1] === 2 && proof.runtimeObservation === "loaded", "proof-mismatch", "Final native evidence is incomplete");
}
/** Production composition must supply actual native proof before using this transaction. */
export async function prepareEnvironmentImport(host: EnvironmentImportHost, root: string, stateRoot: string, cancelled: () => boolean, emit: (event: EnvironmentImportEvent) => void = () => {}): Promise<EnvironmentImportOutcome> {
    let retainedStateRoot: string | null = null;
    let registrationMayHaveCommitted = false;
    const event = (phase: EnvironmentImportEvent["phase"], diagnostic?: EnvironmentDiagnostic): void => {
        // Observability failure must not change the result of a committed registration.
        try { emit({ phase, environmentRoot: root, stateRoot, ...(diagnostic ? { diagnostic } : {}) }); } catch { /* The transaction remains authoritative. */ }
    };
    const check = (): void => environmentRequire(!cancelled(), "cancelled", "Import cancelled; existing registration and state are preserved");
    try {
        check(); validateEnvironmentStateRoots(root, stateRoot); event("verify");
        const closure = await host.verifyFinal(root); check();
        environmentRequire(normalize(closure.root) === normalize(root), "proof-mismatch", "Verification returned another root");
        event("state");
        // Initialization may commit before transport failure. Always expose the requested recovery location.
        retainedStateRoot = stateRoot;
        const state = await host.initializeOrRecoverState(closure, stateRoot); check();
        environmentRequire(state.environmentId === closure.manifest.environmentId && normalize(state.root) === normalize(stateRoot), "state-conflict", "State binding mismatch");
        event("proof");
        const proof = await host.proveFinal(closure, state); check();
        validateEnvironmentFinalProof(closure, state, proof);
        const current = await host.verifyFinal(root); check();
        environmentRequire(current.manifest.environmentId === closure.manifest.environmentId && normalize(current.root) === normalize(root), "source-changed", "Closure changed during final proof");
        const registration = { closure, state, proof };
        event("register"); check();
        registrationMayHaveCommitted = true;
        const status = await host.register(registration);
        // Once atomic registration commits, late cancellation cannot turn it into a fictitious rollback.
        event("settled");
        return { status, registration };
    } catch (error) {
        const diagnostic = environmentDiagnostic(error); event("settled", diagnostic);
        return { status: "refused", diagnostic, retainedStateRoot, registrationMayHaveCommitted };
    }
}
/** Owner approved v1 on 2026-09-09; production proof, state and activation wiring remain incomplete. */
export const ENVIRONMENT_IMPORT_AVAILABILITY = {
    enabled: false,
    reason: "Environment import is not connected to final native proof and activation services yet.",
} as const;

/** State metadata is operational binding only. The host also checks all ancestors/entries and designated directories. */
export function readEnvironmentStateBinding(text: string, root: string, closure: VerifiedEnvironmentClosure): EnvironmentStateBinding {
    validateEnvironmentStateRoots(closure.root, root);
    const state = environmentExact(parseEnvironmentJson(text), ["stateVersion", "environmentId"]);
    environmentRequire(state.stateVersion === 1, "unsupported-version", "Unsupported stateVersion", "$.stateVersion");
    environmentRequire(state.environmentId === closure.manifest.environmentId, "state-conflict", "State belongs to another Environment", "$.environmentId");
    return { root, environmentId: closure.manifest.environmentId };
}
/** Host-only path plan: no argv, native policy, or WebView filesystem authority. */
export function environmentExecutionLocations(closure: VerifiedEnvironmentClosure, state: EnvironmentStateBinding) {
    validateEnvironmentStateRoots(closure.root, state.root);
    environmentRequire(state.environmentId === closure.manifest.environmentId, "state-conflict", "State belongs to another Environment");
    const immutable = (role: keyof EnvironmentManifest["roles"]): string => closure.root.replace(/[\\/]+$/, "") + "/" + closure.manifest.roles[role];
    const writable = (role: keyof typeof ENVIRONMENT_STATE_ROLES): string => state.root.replace(/[\\/]+$/, "") + "/" + closure.manifest.writableState.roles[role];
    return {
        tool: immutable("tool"), runtime: immutable("runtime"), sourceRoot: immutable("shaderSources"),
        vulkanLayerPath: immutable("vulkanLayers"), stateRoot: state.root, workingDirectory: state.root,
        generatedSources: writable("generatedSources"), cacheRoot: writable("shaderCache"), artifactRoot: writable("artifacts"),
        previewPublications: writable("previewPublications"), previewSessions: writable("previewSessions"),
        observations: writable("observations"), logs: writable("logs"), derivedData: writable("derivedData"), settings: writable("settings"),
    };
}
