import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Button-kit lock — the GGLab Tool Button Language is ONE. No second button
// language may exist (no parallel button classes in app.css, no ad-hoc
// geometry). This test freezes the kit's baseline: the variant set, the
// frozen geometry, the type-scale typography, and the five states.
// Same exact-boundary discipline as the capability + typography locks.

const uiRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/editor-ui/src");
const buttonCss = readFileSync(join(uiRoot, "components/ui/button.tsx"), "utf8");
const groupSource = readFileSync(join(uiRoot, "components/ui/button-group.tsx"), "utf8");
const barrel = readFileSync(join(uiRoot, "index.ts"), "utf8");

// The single CSS sheet must not redefine a button language.
const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/app.css"), "utf8");

it("keeps exactly the six frozen variants (destructive = the danger slot, available, not yet adopted)", () => {
    for (const variant of ["primary", "secondary", "toolbar", "ghost", "icon", "destructive"]) {
        expect(buttonCss).toContain(`${variant}:`);
    }
});

it("freezes the geometry baseline: 28px text / 26×26 icon, the --r-1 radius, 10px padding, 1px border, 6px icon gap, nowrap, 14px icons", () => {
    const base = buttonCss.match(/"relative inline-flex[^"]*"/)?.[0] ?? "";
    expect(base).toContain("rounded-[var(--r-1)]");
    expect(base).toContain(" border ");
    expect(base).toContain("gap-1.5"); // the 6px icon gap
    expect(base).toContain("whitespace-nowrap");
    expect(base).toContain("[&_svg]:size-3.5"); // 14px icons
    const sizes = buttonCss.slice(buttonCss.indexOf("size: {"), buttonCss.indexOf("},", buttonCss.indexOf("size: {")));
    expect(sizes).toContain("h-[28px] px-2.5");
    expect(sizes).toContain("h-[26px] w-[26px] p-0");
    // Two geometries only — the unused mid size is not part of the language.
    expect(buttonCss).not.toContain("compact:");
});

it("types the control text on the frozen scale (12px body size, 600 strong weight) instead of its own 13px/500 world", () => {
    const base = buttonCss.match(/"relative inline-flex[^"]*"/)?.[0] ?? "";
    expect(base).toContain("text-[length:var(--type-body)]");
    expect(base).toContain("font-semibold"); // 600 == --weight-strong
    expect(base).not.toContain("text-[13px]");
    expect(base).not.toContain("font-medium");
});

it("defines all five states explicitly (rest, hover, pressed, focus-visible, disabled)", () => {
    const base = buttonCss.match(/"relative inline-flex[^"]*"/)?.[0] ?? "";
    expect(base).toContain("active:translate-y-px"); // pressed
    expect(base).toContain("focus-visible:outline-2");
    expect(base).toContain("disabled:pointer-events-none");
    expect(base).toContain("disabled:opacity-50");
    // rest + per-variant hover (the still-screenshot affordance)
    const variantsBlock = buttonCss.slice(buttonCss.indexOf("variant: {"), buttonCss.indexOf("size: {"));
    expect((variantsBlock.match(/hover:/g) ?? []).length).toBeGreaterThanOrEqual(5);
});

it("ships the action-row unit (ButtonGroup) and exports it from the kit", () => {
    expect(groupSource).toContain("inline-flex");
    expect(groupSource).toContain("gap-2"); // fixed 8px spacing
    expect(barrel).toContain('export { ButtonGroup } from "./components/ui/button-group.js";');
});

it("carries the CJK line-metrics optical correction on every label (1.5px, one place)", () => {
    expect(buttonCss).toContain("inline-block [transform:translateY(1.5px)]");
});

it("keeps ONE uniform neutral edge on every variant (the edge never encodes the variant)", () => {
    const variantsBlock = buttonCss.slice(buttonCss.indexOf("variant: {"), buttonCss.indexOf("size: {"));
    const variantLines = variantsBlock.split("\n").filter((line) => /:\s*".*bg-/.test(line));
    for (const line of variantLines) {
        expect(line).toContain("border-border ");
        expect(line).not.toContain("border-primary");
        expect(line).not.toContain("border-destructive");
        expect(line).not.toContain("border-transparent");
    }
});

it("keeps ONE focus ring for every interactive control (the user-agent frame must not leak through a raw button)", () => {
    expect(appCss).toContain("button:focus-visible,");
    expect(appCss).toContain('[role="button"]:focus-visible');
    expect(appCss).toContain("outline: 2px solid var(--accent);");
    expect(appCss).toContain("outline-offset: 1px;");
    // One rule only — no per-class ring declarations may remain.
    expect((appCss.match(/outline: 2px solid var\(--accent\);/g) ?? []).length).toBe(1);
});

it("leaves no parallel button language in the app sheet", () => {
    expect(appCss).not.toMatch(/^\s*\.?gglab-btn/m);
    expect(appCss).not.toContain(".gglab-icobtn");
    expect(appCss).not.toContain(".gglab-doc-actions");
    expect(appCss).not.toContain(".gglab-close-prompt-actions");
    expect(appCss).not.toContain(".gglab-emission-actions");
});
