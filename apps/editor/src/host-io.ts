/**
 * Host/file abstraction — the seam between the editor (document + session
 * state) and the machine that stores files.
 *
 * The layer contract (kept one-directional, and mirrored in the Rust shell):
 *   native document service — owns Open/Save As dialogs, canonical paths,
 *     host-lifetime URI capabilities, exact snapshots, revision tokens, and
 *     compare-and-swap atomic saves. No caller-supplied document path crosses
 *     inward; a returned display path is provenance, never authority;
 *   official scoped plugins — descriptor/config file selection and UTF-8
 *     reads only;
 *   shader-graph-core — parses and serializes documents (the
 *     .shadergraph disk format authority) and profile descriptors;
 *   this app        — owns document/session state and decides which
 *     text moves where.
 *
 * The channel is pure: invoke/open/readTextFile are injected, so the module
 * has no Tauri import of its own and tests drive it with fakes.
 */

import {
    canonicalDocumentUriFromHost,
    type CanonicalDocumentUri,
} from "./workspace-session.js";

/** Detect the stable Tauri marker on a window-like object. */
export function isDesktopHost(host: unknown): boolean {
    if (typeof host !== "object" || host === null) {
        return false;
    }
    return "__TAURI_INTERNALS__" in (host as Record<string, unknown>);
}

/** File dialog options as produced by the channel. `multiple` is always
 * false (single picks only); `directory` is false for the file picks and
 * true for the directory pick (the build-output location). */
export type FileDialogOptions = Record<string, unknown>;
/** Official `open` shape; `null` is a user cancel. */
export type HostOpenDialog = (options?: FileDialogOptions) => Promise<string | string[] | null>;
/** Invoke one allowlisted custom host command. */
export type HostInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
/**
 * Official `readTextFile`. Declared as `Promise<unknown>` on purpose:
 * this boundary verifies the payload at runtime instead of casting it —
 * an IPC result is whatever the other side sent.
 */
export type HostReadTextFile = (path: string) => Promise<unknown>;
export interface DesktopHost {
    readonly invoke: HostInvoke;
    readonly openDialog: HostOpenDialog;
    readonly readTextFile: HostReadTextFile;
}

declare const fileRevisionTokenBrand: unique symbol;

/** Host-owned opaque observation of one exact on-disk document revision. */
export type FileRevisionToken = string & {
    readonly [fileRevisionTokenBrand]: "FileRevisionToken";
};

export interface DocumentSnapshot {
    readonly canonicalDocumentUri: CanonicalDocumentUri;
    readonly displayPath: string;
    readonly text: string;
    readonly fileRevisionToken: FileRevisionToken;
}

export interface SaveDocumentSnapshotRequest {
    readonly canonicalDocumentUri: CanonicalDocumentUri;
    readonly expectedFileRevisionToken: FileRevisionToken;
    readonly text: string;
}

export type DocumentSaveOutcome =
    | { readonly kind: "saved"; readonly snapshot: DocumentSnapshot }
    | {
          readonly kind: "conflict";
          readonly canonicalDocumentUri: CanonicalDocumentUri;
          readonly expectedFileRevisionToken: FileRevisionToken | null;
          readonly observedFileRevisionToken: FileRevisionToken | null;
      }
    | { readonly kind: "cancelled" };

/**
 * A file channel over bounded document capabilities plus scoped auxiliary
 * reads. `null`/`cancelled` are user choices; rejections are explicit host or
 * contract failures.
 */
export interface FileChannel {
    /** Host-owned Open dialog followed by an exact canonical snapshot. */
    openDocument(): Promise<DocumentSnapshot | null>;
    /** Refresh an already-authorized document by its host-issued URI. */
    readDocumentSnapshot(canonicalDocumentUri: CanonicalDocumentUri): Promise<DocumentSnapshot>;
    /** Compare-and-swap save of an already-authorized document. */
    saveDocument(request: SaveDocumentSnapshotRequest): Promise<DocumentSaveOutcome>;
    /** Host-owned Save As dialog; an existing target returns a conflict. */
    saveDocumentAs(defaultName: string, text: string): Promise<DocumentSaveOutcome>;
    /** Open a descriptor (JSON) dialog → path. */
    pickDescriptorPath(): Promise<string | null>;
    /** Pick the tool executable (native file dialog, exe filter) → path. */
    pickToolExecutablePath(): Promise<string | null>;
    /** Pick the sibling build-output directory (native directory dialog)
     * → path. */
    pickSiblingBuildOutputDirectory(): Promise<string | null>;
    /** Read scoped auxiliary UTF-8 text at a user-selected path. */
    readText(path: string): Promise<string>;
}

