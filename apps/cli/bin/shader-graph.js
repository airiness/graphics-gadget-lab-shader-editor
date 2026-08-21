#!/usr/bin/env node
// pnpm bin shim for the shader-graph command (tsx runtime).
//
// tsx must be installed as Node's --import hook (not registered in-process),
// so the shim re-executes node once with `--import <tsx>` against this same
// shim; the re-executed process (env-guard) resolves the TypeScript entry
// under tsx's resolution hooks — so the repository's relative import
// specifiers resolve at runtime — imports it, and runs main() with the user
// argv. stdio and the exit code are the child process's own.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHIM = fileURLToPath(import.meta.url);
const ENTRY = new URL("../src/index.ts", import.meta.url).href;

if (process.env.__GGLAB_SHADER_GRAPH_CLI_RUN === "1") {
    const { main } = await import(ENTRY);
    process.exitCode = main(process.argv.slice(2));
} else {
    const require = createRequire(import.meta.url);
    const tsx = pathToFileURL(require.resolve("tsx")).href;
    const args = process.argv.slice(2);
    const result = spawnSync(process.execPath, ["--import", tsx, SHIM, ...args], {
        stdio: "inherit",
        env: { ...process.env, __GGLAB_SHADER_GRAPH_CLI_RUN: "1" },
    });
    if (result.error) {
        process.stderr.write(`${result.error}\n`);
        process.exitCode = 2;
    } else {
        process.exitCode = result.status === null ? 1 : result.status;
    }
}
