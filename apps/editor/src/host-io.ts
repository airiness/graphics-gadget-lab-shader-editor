/**
 * Host/file abstraction — the seam between the editor (document + session
 * state) and the machine that stores files.
 *
 * The layer contract (kept one-directional, and mirrored in the Rust shell):
 *   native Workspace service — owns root selection, canonical containment,
 *     bounded/cancellable discovery, and refresh observations;
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
import { readLayoutPreferences, type LayoutPreferenceHost } from "./layout-preferences.js";

import {
    canonicalDocumentUriFromHost,
    canonicalWorkspaceUriFromHost,
    type CanonicalDocumentUri,
    type CanonicalWorkspaceUri,
    type WorkspaceRootHandle,
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
/** Construct one native IPC channel whose payload is validated by this seam. */
export type HostChannelFactory = (onMessage: (message: unknown) => void) => unknown;
/**
 * Official `readTextFile`. Declared as `Promise<unknown>` on purpose:
 * this boundary verifies the payload at runtime instead of casting it —
 * an IPC result is whatever the other side sent.
 */
export type HostReadTextFile = (path: string) => Promise<unknown>;
export interface DesktopHost {
    readonly invoke: HostInvoke;
    readonly createChannel: HostChannelFactory;
    readonly openDialog: HostOpenDialog;
    readonly readTextFile: HostReadTextFile;
}

declare const fileRevisionTokenBrand: unique symbol;
declare const workspaceDiscoveryRevisionTokenBrand: unique symbol;

/** Host-owned opaque observation of one exact on-disk document revision. */
export type FileRevisionToken = string & {
    readonly [fileRevisionTokenBrand]: "FileRevisionToken";
};

/** Opaque identity of one deterministic Workspace discovery observation. */
export type WorkspaceDiscoveryRevisionToken = string & {
    readonly [workspaceDiscoveryRevisionTokenBrand]: "WorkspaceDiscoveryRevisionToken";
};

export interface WorkspaceDiscoveryId {
    readonly sequence: number;
}

export interface WorkspaceDocumentEntry {
    /** Presentation/tree label only; never an arbitrary-path capability. */
    readonly relativePath: string;
    readonly canonicalDocumentUri: CanonicalDocumentUri;
}

export interface WorkspaceDiscoverySnapshot {
    readonly root: WorkspaceRootHandle;
    readonly documents: readonly WorkspaceDocumentEntry[];
    readonly discoveryRevisionToken: WorkspaceDiscoveryRevisionToken;
}

export type WorkspaceDiscoverySettlement =
    | {
          readonly kind: "changed";
          readonly discoveryId: WorkspaceDiscoveryId;
          readonly snapshot: WorkspaceDiscoverySnapshot;
      }
    | {
          readonly kind: "unchanged";
          readonly discoveryId: WorkspaceDiscoveryId;
          readonly canonicalWorkspaceUri: CanonicalWorkspaceUri;
          readonly discoveryRevisionToken: WorkspaceDiscoveryRevisionToken;
      }
    | { readonly kind: "cancelled"; readonly discoveryId: WorkspaceDiscoveryId }
    | {
          readonly kind: "failed";
          readonly discoveryId: WorkspaceDiscoveryId;
          readonly error: Readonly<Record<string, unknown>>;
      };

export interface WorkspaceDiscoveryAttempt {
    readonly discoveryId: WorkspaceDiscoveryId;
    readonly result: Promise<WorkspaceDiscoverySettlement>;
}

