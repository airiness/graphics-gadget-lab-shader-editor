/**
 * Headless core for GGLab ShaderGraph semantics.
 *
 * This package owns the graph document model, type rules, validation,
 * DAG compilation, and deterministic HLSL generation. It must remain
 * pure TypeScript with no dependency on React, React Flow, Zustand,
 * Tauri, DOM/Web APIs, native addons, or C++ libraries.
 */

export const corePackageName = "@gglab/shader-graph-core";

/** Returns the package identity of the headless shader graph core. */
export function getCorePackageName(): string {
    return corePackageName;
}
