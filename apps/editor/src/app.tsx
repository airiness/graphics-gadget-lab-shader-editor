/**
 * Composition root — where the core's semantic services are asked about
 * everything the user can do. The GUI components forward raw intents
 * (add node, connect, place, load, save, emit); this root applies them to
 * the document, re-asks the core's services for the verdicts, and renders
 * the structured diagnostics the core returns. No graph semantics are
 * defined here: validation, port-level types, conformance, compatibility,
 * and emission all come from @gglab/shader-graph-core.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
    addConnection,
    removeConnection,
    removeConnectionsAtPort,
    removeNode,
    reconnectConnection,
    isEditingTextTarget,
    createHistory,
    recordHistory,
    undoHistory,
    redoHistory,
    canUndoHistory,
    canRedoHistory,
    UndoIcon,
    RedoIcon,
    addNode,
    addParameter,
    autoLayout,
    Badge,
    BadgeDot,
    Button,
    ButtonGroup,
    DescriptorPanel,
    DiagnosticsPanel,
    diagnosticFocus,
    documentToFlow,
    FlowViewport,
    Input,
    LayoutIcon,
    PanelCloseIcon,
    PanelOpenIcon,
    TrashIcon,
    NodePalette,
    type AuthoringDropPayload,
    type AuthoringResult,
    type CanvasFocus,
    FileIcon,
    type ConnectionRequest,
    type DescriptorPanelState,
    type ParameterRequest,
    withNodePosition,
} from "@gglab/editor-ui";
import {
    checkProfileConformance,
    checkProfileDescriptorCompatibility,
    emitHlsl,
    parseShaderGraphDocument,
    resolveGraphTypes,
    serializeShaderGraphDocument,
    validateShaderGraph,
    type HlslEmission,
    type ShaderGraphDocument,
    type ShaderGraphDiagnostic,
    type SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";
import { DEFAULT_BUILD_TARGET } from "./build-target-config.js";
import type { BuildInspectorRow } from "./build-inspector.js";
import { createDesktopFileChannel, isDesktopHost, type FileChannel } from "./host-io.js";
import { useNativeBuild } from "./useNativeBuild.js";
import { useShaderPreview } from "./useShaderPreview.js";
import type { NativeBuildReadiness } from "./native-build-readiness.js";
import { basenameOf, closeAction, createSession, isDirty, provenanceFromImport, provenanceFromFile, saveTarget, sessionSaved, sessionTitle, type CloseChoice, type DocumentProvenance, type DocumentSession } from "./document-session.js";
import { saveShortcutOf } from "./shortcuts.js";
import { INSPECTOR_ZONES, INSPECTOR_ZONE_LABELS, inspectorZoneBadge, type InspectorZone, type InspectorZoneFacts } from "./inspector-tabs.js";
// Type-only (erased at compile time): the official dialog option shapes,
// used for the single documented boundary cast below. Runtime functions
// are dynamically imported inside the desktop effect only.
import type { OpenDialogOptions, SaveDialogOptions } from "@tauri-apps/plugin-dialog";
import "./app.css";

/** The editor's default workspace document (a valid gglab.surface v1 graph). */
const SEED_DOCUMENT_TEXT = JSON.stringify(
    {
        schemaVersion: 1,
        graphId: "graph.editor-seed",
        profile: "gglab.surface",
        profileVersion: 1,
        parameters: [{ id: "p.tint", name: "Tint", class: "VectorParameter", valueType: "float3" }],
        nodes: [
            { id: "n.t", type: "VectorParameter", version: 1, properties: { parameterId: "p.tint" } },
            { id: "n.out", type: "SurfaceOutput", version: 1, properties: {} },
        ],
        connections: [{ id: "c1", from: { nodeId: "n.t", portId: "value" }, to: { nodeId: "n.out", portId: "Emissive" } }],
        editorMetadata: { nodes: {} },
    },
    null,
    2,
);

function seedDocument(): ShaderGraphDocument {
    const parsed = parseShaderGraphDocument(SEED_DOCUMENT_TEXT);
    if (parsed.ok === false || parsed.value === null) {
        const first = parsed.diagnostics[0];
        throw new Error(`Editor seed document is invalid: ${first !== undefined ? `${first.code}: ${first.message}` : "reader failure"}`);
    }
    return parsed.value;
}

/** Last path segment of a host file path (Windows or POSIX separators). */
interface DiagnosticSet {
    readonly title: string;
    readonly ok: boolean;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    readonly passedText: string;
}

