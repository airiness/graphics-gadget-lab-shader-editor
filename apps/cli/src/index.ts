import { getCorePackageName } from "@gglab/shader-graph-core";

/**
 * Entry point for the machine/automation authoring frontend.
 *
 * The CLI is a thin frontend over the headless core: it serializes
 * structured requests and core-owned results, and never defines graph
 * semantics of its own. The real command surface is designed from the
 * core's public API rather than from a prior command framework.
 */
export function resolveCorePackageName(): string {
    return getCorePackageName();
}
