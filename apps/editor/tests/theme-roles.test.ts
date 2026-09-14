import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/app.css"), "utf8");
function color(name: string): number[] {
    const hex = new RegExp(`--${name}: #([0-9a-f]{6});`).exec(css)?.[1];
    if (!hex) throw new Error(`Missing literal theme color ${name}`);
    return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
}
function luminance(rgb: number[]): number {
    return rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
}
function contrast(a: string, b: string): number {
    const left = luminance(color(a)), right = luminance(color(b));
    return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}
describe("Graphite and Iris semantic theme", () => {
    it("keeps body and small metadata text readable on every shell surface", () => {
        for (const text of ["text", "muted", "faint", "accent", "info", "ok", "warn", "error"]) {
            for (const surface of ["bg", "panel", "panel-2", "panel-hi"]) {
                expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        expect(contrast("accent-ink", "accent")).toBeGreaterThanOrEqual(4.5);
    });
    it("uses distinct interaction, information and verdict colors", () => {
        const roles = ["accent", "info", "ok", "warn", "error"].map(role => color(role).join(","));
        expect(new Set(roles).size).toBe(roles.length);
        for (const surface of ["bg", "panel", "panel-2", "panel-hi"]) {
            const channels = color(surface);
            expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(0.04);
        }
    });
    it("does not color target selection as success or failed evidence as a warning", () => {
        expect(css).toMatch(/\.gglab-tab-preview\s*\{\s*color: var\(--accent\)/);
        expect(css).toMatch(/\.gglab-explorer-open\s*\{\s*color: var\(--accent\)/);
        expect(css).toMatch(/\.gglab-view-state-failed\s*\{ color: var\(--error\)/);
        expect(css).toMatch(/\.gglab-view-severity-error\s*\{\s*color: var\(--error\)/);
        expect(css).not.toContain("var(--err,");
        expect(css).not.toContain("var(--edge)");
    });
});
