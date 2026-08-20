/**
 * Headless core for GGLab ShaderGraph semantics.
 *
 * This package owns the graph document model, type rules, validation,
 * DAG compilation, and deterministic HLSL generation. It must remain
 * pure TypeScript with no dependency on React, React Flow, Zustand,
 * Tauri, DOM/Web APIs, native addons, or C++ libraries.
 *
 * Current public surface: structured diagnostics, the JSON value grammar,
 * the strict Surface Profile Descriptor reader, and the ShaderGraphDocument
 * model with deterministic serialization.
 */

export const corePackageName = "@gglab/shader-graph-core";

/** Returns the package identity of the headless shader graph core. */
export function getCorePackageName(): string {
    return corePackageName;
}

export * from "./diagnostics.js";
export * from "./json-value.js";
export * from "./graph-types.js";
export * from "./node-definitions.js";
export * from "./surface-profile-descriptor.js";
export * from "./graph-document.js";
