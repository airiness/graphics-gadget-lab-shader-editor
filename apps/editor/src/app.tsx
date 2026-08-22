/**
 * Composition root — where the core's semantic services are asked about
 * everything the user can do. The GUI components forward raw intents
 * (add node, connect, place, load, save, emit); this root applies them to
 * the document, re-asks the core's services for the verdicts, and renders
 * the structured diagnostics the core returns. No graph semantics are
 * defined here: validation, port-level types, conformance, compatibility,
 * and emission all come from @gglab/shader-graph-core.
 */
import { useMemo, useRef, useState } from "react";
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
    NodePalette,
    type AuthoringResult,
    type CanvasFocus,
    type ConnectionRequest,
    type DescriptorPanelState,
    type ParameterRequest,
} from "@gglab/editor-ui";
import {
    checkProfileConformance,
    checkProfileDescriptorCompatibility,
    emitHlsl,
    parseShaderGraphDocument,
    resolveGraphTypes,
    validateShaderGraph,
    type HlslEmission,
    type ShaderGraphDocument,
    type ShaderGraphDiagnostic,
    type SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";
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
        // Session state (canvas layout): recorded, never a semantic change.
        setDocument((previous) => ({
            ...previous,
            editorMetadata: { ...previous.editorMetadata, nodes: { ...previous.editorMetadata.nodes, [nodeId]: { position, unknownFields: {} } } },
        }));
    };

    const onAutoLayout = (): void => {
        // Session convenience: compute positions for the WHOLE graph and
        // write them into editorMetadata (session state). The core services
        // are re-asked as usual; placement never changes emitted HLSL.
        setDocument((previous) => {
            const layout = autoLayout(previous);
            if (layout.nodeCount === 0) {
                return previous;
            }
            const nodes = { ...previous.editorMetadata.nodes };
            for (const [id, position] of Object.entries(layout.positions)) {
                nodes[id] = { position, unknownFields: {} };
            }
            return { ...previous, editorMetadata: { ...previous.editorMetadata, nodes } };
        });
        // Fit once the projection has picked up the new positions.
        requestAnimationFrame(() => fitRef.current?.());
    };

    const onSave = (): void => {
        setSavedText(JSON.stringify(document, null, 2));
        setEmission(null);
    };

    const onLoad = (): void => {
        const parsed = parseShaderGraphDocument(savedText);
        if (parsed.ok && parsed.value !== null) {
            setDocument(parsed.value);
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
                    <div className="gglab-canvas-actions">
                        <Button variant="outline" size="sm" onClick={onAutoLayout}>
                            Auto layout
                        </Button>
                    </div>
                    <FlowViewport
                        nodes={flow.nodes}
                        edges={flow.edges}
                        onConnectRequest={onConnectRequest}
                        onNodePlaced={onNodePlaced}
                        onFlowReady={(fitView) => {
                            fitRef.current = fitView;
                        }}
                    />
                </main>
                <aside className="gglab-side gglab-side-right">
                    <DescriptorPanel state={descriptorState} onStateChange={(state) => setDescriptorState(state)} />
                    {graphSets.map((set) => (
                        <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} onSelect={selectDiagnostic} />
                    ))}
                    {contractSets.map((set) => (
                        <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} onSelect={selectDiagnostic} />
                    ))}
                    {loadResult !== null && (
                        <DiagnosticsPanel title={loadResult.title} diagnostics={loadResult.diagnostics} ok={loadResult.ok} passedText={loadResult.passedText} onSelect={selectDiagnostic} />
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
                            <Button variant="outline" onClick={onSave}>
                                Save to text
                            </Button>
                            <Button variant="primary" onClick={onLoad}>
                                Load from text
                            </Button>
                        </div>
                    </section>
                    <section className="gglab-panel gglab-emission-block">
                        <h2 className="gglab-panel-title">Emission preview</h2>
                        <div className="gglab-emission-actions">
                            <Button variant="outline" onClick={onEmit}>
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
