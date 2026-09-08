/** Read-only Node host. Deployment semantics and protocol readers live in the shared client. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { ENVIRONMENT_JSON_LIMIT, EnvironmentContractError, environmentAbsolutePath, environmentLocator, environmentRequire, readEnvironmentStateBinding, validateEnvironmentStateRoots, ENVIRONMENT_STATE_ROLES, readEnvironmentBootstrap, readEnvironmentRequest, readEnvironmentResponse, verifyEnvironmentClosure, type EnvironmentClosureHost, type EnvironmentEntry, type EnvironmentRequest, type VerifiedEnvironmentClosure } from "@gglab/shader-toolchain-client";

export const environmentSha256 = (text: string): string => createHash("sha256").update(text, "ascii").digest("hex");
function assertWindows(): void { environmentRequire(process.platform === "win32", "unsupported-platform", "Environment filesystem validation requires Windows"); }
/** lstat catches symbolic links/junctions; GetAttributes additionally catches non-symlink reparse tags. */
function assertNoReparse(paths: readonly string[]): void {
    assertWindows();
    const script = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.Encoding]::UTF8; $paths=ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach($p in $paths) { if (([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { [Console]::Out.Write("reparse"); exit 2 } }';
    try {
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { input: JSON.stringify(paths), encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: ENVIRONMENT_JSON_LIMIT });
    } catch (error) {
        const result = error as { stdout?: string };
        if (result.stdout === "reparse") throw new EnvironmentContractError("reparse-point", "Reparse point is forbidden");
        throw new EnvironmentContractError("io-error", "Windows file attribute inspection failed");
    }
}
export function assertEnvironmentHostPath(root: string): void {
    assertWindows(); environmentAbsolutePath(root);
    let path = resolve(root); const ancestors: string[] = [];
    for (;;) {
        try {
            const entry = lstatSync(path);
            environmentRequire(!entry.isSymbolicLink(), "reparse-point", "Reparse point is forbidden", path);
            ancestors.push(path);
        } catch (error) {
            if ((error as { code?: string }).code !== "ENOENT") throw error;
        }
        const parent = dirname(path); if (parent === path) break; path = parent;
    }
    assertNoReparse(ancestors);
}
function containedPath(root: string, locator: string): string {
    environmentLocator(locator);
    const path = resolve(root, locator), rel = relative(resolve(root), path);
    environmentRequire(rel !== "" && !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel), "invalid-path", "Path escapes root");
    return path;
}
function utf8(bytes: Buffer): string {
    const text = bytes.toString("utf8");
    environmentRequire(Buffer.from(text, "utf8").equals(bytes), "invalid-json", "Malformed UTF-8");
    return text;
}
function readBounded(path: string): string {
    const fd = openSync(path, "r");
    try {
        environmentRequire(fstatSync(fd).size <= ENVIRONMENT_JSON_LIMIT, "limit-exceeded", "JSON exceeds 16 MiB");
        const bytes = Buffer.alloc(ENVIRONMENT_JSON_LIMIT + 1); let count = 0;
        while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
        environmentRequire(count <= ENVIRONMENT_JSON_LIMIT, "limit-exceeded", "JSON exceeds 16 MiB");
        return utf8(bytes.subarray(0, count));
    } finally { closeSync(fd); }
}
function hashFile(path: string): { size: number; sha256: string } {
    const fd = openSync(path, "r");
    try {
        const before = fstatSync(fd); environmentRequire(before.isFile() && before.nlink === 1, "hard-link", "Expected independent regular file");
        const hash = createHash("sha256"), buffer = Buffer.alloc(1024 * 1024); let size = 0;
        for (;;) { const n = readSync(fd, buffer, 0, buffer.length, null); if (!n) break; hash.update(buffer.subarray(0, n)); size += n; }
        const after = fstatSync(fd);
        environmentRequire(before.size === size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, "source-changed", "File changed during observation", path);
        return { size, sha256: hash.digest("hex") };
    } finally { closeSync(fd); }
}
export const nodeEnvironmentClosureHost: EnvironmentClosureHost = {
    hashAscii: environmentSha256,
    assertOrdinaryRoot(root) {
        assertEnvironmentHostPath(root);
        return realpathSync.native(root);
    },
    entries(root) {
        if (!existsSync(root)) return [];
        const result: EnvironmentEntry[] = []; let directories = 0;
        let frontier = [root];
        while (frontier.length) {
            const paths: string[] = [], next: string[] = [];
            for (const directory of frontier) {
                environmentRequire(++directories <= 10000, "limit-exceeded", "Environment inventory exceeds 10000 directories");
                for (const name of readdirSync(directory).sort()) {
                    const path = join(directory, name), stat = lstatSync(path);
                    const locator = relative(root, path).replace(/\\/g, "/"); environmentLocator(locator);
                    environmentRequire(!stat.isSymbolicLink(), "reparse-point", "Linked entry is forbidden", locator);
                    paths.push(path);
                    result.push({ path: locator, kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other", linkCount: stat.nlink, reparsePoint: false });
                    environmentRequire(result.length <= 30000, "limit-exceeded", "Environment inventory exceeds host bound");
                    if (stat.isDirectory()) next.push(path);
                }
            }
            // Check every reparse tag before descending into the next level or reading any member bytes.
            if (paths.length) assertNoReparse(paths);
            frontier = next;
        }
        return result;
    },
    readManifest(root) { const path = join(root, "environment.json"); return existsSync(path) && lstatSync(path).isFile() ? readBounded(path) : null; },
    hashMember(root, locator) { return hashFile(containedPath(root, locator)); },
};
export function verifyEnvironmentDirectory(root: string) {
    environmentAbsolutePath(root);
    return verifyEnvironmentClosure(nodeEnvironmentClosureHost, resolve(root));
}
/** No mutating producer operation is exposed while the proposal is pending review. */
export function inspectEnvironmentProducer(repositoryRoot: string, suppliedRequest?: EnvironmentRequest) {
    assertEnvironmentHostPath(repositoryRoot);
    const bootstrapPath = containedPath(repositoryRoot, "Scripts/Environment/bootstrap.json"); assertEnvironmentHostPath(bootstrapPath);
    const bootstrap = readEnvironmentBootstrap(readBounded(bootstrapPath));
    const request = readEnvironmentRequest(suppliedRequest ?? { requestVersion: 1, operation: "discover", repositoryRoot, searchRoots: bootstrap.defaultSearchRoots });
    environmentRequire(request.operation === "discover" || request.operation === "verify", "approval-required", "Environment publish/init-state require owner review before import");
    if (request.operation === "discover") environmentRequire(resolve(request.repositoryRoot).toLowerCase() === resolve(repositoryRoot).toLowerCase(), "invalid-path", "Bootstrap repository mismatch");
    const publisher = containedPath(repositoryRoot, bootstrap.publisher); assertEnvironmentHostPath(publisher);
    const observation = hashFile(publisher);
    const python = spawnSync("python", ["-c", "import sys;sys.exit(0 if sys.version_info >= (3,12) else 2)"], { windowsHide: true, timeout: 30000 });
    environmentRequire(!python.error && python.status === 0, "unsupported-platform", "Python 3.12+ is required; no automatic installation");
    environmentRequire(hashFile(publisher).sha256 === observation.sha256, "source-changed", "Publisher changed before invocation");
    const processResult = spawnSync("python", [realpathSync(publisher)], { input: JSON.stringify(request), cwd: repositoryRoot, windowsHide: true, timeout: 120000, maxBuffer: ENVIRONMENT_JSON_LIMIT });
    environmentRequire(!processResult.error, "producer-unavailable", "Producer process failed or exceeded its host bound");
    environmentRequire(hashFile(publisher).sha256 === observation.sha256, "source-changed", "Publisher changed during invocation");
    return { publisherSha256: observation.sha256, response: readEnvironmentResponse(utf8(processResult.stdout), processResult.status, request.operation) };
}

/** Read-only recovery inspection. A missing/invalid state is never recreated or overwritten here. */
export function inspectEnvironmentState(closure: VerifiedEnvironmentClosure, stateRoot: string) {
    validateEnvironmentStateRoots(closure.root, stateRoot);
    assertEnvironmentHostPath(stateRoot);
    environmentRequire(!resolve(stateRoot).split(/[\\/]/).at(-1)?.toLowerCase().startsWith(".staging-"), "incomplete-publication", "Staging state cannot be recovered");
    const entries = nodeEnvironmentClosureHost.entries(stateRoot);
    for (const entry of entries) {
        environmentRequire(entry.kind !== "other" && (entry.kind !== "file" || entry.linkCount === 1), "invalid-member", "Linked or non-regular state entry", entry.path);
    }
    for (const locator of new Set(Object.values(ENVIRONMENT_STATE_ROLES))) {
        environmentRequire(entries.some(e => e.path === locator && e.kind === "directory"), "missing-member", "Missing state directory", locator);
    }
    return readEnvironmentStateBinding(readBounded(join(stateRoot, "state.json")), stateRoot, closure);
}

/** Read a verified contract member at its final locator; never fall back to a checkout descriptor. */
export function readEnvironmentRoleText(closure: VerifiedEnvironmentClosure, role: "surfaceProfile1" | "surfaceProfile2") {
    const locator = closure.manifest.roles[role], path = containedPath(closure.root, locator);
    assertEnvironmentHostPath(path);
    const text = readBounded(path), bytes = Buffer.from(text, "utf8");
    const member = closure.manifest.members.find(m => m.path === locator);
    environmentRequire(member && member.size === bytes.length && member.sha256 === createHash("sha256").update(bytes).digest("hex"), "hash-mismatch", "Contract member changed since closure verification", locator);
    return text;
}
