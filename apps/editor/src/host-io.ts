/**
 * Host/file abstraction — the seam between the editor (document + session
 * state) and the machine that stores files.
 *
 * The layer contract (kept one-directional, and mirrored in the Rust
 * shell):
 *   Tauri / native layer — only a file path + UTF-8 bytes. It has no
 *     knowledge of shader graphs, node types, profile versions, or
 *     retained fields.
 *   shader-graph-core    — parses and serializes documents (the
 *     .shadergraph disk format authority) and profile descriptors.
 *   this app            — owns document/session state and decides which
 *     text hands to the host.
 *
 * The channel is pure: the host's `invoke` and the dialog calls are
 * INJECTED, so the module has no Tauri import of its own (the web build
 * never downloads the desktop code, and tests drive it with fakes).
 */

/** Detect the stable Tauri 2 marker on a window-like object. */
export function isDesktopHost(host: unknown): boolean {
    if (typeof host !== "object" || host === null) {
        return false;
    }
    return "__TAURI_INTERNALS__" in (host as Record<string, unknown>);
}

/** The Tauri core bridge: invoke a command by name with its args. */
export type HostInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
/** Tauri `open` dialog; `null` is a user cancel. */
export type HostOpenDialog = (options?: Record<string, unknown>) => Promise<string | string[] | null>;
/** Tauri `save` dialog; `null` is a user cancel. */
export type HostSaveDialog = (options?: Record<string, unknown>) => Promise<string | null>;

export interface DesktopHost {
    readonly invoke: HostInvoke;
    readonly openDialog: HostOpenDialog;
    readonly saveDialog: HostSaveDialog;
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
    /** Read UTF-8 text at a path. */
    readText(path: string): Promise<string>;
    /** Write UTF-8 text at a path. */
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
            const text = await host.invoke("read_text_file", { path });
            return text as string;
        },
        async writeText(path, contents) {
            await host.invoke("write_text_file", { path, contents });
        },
    };
}
