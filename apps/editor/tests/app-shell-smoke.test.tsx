/**
 * The App shell render smoke: a rendering-phase runtime error (the
 * white-screen class of failure — a blank desktop window, no other
 * signal) is caught here as a test failure, before it reaches the user.
 * Global configuration and selection are separate surfaces.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { App } from "../src/app.js";

describe("the app shell renders without throwing", () => {
    it("renders the whole surface, with selection and global action surfaces", () => {
        const html = renderToString(<App />);
        expect(html.length).toBeGreaterThan(0);
        expect(html).toContain('aria-label="Selection Inspector"');
        expect(html).toContain("Select a node on the canvas");
        expect(html).not.toContain("gglab-inspector-tabs");
        for (const label of ["Document…", "Profile…", "Advanced…", "Build / HLSL", "Preview details"]) expect(html).toContain(label);

    });
});
