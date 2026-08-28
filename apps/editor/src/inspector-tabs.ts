/**
 * The inspector's zones (surface grouping; design document section 13,
 * surface note): the right inspector holds distinct RESPONSIBILITIES,
 * and each one gets a zone with its own tab. The grouping is honest by
 * construction:
 *
 * - a zone's STATE stays visible while its content is zoned out — the
 *   tab label carries a live badge, projected from facts the app already
 *   holds (the badge projects, it never owns: no new state authority);
 * - switching zones is pure surface organization: it concedes no
 *   authority over any zone's state, and changes no other view's facts;
 * - every badge is a rendering of facts the app holds TODAY (graph/
 *   contract verdicts, dirty, the emission's own state, the
 *   composition's verdict) — nothing here is computed twice or owned.
 */

export const INSPECTOR_ZONES = ["contract", "document", "emission", "build"] as const;
export type InspectorZone = (typeof INSPECTOR_ZONES)[number];

export const INSPECTOR_ZONE_LABELS: Readonly<Record<InspectorZone, string>> = {
    contract: "Contract & checks",
    document: "Document",
    emission: "Emission",
    build: "Native build",
};

/** The badge variants the zone strip may express (the kit's vocabulary). */
export type InspectorZoneBadgeVariant = "ok" | "warn" | "error" | "default";

export interface InspectorZoneBadge {
    readonly variant: InspectorZoneBadgeVariant;
    readonly label: string;
}

/** The zone facts — plain values, each with exactly one owner upstream
 *  (the badge only renders them). */
export interface InspectorZoneFacts {
    /** Contract & checks: the graph verdicts, the contract sets, and the
     *  load verdict (absent load = nothing to fail). */
    readonly checks: { readonly ok: boolean; readonly problemCount: number };
    /** Document: the session's dirty star (no save claims — "clean"
     *  only means "no pending changes right now"). */
    readonly document: { readonly dirty: boolean };
    /** Emission: the core's own state (never emitted / emitted / failed
     *  with its own problem count). */
    readonly emission: { readonly state: "none" | "ok" | "failed"; readonly problemCount: number };
    /** Build: the composition's verdict (Ready / NotReady). */
    readonly build: { readonly ready: boolean };
}

const problemLabel = (count: number): string => `${count} problem${count === 1 ? "" : "s"}`;

/** The live badge for one zone: its current state, complete and
 *  structured — the tab is the zone's always-visible state row. */
export function inspectorZoneBadge(zone: InspectorZone, facts: InspectorZoneFacts): InspectorZoneBadge {
    switch (zone) {
        case "contract":
            if (facts.checks.ok) {
                return { variant: "ok", label: "ok" };
            }
            // Not ok: the complete problem count where one exists; the
            // zone is still honest with a bare attention mark when the
            // failure carries no error-class problems (e.g. warnings).
            return { variant: "error", label: facts.checks.problemCount > 0 ? problemLabel(facts.checks.problemCount) : "attention" };
        case "document":
            return facts.document.dirty ? { variant: "warn", label: "unsaved" } : { variant: "default", label: "clean" };
        case "emission":
            if (facts.emission.state === "failed") {
                return { variant: "error", label: problemLabel(facts.emission.problemCount) };
            }
            if (facts.emission.state === "ok") {
                return { variant: "ok", label: "emitted" };
            }
            return { variant: "default", label: "not emitted" };
        case "build":
            return facts.build.ready ? { variant: "ok", label: "Ready" } : { variant: "error", label: "NotReady" };
    }
}
