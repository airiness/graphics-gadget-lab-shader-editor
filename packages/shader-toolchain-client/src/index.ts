/**
 * Headless client for the GGLab shader toolchain (gglab-shaderc).
 *
 * This package owns the machine-protocol side of native shader production:
 * the plain value vocabulary (contract facts, envelopes, the
 * NativeCompileRequest shape, build intents, result states), the strict
 * readers for the published handshake and result envelopes, the
 * ToolCompatibility state machine, the revisioned build-line rules, and the
 * host-boundary contract with its reference fake.
 *
 * Invariants: pure TypeScript; no React, Tauri, DOM/Web API, Node/OS
 * runtime import, native addon, or C++ dependency. It consumes the
 * toolchain's published contracts — it never defines or extends them. Its
 * vocabulary contains no argv type: argument arrays exist only inside the
 * host boundary the service implements. It is a sibling of, and dependency-
 * free from, @gglab/shader-graph-core in both directions.
 */

export const clientPackageName = "@gglab/shader-toolchain-client";

/** Returns the package identity of the headless shader toolchain client. */
export function getClientPackageName(): string {
    return clientPackageName;
}

export * from "./contract-facts.js";
export * from "./contract-range-declaration.js";
export * from "./contract-range.js";
export * from "./preview-contract-range-declaration.js";
export * from "./semver.js";
export * from "./verdicts.js";
export * from "./handshake-document.js";
export * from "./result-envelope.js";
export * from "./preview-handshake-document.js";
export * from "./preview-result-envelope.js";
export * from "./preview-compatibility.js";
export * from "./tool-compatibility.js";
export * from "./native-compile-request.js";
export * from "./native-preview-build-request.js";
export * from "./build-line.js";
export * from "./preview-build-line.js";
export * from "./preview-observation.js";
export * from "./preview-observation-boundary.js";
export * from "./preview-runtime-boundary.js";
export * from "./host-boundary.js";
export * from "./utf8.js";
export * from "./process-output.js";
export * from "./testing/fake-host-boundary.js";
export * from "./testing/fake-preview-observation-boundary.js";
export * from "./testing/fake-preview-runtime-boundary.js";

export * from "./environment-contract.js";
export * from "./environment-protocol.js";
export * from "./environment-import.js";
export * from "./environment-closure.js";
export * from "./environment-registry.js";
export * from "./environment-host-boundary.js";
export * from "./environment-storage-boundary.js";
export * from "./environment-proof.js";

export * from "./environment-mutation.js";
