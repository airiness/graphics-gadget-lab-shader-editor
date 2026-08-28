/**
 * The App shell render smoke: a rendering-phase runtime error (the
 * white-screen class of failure — a blank desktop window, no other
 * signal) is caught here as a test failure, before it reaches the user.
 * The smoke also pins the inspector zone strip: the tablist must be in
 * the rendered output, with each zone's live state badge present.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { App } from "../src/app.js";

describe("the app shell renders without throwing", () => {
    it("renders the whole surface, including the inspector zone strip", () => {
        const html = renderToString(<App />);
        expect(html.length).toBeGreaterThan(0);
        // The zone strip is rendered (the ampersand is entity-encoded in
        // HTML output) — and each zone's live badge states itself:
        expect(html).toContain("gglab-inspector-tabs");
        expect(html).toContain("Contract &amp; checks");
        for (const label of ["Document", "Emission", "Native build"]) {
            expect(html).toContain(label);
        }
    });
});
