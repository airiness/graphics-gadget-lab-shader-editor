/**
 * Desktop slice 1 — native document I/O regression (host/file abstraction).
 *
 * The layer contract under test:
 *   host (Tauri)   — only a path + UTF-8 bytes; it does not know what a
 *                    shader graph, a profile, or a retained field is;
 *   core           — parses and serializes (the .shadergraph disk format);
 *   editor (app)   — document + session state; chooses which text moves.
 *
 * The `FileChannel` is the app's seam over the host. It is pure: the
 * Tauri `invoke` and the dialog calls are injected, so these tests drive
 * it with fakes (no Tauri runtime needed) and assert the exact IPC names,
 * argument shapes, and cancellation/error semantics of the contract.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDesktopFileChannel, isDesktopHost, type DesktopHost } from "../src/host-io.js";

/// The host contract as a fake: invoke + both dialogs, recording EVERY
/// call (record first, then delegate to the override — or the fake
/// default — so the call log is complete either way).
function fakeHost(overrides: Partial<Pick<DesktopHost, "invoke" | "openDialog" | "saveDialog">> = {}): {
    host: DesktopHost;
    invokes: Array<{ command: string; args?: Record<string, unknown> }>;
    opens: Array<Record<string, unknown>>;
    saves: Array<Record<string, unknown>>;
} {
    const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const opens: Array<Record<string, unknown>> = [];
    const saves: Array<Record<string, unknown>> = [];
    const host: DesktopHost = {
        invoke: (command, args) => {
            invokes.push({ command, args });
            if (overrides.invoke !== undefined) {
                return Promise.resolve(overrides.invoke(command, args));
            }
            if (command === "read_text_file") {
                return Promise.resolve('{"schemaVersion":1,"graphId":"g","profile":"gglab.surface","profileVersion":1,"parameters":[],"nodes":[],"connections":[],"editorMetadata":{"nodes":{}}}');
            }
            return Promise.reject(new Error(`unexpected invoke in fake host: ${command}`));
        },
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
    };
    return { host, invokes, opens, saves };
}

describe("host/file abstraction (native document I/O)", () => {
    it("is only a desktop host when the Tauri marker is present on the window", () => {
        expect(isDesktopHost({ __TAURI_INTERNALS__: {} })).toBe(true);
        expect(isDesktopHost({})).toBe(false);
        expect(isDesktopHost(null)).toBe(false);
        expect(isDesktopHost("not a window")).toBe(false);
    });

    it("reads through the host's read_text_file with the exact path argument", async () => {
        const { host, invokes } = fakeHost();
        const channel = createDesktopFileChannel(host);
        const text = await channel.readText("C:\\docs\\graph.shadergraph");
        expect(text).toContain("schemaVersion");
        expect(invokes).toEqual([{ command: "read_text_file", args: { path: "C:\\docs\\graph.shadergraph" } }]);
    });

    it("writes through the host's write_text_file with path + contents", async () => {
        const { host, invokes } = fakeHost({
            invoke: async (command, args) => {
                if (command === "write_text_file") {
                    expect(args?.["contents"]).toContain("schemaVersion");
                    return null;
                }
                throw new Error(`unexpected invoke in fake host: ${command}`);
            },
        });
        const channel = createDesktopFileChannel(host);
        await channel.writeText("C:\\docs\\out.shadergraph", '{"schemaVersion":1}');
        const expectedContents = '{"schemaVersion":1}';
        expect(invokes).toEqual([{ command: "write_text_file", args: { path: "C:\\docs\\out.shadergraph", contents: expectedContents } }]);
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
            invoke: async (command) => {
                throw new Error(`Write failed at C:\\gglab\\blocked.shadergraph: access denied (host: ${command})`);
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

    it("exposes exactly the thin IPC surface: core defaults + dialog open/save (no semantic knowledge)", async () => {
        const caps = (JSON.parse(await readFile(resolve(tauriDir, "capabilities/default.json"), "utf8")) as Array<{
            identifier: string;
            windows: string[];
            permissions: string[];
        }>)[0];
        expect(caps !== undefined).toBe(true);
        if (caps === undefined) {
            return;
        }
        expect(caps.permissions).toEqual(expect.arrayContaining(["core:default", "dialog:allow-open", "dialog:allow-save"]));
        // Only core + dialog ACL ids — no document/semantic surface.
        for (const permission of caps.permissions) {
            expect(permission.startsWith("core:") || permission.startsWith("dialog:")).toBe(true);
        }
    });

    it("registers the two thin host file commands and the dialog plugin", async () => {
        const mainRs = await readFile(resolve(tauriDir, "src/main.rs"), "utf8");
        expect(mainRs).toContain("read_text_file");
        expect(mainRs).toContain("write_text_file");
        expect(mainRs).toContain("tauri_plugin_dialog");
        expect(mainRs).toContain("fs::read_to_string");
        expect(mainRs).toContain("fs::write");
    });
});
