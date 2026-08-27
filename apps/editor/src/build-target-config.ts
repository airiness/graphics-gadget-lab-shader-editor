/**
 * The explicit build-target configuration (design authority: section 8
 * and the global exit criteria: "the first real target is gglab-dx12, as
 * explicit configuration — a deployment choice for the development
 * environment, not a semantic fact and not a default smuggled into the
 * descriptor").
 *
 * Rules, stated where they live:
 *
 * - the target is ALWAYS explicit: the request's `target` comes from
 *   this configuration, never from the descriptor and never from the
 *   tool (whose published targets are a FACT the composition judges
 *   against, not a source of the value);
 * - the development default exists, is visible in the surface, and is
 *   changeable — it is a configuration default, not a hidden semantic;
 * - changing the target changes the NEXT BuildIntent (a result can only
 *   be `current` under the intent it belongs to); the tool's own
 *   compatibility verdict is untouched by it (section 6: the same
 *   executable never oscillates incompatible / compatible when the
 *   target changes).
 */

/** The development default target — explicit, visible, changeable. */
export const DEFAULT_BUILD_TARGET = "gglab-dx12";

/** The session's target configuration: a value, not an effect. */
export interface BuildTargetConfiguration {
    readonly target: string;
}

export function createBuildTargetConfiguration(target: string = DEFAULT_BUILD_TARGET): BuildTargetConfiguration {
    return { target };
}

/** A configuration change is a new value; the previous one keeps its
 *  facts (results bound to it stay in the line under their intent). An
 *  unchanged value is an honest no-op (the same reference). */
export function setBuildTarget(configuration: BuildTargetConfiguration, target: string): BuildTargetConfiguration {
    return configuration.target === target ? configuration : { target };
}
