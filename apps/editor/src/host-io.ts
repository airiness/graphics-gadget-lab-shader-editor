/**
 * Host/file abstraction — the seam between the editor (document + session
 * state) and the machine that stores files.
 *
 * The layer contract (kept one-directional, and mirrored in the Rust
 * shell):
 *   native layer (official Tauri plugins only, no custom commands)
 *                — dialog plugins choose a path (and, on a user pick,
 *                  add that path to the filesystem scope); the fs plugin
 *                  serves scoped UTF-8 bytes. Arbitrary-path access does
 *                  not exist in the host;
 *   shader-graph-core — parses and serializes documents (the
 *     .shadergraph disk format authority) and profile descriptors;
 *   this app        — owns document/session state and decides which
 *     text moves where.
 *
 * The channel is pure: the host's official API functions (open / save /
 * readTextFile / writeTextFile) are INJECTED, so the module has no Tauri
 * import of its own — the web build never downloads the desktop code,
 * and tests drive it with fakes.
 */

/** Detect the stable Tauri marker on a window-like object. */
export function isDesktopHost(host: unknown): boolean {
    if (typeof host !== "object" || host === null) {
        return false;
    }
    return "__TAURI_INTERNALS__" in (host as Record<string, unknown>);
}

/** File dialog options as produced by the channel; `multiple`/`directory`
 * are always false (single file picks only). */
export type FileDialogOptions = Record<string, unknown>;
/** Official `open` shape; `null` is a user cancel. */
export type HostOpenDialog = (options?: FileDialogOptions) => Promise<string | string[] | null>;
/** Official `save` shape; `null` is a user cancel. */
export type HostSaveDialog = (options?: FileDialogOptions) => Promise<string | null>;
/**
 * Official `readTextFile`. Declared as `Promise<unknown>` on purpose:
 * this boundary verifies the payload at runtime instead of casting it —
 * an IPC result is whatever the other side sent.
 */
export type HostReadTextFile = (path: string) => Promise<unknown>;
/** Official `writeTextFile`: scoped UTF-8 write. */
export type HostWriteTextFile = (path: string, contents: string) => Promise<void>;

export interface DesktopHost {
    readonly openDialog: HostOpenDialog;
    readonly saveDialog: HostSaveDialog;
    readonly readTextFile: HostReadTextFile;
    readonly writeTextFile: HostWriteTextFile;
}

/**
 * A file channel: pick paths through native dialogs, then move UTF-8
 * text to/from the host. `null` from the pick calls means the user
 * cancelled; rejections are explicit IO failures (never silent).
 */
export interface FileChannel {
    /** Open a document (`.shadergraph` / descriptor JSON) dialog → path. */
    pickDocumentPath(): Promise<string | null>;
    /** Open a descriptor (JSON) dialog → path. */
    pickDescriptorPath(): Promise<string | null>;
    /** Save dialog → destination path (the host appends nothing; the name
     * is what the user chose). */
    pickSavePath(defaultName: string): Promise<string | null>;
    /** Read scoped UTF-8 text at a user-selected path. */
    readText(path: string): Promise<string>;
    /** Write scoped UTF-8 text to a user-selected path. */
    writeText(path: string, contents: string): Promise<void>;
}

export function createDesktopFileChannel(host: DesktopHost): FileChannel {
    return {
        async pickDocumentPath() {
            const picked = await host.openDialog({
                title: "Open shader graph document",
                multiple: false,
                directory: false,
                filters: [{ name: "Shader graph / descriptor (JSON)", extensions: ["shadergraph", "json"] }],
            });
            return typeof picked === "string" ? picked : null;
        },
        async pickDescriptorPath() {
            const picked = await host.openDialog({
                title: "Open surface profile descriptor",
                multiple: false,
                directory: false,
                filters: [{ name: "Surface profile descriptor", extensions: ["json"] }],
            });
            return typeof picked === "string" ? picked : null;
        },
        async pickSavePath(defaultName) {
            return host.saveDialog({
                title: "Save shader graph document",
                defaultPath: defaultName,
                filters: [{ name: "Shader graph document", extensions: ["shadergraph", "json"] }],
            });
        },
        async readText(path) {
            const text = await host.readTextFile(path);
            if (typeof text !== "string") {
                throw new Error(`Host returned an unexpected payload for ${path} — expected UTF-8 text; refusing to reinterpret it.`);
            }
            return text;
        },
        async writeText(path, contents) {
            await host.writeTextFile(path, contents);
        },
    };
}