export interface WorkspaceDiscoveryCancelOutcome {
    readonly discoveryId: WorkspaceDiscoveryId;
    readonly cancellationRequested: boolean;
    readonly alreadySettled: boolean;
}

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
export interface FileChannel extends LayoutPreferenceHost {
    /** Host-owned directory dialog followed by canonical root admission. */
    chooseWorkspaceRoot(): Promise<WorkspaceRootHandle | null>;
    /** Re-admit only the host-remembered Workspace; never restore live handles. */
    reopenLastWorkspace(): Promise<WorkspaceRootHandle | null>;
    /** Bounded/cancellable discovery; the prior token turns this into a
     * pull-based change observation. */
    discoverWorkspace(
        canonicalWorkspaceUri: CanonicalWorkspaceUri,
        observedDiscoveryRevisionToken?: WorkspaceDiscoveryRevisionToken,
    ): Promise<WorkspaceDiscoveryAttempt>;
    /** Cancel one in-flight discovery without changing settled authority. */
    cancelWorkspaceDiscovery(
        discoveryId: WorkspaceDiscoveryId,
    ): Promise<WorkspaceDiscoveryCancelOutcome>;
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
        async readLayoutPreferences() {
            const value = await host.invoke("shader-editor-read-layout");
            return value === null ? null : readLayoutPreferences(value);
        },
        async saveLayoutPreferences(layout) {
            await host.invoke("shader-editor-save-layout", { layout: readLayoutPreferences(layout) });
        },
        async reopenLastWorkspace() {
            const value = await host.invoke("shader-workspace-reopen-last");
            return value === null ? null : readWorkspaceRoot(value);
        },
        async chooseWorkspaceRoot() {
            const value = await host.invoke("shader-workspace-choose-root");
            return value === null ? null : readWorkspaceRoot(value);
        },
        async discoverWorkspace(
            canonicalWorkspaceUri,
            observedDiscoveryRevisionToken = undefined,
        ) {
            let resolveSettlement: (settlement: WorkspaceDiscoverySettlement) => void =
                () => undefined;
            let rejectSettlement: (reason: unknown) => void = () => undefined;
            const result = new Promise<WorkspaceDiscoverySettlement>((resolve, reject) => {
                resolveSettlement = resolve;
                rejectSettlement = reject;
            });
            const channel = host.createChannel((message) => {
                try {
                    resolveSettlement(readWorkspaceDiscoverySettlement(message));
                } catch (error) {
                    rejectSettlement(error);
                }
            });
            const value = await host.invoke("shader-workspace-discover", {
                request: {
                    canonicalWorkspaceUri,
                    observedDiscoveryRevisionToken:
                        observedDiscoveryRevisionToken ?? null,
                },
                channel,
            });
            const discoveryId = readWorkspaceDiscoveryId(value);
            return {
                discoveryId,
                result: result.then((settlement) => {
                    if (settlement.discoveryId.sequence !== discoveryId.sequence) {
                        throw new Error(
                            "Host settled a different Workspace discovery identity.",
                        );
                    }
                    const settledWorkspaceUri =
                        settlement.kind === "changed"
                            ? settlement.snapshot.root.canonicalWorkspaceUri
                            : settlement.kind === "unchanged"
                              ? settlement.canonicalWorkspaceUri
                              : canonicalWorkspaceUri;
                    if (settledWorkspaceUri !== canonicalWorkspaceUri) {
                        throw new Error(
                            "Host settled a different canonical Workspace URI.",
                        );
                    }
                    return settlement;
                }),
            };
        },
        async cancelWorkspaceDiscovery(discoveryId) {
            const value = await host.invoke("shader-workspace-cancel-discovery", {
                discoveryId,
            });
            const outcome = readWorkspaceDiscoveryCancelOutcome(value);
            if (outcome.discoveryId.sequence !== discoveryId.sequence) {
                throw new Error(
                    "Host cancelled a different Workspace discovery identity.",
                );
            }
            return outcome;
        },
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

function readWorkspaceRoot(value: unknown): WorkspaceRootHandle {
    const record = readRecord(value, "Workspace root");
    return {
        canonicalWorkspaceUri: canonicalWorkspaceUriFromHost(
            readNonEmptyString(
                record["canonicalWorkspaceUri"],
                "Workspace root canonicalWorkspaceUri",
            ),
        ),
        displayPath: readNonEmptyString(record["displayPath"], "Workspace root displayPath"),
    };
}

function readWorkspaceDiscoverySettlement(value: unknown): WorkspaceDiscoverySettlement {
    const record = readRecord(value, "Workspace discovery settlement");
    const discoveryId = readWorkspaceDiscoveryId(record["discoveryId"]);
    switch (record["kind"]) {
        case "changed":
            return {
                kind: "changed",
                discoveryId,
                snapshot: readWorkspaceDiscoverySnapshot(record["snapshot"]),
            };
        case "unchanged":
            return {
                kind: "unchanged",
                discoveryId,
                canonicalWorkspaceUri: canonicalWorkspaceUriFromHost(
                    readNonEmptyString(
                        record["canonicalWorkspaceUri"],
                        "Workspace observation canonicalWorkspaceUri",
                    ),
                ),
                discoveryRevisionToken: workspaceDiscoveryRevisionTokenFromHost(
                    readNonEmptyString(
                        record["discoveryRevisionToken"],
                        "Workspace observation discoveryRevisionToken",
                    ),
                ),
            };
        case "cancelled":
            return { kind: "cancelled", discoveryId };
        case "failed":
            return {
                kind: "failed",
                discoveryId,
                error: readRecord(record["error"], "Workspace discovery error"),
            };
        default:
            throw new Error("Host returned an unexpected Workspace discovery settlement kind.");
    }
}

function readWorkspaceDiscoverySnapshot(value: unknown): WorkspaceDiscoverySnapshot {
    const record = readRecord(value, "Workspace discovery snapshot");
    const documents = record["documents"];
    if (!Array.isArray(documents)) {
        throw new Error("Host returned unexpected Workspace discovery documents.");
    }
    return {
        root: readWorkspaceRoot(record["root"]),
        documents: documents.map((document) => {
            const entry = readRecord(document, "Workspace document entry");
            return {
                relativePath: readWorkspaceRelativePath(
                    entry["relativePath"],
                ),
                canonicalDocumentUri: canonicalDocumentUriFromHost(
                    readNonEmptyString(
                        entry["canonicalDocumentUri"],
                        "Workspace document canonicalDocumentUri",
                    ),
                ),
            };
        }),
        discoveryRevisionToken: workspaceDiscoveryRevisionTokenFromHost(
            readNonEmptyString(
                record["discoveryRevisionToken"],
                "Workspace discovery revision token",
            ),
        ),
    };
}

function readWorkspaceRelativePath(value: unknown): string {
    const relativePath = readNonEmptyString(value, "Workspace document relativePath");
    const components = relativePath.split("/");
    if (
        relativePath.startsWith("/") ||
        relativePath.includes("\\") ||
        components.some((component) => component === "" || component === "." || component === "..")
    ) {
        throw new Error("Host returned a non-portable Workspace document relativePath.");
    }
    return relativePath;
}

function readWorkspaceDiscoveryId(value: unknown): WorkspaceDiscoveryId {
    const record = readRecord(value, "Workspace discovery identity");
    const sequence = record["sequence"];
    if (!Number.isSafeInteger(sequence) || (sequence as number) <= 0) {
        throw new Error("Host returned an invalid Workspace discovery sequence.");
    }
    return { sequence: sequence as number };
}

function readWorkspaceDiscoveryCancelOutcome(
    value: unknown,
): WorkspaceDiscoveryCancelOutcome {
    const record = readRecord(value, "Workspace discovery cancellation");
    const cancellationRequested = record["cancellationRequested"];
    const alreadySettled = record["alreadySettled"];
    if (typeof cancellationRequested !== "boolean" || typeof alreadySettled !== "boolean") {
        throw new Error("Host returned invalid Workspace discovery cancellation flags.");
    }
    if (cancellationRequested === alreadySettled) {
        throw new Error("Host returned contradictory Workspace discovery cancellation flags.");
    }
    return {
        discoveryId: readWorkspaceDiscoveryId(record["discoveryId"]),
        cancellationRequested,
        alreadySettled,
    };
}

export function workspaceDiscoveryRevisionTokenFromHost(
    value: string,
): WorkspaceDiscoveryRevisionToken {
    if (value.trim() === "") {
        throw new Error("A host Workspace discovery revision token must not be empty.");
    }
    return value as WorkspaceDiscoveryRevisionToken;
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
