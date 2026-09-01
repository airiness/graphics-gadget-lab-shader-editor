/**
 * The inspector zone badges (surface grouping; design section 13,
 * surface note): each badge is a COMPLETE statement of the zone's live
 * state, projected from facts the editor already holds — the tests pin
 * the projections so no zone's state can ever be shown half-way.
 */
import { describe, expect, it } from "vitest";
import { INSPECTOR_ZONES, INSPECTOR_ZONE_LABELS, inspectorZoneBadge, type InspectorZoneFacts } from "../src/inspector-tabs.js";

const facts = (patch: Partial<InspectorZoneFacts> = {}): InspectorZoneFacts => ({
    selection: { nodeSelected: false },
    checks: { ok: true, problemCount: 0 },
    document: { dirty: false },
    emission: { state: "none", problemCount: 0 },
    build: { ready: false },
    ...patch,
});

describe("inspector zones — the live state row of each tab", () => {
    it("exposes exactly five zones, each with a stable label", () => {
        expect(INSPECTOR_ZONES).toEqual(["selection", "contract", "document", "emission", "build"]);
        for (const zone of INSPECTOR_ZONES) {
            expect(INSPECTOR_ZONE_LABELS[zone]).toBeTruthy();
        }
    });

    it("selection: states whether contextual node properties are available", () => {
        expect(inspectorZoneBadge("selection", facts())).toEqual({ variant: "default", label: "none" });
        expect(inspectorZoneBadge("selection", facts({ selection: { nodeSelected: true } }))).toEqual({
            variant: "default",
            label: "selected",
        });
    });

    it("contract & checks: ok stays ok; a failing zone states the complete problem count", () => {
        expect(inspectorZoneBadge("contract", facts())).toEqual({ variant: "ok", label: "ok" });
        expect(inspectorZoneBadge("contract", facts({ checks: { ok: false, problemCount: 3 } }))).toEqual({ variant: "error", label: "3 problems" });
        expect(inspectorZoneBadge("contract", facts({ checks: { ok: false, problemCount: 1 } }))).toEqual({ variant: "error", label: "1 problem" });
    });

    it("contract & checks: no error-class failures -> an honest attention mark, never an invented count", () => {
        expect(inspectorZoneBadge("contract", facts({ checks: { ok: false, problemCount: 0 } }))).toEqual({ variant: "error", label: "attention" });
    });

    it("document: dirty states UNSAVED; clean states only that — no save claims", () => {
        expect(inspectorZoneBadge("document", facts())).toEqual({ variant: "default", label: "clean" });
        expect(inspectorZoneBadge("document", facts({ document: { dirty: true } }))).toEqual({ variant: "warn", label: "unsaved" });
    });

    it("emission: the core's own state — never emitted / emitted / failed with the core's OWN count", () => {
        expect(inspectorZoneBadge("emission", facts())).toEqual({ variant: "default", label: "not emitted" });
        expect(inspectorZoneBadge("emission", facts({ emission: { state: "ok", problemCount: 0 } }))).toEqual({ variant: "ok", label: "emitted" });
        expect(inspectorZoneBadge("emission", facts({ emission: { state: "failed", problemCount: 2 } }))).toEqual({ variant: "error", label: "2 problems" });
    });

    it("build: the composition's verdict, nothing else is projected", () => {
        expect(inspectorZoneBadge("build", facts())).toEqual({ variant: "error", label: "NotReady" });
        expect(inspectorZoneBadge("build", facts({ build: { ready: true } }))).toEqual({ variant: "ok", label: "Ready" });
    });
});
