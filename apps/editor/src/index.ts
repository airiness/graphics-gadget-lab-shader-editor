import { getCorePackageName } from "@gglab/shader-graph-core";

/**
 * Composition root for the shader graph editor application.
 *
 * The desktop shell and native bridge are wired here; graph semantics,
 * validation, and HLSL generation stay in the headless core package.
 */
export function resolveCorePackageName(): string {
    return getCorePackageName();
}
