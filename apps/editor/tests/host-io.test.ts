/**
 * Native document snapshot and scoped auxiliary-file regression.
 *
 * The layer contract under test:
 *   native document service — host-owned dialogs, canonical URI capability,
 *     exact UTF-8 snapshots, revision tokens, and CAS atomic save;
 *   official plugins — scoped descriptor/config reads;
 *   core         — parses and serializes (the .shadergraph disk format);
 *   editor (app) — document + session state; chooses which text moves.
 *
 * The `FileChannel` is the app's seam over the host. It is pure: the
 * invoke/open/readTextFile are injected, so these tests drive it with fakes
 * and assert command shapes, runtime validation, and cancellation/conflict
 * semantics without a Tauri runtime.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
    createDesktopFileChannel,
    isDesktopHost,
    workspaceDiscoveryRevisionTokenFromHost,
    type DesktopHost,
} from "../src/host-io.js";
import { canonicalWorkspaceUriFromHost } from "../src/workspace-session.js";

const FAKE_DOCUMENT_TEXT = '{"schemaVersion":1,"graphId":"g","profile":"gglab.surface","profileVersion":1,"parameters":[],"nodes":[],"connections":[],"editorMetadata":{"nodes":{}}}';

const HOST_SNAPSHOT = {
    canonicalDocumentUri: "file:///C:/gglab/surface-base.shadergraph",
    displayPath: "C:\\gglab\\surface-base.shadergraph",
    text: FAKE_DOCUMENT_TEXT,
    fileRevisionToken: "revision-a",
};

const HOST_WORKSPACE_ROOT = {
    canonicalWorkspaceUri: "file:///C:/gglab/workspace/",
    displayPath: "C:\\gglab\\workspace",
};

const HOST_WORKSPACE_SNAPSHOT = {
    root: HOST_WORKSPACE_ROOT,
    documents: [
        {
            relativePath: "Materials/Surface.shadergraph",
            canonicalDocumentUri:
                "file:///C:/gglab/workspace/Materials/Surface.shadergraph",
        },
    ],
    discoveryRevisionToken: "workspace-revision-a",
};

interface FakeChannel {
    readonly emit: (message: unknown) => void;
}

/// Record every injected host call before delegating to an override/default.
function fakeHost(
    overrides: Partial<
        Pick<DesktopHost, "invoke" | "createChannel" | "openDialog" | "readTextFile">
    > = {},
): {
    host: DesktopHost;
    invokes: Array<{ command: string; args?: Record<string, unknown> }>;
    channels: FakeChannel[];
    opens: Array<Record<string, unknown>>;
    reads: string[];
} {
    const invokes: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const channels: FakeChannel[] = [];
    const opens: Array<Record<string, unknown>> = [];
    const reads: string[] = [];
    const host: DesktopHost = {
        invoke: (command, args) => {
            invokes.push(args === undefined ? { command } : { command, args });
            if (overrides.invoke !== undefined) {
                return Promise.resolve(overrides.invoke(command, args));
            }
            if (command === "shader-workspace-choose-root") {
                return Promise.resolve(HOST_WORKSPACE_ROOT);
            }
            if (command === "shader-workspace-discover") {
                const channel = args?.["channel"] as FakeChannel | undefined;
                channel?.emit({
                    kind: "changed",
                    discoveryId: { sequence: 7 },
                    snapshot: HOST_WORKSPACE_SNAPSHOT,
                });
                return Promise.resolve({ sequence: 7 });
            }
            if (command === "shader-workspace-cancel-discovery") {
                return Promise.resolve({
                    discoveryId: args?.["discoveryId"],
                    cancellationRequested: true,
                    alreadySettled: false,
                });
            }
            if (command === "shader-document-save" || command === "shader-document-save-as") {
                const request = args?.["request"] as { text?: unknown } | undefined;
                return Promise.resolve({
                    kind: "saved",
                    snapshot: { ...HOST_SNAPSHOT, text: request?.text ?? HOST_SNAPSHOT.text },
                });
            }
            return Promise.resolve(HOST_SNAPSHOT);
        },
        createChannel: (onMessage) => {
            if (overrides.createChannel !== undefined) {
                return overrides.createChannel(onMessage);
            }
            const channel: FakeChannel = { emit: onMessage };
            channels.push(channel);
            return channel;
        },
        openDialog: (options) => {
            opens.push(options ?? {});
            if (overrides.openDialog !== undefined) {
                return Promise.resolve(overrides.openDialog(options));
            }
            return Promise.resolve("C:\\gglab\\surface-base.shadergraph");
        },
        readTextFile: (path) => {
            reads.push(path);
            if (overrides.readTextFile !== undefined) {
                return Promise.resolve(overrides.readTextFile(path));
            }
            return Promise.resolve(FAKE_DOCUMENT_TEXT);
        },
    };
    return { host, invokes, channels, opens, reads };
}

describe("host/file abstraction (native document I/O)", () => {
    it("is only a desktop host when the Tauri marker is present on the window", () => {
        expect(isDesktopHost({ __TAURI_INTERNALS__: {} })).toBe(true);
        expect(isDesktopHost({})).toBe(false);
        expect(isDesktopHost(null)).toBe(false);
        expect(isDesktopHost("not a window")).toBe(false);
    });

    it("keeps scoped auxiliary reads on readTextFile with the exact selected path", async () => {
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

    it("opens documents through the bounded host command and validates the snapshot", async () => {
        const { host, invokes, opens } = fakeHost();
        const channel = createDesktopFileChannel(host);
        const snapshot = await channel.openDocument();

        expect(snapshot).toEqual(HOST_SNAPSHOT);
        expect(invokes).toEqual([{ command: "shader-document-open" }]);
        expect(opens).toHaveLength(0); // the Rust service owns this dialog
    });

    it("returns null when the host-owned Open dialog is cancelled", async () => {
        const { host } = fakeHost({
            invoke: async (command) => command === "shader-document-open" ? null : HOST_SNAPSHOT,
        });
        const channel = createDesktopFileChannel(host);
        expect(await channel.openDocument()).toBeNull();
    });

    it("refreshes only by a host-issued canonical URI", async () => {
        const { host, invokes } = fakeHost();
        const channel = createDesktopFileChannel(host);
        const opened = await channel.openDocument();
        if (opened === null) {
            throw new Error("fixture Open was cancelled");
        }

        expect(await channel.readDocumentSnapshot(opened.canonicalDocumentUri)).toEqual(HOST_SNAPSHOT);
        expect(invokes[1]).toEqual({
            command: "shader-document-read-snapshot",
            args: { request: { canonicalDocumentUri: HOST_SNAPSHOT.canonicalDocumentUri } },
        });
    });

    it("sends canonical URI + expected revision + exact bytes for CAS save", async () => {
        const { host, invokes } = fakeHost();
        const channel = createDesktopFileChannel(host);
        const opened = await channel.openDocument();
        if (opened === null) {
            throw new Error("fixture Open was cancelled");
        }
        const text = '{"schemaVersion":1}';

        const outcome = await channel.saveDocument({
            canonicalDocumentUri: opened.canonicalDocumentUri,
            expectedFileRevisionToken: opened.fileRevisionToken,
            text,
        });

        expect(outcome).toEqual({ kind: "saved", snapshot: { ...HOST_SNAPSHOT, text } });
        expect(invokes[1]).toEqual({
            command: "shader-document-save",
            args: {
                request: {
                    canonicalDocumentUri: HOST_SNAPSHOT.canonicalDocumentUri,
                    expectedFileRevisionToken: HOST_SNAPSHOT.fileRevisionToken,
                    text,
                },
            },
        });
    });

    it("preserves Save As cancellation and structured conflicts", async () => {
        const conflict = {
            kind: "conflict",
            canonicalDocumentUri: "file:///C:/gglab/existing.shadergraph",
            expectedFileRevisionToken: null,
            observedFileRevisionToken: "observed",
        };
        const { host, invokes } = fakeHost({ invoke: async () => conflict });
        const channel = createDesktopFileChannel(host);

        expect(await channel.saveDocumentAs("Untitled.shadergraph", "local")).toEqual(conflict);
        expect(invokes).toEqual([
            {
                command: "shader-document-save-as",
                args: { request: { defaultName: "Untitled.shadergraph", text: "local" } },
            },
        ]);

        const { host: cancelHost } = fakeHost({ invoke: async () => ({ kind: "cancelled" }) });
        expect(await createDesktopFileChannel(cancelHost).saveDocumentAs("Untitled.shadergraph", "local"))
            .toEqual({ kind: "cancelled" });
    });

    it("refuses malformed snapshot/save payloads instead of casting through", async () => {
        const { host } = fakeHost({ invoke: async () => ({ canonicalDocumentUri: 42 }) });
        await expect(createDesktopFileChannel(host).openDocument()).rejects.toThrow(
            /document snapshot canonicalDocumentUri/,
        );

        const { host: outcomeHost } = fakeHost({ invoke: async () => ({ kind: "mystery" }) });
        await expect(
            createDesktopFileChannel(outcomeHost).saveDocumentAs("Untitled.shadergraph", "x"),
        ).rejects.toThrow(/unexpected document save outcome kind/);
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

    it("picks the tool executable as a FILE with the exe-first filter; cancel is null", async () => {
        const { host, opens } = fakeHost({
            openDialog: async () => "C:\\tools\\gglab-shaderc.exe",
        });
        const channel = createDesktopFileChannel(host);
        expect(await channel.pickToolExecutablePath()).toBe("C:\\tools\\gglab-shaderc.exe");
        expect(opens).toHaveLength(1);
        const opts = opens[0] as { directory?: boolean; multiple?: boolean; filters?: Array<{ name?: string; extensions?: readonly string[] }> };
        expect(opts.directory).toBe(false);
        expect(opts.multiple).toBe(false);
        expect(opts.filters?.[0]?.extensions).toEqual(["exe"]);
        expect(opts.filters?.[1]?.extensions).toEqual([]); // the honest "all files" escape
    });

    it("picks the sibling build-output location as a DIRECTORY (single pick); cancel is null", async () => {
        const { host, opens } = fakeHost({
            openDialog: async () => "C:\\Projects\\GGLab\\Build\\Output",
        });
        const channel = createDesktopFileChannel(host);
        expect(await channel.pickSiblingBuildOutputDirectory()).toBe("C:\\Projects\\GGLab\\Build\\Output");
        const opts = opens[0] as { directory?: boolean; multiple?: boolean };
        expect(opts.directory).toBe(true);
        expect(opts.multiple).toBe(false);

        const { host: cancelHost } = fakeHost({ openDialog: async () => null });
        expect(await createDesktopFileChannel(cancelHost).pickSiblingBuildOutputDirectory()).toBeNull();
    });

    it("surfaces host failures as rejections carrying the host's message", async () => {
        const { host } = fakeHost({
            invoke: async () => {
                throw new Error("CAS save failed: access denied");
            },
        });
        const channel = createDesktopFileChannel(host);
        await expect(channel.saveDocumentAs("Blocked.shadergraph", "x")).rejects.toThrow(
            /CAS save failed: access denied/,
        );
    });
});

describe("host/file abstraction (bounded Workspace I/O)", () => {
    it("admits a Workspace root only through the host-owned directory dialog", async () => {
        const { host, invokes, opens } = fakeHost();

        const root = await createDesktopFileChannel(host).chooseWorkspaceRoot();

        expect(root).toEqual(HOST_WORKSPACE_ROOT);
        expect(invokes).toEqual([{ command: "shader-workspace-choose-root" }]);
        expect(opens).toHaveLength(0);
    });

    it("returns a cancellable discovery attempt and materializes its changed snapshot", async () => {
        const { host, invokes, channels } = fakeHost();
        const channel = createDesktopFileChannel(host);
        const rootUri = canonicalWorkspaceUriFromHost(
            HOST_WORKSPACE_ROOT.canonicalWorkspaceUri,
        );

        const attempt = await channel.discoverWorkspace(rootUri);
        const settlement = await attempt.result;

        expect(attempt.discoveryId).toEqual({ sequence: 7 });
        expect(settlement).toEqual({
            kind: "changed",
            discoveryId: { sequence: 7 },
            snapshot: HOST_WORKSPACE_SNAPSHOT,
        });
        expect(channels).toHaveLength(1);
        expect(invokes).toEqual([
            {
                command: "shader-workspace-discover",
                args: {
                    request: {
                        canonicalWorkspaceUri: rootUri,
                        observedDiscoveryRevisionToken: null,
                    },
                    channel: channels[0],
                },
            },
        ]);
    });

    it("uses the prior discovery token as a refresh observation and accepts unchanged", async () => {
        const { host } = fakeHost({
            invoke: async (command, args) => {
                if (command !== "shader-workspace-discover") {
                    return HOST_WORKSPACE_ROOT;
                }
                (args?.["channel"] as FakeChannel).emit({
                    kind: "unchanged",
                    discoveryId: { sequence: 8 },
                    canonicalWorkspaceUri: HOST_WORKSPACE_ROOT.canonicalWorkspaceUri,
                    discoveryRevisionToken: "workspace-revision-a",
                });
                return { sequence: 8 };
            },
        });
        const rootUri = canonicalWorkspaceUriFromHost(
            HOST_WORKSPACE_ROOT.canonicalWorkspaceUri,
        );
        const token = workspaceDiscoveryRevisionTokenFromHost("workspace-revision-a");

        const attempt = await createDesktopFileChannel(host).discoverWorkspace(rootUri, token);

        await expect(attempt.result).resolves.toEqual({
            kind: "unchanged",
            discoveryId: { sequence: 8 },
            canonicalWorkspaceUri: rootUri,
            discoveryRevisionToken: token,
        });
    });

    it("cancels by host-issued discovery identity and validates the outcome", async () => {
        const { host, invokes } = fakeHost();
        const outcome = await createDesktopFileChannel(host).cancelWorkspaceDiscovery({
            sequence: 7,
        });

        expect(outcome).toEqual({
            discoveryId: { sequence: 7 },
            cancellationRequested: true,
            alreadySettled: false,
        });
        expect(invokes).toEqual([
            {
                command: "shader-workspace-cancel-discovery",
                args: { discoveryId: { sequence: 7 } },
            },
        ]);
    });

    it("rejects a cancellation outcome for another discovery identity", async () => {
        const { host } = fakeHost({
            invoke: async () => ({
                discoveryId: { sequence: 99 },
                cancellationRequested: true,
                alreadySettled: false,
            }),
        });

        await expect(
            createDesktopFileChannel(host).cancelWorkspaceDiscovery({ sequence: 7 }),
        ).rejects.toThrow(/cancelled a different Workspace discovery identity/);
    });

    it("rejects a non-portable relative path from the host", async () => {
        const { host } = fakeHost({
            invoke: async (_command, args) => {
                (args?.["channel"] as FakeChannel).emit({
                    kind: "changed",
                    discoveryId: { sequence: 7 },
                    snapshot: {
                        ...HOST_WORKSPACE_SNAPSHOT,
                        documents: [
                            {
                                relativePath: "../escape.shadergraph",
                                canonicalDocumentUri:
                                    "file:///C:/gglab/escape.shadergraph",
                            },
                        ],
                    },
                });
                return { sequence: 7 };
            },
        });
        const attempt = await createDesktopFileChannel(host).discoverWorkspace(
            canonicalWorkspaceUriFromHost(HOST_WORKSPACE_ROOT.canonicalWorkspaceUri),
        );

        await expect(attempt.result).rejects.toThrow(/non-portable Workspace document/);
    });

    it("rejects mismatched admission/settlement identities", async () => {
        const { host } = fakeHost({
            invoke: async (_command, args) => {
                (args?.["channel"] as FakeChannel).emit({
                    kind: "cancelled",
                    discoveryId: { sequence: 99 },
                });
                return { sequence: 7 };
            },
        });
        const attempt = await createDesktopFileChannel(host).discoverWorkspace(
            canonicalWorkspaceUriFromHost(HOST_WORKSPACE_ROOT.canonicalWorkspaceUri),
        );

        await expect(attempt.result).rejects.toThrow(/different Workspace discovery identity/);
    });

    it("rejects a settlement bound to another canonical Workspace", async () => {
        const { host } = fakeHost({
            invoke: async (_command, args) => {
                (args?.["channel"] as FakeChannel).emit({
                    kind: "unchanged",
                    discoveryId: { sequence: 7 },
                    canonicalWorkspaceUri: "file:///C:/other/",
                    discoveryRevisionToken: "workspace-revision-a",
                });
                return { sequence: 7 };
            },
        });
        const attempt = await createDesktopFileChannel(host).discoverWorkspace(
            canonicalWorkspaceUriFromHost(HOST_WORKSPACE_ROOT.canonicalWorkspaceUri),
        );

        await expect(attempt.result).rejects.toThrow(/different canonical Workspace URI/);
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
            ["core:default", "core:window:allow-destroy", "core:window:allow-set-title", "dialog:allow-open", "fs:allow-read-text-file"].sort(),
        );
    });

    it("exposes exactly the bounded Workspace, document, tool, and Preview surface", async () => {
        const libRs = await readFile(resolve(tauriDir, "src/lib.rs"), "utf8");
        // The document-IO module is split into a shared core plus the two
        // platform-specific save-settlement submodules; the invariants below
        // are asserted over the whole module, not just the top file.
        const [
            documentIoCore,
            documentIoSettlementWindows,
            documentIoSettlementPosix,
        ] = await Promise.all([
            readFile(resolve(tauriDir, "src/document_io.rs"), "utf8"),
            readFile(
                resolve(tauriDir, "src/document_io/settlement_windows.rs"),
                "utf8",
            ),
            readFile(
                resolve(tauriDir, "src/document_io/settlement_posix.rs"),
                "utf8",
            ),
        ]);
        const documentIoRs = [
            documentIoCore,
            documentIoSettlementWindows,
            documentIoSettlementPosix,
        ].join("\n");
        const workspaceIoRs = await readFile(resolve(tauriDir, "src/workspace_io.rs"), "utf8");
        const mainRs = await readFile(resolve(tauriDir, "src/main.rs"), "utf8");
        // The shell keeps the two official plugins for scoped auxiliary
        // reads. Document Open/Save As dialogs are host-owned.
        expect(libRs).toContain("tauri_plugin_dialog");
        expect(libRs).toContain("tauri_plugin_fs");
        // The web-facing command surface is EXACTLY the four document
        // capabilities, six tool operations, and separately declared bounded
        // Preview surface. Any additional command is a surface violation.
        // The attribute is `#[tauri::command(rename = "<id>")]` — the
        // `[` sits inside a character class here: a bare `[` in a regex
        // literal would start a class of its own and swallow the rest
        // of the pattern. The rename value is the web-facing invoke id.
        const commandPattern = /#[[]tauri::command\(rename = "([^"]+)"\)/g;
        const commands = [...libRs.matchAll(commandPattern)].map((m) => m[1] as string);
        expect(commands.sort()).toEqual([
            "shader-document-open",
            "shader-document-read-snapshot",
            "shader-document-save",
            "shader-document-save-as",
            "shader-preview-launch-runtime",
            "shader-preview-read-observation",
            "shader-preview-stop-runtime",
            "shader-tool-build-preview",
            "shader-tool-cancel",
            "shader-tool-compile",
            "shader-tool-discover",
            "shader-tool-handshake",
            "shader-tool-preview-handshake",
            "shader-workspace-cancel-discovery",
            "shader-workspace-choose-root",
            "shader-workspace-discover",
        ]);
        // No raw arbitrary-path parameter exists on the document command
        // surface. The native service resolves only host-issued URI
        // capabilities through its private registry.
        expect(documentIoRs).toContain("registered_documents");
        expect(documentIoRs).toContain("expected_file_revision_token");
        // Saves bind the committed bytes onto the target through an atomic
        // name operation (move/replace of the name), never an in-place data
        // swap over the open target.
        expect(documentIoRs).toContain("atomic_move_replace");
        // The guarded settlement creates the writer exclusion with a share
        // mask that grants read and delete but omits write sharing — that
        // omission is what the OS enforces in both directions (pinned by
        // the guard contract test on the host).
        expect(documentIoRs).toContain(
            "share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)",
        );
        expect(documentIoRs).toContain("Unauthorized");
        expect(workspaceIoRs).toContain("registered_workspaces");
        expect(workspaceIoRs).toContain("is_contained");
        expect(workspaceIoRs).toContain("file_type.is_symlink()");
        expect(workspaceIoRs).toContain("MAX_DISCOVERY_ENTRIES");
        expect(workspaceIoRs).toContain("observed_discovery_revision_token");
        const documentCapabilitySignatures = [
            ...libRs.matchAll(
                /async fn shader_document_(?:read_snapshot|save)\(([\s\S]*?)\)\s*->/g,
            ),
        ].map((match) => match[1] as string);
        expect(documentCapabilitySignatures).toHaveLength(2);
        for (const signature of documentCapabilitySignatures) {
            expect(signature).not.toMatch(/\bpath\s*:/);
        }
        const workspaceCapabilitySignatures = [
            ...libRs.matchAll(
                /(?:async )?fn shader_workspace_(?:choose_root|discover|cancel_discovery)\(([\s\S]*?)\)\s*->/g,
            ),
        ].map((match) => match[1] as string);
        expect(workspaceCapabilitySignatures).toHaveLength(3);
        for (const signature of workspaceCapabilitySignatures) {
            expect(signature).not.toMatch(/\bpath\s*:/);
        }
        expect(mainRs).not.toContain("#[tauri::command]");
        expect(mainRs).not.toContain("invoke_handler");
        expect(mainRs).not.toContain("fs::read_to_string");
        expect(mainRs).not.toContain("fs::write");
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
