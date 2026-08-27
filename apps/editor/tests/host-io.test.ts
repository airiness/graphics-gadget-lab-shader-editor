/**
 * Desktop slice 1 — native document I/O regression (host/file abstraction).
 *
 * The layer contract under test:
 *   native layer (official Tauri plugins only, NO custom commands)
 *                — dialogs choose a path (and add THAT path to the
 *                  filesystem scope); the fs plugin serves scoped
 *                  UTF-8 bytes. It does not know what a shader graph,
 *                  a profile, or a retained field is;
 *   core         — parses and serializes (the .shadergraph disk format);
 *   editor (app) — document + session state; chooses which text moves.
 *
 * The `FileChannel` is the app's seam over the host. It is pure: the
 * host's official API functions (open / save / readTextFile /
 * writeTextFile) are injected, so these tests drive it with fakes (no
 * Tauri runtime needed) and assert argument shapes, the runtime type
 * boundary on reads, and cancellation/error semantics.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopFileChannel, isDesktopHost, type DesktopHost } from "../src/host-io.js";

const FAKE_DOCUMENT_TEXT = '{"schemaVersion":1,"graphId":"g","profile":"gglab.surface","profileVersion":1,"parameters":[],"nodes":[],"connections":[],"editorMetadata":{"nodes":{}}}';

/// The host contract as a fake: the four official API functions,
/// recording EVERY call (record first, then delegate to the override —
/// or the fake default — so the call log is complete either way).
function fakeHost(
    overrides: Partial<Pick<DesktopHost, "openDialog" | "saveDialog" | "readTextFile" | "writeTextFile">> = {},
): {
    host: DesktopHost;
    opens: Array<Record<string, unknown>>;
    saves: Array<Record<string, unknown>>;
    reads: string[];
    writes: Array<{ path: string; contents: string }>;
} {
    const opens: Array<Record<string, unknown>> = [];
    const saves: Array<Record<string, unknown>> = [];
    const reads: string[] = [];
    const writes: Array<{ path: string; contents: string }> = [];
    const host: DesktopHost = {
        openDialog: (options) => {
            opens.push(options ?? {});
            if (overrides.openDialog !== undefined) {
                return Promise.resolve(overrides.openDialog(options));
            }
            return Promise.resolve("C:\\gglab\\surface-base.shadergraph");
        },
        saveDialog: (options) => {
            saves.push(options ?? {});
            if (overrides.saveDialog !== undefined) {
                return Promise.resolve(overrides.saveDialog(options));
            }
            return Promise.resolve("C:\\gglab\\renamed.shadergraph");
        },
        readTextFile: (path) => {
            reads.push(path);
            if (overrides.readTextFile !== undefined) {
                return Promise.resolve(overrides.readTextFile(path));
            }
            return Promise.resolve(FAKE_DOCUMENT_TEXT);
        },
        writeTextFile: (path, contents) => {
            writes.push({ path, contents });
            if (overrides.writeTextFile !== undefined) {
                return Promise.resolve(overrides.writeTextFile(path, contents));
            }
            return Promise.resolve(undefined);
        },
    };
    return { host, opens, saves, reads, writes };
}

describe("host/file abstraction (native document I/O)", () => {
    it("is only a desktop host when the Tauri marker is present on the window", () => {
        expect(isDesktopHost({ __TAURI_INTERNALS__: {} })).toBe(true);
        expect(isDesktopHost({})).toBe(false);
        expect(isDesktopHost(null)).toBe(false);
        expect(isDesktopHost("not a window")).toBe(false);
    });

    it("reads through the host's readTextFile with the exact path argument", async () => {
        const { host, reads } = fakeHost();
        const channel = createDesktopFileChannel(host);
        const text = await channel.readText("C:\\docs\\graph.shadergraph");
        expect(text).toContain("schemaVersion");
        expect(reads).toEqual(["C:\\docs\\graph.shadergraph"]);
    });

    it("refuses a non-text read payload at the boundary (no cast through)", async () => {
        const { host } = fakeHost({
            readTextFile: async () => ({ bytes: [1, 2, 3] }), // wrong shape from the host
        });
        const channel = createDesktopFileChannel(host);
        await expect(channel.readText("C:\\docs\\weird.shadergraph")).rejects.toThrow(/unexpected payload for C:\\docs\\weird\.shadergraph — expected UTF-8 text/);
    });

    it("writes through the host's writeTextFile with path + contents", async () => {
        const { host, writes } = fakeHost();
        const channel = createDesktopFileChannel(host);
        const expectedContents = '{"schemaVersion":1}';
        await channel.writeText("C:\\docs\\out.shadergraph", expectedContents);
        expect(writes).toEqual([{ path: "C:\\docs\\out.shadergraph", contents: expectedContents }]);
    });

    it("picks document paths through the open dialog with the .shadergraph filter; cancel is null", async () => {
        const { host, opens, saves } = fakeHost({
            openDialog: async () => null, // user cancel
        });
        const channel = createDesktopFileChannel(host);
        expect(await channel.pickDocumentPath()).toBeNull();
        expect(opens).toHaveLength(1);
        const filter = (opens[0] as { filters?: Array<{ extensions?: readonly string[] }> })?.filters?.[0];
        expect(filter !== undefined).toBe(true);
        if (filter !== undefined) {
            expect(filter.extensions).toEqual(expect.arrayContaining(["shadergraph", "json"]));
        }
        expect(saves).toHaveLength(0);
    });

    it("picks descriptor paths with the JSON-only filter", async () => {
        const { host, opens } = fakeHost({
            openDialog: async () => "C:\\profiles\\GGLab.Surface\\2\\descriptor.json",
        });
        const channel = createDesktopFileChannel(host);
        expect(await channel.pickDescriptorPath()).toBe("C:\\profiles\\GGLab.Surface\\2\\descriptor.json");
        const filter = (opens[0] as { filters?: Array<{ extensions?: readonly string[] }> })?.filters?.[0];
        expect(filter !== undefined).toBe(true);
        if (filter !== undefined) {
            expect(filter.extensions).toEqual(["json"]);
        }
    });

    it("picks save destinations through the save dialog, passing a default name", async () => {
        const { host, saves } = fakeHost();
        const channel = createDesktopFileChannel(host);
        expect(await channel.pickSavePath("surface-base.shadergraph")).toBe("C:\\gglab\\renamed.shadergraph");
        expect(saves).toHaveLength(1);
        expect((saves[0] as { defaultPath?: string })?.defaultPath).toBe("surface-base.shadergraph");
    });

    it("surfaces host failures as rejections carrying the host's message", async () => {
        const { host } = fakeHost({
            writeTextFile: async () => {
                throw new Error("Write failed at C:\\gglab\\blocked.shadergraph: access denied");
            },
        });
        const channel = createDesktopFileChannel(host);
        await expect(channel.writeText("C:\\gglab\\blocked.shadergraph", "x")).rejects.toThrow(/Write failed at C:\\gglab\\blocked\.shadergraph: access denied/);
    });
});

describe("desktop host wiring (this repo's tauri surface)", () => {
    const rootDir = dirname(fileURLToPath(new URL(import.meta.url, import.meta.url)));
    const tauriDir = resolve(rootDir, "../src-tauri");

    it("keeps the window's native drag-drop disabled (the editor's HTML5 DnD requires it off)", async () => {
        const conf = JSON.parse(await readFile(resolve(tauriDir, "tauri.conf.json"), "utf8")) as {
            app?: { windows?: Array<Record<string, unknown>> };
        };
        const windows = conf.app?.windows ?? [];
        expect(windows).toHaveLength(1);
        expect(windows[0]?.["dragDropEnabled"]).toBe(false);
        expect(windows[0]?.["title"]).toBe("GGLab Shader Graph Editor");
    });

    it("grants exactly the scoped surface (EXACT set — any extra or missing permission fails)", async () => {
        const caps = (JSON.parse(await readFile(resolve(tauriDir, "capabilities/default.json"), "utf8")) as Array<{
            identifier: string;
            windows: string[];
            permissions: string[];
        }>)[0];
        expect(caps !== undefined).toBe(true);
        if (caps === undefined) {
            return;
        }
        // This is the security boundary for file access — assert the
        // exact set (sorted), not a subset or a prefix match.
        // core:window:allow-destroy is the CLOSE PATH in Tauri 2.11.5:
        // with a JS close listener registered, the core auto-prevents
        // every close and the api's onCloseRequested wrapper destroys
        // the window when the handler does not preventDefault().
        expect([...caps.permissions].sort()).toEqual(
            ["core:default", "core:window:allow-destroy", "core:window:allow-set-title", "dialog:allow-open", "dialog:allow-save", "fs:allow-read-text-file", "fs:allow-write-text-file"].sort(),
        );
    });

    it("exposes exactly the four sanctioned host-boundary commands, on top of the official plugins (EXACT set — any extra command fails)", async () => {
        const libRs = await readFile(resolve(tauriDir, "src/lib.rs"), "utf8");
        const mainRs = await readFile(resolve(tauriDir, "src/main.rs"), "utf8");
        // The shell keeps the two official plugins — the access model.
        expect(libRs).toContain("tauri_plugin_dialog");
        expect(libRs).toContain("tauri_plugin_fs");
        // The web-facing command surface is EXACTLY the four host-boundary
        // capabilities of the toolchain client (design section 9) — a
        // fifth command is a surface violation.
        // The attribute is `#[tauri::command(rename = "<id>")]` — the
        // `[` sits inside a character class here: a bare `[` in a regex
        // literal would start a class of its own and swallow the rest
        // of the pattern. The rename value is the web-facing invoke id.
        const commandPattern = /#[[]tauri::command\(rename = "([^"]+)"\)/g;
        const commands = [...libRs.matchAll(commandPattern)].map((m) => m[1] as string);
        expect(commands.sort()).toEqual([
            "shader-tool-cancel",
            "shader-tool-compile",
            "shader-tool-discover",
            "shader-tool-handshake",
        ]);
        // No raw arbitrary-path file access anywhere on the web-facing
        // host surface itself.
        expect(mainRs).not.toContain("#[tauri::command]");
        expect(mainRs).not.toContain("invoke_handler");
        expect(mainRs).not.toContain("fs::read_to_string");
        expect(mainRs).not.toContain("fs::write");
        expect(libRs).not.toContain("fs::read_to_string");
        expect(libRs).not.toContain('std::fs::write');
    });

    it("tightens the webview CSP now that the host can move real files", async () => {
        const conf = JSON.parse(await readFile(resolve(tauriDir, "tauri.conf.json"), "utf8")) as {
            app?: { security?: { csp?: string | null; devCsp?: string | null } };
        };
        const security = conf.app?.security;
        expect(security?.csp).not.toBeNull();
        expect(typeof security?.csp).toBe("string");
        if (typeof security?.csp === "string") {
            expect(security.csp).toContain("script-src 'self'");
            expect(security.csp).toContain("connect-src");
        }
        expect(typeof security?.devCsp).toBe("string");
    });
});
