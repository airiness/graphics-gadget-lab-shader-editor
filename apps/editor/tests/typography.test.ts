import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Typography lock — the app has exactly ONE type system:
// - two family stacks (UI + mono) with a CJK-capable fallback ordered
//   BEFORE any pure-Latin face (a missing Noto must never re-introduce
//   a random cross-family CJK fallback),
// - a fixed role scale (sizes / weights / line heights) that EVERY
//   font-size / font-weight / line-height declaration must reference.
// This test freezes both the token authority and the "no stray literal
// metrics" boundary, in the same exact-set style as the capability
// regression.

const appCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/app.css"), "utf8");

// --- family stacks -------------------------------------------------------------

// The token block lives in the second :root, anchored by the
// typography banner — the shadcn alias block earlier in the sheet also
// references --font-mono, so it must not be used as an anchor.
const typeRoot = appCss.indexOf("/* ---- typography");

it("anchors the UI stack on the unified Noto family and keeps CJK-capable faces ahead of pure-Latin ones", () => {
    expect(typeRoot).toBeGreaterThan(-1);
    const block = appCss.slice(typeRoot, appCss.indexOf("--font-mono:", typeRoot));
    // Unified family first (name coverage for both the CJK and the
    // newer variable-font naming lines).
    const notoCjk = block.indexOf("Noto Sans CJK JP");
    const notoVf = block.indexOf("Noto Sans JP");
    const notoLatin = block.indexOf("Noto Sans\"");
    expect(notoCjk).toBeGreaterThan(-1);
    expect(notoVf).toBeGreaterThan(notoCjk);
    expect(notoLatin).toBeGreaterThan(notoVf);
    // CJK-capable local faces stay AHEAD of the pure-Latin Segoe face
    // (a missing Noto must not re-introduce a random CJK fallback).
    const yahei = block.indexOf("Microsoft YaHei");
    const segoe = block.indexOf("Segoe UI");
    expect(yahei).toBeGreaterThan(notoLatin);
    expect(segoe).toBeGreaterThan(yahei);
    expect(block).toContain('"Segoe UI", system-ui, sans-serif;');
});

it("keeps the mono stack equal-width-Latin-first with the CJK fallback after the mono Latin faces", () => {
    const monoStart = appCss.indexOf("--font-mono:", typeRoot);
    const block = appCss.slice(monoStart, appCss.indexOf("--type-micro:", typeRoot));
    expect(block).toContain('"Cascadia Mono", "Cascadia Code", "Consolas"');
    const consolas = block.indexOf("Consolas");
    const yahei = block.indexOf("Microsoft YaHei");
    expect(consolas).toBeGreaterThan(-1);
    // A proportional CJK face in front of the mono Latin would break
    // code alignment — the CJK fallback must come AFTER Consolas.
    expect(yahei).toBeGreaterThan(consolas);
    expect(block).toContain('"Microsoft YaHei", ui-monospace, monospace;');
});

// --- scale tokens (the single authority) ---------------------------------------

it("defines the six-size role scale and the semantic weights", () => {
    expect(appCss).toContain("--type-micro: 10.5px;");
    expect(appCss).toContain("--type-meta: 11px;");
    expect(appCss).toContain("--type-body: 12px;");
    expect(appCss).toContain("--type-code: 11.5px;");
    expect(appCss).toContain("--type-node: 13.5px;");
    expect(appCss).toContain("--type-display: 15px;");
    expect(appCss).toContain("--weight-strong: 600;");
    expect(appCss).toContain("--weight-heading: 700;");
    expect(appCss).toContain("--lh-body: 1.5;");
    expect(appCss).toContain("--lh-code: 1.6;");
    expect(appCss).toContain("--tracking-caps: 0.09em;");
});

// --- no stray literal metrics ----------------------------------------------------

function strayViolations(css: string): string[] {
    const violations: string[] = [];
    const lines = css.split("\n");
    lines.forEach((line, index) => {
        const n = index + 1;
        const trimmed = line.trim();
        if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("--")) {
            return; // comment or token definition
        }
        if (/font-size:\s*\d/.test(trimmed)) {
            violations.push(`L${n}: bare font-size literal — must reference a --type-* token: ${trimmed}`);
        }
        // font shorthand: only inherit/unset/initial, or a fully tokenized form
        if (/\bfont:\s/.test(line) && !/\bfont:\s(inherit|unset|initial);/.test(line)) {
            violations.push(`L${n}: font shorthand must stay inherit/unset/initial (decompose metrics into tokens): ${trimmed}`);
        }
    });
    return violations;
}

it("allows no stray literal font metrics anywhere in the sheet", () => {
    expect(strayViolations(appCss)).toEqual([]);
});

it("keeps font-weight to the three semantic values (400 base, 600 strong, 700 heading)", () => {
    const offenders = appCss
        .split("\n")
        .filter((line) => /font-weight:\s*\d/.test(line) && !/font-weight:\s*(400|600|700);/.test(line));
    expect(offenders).toEqual([]);
});

it("keeps line-height to the two scale values (body 1.5, code 1.6) or standard keywords", () => {
    const offenders = appCss
        .split("\n")
        .filter((line) => /line-height:\s*[\d.]+/.test(line) && !/line-height:\s*(1\.5|1\.6);/.test(line));
    expect(offenders).toEqual([]);
});

it("keeps caps tracking to the single --tracking-caps value (plus literal 0 for untracked mono and 0.01em micro-tracked Latin)", () => {
    const offenders = appCss
        .split("\n")
        .filter((line) => /letter-spacing:\s*[\d.]+/.test(line) && !/letter-spacing:\s*(0|0\.01em);/.test(line));
    expect(offenders).toEqual([]);
});

it("routes the app body through the UI stack and keeps the code surfaces on the mono stack", () => {
    expect(appCss).toContain("font-family: var(--font-ui);");
    expect(appCss.match(/font-family: var\(--font-mono\);/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
});
