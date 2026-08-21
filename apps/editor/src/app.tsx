/**
 * Composition root — where the core's semantic services are asked about
 * everything the user can do. The GUI components forward raw intents
 * (add node, connect, place, load, save, emit); this root applies them to
 * the document, re-asks the core's services for the verdicts, and renders
 * the structured diagnostics the core returns. No graph semantics are
 * defined here: validation, port-level types, conformance, compatibility,
 * and emission all come from @gglab/shader-graph-core.
 */
import { useMemo, useState } from "react";
import {
    addConnection,
    addNode,
    addParameter,
    DescriptorPanel,
    DiagnosticsPanel,
    documentToFlow,
    FlowViewport,
    NodePalette,
    type AuthoringResult,
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

    const descriptor: SurfaceProfileDescriptor | null = descriptorState.kind === "ready" ? descriptorState.descriptor : null;

    const flow = useMemo(() => documentToFlow(document), [document]);

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
            return;
        }
        const reason = result.refusal !== undefined ? result.refusal.reason : "The operation was not applied.";
        setOperationNotes((previous) => [...previous, reason]);
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

    const onSave = (): void => {
        setSavedText(JSON.stringify(document, null, 2));
        setEmission(null);
    };

    const onLoad = (): void => {
        const parsed = parseShaderGraphDocument(savedText);
        if (parsed.ok && parsed.value !== null) {
            setDocument(parsed.value);
            setLoadResult({ title: "Load result", ok: true, diagnostics: parsed.diagnostics, passedText: "The saved document loaded; the session state was restored." });
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

    return (
        <div className="gglab-app">
            <aside className="gglab-side gglab-side-left">
                <NodePalette onAddNode={onAddNode} onAddParameter={onAddParameter} />
                {operationNotes.length > 0 && (
                    <section className="gglab-notes">
                        <h2>Authoring notes</h2>
                        {operationNotes.map((note, index) => (
                            <p key={index}>{note}</p>
                        ))}
                    </section>
                )}
            </aside>
            <main className="gglab-canvas">
                <FlowViewport nodes={flow.nodes} edges={flow.edges} onConnectRequest={onConnectRequest} onNodePlaced={onNodePlaced} />
            </main>
            <aside className="gglab-side gglab-side-right">
                <DescriptorPanel state={descriptorState} onStateChange={(state) => setDescriptorState(state)} />
                {graphSets.map((set) => (
                    <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} />
                ))}
                {contractSets.map((set) => (
                    <DiagnosticsPanel key={set.title} title={set.title} diagnostics={set.diagnostics} ok={set.ok} passedText={set.passedText} />
                ))}
                {loadResult !== null && (
                    <DiagnosticsPanel title={loadResult.title} diagnostics={loadResult.diagnostics} ok={loadResult.ok} passedText={loadResult.passedText} />
                )}
                <section className="gglab-document-io">
                    <h2>Document save / load</h2>
                    <textarea className="gglab-document-text" value={savedText} onChange={(event) => setSavedText(event.currentTarget.value)} rows={12} spellCheck={false} />
                    <div className="gglab-document-buttons">
                        <button type="button" onClick={onSave}>
                            Save to text
                        </button>
                        <button type="button" onClick={onLoad}>
                            Load from text
                        </button>
                    </div>
                </section>
                <section className="gglab-emission">
                    <h2>Emission preview</h2>
                    <button type="button" onClick={onEmit}>
                        Generate HLSL (core)
                    </button>
                    {emission !== null && <EmissionPreview emission={emission} />}
                </section>
            </aside>
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
