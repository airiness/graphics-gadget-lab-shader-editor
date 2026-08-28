import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as client from "../src/index.js";
import { clientSupportedContractRange } from "../src/contract-range-declaration.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function listSourceFiles(directory: string): string[] {
    const entries = readdirSync(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(full));
        } else if (entry.name.endsWith(".ts")) {
            files.push(full);
        }
    }
    return files;
}

/**
 * The client's vocabulary independence (toolchain integration design,
 * section 14): no import of core types, and no argv type in the client's
 * vocabulary at all — tests that fail if either leaks in. The scans are
 * over the package's own source, which is what ships.
 */
describe("the client's vocabulary independence", () => {
    it("exposes no argv-shaped identifier on its public surface", () => {
        const names = Object.keys(client);
        expect(names.length).toBeGreaterThan(10);
        const argvShaped = names.filter((name) => /argv|command-line|commandline|arguments/i.test(name));
        expect(argvShaped).toEqual([]);
    });

    it("imports no host, core, or framework module anywhere in its source", () => {
        const files = listSourceFiles(join(packageRoot, "src"));
        expect(files.length).toBeGreaterThan(5);
        const forbidden = [
            /from\s+["']node:/u,
            /from\s+["']@gglab\/shader-graph-core/u,
            /from\s+["']@tauri-apps\//u,
            /from\s+["']react/u,
            /\brequire\s*\(/u,
            /\bchild_process\b/u,
        ];
        const violations: string[] = [];
        for (const file of files) {
            const content = readFileSync(file, "utf8");
            for (const pattern of forbidden) {
                if (pattern.test(content)) {
                    violations.push(`${file.slice(packageRoot.length).replace(/\\/gu, "/")}: ${pattern}`);
                }
            }
        }
        expect(violations).toEqual([]);
    });

    it("has no runtime dependencies at all — the package ships values and readers", () => {
        const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
            dependencies?: Record<string, string>;
        };
        expect(manifest.dependencies ?? {}).toEqual({});
    });

    it("declares the published v2 axis exactly — nothing more, nothing less (no 1..2: the v1→policy mapping is undefined and never guessed)", () => {
        expect(clientSupportedContractRange).toEqual({ minimum: 2, maximum: 2 });
    });
});
