/**
 * Composition root — where the core's semantic services are asked about
 * everything the user can do. The GUI components forward raw intents
 * (add node, connect, place, load, save, emit); this root applies them to
 * the document, re-asks the core's services for the verdicts, and renders
 * the structured diagnostics the core returns. No graph semantics are
 * defined here: validation, port-level types, conformance, compatibility,
 * and emission all come from @gglab/shader-graph-core.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
    addConnection,
    addNode,
    addParameter,
    autoLayout,
    Badge,
    BadgeDot,
    Button,
    DescriptorPanel,
    DiagnosticsPanel,
    diagnosticFocus,
    documentToFlow,
    FlowViewport,
    Input,
    LayoutIcon,
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
import { createDesktopFileChannel, isDesktopHost, type FileChannel } from "./host-io.js";
import { provenanceFromImport, provenanceFromFile, saveTarget, type DocumentProvenance } from "./document-session.js";
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
function basenameOf(path: string): string {
    const parts = path.split(/[\\/]/);
    const last = parts[parts.length - 1];
    return last === undefined || last === "" ? path : last;
}

interface DiagnosticSet {
    readonly title: string;
    readonly ok: boolean;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    readonly passedText: string;
}

export function App() {
    const [document, setDocument] = useState<ShaderGraphDocument>(() => seedDocument());
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
    // Viewport fit trigger (registered by the flow adapter via onInit).
    const fitRef = useRef<(() => void) | null>(null);
    // Desktop slice 1: native document I/O channel (absent in the browser
    // — the web build keeps the text save/load surface only).
    const [fileChannel, setFileChannel] = useState<FileChannel | null>(null);
    // Where the current document came from (file path, or no path at
    // all) — the Save target is derived from THIS, never from leftover
    // state of a previous document.
    const [provenance, setProvenance] = useState<DocumentProvenance>(() => provenanceFromImport());
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
    const replaceDocumentSession = (next: ShaderGraphDocument, source: DocumentProvenance): void => {
        setDocument(next);
        setProvenance(source);
        setFocus(null);
        setEmission(null);
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
    const saveDocument = async (as: boolean): Promise<void> => {
        const channel = fileChannel;
        if (channel === null) {
            return;
        }
        try {
            const text = serializeShaderGraphDocument(document);
            let path = saveTarget(provenance, as);
            if (path === null) {
                const defaultName = provenance.kind === "file" ? basenameOf(provenance.path) : "Untitled.shadergraph";
                path = await channel.pickSavePath(defaultName);
                if (path === null) {
                    return; // user cancelled
                }
            }
            await channel.writeText(path, text);
            setProvenance(provenanceFromFile(path));
            setSavedText(text);
            setOperationNotes((previous) => [...previous, `Saved ${path} as the core's canonical .shadergraph bytes.`]);
        } catch (error) {
            setOperationNotes((previous) => [...previous, `Save failed (${error instanceof Error ? error.message : String(error)}).`]);
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

    const descriptor: SurfaceProfileDescriptor | null = descriptorState.kind === "ready" ? descriptorState.descriptor : null;

    const flow = useMemo(() => documentToFlow(document, focus), [document, focus]);

    const graphSets = useMemo<readonly DiagnosticSet[]>(() => {
        const validation = validateShaderGraph(document);
        const types = resolveGraphTypes(document);
        return [
            { title: "Graph validation", ok: validation.ok, diagnostics: validation.diagnostics, passedText: "No graph validation problems." },
            { title: "Connection types", ok: types.ok, diagnostics: types.diagnostics, passedText: "Every connection carries compatible types." },
        ];
    }, [document]);

    const contractSets = useMemo<readonly DiagnosticSet[]>(() => {
        if (descriptor === null) {
            return [];
        }
        const conformance = checkProfileConformance(document, descriptor);
        const compatibility = checkProfileDescriptorCompatibility(document, descriptor);
        return [
            { title: "Parameter conformance", ok: conformance.ok, diagnostics: conformance.diagnostics, passedText: "Parameters conform to the loaded descriptor." },
            {
                title: "Profile × descriptor compatibility",
                ok: compatibility.ok,
                diagnostics: compatibility.diagnostics,
                passedText: "The document's profile line and this descriptor instance agree on capabilities.",
            },
        ];
    }, [document, descriptor]);

    function applyAuthoring(result: AuthoringResult): void {
        if (result.applied) {
            setDocument(result.document);
            setOperationNotes([]);
            setFocus(null); // the document changed — any highlighted target would be stale
            return;
        }
        const reason = result.refusal !== undefined ? result.refusal.reason : "The operation was not applied.";
        setOperationNotes((previous) => [...previous, reason]);
    }

    function selectDiagnostic(diagnostic: ShaderGraphDiagnostic): void {
        // Navigation intent → target resolved against the document from the
        // diagnostic's own dataPath anchor (never parsed from prose).
        setFocus(diagnosticFocus(document, diagnostic));
    }

    const onAddNode = (type: string): void => {
        applyAuthoring(addNode(document, type));
    };
    const onAddParameter = (request: ParameterRequest): void => {
        applyAuthoring(addParameter(document, request));
    };
    const onConnectRequest = (request: ConnectionRequest): void => {
        applyAuthoring(addConnection(document, request.from, request.to));
    };
    const onNodePlaced = (nodeId: string, position: { x: number; y: number }): void => {
        // Session state (canvas layout): the shared position-patch helper
        // updates ONLY the position, preserving the node's existing
        // editor-state metadata (unknownFields, future presentation fields).
        setDocument((previous) => withNodePosition(previous, nodeId, position));
    };

    const onAutoLayout = (): void => {
        // Session convenience: compute positions for the WHOLE graph and
        // patch them into editorMetadata (session state) one node at a time
        // through the shared helper — never dropping metadata it doesn't
        // own. The core services are re-asked as usual; placement never
        // changes emitted HLSL.
        setDocument((previous) => {
            const layout = autoLayout(previous);
            if (layout.nodeCount === 0) {
                return previous;
            }
            let placed = previous;
            for (const [id, position] of Object.entries(layout.positions)) {
                placed = withNodePosition(placed, id, position);
            }
            return placed;
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
            applyAuthoring(addNode(document, payload.nodeType, { position }));
            return;
        }
        applyAuthoring(
            addParameter(document, { name: "New Parameter", class: payload.parameterClass, valueType: payload.valueType }, { position }),
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
            <div className={`gglab-body${libraryOpen ? "" : " gglab-body-library-collapsed"}`}>
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
                        <Button variant="toolbar" onClick={onAutoLayout} title="Lay the whole graph out (positions are session state)">
                            <LayoutIcon />
                            Auto layout
                        </Button>
                    </div>
                    <FlowViewport
                        nodes={flow.nodes}
                        edges={flow.edges}
                        onConnectRequest={onConnectRequest}
                        onNodePlaced={onNodePlaced}
                        onDropRequest={onDropRequest}
                        onFlowReady={(fitView) => {
                            fitRef.current = fitView;
                        }}
                    />
                </main>
                <aside className="gglab-side gglab-side-right">
                    <DescriptorPanel state={descriptorState} onStateChange={(state) => setDescriptorState(state)} openDescriptorFile={openDescriptorFile} />
                    {graphSets.map((set) => (
                        <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} onSelect={selectDiagnostic} />
                    ))}
                    {contractSets.map((set) => (
                        <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} onSelect={selectDiagnostic} />
                    ))}
                    {loadResult !== null && (
                        <DiagnosticsPanel title={loadResult.title} diagnostics={loadResult.diagnostics} ok={loadResult.ok} passedText={loadResult.passedText} onSelect={selectDiagnostic} />
                    )}
                    {/* Desktop slice 1: native document I/O. The host owns
                        path + UTF-8 bytes only; the core owns parse/
                        serialize; this app owns which text moves where. */}
                    {fileChannel !== null && (
                        <section className="gglab-panel gglab-document-native">
                            <h2 className="gglab-panel-title">Document</h2>
                            <p className="gglab-panel-hint">
                                Native open, save, save-as (the host moves path + UTF-8 bytes; bytes are the core's canonical .shadergraph serialization).
                            </p>
                            <div className="gglab-doc-actions" role="toolbar" aria-label="Document I/O">
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
                            </div>
                            {provenance.kind === "file" && <p className="gglab-panel-hint mono">{provenance.path}</p>}
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
                        <div className="gglab-doc-actions">
                            <Button variant="ghost" onClick={onSave}>
                                Save to text
                            </Button>
                            <Button variant="secondary" onClick={onLoad}>
                                Load from text
                            </Button>
                        </div>
                    </section>
                    <section className="gglab-panel gglab-emission-block">
                        <h2 className="gglab-panel-title">Emission preview</h2>
                        <div className="gglab-emission-actions">
                            <Button variant="secondary" onClick={onEmit}>
                                Generate HLSL (core)
                            </Button>
                        </div>
                        {emission !== null && <EmissionPreview emission={emission} />}
                    </section>
                </aside>
            </div>
            <footer className="gglab-statusbar">
                <div className="gglab-status-group">
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
