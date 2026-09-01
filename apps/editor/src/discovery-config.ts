/**
 * The explicit tool-discovery configuration (design authority: section 5,
 * the discovery model — rules 1 and 2 are editor-owned CONFIGURATION
 * values):
 *
 * - rule 1 — an explicit editor configuration (a path set by the user in
 *   editor settings);
 * - rule 2 — a configured sibling GGLab build output (a configured
 *   build-output location).
 *
 * Rules, stated where they live (the same discipline as the build-target
 * configuration):
 *
 * - the values are ALWAYS explicit, visible in the surface, and
 *   changeable;
 * - an empty value is the honest "not configured": that rule records its
 *   OWN failure (a fact, never a silent default);
 * - `bundled` (rule 3) is a WORLD FACT, not a configuration value — it is
 *   absent in development, so the request states it as an explicit
 *   `false` rather than hiding it;
 * - the configuration passes through to the discovery request VERBATIM —
 *   no path rewriting here: the rule walk, and the resolution of each
 *   location, belong to the service (its host facts), not to this value.
 */
import type { DiscoverRequest } from "@gglab/shader-toolchain-client";

/** The session's discovery configuration: values, not effects. An empty
 *  string means "not configured" (that rule records its own failure). */
export interface DiscoveryConfiguration {
    readonly explicitConfig: string;
    readonly siblingBuildOutput: string;
}

export function createDiscoveryConfiguration(): DiscoveryConfiguration {
    return { explicitConfig: "", siblingBuildOutput: "" };
}

/** A configuration change is a new value; an unchanged value is an
 *  honest no-op (the same reference). */
export function setExplicitToolPath(configuration: DiscoveryConfiguration, path: string): DiscoveryConfiguration {
    return configuration.explicitConfig === path ? configuration : { ...configuration, explicitConfig: path };
}

export function setSiblingBuildOutput(configuration: DiscoveryConfiguration, path: string): DiscoveryConfiguration {
    return configuration.siblingBuildOutput === path ? configuration : { ...configuration, siblingBuildOutput: path };
}

/** The discovery request for one configuration: an unset field becomes
 *  ABSENT (`undefined`) — the honest "not configured" — and `bundled`
 *  states the development fact explicitly (no bundled deployment here).
 *  The request is the single place the values become a boundary input. */
export function discoveryRequestFor(configuration: DiscoveryConfiguration): DiscoverRequest {
    return {
        explicitConfig: configuration.explicitConfig === "" ? undefined : configuration.explicitConfig,
        siblingBuildOutput: configuration.siblingBuildOutput === "" ? undefined : configuration.siblingBuildOutput,
        bundled: false,
    };
}