export function App() {
    // The seeded startup document and its initial session share ONE
    // instance so the baseline is exactly that document's canonical
    // bytes.
    const [seed] = useState(() => seedDocument());
    // The document lives INSIDE the history (present), so undo/redo and
    // the "authoring result" path are the SAME state transition — no
    // second source of truth to drift. Provenance changes (open / import)
    // do not append: they RESET the history around the new document.
    const [history, setHistory] = useState(() => createHistory(seed));
    const document = history.present;
    const [operationNotes, setOperationNotes] = useState<readonly string[]>([]);
    const [descriptorState, setDescriptorState] = useState<DescriptorPanelState>({ kind: "empty" });
    const [savedText, setSavedText] = useState(() => SEED_DOCUMENT_TEXT);
    const [loadResult, setLoadResult] = useState<DiagnosticSet | null>(null);
    const [emission, setEmission] = useState<HlslEmission | null>(null);
    // Which diagnostic's target the canvas is highlighting (null = none).
    const [focus, setFocus] = useState<CanvasFocus | null>(null);
    // Library search — a presentation filter over display names (no semantics).
    const [libraryQuery, setLibraryQuery] = useState("");
    // Whole-library collapse — UI session state (layout), never document data.
    const [libraryOpen, setLibraryOpen] = useState(true);
    // Right inspector rail: layout session state, same model as the
    // library rail (the app owns which column is collapsed).
    const [inspectorOpen, setInspectorOpen] = useState(true);
    /** The visible inspector zone — pure surface organization (inspector-tabs.ts):
     *  the zoned-out zones keep their state on their TAB (a projection of
     *  existing facts; the switch itself owns no state). */
    const [inspectorZone, setInspectorZone] = useState<InspectorZone>("contract");
    // Connection selection — SESSION state (canvas interaction), never
    // document data: selecting or deselecting an edge must not dirty the
    // document. The projection (documentToFlow) receives it and renders
    // emphasis only; the core stays untouched by a selection.
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    // The edge context menu position (cursor point), null = closed.
    const [edgeMenu, setEdgeMenu] = useState<{ x: number; y: number } | null>(null);
    // The advanced "reconnect" armed state: Ctrl+click on a connection
    // selects it AND starts the pending end-point move. Nothing is
    // mutated until a port click confirms — Esc / blank click cancels and
    // the original connection is provably untouched (revert by
    // construction, not by a compensating operation).
    const [reconnectArmed, setReconnectArmed] = useState<string | null>(null);
    // Single-node selection — SESSION state, the counterpart of the edge
    // selection, exclusive with it (one selection fact at a time). It is
    // the TARGET of the Delete key's node removal and the menu opens with
    // that node selected. Emphasis only; the core is never touched.
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    // The node action menu (target node + anchor point), null = closed.
    const [nodeMenu, setNodeMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null);
    // Viewport fit trigger (registered by the flow adapter via onInit).
    const fitRef = useRef<(() => void) | null>(null);
    // Desktop slice 1: native document I/O channel (absent in the browser
    // — the web build keeps the text save/load surface only).
    const [fileChannel, setFileChannel] = useState<FileChannel | null>(null);
    // The full document session: provenance (where the current document
    // came from) + the canonical bytes of its last saved state. The
    // Save target is derived from the provenance — never from leftover
    // state of a previous document.
    const [session, setSession] = useState<DocumentSession>(() => createSession(provenanceFromImport(), seed));
    // Dirty = current canonical bytes ≠ baseline (core determinism makes
    // the byte comparison a structural one).
    const dirty = useMemo(() => isDirty(document, session), [document, session]);
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            if (!isDesktopHost(globalThis)) {
                return;
            }
            // Desktop-only code path: the official plugin JS APIs are
            // code-split out of the web bundle and loaded only inside the
            // desktop webview. The native side stays thin and scoped:
            // dialog.open / dialog.save choose a path (and the dialog
            // plugin adds THAT path to the filesystem scope), then
            // fs.readTextFile / fs.writeTextFile move scoped UTF-8 bytes.
            // No arbitrary-path command exists in the host.
            const [dialog, fs] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
            if (cancelled) {
                return;
            }
            setFileChannel(
                createDesktopFileChannel({
                    // The host-io slots are intentionally generic
                    // (Record<string, unknown> options); the official API
                    // types live here, at the composition root — the single
                    // place cast/verification is allowed.
                    openDialog: (options) => dialog.open(options as unknown as OpenDialogOptions),
                    saveDialog: (options) => dialog.save(options as unknown as SaveDialogOptions),
                    readTextFile: (path) => fs.readTextFile(path),
                    writeTextFile: (path, contents) => fs.writeTextFile(path, contents),
                }),
            );
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    /**
     * Replace the session around a newly authoritative document (a file
     * open or a text load): the document becomes current and every
     * derivative of the previous one is invalidated — the diagnostic
     * focus, the emission preview (a stale build result is never
     * current), and the operation notes — while the saved-text pane shows
     * the new document's canonical serialization.
     */
    /**
     * Canvas interaction state: the selected connection, the selected node,
     * the pending reconnection, and the two context menus.
     *
     * Connection and node ids are DOCUMENT-scoped: a stable id is meaningful
     * inside one document and is NOT a cross-document identity. Any
     * transition that changes which document is current (open/import,
     * or a history step back/forward) MUST clear this state — a stale
     * selection pointing at an id that happens to exist in the new
     * document is an outright delete/reconnect hazard (the Delete key
     * would remove a survivor).
     */
    function clearCanvasInteractionState(): void {
        setSelectedConnectionId(null);
        setSelectedNodeId(null);
        setReconnectArmed(null);
        setEdgeMenu(null);
        setNodeMenu(null);
    }

    /**
     * Revision-derived session state: the diagnostic focus and the
     * emission preview.
     *
     * The focus is derived from the document revision that produced its
     * diagnostics, and the emission preview is `f(document, descriptor)` —
     * BOTH inputs are its authority. A derivative must never outlive the
     * revision (and contract) it describes: a preview showing another
     * revision's HLSL is a wrong statement, not a stale convenience —
     * regenerate it instead.
     */
    function invalidateRevisionDerivedState(): void {
        setFocus(null);
        setEmission(null);
    }

    const replaceDocumentSession = (next: ShaderGraphDocument, source: DocumentProvenance): void => {
        // A new document is a NEW history line, not an undoable step —
        // and every canvas state bound to the old document is stale.
        setHistory(createHistory(next));
        clearCanvasInteractionState();
        invalidateRevisionDerivedState();
        // A new document becomes the new baseline — the session is not
        // dirty merely because its text was imported or a file was
        // opened.
        setSession(createSession(source, next));
        setOperationNotes([]);
        setSavedText(serializeShaderGraphDocument(next));
    };

    /** Open a `.shadergraph` through the host (path → scoped UTF-8 → core reader). */
    const openDocument = async (): Promise<void> => {
        const channel = fileChannel;
        if (channel === null) {
            return;
        }
        try {
            const path = await channel.pickDocumentPath();
            if (path === null) {
                return; // user cancelled
            }
            const text = await channel.readText(path);
            const parsed = parseShaderGraphDocument(text);
            if (parsed.ok && parsed.value !== null) {
                // A file-opened document OWNS that path — from now on a
                // plain Save targets exactly it.
                replaceDocumentSession(parsed.value, provenanceFromFile(path));
                setLoadResult({ title: "Load result", ok: true, diagnostics: parsed.diagnostics, passedText: `Opened ${path}; the session state was restored.` });
                requestAnimationFrame(() => fitRef.current?.());
                return;
            }
            setLoadResult({
                title: "Load result",
                ok: false,
                diagnostics: parsed.diagnostics,
                passedText: "",
            });
        } catch (error) {
            setOperationNotes((previous) => [...previous, `Open failed (${error instanceof Error ? error.message : String(error)}).`]);
        }
    };

    /**
     * Save via the host: the BYTES are the core's canonical .shadergraph
     * serialization (the disk format authority); the host only writes
     * scoped UTF-8 bytes to a user-chosen path. The TARGET comes from
     * the current document's provenance — Save reuses the owned path
     * when one exists, otherwise (and always for Save As) the dialog
     * asks. An imported document can therefore never overwrite a file
     * from a previous session of a different document.
     */
    /** Save to the session's target; resolve with success. Saving
     * establishes the new baseline (the saved bytes) — the document is
     * clean from that moment. */
    const saveDocument = async (as: boolean): Promise<boolean> => {
        const channel = fileChannel;
        if (channel === null) {
            return false;
        }
        try {
            const text = serializeShaderGraphDocument(document);
            let path = saveTarget(session, as);
            if (path === null) {
                const defaultName = session.provenance.kind === "file" ? basenameOf(session.provenance.path) : "Untitled.shadergraph";
                path = await channel.pickSavePath(defaultName);
                if (path === null) {
                    return false; // user cancelled
                }
            }
            await channel.writeText(path, text);
            setSession(sessionSaved(path, text));
            setSavedText(text);
            setOperationNotes((previous) => [...previous, `Saved ${path} as the core's canonical .shadergraph bytes.`]);
            return true;
        } catch (error) {
            setOperationNotes((previous) => [...previous, `Save failed (${error instanceof Error ? error.message : String(error)}).`]);
            return false;
        }
    };

    /** Desktop descriptor open: host path → UTF-8 → the panel's core reader. */
    const openDescriptorFile =
        fileChannel !== null
            ? async (): Promise<{ name: string; text: string } | null> => {
                  const channel = fileChannel;
                  const path = await channel.pickDescriptorPath();
                  if (path === null) {
                      return null;
                  }
                  const text = await channel.readText(path);
                  return { name: basenameOf(path), text };
              }
            : undefined;

    // The latest save flow, kept reachable from the once-registered
    // close guard (a stale closure in a listener must never save the
    // old document).
    const saveRef = useRef(saveDocument);
    useEffect(() => {
        saveRef.current = saveDocument;
    });
    // The close guard's live dirty state (the session's rule).
    const dirtyRef = useRef(dirty);
    useEffect(() => {
        dirtyRef.current = dirty;
    });
    // The in-page close confirmation (Save / Don't Save / Cancel): the
    // overlay is app state; the pending close decision resolves through
    // this ref (answered by a button). closePendingRef is the re-entry
    // guard: while the question is up, new close requests are absorbed
    // (prevented, ignored) — never answered by a second question.
    const [closePrompt, setClosePrompt] = useState(false);
    const resolveRef = useRef<((choice: CloseChoice) => void) | null>(null);
    const closePendingRef = useRef(false);
    const chooseCloseChoice = (choice: CloseChoice): void => {
        setClosePrompt(false);
        const resolve = resolveRef.current;
        if (resolve === null) {
            return;
        }
        resolveRef.current = null;
        resolve(choice);
    };

    // Native window title — the session's single title rule (name + the
    // dirty star), the same string the status bar shows.
    useEffect(() => {
        if (!isDesktopHost(globalThis)) {
            return;
        }
        let disposed = false;
        void (async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            if (disposed) {
                return;
            }
            await getCurrentWindow().setTitle(sessionTitle(session, dirty));
        })();
        return () => {
            disposed = true;
        };
    }, [session, dirty]);

    // Unsaved close guard (registered once). The verified Tauri 2.11.5
    // close model (read from the core + api sources):
    //
    //   X or close()  →  core AUTO-prevents whenever a JS close
    //                    listener is registered (manager/window.rs)
    //                    →  the event reaches this handler
    //   the api's onCloseRequested wrapper, AFTER this handler
    //            resolves:  if the handler did NOT call
    //            preventDefault() → the api DESTROYS the window
    //            (core:window:allow-destroy is the close path);
    //            if it did → the window stays.
    //
    // So "close" is expressed by NOT preventing, and "stay" by
    // preventing. The handler therefore decides FIRST and only
    // prevents when the session must stay. The question itself stays up
    // until answered, like any modal confirmation (no auto-cancel
    // countdown); while it is up, FURTHER close requests are absorbed
    // (closePendingRef: prevented and ignored — never answered by a
    // second question/resolver). The pure decision
    // (choice + save outcome → close/stay) is the session's rule,
    // exercised by the tests without any window.
    useEffect(() => {
        if (!isDesktopHost(globalThis)) {
            return;
        }
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void (async () => {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            if (disposed) {
                return;
            }
            unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
                if (!dirtyRef.current) {
                    setOperationNotes((previous) => [...previous, "Close guard: clean session — closing."]);
                    return; // not prevented → the api wrapper destroys the window
                }
                if (closePendingRef.current) {
                    // The Save / Don't Save / Cancel question is already
                    // up — absorb this new close request, do not create
                    // a second question (or a second resolver that would
                    // leak the first one).
                    event.preventDefault();
                    return;
                }
                closePendingRef.current = true;
                try {
                    setOperationNotes((previous) => [...previous, "Close guard: close attempt intercepted — the session has unsaved changes."]);
                    // Await the user's choice from the in-page surface
                    // (kept up until answered, like a modal question).
                    const choice: CloseChoice = await new Promise<CloseChoice>((resolve) => {
                        resolveRef.current = resolve;
                        setClosePrompt(true);
                    });
                    setClosePrompt(false);
                    let saveSucceeded = false;
                    if (choice === "save") {
                        saveSucceeded = await saveRef.current(false);
                    }
                    setOperationNotes((previous) => [...previous, `Close guard: choice = ${choice}(; save ${saveSucceeded ? "completed" : "not attempted/failed"}).`]);
                    if (closeAction(choice, saveSucceeded) === "stay") {
                        event.preventDefault(); // stay — the session is kept
                        setOperationNotes((previous) => [...previous, choice === "cancel" ? "Close guard: STAYED (Cancel)." : "Close guard: STAYED (the save did not complete)."]);
                        return;
                    }
                    // discard (or a completed save) — NOT prevented, so
                    // the api wrapper destroys the window and the close
                    // happens.
                    setOperationNotes((previous) => [...previous, choice === "discard" ? "Close guard: closing (unsaved changes discarded, as chosen)." : "Close guard: closing (changes saved)."]);
                } finally {
                    closePendingRef.current = false;
                }
            });
        })();
        return () => {
            disposed = true;
            unlisten?.();
        };
    }, []);

    // Ctrl/⌘+S and Ctrl/⌘+Shift+S (desktop builds only — a browser keeps
    // its own native defaults).
    useEffect(() => {
        if (fileChannel === null) {
            return;
        }
        const handler = (ev: KeyboardEvent): void => {
            const which = saveShortcutOf(ev);
            if (which === null) {
                return;
            }
            ev.preventDefault();
            void (which === "save-as" ? saveRef.current(true) : saveRef.current(false));
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [fileChannel]);

    const descriptor: SurfaceProfileDescriptor | null = descriptorState.kind === "ready" ? descriptorState.descriptor : null;

    const flow = useMemo(() => documentToFlow(document, focus, selectedConnectionId, selectedNodeId), [document, focus, selectedConnectionId, selectedNodeId]);

    const graphSets = useMemo<readonly DiagnosticSet[]>(() => {
        const validation = validateShaderGraph(document);
        const types = resolveGraphTypes(document);
        return [
            { title: "Graph validation", ok: validation.ok, diagnostics: validation.diagnostics, passedText: "No graph validation problems." },
            { title: "Connection types", ok: types.ok, diagnostics: types.diagnostics, passedText: "Every connection carries compatible types." },
        ];
    }, [document]);

    // The core's profile × descriptor compatibility — one memo, two
    // consumers (the diagnostics panel AND the native-build readiness
    // composition): the verdict has exactly one source here.
    const profileCompatibility = useMemo(() => {
        if (descriptor === null) {
            return null;
        }
        return {
            verdict: checkProfileDescriptorCompatibility(document, descriptor),
            conformance: checkProfileConformance(document, descriptor),
        };
    }, [document, descriptor]);

    const contractSets = useMemo<readonly DiagnosticSet[]>(() => {
        if (profileCompatibility === null) {
            return [];
        }
        const { conformance, verdict } = profileCompatibility;
        return [
            { title: "Parameter conformance", ok: conformance.ok, diagnostics: conformance.diagnostics, passedText: "Parameters conform to the loaded descriptor." },
            {
                title: "Profile × descriptor compatibility",
                ok: verdict.ok,
                diagnostics: verdict.diagnostics,
                passedText: "The document's profile line and this descriptor instance agree on capabilities.",
            },
        ];
    }, [profileCompatibility]);

    // The core's own explanation of a failed verdict (its structured
    // diagnostics, one line — the readiness reason carries the core's
    // detail verbatim, never a paraphrase).
    const descriptorDetail = useMemo(() => {
        if (profileCompatibility === null) {
            return "no descriptor instance is loaded";
        }
        const first = profileCompatibility.verdict.diagnostics.find((diagnostic) => diagnostic.severity === "error");
        return first !== undefined ? `${first.code}: ${first.message}` : "the profile and the descriptor instance disagree on capabilities";
    }, [profileCompatibility]);

    function applyAuthoring(result: AuthoringResult, label: string): void {
        if (result.applied) {
            // An ACCEPTED operation is not necessarily a mutation: an
            // accepted no-op (a same-endpoint reconnect, a zero-attachment
            // disconnect) returns the SAME document instance, and it
            // invalidates nothing — the focus and the emission preview
            // still describe the current revision, and no fake history
            // step is recorded.
            if (!Object.is(result.document, document)) {
                // One user intent = one history step (the label names it);
                // the before/after pair is exactly what undo/redo restore.
                setHistory((previous) => recordHistory(previous, result.document, label));
                // The revision moved: the derivative state (focus and
                // emission preview) described the former revision and is
                // now stale — the preview must never outlive its revision.
                invalidateRevisionDerivedState();
            }
            setOperationNotes([]);
            return;
        }
        // A REFUSED operation is not a change: it is exposed (the note
        // below) but never entered the history — undo must never "undo
        // nothing".
        const reason = result.refusal !== undefined ? result.refusal.reason : "The operation was not applied.";
        setOperationNotes((previous) => [...previous, reason]);
    }

    function selectDiagnostic(diagnostic: ShaderGraphDiagnostic): void {
        // Navigation intent → target resolved against the document from the
        // diagnostic's own dataPath anchor (never parsed from prose).
        setFocus(diagnosticFocus(document, diagnostic));
    }

    const onAddNode = (type: string): void => {
        applyAuthoring(addNode(document, type), `added a ${type} node`);
    };
    const onAddParameter = (request: ParameterRequest): void => {
        applyAuthoring(addParameter(document, request), `added a ${request.class} parameter`);
    };
    const onConnectRequest = (request: ConnectionRequest): void => {
        applyAuthoring(
            addConnection(document, request.from, request.to),
            `connected ${request.from.nodeId}.${request.from.portId} to ${request.to.nodeId}.${request.to.portId}`,
        );
    };

    // ---- connection selection + removal (session state, core semantics) ----
    // The viewport reports raw gestures with the edge id; this is where the
    // app gives them meaning. Selection never touches the document.
    const onRemoveNode = (nodeId: string): void => {
        // Node removal is ONE intent applied by the core-judged
        // operation: the node, every connection touching it (either
        // end), and its placement. A canvas selection or armed reconnect
        // naming one of the connections that goes with the node is stale
        // the instant it lands — clear exactly that stale state (a
        // selection on a survivor stays put).
        const goneIds = document.connections.filter((connection) => connection.from.nodeId === nodeId || connection.to.nodeId === nodeId).map((connection) => connection.id);
        applyAuthoring(removeNode(document, nodeId), `removed node ${nodeId}`);
        if (selectedNodeId === nodeId) {
            setSelectedNodeId(null); // the target no longer exists — drop it from the selection
        }
        setNodeMenu(null); // a menu naming the removed node is stale
        if (goneIds.includes(selectedConnectionId ?? "") || goneIds.includes(reconnectArmed ?? "")) {
            clearCanvasInteractionState();
        }
    };

    const onEdgeSelect = (connectionId: string): void => {
        // Selection is ONE fact at a time: an edge selection retires the
        // node selection (and the node menu) — never two live targets for
        // the Delete key.
        setSelectedConnectionId(connectionId);
        setSelectedNodeId(null);
        setEdgeMenu(null);
        setNodeMenu(null);
    };
    const onNodeSelect = (nodeId: string): void => {
        // A genuine card click selects THAT node and retires the edge
        // selection — the same exclusive, one-selection model.
        setSelectedNodeId(nodeId);
        setSelectedConnectionId(null);
        setEdgeMenu(null);
    };
    const onCanvasClick = (): void => {
        setSelectedConnectionId(null);
        setSelectedNodeId(null);
        setEdgeMenu(null);
        setNodeMenu(null);
        setReconnectArmed(null);
    };
    const onNodeMenu = (nodeId: string, anchor: { x: number; y: number }): void => {
        // The chevron names its own target: the menu opens with that node
        // SELECTED (the Delete key and the menu agree on the target), the
        // edge side retired, and the armed reconnect cancelled — a pending
        // gesture and an open action menu are contradictory states.
        setSelectedNodeId(nodeId);
        setSelectedConnectionId(null);
        setEdgeMenu(null);
        setReconnectArmed(null);
        setNodeMenu({ nodeId, x: anchor.x, y: anchor.y });
    };
    const onEdgeContextMenu = (event: { clientX: number; clientY: number }, connectionId: string): void => {
        // Right-click selects (if needed) and offers the one destructive
        // action; the menu is pure UI state — it never touches the edges.
        setSelectedConnectionId(connectionId);
        setEdgeMenu({ x: event.clientX, y: event.clientY });
    };
    // Deleting a connection is a DOCUMENT change: it flows through the core's
    // atomic removeConnection on the authoring path (dirty/validation/
    // serialization ride the same transaction). A stale id is refused by the
    // core and surfaces as an operation note — never silently swallowed.
    const applyRemoveConnection = (connectionId: string): void => {
        applyAuthoring(removeConnection(document, connectionId), `removed connection ${connectionId}`);
        setSelectedConnectionId(null);
        setEdgeMenu(null);
        setReconnectArmed(null);
    };

    // ---- undo / redo — history is session state; the document follows ----
    // (The document IS history.present: one transition, no drift. The
    // dirty star stays derived — undoing to the saved baseline simply
    // un-dirties, no extra bookkeeping.)
    const onUndo = (): void => {
        if (canUndoHistory(history) === false) {
            return;
        }
        setHistory((previous) => undoHistory(previous));
        clearCanvasInteractionState();
        invalidateRevisionDerivedState();
    };
    const onRedo = (): void => {
        if (canRedoHistory(history) === false) {
            return;
        }
        setHistory((previous) => redoHistory(previous));
        clearCanvasInteractionState();
        invalidateRevisionDerivedState();
    };

    // ---- advanced gestures (port disconnect + reconnect) ------------------
    const onEdgeReconnectArm = (connectionId: string): void => {
        // Ctrl+click a connection: select it (the armed edge keeps the
        // selection language) and start the pending endpoint move.
        setSelectedConnectionId(connectionId);
        setReconnectArmed(connectionId);
        setEdgeMenu(null);
    };
    const onPortActivate = (activation: { nodeId: string; portId: string; isInput: boolean; altKey: boolean }): void => {
        if (activation.altKey) {
            // Alt + click a port: disconnect EVERYTHING attached to it
            // (the core's atomic port removal — the fan-out of an output,
            // the incoming of an input, both-side honest). The selection
            // may now be stale: clear it either way.
            // The clicked handle KNOWS its side (a rendered input handle
            // or an output handle) — pass the full port identity down.
            // The catalog ships same-named input/output ports, so side
            // scoping is what keeps "Alt+click value on OneMinus" from
            // severing the other side's wire.
            applyAuthoring(
                removeConnectionsAtPort(document, {
                    nodeId: activation.nodeId,
                    portId: activation.portId,
                    side: activation.isInput ? "input" : "output",
                }),
                `disconnected ${activation.isInput ? "input" : "output"} ${activation.nodeId}.${activation.portId}`,
            );
            setSelectedConnectionId(null);
            setReconnectArmed(null);
            return;
        }
        if (reconnectArmed !== null) {
            // Confirm the pending reconnect: the port's ROLE decides the
            // side — an input handle (rendered as the TARGET end) becomes
            // the new "to", an output handle the new "from". No guessing:
            // the row knew which side it rendered. One atomic core
            // operation; same connection id, other end untouched.
            applyAuthoring(
                reconnectConnection(document, reconnectArmed, {
                    side: activation.isInput ? "to" : "from",
                    nodeId: activation.nodeId,
                    portId: activation.portId,
                }),
                `reconnected ${reconnectArmed}`,
            );
            setReconnectArmed(null);
            // The selection intentionally STAYS on the same connection id:
            // it is still the same first-class document object, moved.
            return;
        }
        // A bare port click with no pending gesture is a pure socket: a
        // no-op. (Wiring still happens as before: drag from a handle.)
    };

    // Delete / Backspace remove the selected connection — but only when the
    // keyboard belongs to the editor. While a text field (library search,
    // the JSON viewport, any input) is active the key is the field's: the
    // shared guard predicate keeps graph shortcuts out of text editing.
    // Escape closes the context menu.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === "Escape") {
                setEdgeMenu(null);
                setNodeMenu(null);
                setSelectedNodeId(null);
                setReconnectArmed(null);
                return;
            }
            // Ctrl+Z / Ctrl+Y (and Ctrl+Shift+Z) — the editor's undo/redo.
            // The shared text-field guard runs FIRST: inside the library
            // search or the JSON viewport the shortcut belongs to the field's
            // own editor history, never to the graph.
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
                if (isEditingTextTarget(event.target)) {
                    return;
                }
                event.preventDefault();
                if (event.shiftKey) {
                    onRedo();
                } else {
                    onUndo();
                }
                return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
                if (isEditingTextTarget(event.target)) {
                    return;
                }
                event.preventDefault();
                onRedo();
                return;
            }
            // Delete / Backspace removes the CURRENT selection — node
            // first (they are exclusive, so at most one branch fires):
            // the target's removal is the core-judged operation on the
            // authoring path. The shared text-field guard runs FIRST.
            if (event.key === "Delete" || event.key === "Backspace") {
                if (isEditingTextTarget(event.target)) {
                    return;
                }
                if (selectedNodeId !== null) {
                    event.preventDefault();
                    onRemoveNode(selectedNodeId);
                    return;
                }
                if (selectedConnectionId !== null) {
                    event.preventDefault();
                    applyRemoveConnection(selectedConnectionId);
                }
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selectedConnectionId, selectedNodeId, document, onUndo, onRedo]);
    const onNodePlaced = (nodeId: string, position: { x: number; y: number }): void => {
        // Session state (canvas layout): the shared position-patch helper
        // updates ONLY the position, preserving the node's existing
        // editor-state metadata (unknownFields, future presentation
        // fields). One drag stop = one intent = one history step.
        setHistory((previous) => recordHistory(previous, withNodePosition(previous.present, nodeId, position), `placed ${nodeId}`));
    };

    const onAutoLayout = (): void => {
        // Session convenience: compute positions for the WHOLE graph and
        // patch them into editorMetadata (session state) one node at a time
        // through the shared helper — never dropping metadata it doesn't
        // own. The core services are re-asked as usual; placement never
        // changes emitted HLSL. ONE layout pass = ONE intent = ONE history
        // step (undo reverts the whole pass, not node by node).
        setHistory((previous) => {
            const layout = autoLayout(previous.present);
            if (layout.nodeCount === 0) {
                return previous;
            }
            let placed = previous.present;
            for (const [id, position] of Object.entries(layout.positions)) {
                placed = withNodePosition(placed, id, position);
            }
            return recordHistory(previous, placed, "automatic layout");
        });
        // Fit once the projection has picked up the new positions.
        requestAnimationFrame(() => fitRef.current?.());
    };

    const onDropRequest = (payload: AuthoringDropPayload, position: { x: number; y: number }): void => {
        // Palette → canvas drop: the coordinate came from the flow adapter
        // (screen → flow, resolved + guarded), the creation is the same
        // core-judged authoring operation as a click, only seeded with the
        // drop position. The payload's valueType is a GraphType by
        // construction (validated at the decode boundary) — no cast.
        if (payload.kind === "node") {
            applyAuthoring(addNode(document, payload.nodeType, { position }), `added a ${payload.nodeType} node`);
            return;
        }
        applyAuthoring(
            addParameter(document, { name: "New Parameter", class: payload.parameterClass, valueType: payload.valueType }, { position }),
            `added a ${payload.parameterClass} parameter`,
        );
    };

    const onSave = (): void => {
        // The `.shadergraph` disk format is the core's canonical
        // serialization authority — never a raw `JSON.stringify(document)`,
        // which would emit the model's internal `unknownFields` bookkeeping
        // keys and corrupt retained forward-compatible data on re-parse.
        setSavedText(serializeShaderGraphDocument(document));
        setEmission(null);
    };

    const onLoad = (): void => {
        const parsed = parseShaderGraphDocument(savedText);
        if (parsed.ok && parsed.value !== null) {
            // An imported (text) document owns NO file path — a later
            // Save must ask for a destination instead of touching a file
            // path left over from any earlier document.
            replaceDocumentSession(parsed.value, provenanceFromImport());
            setLoadResult({ title: "Load result", ok: true, diagnostics: parsed.diagnostics, passedText: "The saved document loaded; the session state was restored." });
            requestAnimationFrame(() => fitRef.current?.());
            return;
        }
        setLoadResult({ title: "Load result", ok: false, diagnostics: parsed.diagnostics, passedText: "" });
    };

    const onDescriptorStateChange = (next: DescriptorPanelState): void => {
        // Emission = f(document, descriptor): the descriptor is the
        // preview's OTHER authority input, so a descriptor change
        // invalidates the revision-derived state exactly as a document
        // change does. The identity check keeps a pure re-set (the very
        // same state object) an honest no-op.
        if (!Object.is(next, descriptorState)) {
            invalidateRevisionDerivedState();
        }
        setDescriptorState(next);
    };

    const onEmit = (): void => {
        if (descriptor === null) {
            setEmission(null);
            setOperationNotes((previous) => [...previous, "Emission needs the profile contract: load a descriptor instance first (the descriptor is the serialized profile contract, never a header import — and without it the core refuses to emit)."]);
            return;
        }
        setEmission(emitHlsl(document, descriptor));
    };

    const graphOk = graphSets.every((set) => set.ok);
    const contractOk = descriptor !== null && contractSets.length > 0 && contractSets.every((set) => set.ok);
    const graphProblemCount = graphSets.reduce((sum, set) => sum + set.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length, 0);
    const contractProblemCount = contractSets.reduce((sum, set) => sum + set.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length, 0);
    const emissionIdentity = emission !== null && emission.ok && emission.sourceMap?.generatedSourceIdentity !== undefined ? emission.sourceMap.generatedSourceIdentity.slice(0, 12) + "…" : undefined;

    // ---- native build (Step 4 surface) — the composition and gate ----
    // Every RULE lives in the client (verdicts, the state machine, the
    // build-line) and the pure editor modules (readiness composition,
    // the session store, the inspector projection); the app owns only
    // which facts feed them and the actions the user can take.
    const native = useNativeBuild({
        descriptor,
        descriptorCompatible: profileCompatibility !== null && profileCompatibility.verdict.ok,
        descriptorDetail,
        emission,
    });
    const preview = useShaderPreview({
        document,
        descriptor,
        descriptorCompatible: profileCompatibility !== null && profileCompatibility.verdict.ok,
        emission,
        configuredTarget: native.target.target,
        nativeFlow: native.flow,
    });

    const nativeTargetOptions = useMemo(() => {
        const supported = native.flow?.supportedTargets ?? null;
        return Array.from(new Set<string>([native.target.target, DEFAULT_BUILD_TARGET, ...(supported ?? [])]));
    }, [native.flow, native.target.target]);

    // Discovery-config picks (design section 5, rules 1 and 2): the
    // native dialog seam belongs to the file channel (desktop host only —
    // nothing chooses a path on its own in a web shell); the picked value
    // lands in the CONFIG SETTER, its single write path — nothing else
    // moves (the next Re-discover resolves over it).
    const browseToolPath = async (): Promise<void> => {
        const channel = fileChannel;
        if (channel === null) {
            return;
        }
        try {
            const path = await channel.pickToolExecutablePath();
            if (path !== null) {
                native.setToolPath(path);
            }
        } catch (error) {
            native.addNote("refusal", `Tool path pick failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    const browseSiblingBuildOutput = async (): Promise<void> => {
        const channel = fileChannel;
        if (channel === null) {
            return;
        }
        try {
            const path = await channel.pickSiblingBuildOutputDirectory();
            if (path !== null) {
                native.setSiblingBuildOutput(path);
            }
        } catch (error) {
            native.addNote("refusal", `Build-output pick failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    // The zone badges: each zone's live STATE projected from the facts
    // above (design section 13, surface note) — the badges render, they
    // own nothing: one source of truth per fact stands.
    const inspectorZoneFacts: InspectorZoneFacts = {
        checks: {
            ok: graphOk && contractOk && (loadResult === null || loadResult.ok),
            problemCount:
                graphProblemCount +
                contractProblemCount +
                (loadResult !== null ? loadResult.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length : 0),
        },
        document: { dirty },
        emission: {
            state: emission === null ? "none" : emission.ok === false ? "failed" : "ok",
            problemCount: emission !== null && emission.ok === false ? emission.diagnostics.length : 0,
        },
        build: { ready: native.ready },
    };

    return (
        <div className="gglab-app">
            <header className="gglab-header">
                <div className="gglab-header-group">
                    <span className="gglab-brand">Shader Graph Editor</span>
                    <span className="gglab-brand-sub">gglab.surface authoring</span>
                </div>
                <div className="gglab-header-group">
                    <Badge variant="outline" className="font-mono">
                        {descriptor !== null ? `${descriptor.profileId} v${descriptor.profileVersion}` : "no profile contract"}
                    </Badge>
                    <Badge variant={descriptor === null ? "default" : contractOk ? "ok" : "error"}>
                        <BadgeDot />
                        {descriptor === null ? "awaiting descriptor" : contractOk ? "contract ok" : `${contractProblemCount} contract problem${contractProblemCount === 1 ? "" : "s"}`}
                    </Badge>
                </div>
            </header>
            <div className={`gglab-body${libraryOpen ? "" : " gglab-body-library-collapsed"}${inspectorOpen ? "" : " gglab-body-inspector-collapsed"}`}>
                <aside className="gglab-side gglab-side-left">
                    {libraryOpen ? (
                        <>
                            <div className="gglab-library-search">
                                <Input
                                    placeholder="Filter the library…"
                                    value={libraryQuery}
                                    onChange={(event) => setLibraryQuery(event.currentTarget.value)}
                                    aria-label="Filter the node library"
                                />
                            </div>
                            <NodePalette
                                onAddNode={onAddNode}
                                onAddParameter={onAddParameter}
                                descriptor={descriptor}
                                query={libraryQuery}
                                onCollapseLibrary={() => setLibraryOpen(false)}
                            />
                            {operationNotes.length > 0 && (
                                <section className="gglab-notes">
                                    <h2>Authoring notes</h2>
                                    {operationNotes.map((note, index) => (
                                        <p key={index}>{note}</p>
                                    ))}
                                </section>
                            )}
                        </>
                    ) : (
                        <NodePalette rail onAddNode={onAddNode} onAddParameter={onAddParameter} descriptor={descriptor} onExpandLibrary={() => setLibraryOpen(true)} />
                    )}
                </aside>
                <main className="gglab-canvas">
                    {/* Canvas toolbar — one visual language for canvas
                        actions (Auto Layout today; Fit View / Snap later). */}
                    <div className="gglab-canvas-actions" role="toolbar" aria-label="Canvas actions">
                        {/* Undo / Redo — the session's document history
                            (one step per user intent; refused operations
                            never enter; disabled while nothing to step). */}
                        <Button variant="toolbar" onClick={onUndo} disabled={!canUndoHistory(history)} title="Undo the last change (Ctrl+Z)" aria-label="Undo">
                            <UndoIcon />
                            Undo
                        </Button>
                        <Button variant="toolbar" onClick={onRedo} disabled={!canRedoHistory(history)} title="Redo the last undone change (Ctrl+Y)" aria-label="Redo">
                            <RedoIcon />
                            Redo
                        </Button>
                        <Button variant="toolbar" onClick={onAutoLayout} title="Lay the whole graph out (positions are session state)">
                            <LayoutIcon />
                            Auto layout
                        </Button>
                    </div>
                    {/* Reconnect armed — the advanced gesture's visible
                        affordance. Cancelling is a no-op: the original
                        connection is moved only when a port confirms. */}
                    {reconnectArmed !== null && (
                        <div className="gglab-reconnect-hint" role="status">
                            Reconnecting <span className="mono">{reconnectArmed}</span> — click a port (input = target end · output = source
                            end). Esc cancels; the original wire stays put.
                        </div>
                    )}
                    <FlowViewport
                        nodes={flow.nodes}
                        edges={flow.edges}
                        onConnectRequest={onConnectRequest}
                        onNodePlaced={onNodePlaced}
                        onDropRequest={onDropRequest}
                        onEdgeSelect={onEdgeSelect}
                        onCanvasClick={onCanvasClick}
                        onEdgeContextMenu={onEdgeContextMenu}
                        onEdgeReconnectArm={onEdgeReconnectArm}
                        onPortActivate={onPortActivate}
                        onNodeSelect={onNodeSelect}
                        onNodeMenu={onNodeMenu}
                        onFlowReady={(fitView) => {
                            fitRef.current = fitView;
                        }}
                    />
                    {/* Edge context menu — one item, the app's core-judged
                        operation. It never calls into React Flow edges. */}
                    {edgeMenu !== null && (
                        <>
                            <div className="gglab-menu-overlay" onPointerDown={() => setEdgeMenu(null)} />
                            <div className="gglab-edge-menu" style={{ left: edgeMenu.x, top: edgeMenu.y }} role="menu" aria-label="Connection actions">
                                <Button
                                    variant="ghost"
                                    className="gglab-edge-menu-item"
                                    role="menuitem"
                                    onClick={() => {
                                        if (selectedConnectionId !== null) {
                                            applyRemoveConnection(selectedConnectionId);
                                        }
                                    }}>
                                    <span>Delete Connection</span>
                                    <span className="gglab-kbd" aria-hidden>
                                        Del
                                    </span>
                                </Button>
                            </div>
                        </>
                    )}
                    {/* Node action menu — the card's chevron, one
                        destructive item; same chrome language as the edge
                        menu, and the same Del key behind it (the menu
                        opens with its target selected, so the two agree). */}
                    {nodeMenu !== null && (
                        <>
                            <div className="gglab-menu-overlay" onPointerDown={() => setNodeMenu(null)} />
                            <div className="gglab-node-menu" style={{ left: nodeMenu.x, top: nodeMenu.y }} role="menu" aria-label={`Node actions for ${nodeMenu.nodeId}`}>
                                <Button
                                    variant="ghost"
                                    className="gglab-node-menu-item"
                                    role="menuitem"
                                    onClick={() => {
                                        const nodeId = nodeMenu.nodeId;
                                        setNodeMenu(null);
                                        onRemoveNode(nodeId);
                                    }}>
                                    <span className="gglab-node-menu-label">
                                        <TrashIcon />
                                        Delete Node
                                    </span>
                                    <span className="gglab-kbd" aria-hidden>
                                        Del
                                    </span>
                                </Button>
                            </div>
                        </>
                    )}
                    {/* Node deletion — one gesture, the whole node (node +
                        touching connections + placement) through the
                        core-judged `removeNode`. */}
                </main>
                <aside className="gglab-side gglab-side-right">
                    {inspectorOpen ? (
                        <>
                        {/* Same rail language as the node library: head +
                            one panel-control; collapsed it becomes the
                            48px rail with the vertical re-open button. */}
                        <div className="gglab-library-head">
                            <h2 className="gglab-library-title">Inspector</h2>
                            <div className="gglab-library-bulk" role="group" aria-label="Inspector controls">
                                <Button variant="icon" size="icon" aria-label="Collapse the inspector" title="Collapse the inspector" onClick={() => setInspectorOpen(false)}>
                                    <PanelCloseIcon />
                                </Button>
                            </div>
                        </div>
                        {/* Inspector zones (design section 13, surface note): one
                            responsibility per tab; each tab carries its zone's
                            LIVE STATE badge — the grouping organizes, it never
                            hides: a zoned-out zone still states itself here. */}
                        <div className="gglab-inspector-tabs" role="tablist" aria-label="Inspector zones">
                            {INSPECTOR_ZONES.map((zone) => {
                                const badge = inspectorZoneBadge(zone, inspectorZoneFacts);
                                return (
                                    <button
                                        key={zone}
                                        type="button"
                                        role="tab"
                                        aria-selected={inspectorZone === zone}
                                        className={inspectorZone === zone ? "gglab-inspector-tab active" : "gglab-inspector-tab"}
                                        onClick={() => setInspectorZone(zone)}
                                    >
                                        <span>{INSPECTOR_ZONE_LABELS[zone]}</span>
                                        <Badge variant={badge.variant}>
                                            <BadgeDot />
                                            {badge.label}
                                        </Badge>
                                    </button>
                                );
                            })}
                        </div>
                        {inspectorZone === "contract" && (
                            <>
                            <DescriptorPanel state={descriptorState} onStateChange={onDescriptorStateChange} openDescriptorFile={openDescriptorFile} />
                    {graphSets.map((set) => (
                        <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} onSelect={selectDiagnostic} />
                    ))}
                    {contractSets.map((set) => (
                        <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} onSelect={selectDiagnostic} />
                    ))}
                    {loadResult !== null && (
                        <DiagnosticsPanel title={loadResult.title} diagnostics={loadResult.diagnostics} ok={loadResult.ok} passedText={loadResult.passedText} onSelect={selectDiagnostic} />
                    )}
                            </>
                        )}
                        {inspectorZone === "document" && (
                            <>
                    {/* Desktop slice 1: native document I/O. The host owns
                        path + UTF-8 bytes only; the core owns parse/
                        serialize; this app owns which text moves where. */}
                    {fileChannel !== null && (
                        <section className="gglab-panel gglab-document-native">
                            <h2 className="gglab-panel-title">Document</h2>
                            <p className="gglab-panel-hint">
                                Native open, save, save-as (the host moves path + UTF-8 bytes; bytes are the core's canonical .shadergraph serialization).
                            </p>
                            <ButtonGroup role="toolbar" aria-label="Document I/O">
                                <Button variant="secondary" onClick={() => void openDocument()}>
                                    <FileIcon />
                                    Open…
                                </Button>
                                <Button variant="secondary" onClick={() => void saveDocument(false)}>
                                    Save
                                </Button>
                                <Button variant="ghost" onClick={() => void saveDocument(true)}>
                                    Save As…
                                </Button>
                            </ButtonGroup>
                            {session.provenance.kind === "file" && <p className="gglab-panel-hint mono">{session.provenance.path}</p>}
                        </section>
                    )}
                    <section className="gglab-panel gglab-document-io">
                        <h2 className="gglab-panel-title">Document save / load</h2>
                        <textarea
                            className="gglab-field gglab-field-mono"
                            value={savedText}
                            onChange={(event) => setSavedText(event.currentTarget.value)}
                            rows={12}
                            spellCheck={false}
                        />
                        <ButtonGroup className="mt-2.5">
                            <Button variant="ghost" onClick={onSave}>
                                Save to text
                            </Button>
                            <Button variant="secondary" onClick={onLoad}>
                                Load from text
                            </Button>
                        </ButtonGroup>
                    </section>
                            </>
                        )}
                        {inspectorZone === "emission" && (
                            <>
                    <section className="gglab-panel gglab-emission-block">
                        <h2 className="gglab-panel-title">Emission preview</h2>
                        <ButtonGroup className="mb-2.5">
                            <Button variant="secondary" onClick={onEmit}>
                                Generate HLSL (core)
                            </Button>
                        </ButtonGroup>
                        {emission !== null && <EmissionPreview emission={emission} />}
                        </section>
                            </>
                        )}
                        {inspectorZone === "build" && (
                            <>
                    {/* Native build — readiness, gate, build line, and the
                        Build Inspector projection (one source of truth
                        per field; the inspector never computes facts). */}
                    <section className="gglab-panel gglab-panel-native-build" aria-label="Native build">
                        <h2 className="gglab-panel-title">Native build</h2>
                        <p className="gglab-panel-hint">
                            Tool readiness, proof, and the generated-function facts for the native production contract. The generated surface function is a
                            function contract, not a complete program entry.
                        </p>
                        <Badge variant={native.ready ? "ok" : "error"}>
                            <BadgeDot />
                            {native.ready ? "Ready" : "NotReady"}
                        </Badge>
                        {readyReasonList(native.readiness) !== null && <ul className="gglab-native-reasons">{readyReasonList(native.readiness)}</ul>}
                        {/* Program-composition state: carried INSIDE the
                            readiness reason list above (one source per
                            fact, one verdict — Preview Program design
                            v1.0): while this surface owns no
                            complete-program composition, the readiness
                            verdict is NotReady [ProgramCompositionUnavailable]
                            and the gate refuses structurally. No second
                            display surface for it here. */}
                        {/* Configuration (sections 5 and 8) — each field is a
                            stacked block: a short label, the explanation in
                            the hint, and the control on its own full-width
                            row. A long label never shares the value's row
                            again (the path display is never crushed). */}
                        <h3 className="gglab-panel-title" style={{ marginTop: 14 }}>
                            Configuration
                        </h3>
                        <div className="gglab-native-field">
                            <label className="gglab-native-field-label" htmlFor="native-tool-path">
                                Tool path
                            </label>
                            <p className="gglab-native-field-hint">
                                Explicit configuration — discovery rule 1. Empty means not configured: that rule records its own failure.
                            </p>
                            <div className="gglab-native-path-row">
                                <Input
                                    id="native-tool-path"
                                    className="gglab-native-path-input"
                                    placeholder="C:\…\gglab-shaderc.exe"
                                    title={native.discoveryConfig.explicitConfig === "" ? undefined : native.discoveryConfig.explicitConfig}
                                    value={native.discoveryConfig.explicitConfig}
                                    onChange={(event) => native.setToolPath(event.currentTarget.value)}
                                    aria-label="Explicit tool path (discovery rule 1)"
                                />
                                {fileChannel !== null && (
                                    <Button variant="ghost" className="gglab-native-path-browse" onClick={() => void browseToolPath()}>
                                        <FileIcon />
                                        Browse…
                                    </Button>
                                )}
                            </div>
                        </div>
                        <div className="gglab-native-field">
                            <label className="gglab-native-field-label" htmlFor="native-sibling-build">
                                Build-output location
                            </label>
                            <p className="gglab-native-field-hint">
                                Sibling GGLab build output — discovery rule 2; optional.
                            </p>
                            <div className="gglab-native-path-row">
                                <Input
                                    id="native-sibling-build"
                                    className="gglab-native-path-input"
                                    placeholder="…\Build\Output\x64"
                                    title={native.discoveryConfig.siblingBuildOutput === "" ? undefined : native.discoveryConfig.siblingBuildOutput}
                                    value={native.discoveryConfig.siblingBuildOutput}
                                    onChange={(event) => native.setSiblingBuildOutput(event.currentTarget.value)}
                                    aria-label="Configured sibling build-output location (discovery rule 2)"
                                />
                                {fileChannel !== null && (
                                    <Button variant="ghost" className="gglab-native-path-browse" onClick={() => void browseSiblingBuildOutput()}>
                                        <FileIcon />
                                        Browse…
                                    </Button>
                                )}
                            </div>
                        </div>
                        <div className="gglab-native-field">
                            <label className="gglab-native-field-label" htmlFor="native-build-target">
                                Build target
                            </label>
                            <p className="gglab-native-field-hint">
                                Explicit configuration (development default {DEFAULT_BUILD_TARGET}); the next BuildIntent carries it.
                            </p>
                            <select id="native-build-target" className="gglab-native-select" value={native.target.target} onChange={(event) => native.setTarget(event.currentTarget.value)}>
                                {nativeTargetOptions.map((option) => (
                                    <option key={option} value={option}>
                                        {option}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {/* Actions, in lifecycle order: resolve the tool
                            (the rule walk), establish proof (the handshake).
                            No compile action: the function-only program
                            composition is unavailable in this editor (the
                            state above), so the surface offers no path to
                            issue one. */}
                        <h3 className="gglab-panel-title" style={{ marginTop: 14 }}>
                            Actions
                        </h3>
                        <ButtonGroup role="toolbar" aria-label="native build actions">
                            <Button variant="ghost" onClick={() => void native.discoverNow()} disabled={native.discoveryInFlight}>
                                {native.discoveryInFlight ? "Discovering…" : "Re-discover"}
                            </Button>
                            <Button variant="ghost" onClick={() => void native.handshakeNow()} disabled={native.handshakeInFlight}>
                                {native.handshakeInFlight ? "Handshaking…" : "Handshake (establish proof)"}
                            </Button>
                        </ButtonGroup>
                        {native.lineReport !== null && (
                            <>
                                <h3 className="gglab-panel-title" style={{ marginTop: 14 }}>
                                    Build line
                                </h3>
                                <p className="gglab-native-field-hint">
                                    This session's attempts, in issue order (the newest issued anchors `current`).
                                </p>
                                <dl className="gglab-facts">
                                    {native.lineReport.states.map((entry, index) => (
                                        <div key={`${entry.buildId.sequence}-${index}`} className="gglab-fact">
                                            <dt>
                                                #{entry.buildId.sequence} · {entry.intent.target}
                                            </dt>
                                            <dd className={`gglab-native-state gglab-native-state-${entry.state}`}>{entry.state}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </>
                        )}
                        {native.inspector !== null && (
                            <>
                                <h3 className="gglab-panel-title" style={{ marginTop: 14 }}>
                                    Replayable evidence
                                </h3>
                                <p className="gglab-native-field-hint">
                                    One source of truth per field: which tool, under which facts, compiled which exact bytes — and where each fact is true.
                                </p>
                                <InspectorRows title="Tool" rows={native.inspector.tool} />
                                <InspectorRows title="Descriptor" rows={native.inspector.descriptor} />
                                <InspectorRows title="Host · target · readiness" rows={native.inspector.hostAndTarget} />
                                <InspectorRows title="Build" rows={native.inspector.build} />
                            </>
                        )}
                        {native.notes.length > 0 && <ul className="gglab-native-notes">{renderNativeNotes(native.notes)}</ul>}
                    </section>
                    <section className="gglab-panel gglab-panel-native-build" aria-label="Shader Graph Preview">
                        <h2 className="gglab-panel-title">Shader Graph Preview</h2>
                        <p className="gglab-panel-hint">
                            Authoritative attached preview through the main-owned Preview Program and GGLab Runtime. Launch is success-first: no Runtime process starts before a valid publication exists.
                        </p>
                        <Badge
                            variant={
                                preview.projection?.freshness === "current"
                                    ? "ok"
                                    : preview.projection?.freshness === "rejected"
                                      ? "error"
                                      : preview.projection?.freshness === "stale"
                                        ? "warn"
                                        : "accent"
                            }
                        >
                            <BadgeDot />
                            {preview.projection?.freshness ?? "idle"}
                        </Badge>
                        <dl className="gglab-facts" style={{ marginTop: 10 }}>
                            <div className="gglab-fact">
                                <dt>Session</dt>
                                <dd className="mono">{preview.sessionId ?? "(desktop Preview host unavailable)"}</dd>
                            </div>
                            <div className="gglab-fact">
                                <dt>Runtime</dt>
                                <dd className="mono">
                                    {preview.runtime.kind}
                                    {"runtimeId" in preview.runtime
                                        ? ` · #${preview.runtime.runtimeId.sequence}`
                                        : preview.runtime.kind === "exited"
                                          ? ` · ${preview.runtime.exit.kind}`
                                          : preview.runtime.kind === "launch-refused"
                                            ? ` · ${preview.runtime.result.kind}`
                                            : ""}
                                </dd>
                            </div>
                            <div className="gglab-fact">
                                <dt>Runtime executable identity</dt>
                                <dd className="mono">
                                    {"runtimeIdentity" in preview.runtime ? preview.runtime.runtimeIdentity : "—"}
                                </dd>
                            </div>
                            <div className="gglab-fact">
                                <dt>Target</dt>
                                <dd className="mono">{native.target.target}</dd>
                            </div>
                            <div className="gglab-fact">
                                <dt>Current publication</dt>
                                <dd className="mono">{preview.projection?.currentPublicationId ?? "—"}</dd>
                            </div>
                            <div className="gglab-fact">
                                <dt>Last-good publication</dt>
                                <dd className="mono">{preview.projection?.lastGoodPublicationId ?? "—"}</dd>
                            </div>
                            <div className="gglab-fact">
                                <dt>Observation</dt>
                                <dd className="mono">
                                    {preview.lastObservationRefresh?.kind ?? "not read"}
                                    {preview.projection?.rejectionCode !== null && preview.projection?.rejectionCode !== undefined
                                        ? ` · ${preview.projection.rejectionCode}`
                                        : ""}
                                </dd>
                            </div>
                        </dl>
                        {preview.gate !== null && !preview.gate.admitted && (
                            <ul className="gglab-native-reasons">
                                {preview.gate.reasons.map((reason, index) => (
                                    <li key={`${reason.reason}-${index}`}>
                                        <code className="gglab-panel-code">{reason.reason}</code>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <ButtonGroup role="toolbar" aria-label="Shader Graph Preview actions">
                            <Button
                                variant="ghost"
                                onClick={() => void preview.previewHandshake()}
                                disabled={preview.flow === null || preview.handshakeInFlight}
                            >
                                {preview.handshakeInFlight ? "Proving Preview…" : "Prove Preview compatibility"}
                            </Button>
                            <Button
                                variant="primary"
                                onClick={() => void preview.buildPreview()}
                                disabled={preview.flow === null || preview.buildInFlight || preview.gate?.admitted !== true}
                            >
                                {preview.buildInFlight ? "Building Preview…" : "Build / Update Preview"}
                            </Button>
                            <Button
                                variant="secondary"
                                onClick={() => void preview.launchPreview()}
                                disabled={
                                    preview.flow === null ||
                                    preview.launchInFlight ||
                                    !preview.initialPublicationAvailable ||
                                    preview.runtime.kind === "running" ||
                                    preview.runtime.kind === "stopping"
                                }
                            >
                                {preview.launchInFlight ? "Launching…" : "Launch attached Lab"}
                            </Button>
                            <Button
                                variant="ghost"
                                onClick={() => void preview.stopPreview()}
                                disabled={preview.runtime.kind !== "running" && preview.runtime.kind !== "stopping"}
                            >
                                Stop attached Lab
                            </Button>
                        </ButtonGroup>
                        {preview.notes.length > 0 && <ul className="gglab-native-notes">{renderNativeNotes(preview.notes)}</ul>}
                    </section>
                        </>
                    )}
                    </>
                    ) : (
                        <div className="gglab-side-rail" aria-label="Inspector (collapsed)">
                            <button type="button" className="gglab-rail-btn" onClick={() => setInspectorOpen(true)} title="Expand the inspector">
                                <PanelOpenIcon />
                                <span className="gglab-rail-text">Inspector</span>
                            </button>
                        </div>
                    )}
                </aside>
            </div>
            {closePrompt && (
                <div className="gglab-close-prompt" role="alertdialog" aria-label="Unsaved changes">
                    <div className="gglab-close-prompt-card">
                        <h2 className="gglab-close-prompt-title">Unsaved changes</h2>
                        <p className="gglab-close-prompt-text">The current session has changes that are not saved as a file yet.</p>
                        <ButtonGroup className="flex justify-end">
                            <Button variant="primary" onClick={() => chooseCloseChoice("save")}>
                                Save
                            </Button>
                            <Button variant="secondary" onClick={() => chooseCloseChoice("discard")}>
                                Don't Save
                            </Button>
                            <Button variant="ghost" onClick={() => chooseCloseChoice("cancel")}>
                                Cancel
                            </Button>
                        </ButtonGroup>
                    </div>
                </div>
            )}
            <footer className="gglab-statusbar">
                <div className="gglab-status-group">
                    {/* The document name + the dirty star — the same rule
                        as the window title (sessionTitle), visible in-
                        app too. */}
                    <span className="gglab-status-item mono">
                        {session.provenance.kind === "file" ? basenameOf(session.provenance.path) : "Untitled"}
                        {dirty ? " *" : ""}
                    </span>
                    <span className="gglab-status-item mono">
                        {document.nodes.length} nodes · {document.connections.length} connections · {document.parameters.length} parameters
                    </span>
                    <Badge variant={graphOk ? "ok" : "error"}>
                        <BadgeDot />
                        {graphOk ? "graph ok" : `${graphProblemCount} problem${graphProblemCount === 1 ? "" : "s"}`}
                    </Badge>
                </div>
                <div className="gglab-status-group">
                    <span className="gglab-status-item mono">{descriptor !== null ? `${descriptor.profileId} v${descriptor.profileVersion}` : "profile —"}</span>
                    <span className="gglab-status-item mono">
                        HLSL {emission === null ? "not emitted" : emission.ok === false ? `${emission.diagnostics.length} problem${emission.diagnostics.length === 1 ? "" : "s"}` : emissionIdentity !== undefined ? `✓ ${emissionIdentity}` : "✓ emitted"}
                    </span>
                </div>
            </footer>
        </div>
    );
}

/** The readiness reason list (every non-Ready input's reason, complete
 *  and structured — the inspector's explanation, not a failure). */
function readyReasonList(readiness: NativeBuildReadiness): readonly ReactElement[] | null {
    if (readiness.status === "Ready") {
        return null;
    }
    const reasons = readiness.reasons;
    return reasons.map((reason, index) => {
        const extra =
            reason.reason === "ToolUnproven"
                ? ` [${reason.unprovenDetails.map((d) => d.code).join(", ")}]`
                : reason.reason === "ToolIncompatible"
                  ? ` [${reason.mismatchCodes.join(", ")}]`
                  : "";
        return (
            <li key={`${reason.reason}-${index}`}>
                <code className="gglab-panel-code">{reason.reason}</code> — {reason.detail}
                {extra}
            </li>
        );
    });
}

/** One inspector section: its owner's domain, and each fact row with
 *  its VALUE (as the owner holds it) and the named SOURCE OF TRUTH —
 *  the "one source of truth per field" guarantee, rendered. */
function InspectorRows(props: { title: string; rows: readonly BuildInspectorRow[] }) {
    const { title, rows } = props;
    if (rows.length === 0) {
        return null;
    }
    return (
        <div>
            <h3 className="gglab-panel-title" style={{ marginTop: 10 }}>
                {title}
            </h3>
            <dl className="gglab-facts">
                {rows.map((row, index) => (
                    <div key={`${row.field}-${index}`} className="gglab-fact gglab-native-fact-detail">
                        {/* Two-line fact: name + value share the top line
                            (the value owns the right half and wraps as long
                            as it needs — a full path stays readable); the
                            source of truth sits below, full width, quiet. */}
                        <div className="gglab-native-fact-row">
                            <dt>{row.field}</dt>
                            <dd className="gglab-native-fact-value">{row.value}</dd>
                        </div>
                        <div className="gglab-native-fact-source">
                            source: {row.source}
                        </div>
                    </div>
                ))}
            </dl>
        </div>
    );
}

/** The native-build operation notes (structured one-liners). */
function renderNativeNotes(notes: readonly { readonly level: "ok" | "info" | "refusal"; readonly text: string }[]): readonly ReactElement[] {
    return notes.map((note, index) => (
        <li key={`${note.text}-${index}`} className={`gglab-note-${note.level}`}>
            {note.text}
        </li>
    ));
}

function EmissionPreview(props: { emission: HlslEmission }) {
    const { emission } = props;
    if (emission.ok === false) {
        return (
            <div className="gglab-emission-blocked">
                {emission.diagnostics.map((diagnostic, index) => (
                    <p key={index} className={`gglab-emission-problem gglab-emission-severity-${diagnostic.severity}`}>
                        <span className="gglab-emission-code">{diagnostic.code}</span> {diagnostic.message}
                    </p>
                ))}
            </div>
        );
    }
    const source = emission.source;
    return (
        <div className="gglab-emission-ok">
            <p className="gglab-emission-identity">
                generatedSourceIdentity: <code>{emission.sourceMap?.generatedSourceIdentity ?? "(none)"}</code>
            </p>
            {source !== undefined && <pre className="gglab-emission-source">{source}</pre>}
        </div>
    );
}