export function createDesktopFileChannel(host: DesktopHost): FileChannel {
    return {
        async openDocument() {
            const value = await host.invoke("shader-document-open");
            return value === null ? null : readDocumentSnapshotPayload(value);
        },
        async readDocumentSnapshot(canonicalDocumentUri) {
            const value = await host.invoke("shader-document-read-snapshot", {
                request: { canonicalDocumentUri },
            });
            return readDocumentSnapshotPayload(value);
        },
        async saveDocument(request) {
            const value = await host.invoke("shader-document-save", { request });
            return readDocumentSaveOutcome(value);
        },
        async saveDocumentAs(defaultName, text) {
            const value = await host.invoke("shader-document-save-as", {
                request: { defaultName, text },
            });
            return readDocumentSaveOutcome(value);
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
        async pickToolExecutablePath() {
            const picked = await host.openDialog({
                title: "Select the gglab-shaderc executable",
                multiple: false,
                directory: false,
                filters: [
                    { name: "Executables", extensions: ["exe"] },
                    { name: "All files", extensions: [] },
                ],
            });
            return typeof picked === "string" ? picked : null;
        },
        async pickSiblingBuildOutputDirectory() {
            const picked = await host.openDialog({
                title: "Select the sibling GGLab build-output directory",
                multiple: false,
                directory: true,
            });
            return typeof picked === "string" ? picked : null;
        },
        async readText(path) {
            const text = await host.readTextFile(path);
            if (typeof text !== "string") {
                throw new Error(`Host returned an unexpected payload for ${path} — expected UTF-8 text; refusing to reinterpret it.`);
            }
            return text;
        },
    };
}

function readDocumentSnapshotPayload(value: unknown): DocumentSnapshot {
    const record = readRecord(value, "document snapshot");
    const canonicalDocumentUri = readNonEmptyString(
        record["canonicalDocumentUri"],
        "document snapshot canonicalDocumentUri",
    );
    return {
        canonicalDocumentUri: canonicalDocumentUriFromHost(canonicalDocumentUri),
        displayPath: readNonEmptyString(record["displayPath"], "document snapshot displayPath"),
        text: readString(record["text"], "document snapshot text"),
        fileRevisionToken: fileRevisionTokenFromHost(
            readNonEmptyString(record["fileRevisionToken"], "document snapshot fileRevisionToken"),
        ),
    };
}

function readDocumentSaveOutcome(value: unknown): DocumentSaveOutcome {
    const record = readRecord(value, "document save outcome");
    const kind = record["kind"];
    if (kind === "cancelled") {
        return { kind };
    }
    if (kind === "saved") {
        return { kind, snapshot: readDocumentSnapshotPayload(record["snapshot"]) };
    }
    if (kind === "conflict") {
        return {
            kind,
            canonicalDocumentUri: canonicalDocumentUriFromHost(
                readNonEmptyString(
                    record["canonicalDocumentUri"],
                    "document conflict canonicalDocumentUri",
                ),
            ),
            expectedFileRevisionToken: readNullableRevisionToken(
                record["expectedFileRevisionToken"],
                "document conflict expectedFileRevisionToken",
            ),
            observedFileRevisionToken: readNullableRevisionToken(
                record["observedFileRevisionToken"],
                "document conflict observedFileRevisionToken",
            ),
        };
    }
    throw new Error("Host returned an unexpected document save outcome kind.");
}

export function fileRevisionTokenFromHost(value: string): FileRevisionToken {
    if (value.trim() === "") {
        throw new Error("A host file revision token must not be empty.");
    }
    return value as FileRevisionToken;
}

function readNullableRevisionToken(value: unknown, field: string): FileRevisionToken | null {
    if (value === null) {
        return null;
    }
    return fileRevisionTokenFromHost(readNonEmptyString(value, field));
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`Host returned an unexpected ${label} payload.`);
    }
    return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
    if (typeof value !== "string") {
        throw new Error(`Host returned an unexpected ${field}; expected a string.`);
    }
    return value;
}

function readNonEmptyString(value: unknown, field: string): string {
    const result = readString(value, field);
    if (result.trim() === "") {
        throw new Error(`Host returned an empty ${field}.`);
    }
    return result;
}
