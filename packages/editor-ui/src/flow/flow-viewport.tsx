/**
 * The canvas — a React Flow (v12, @xyflow/react) presentation/interaction
 * adapter plus the `ShaderNode` design language.
 *
 * ShaderNode: the port is the visual core. Every catalog port renders on
 * its own labeled row, and the React Flow Handle on the card edge is the
 * port's SOLE socket glyph, carrying the data-category color (scalar /
 * vector / texture — the core catalog's own types, mapped to colors) and
 * the focus state. The category rail (the core's node categories) gives
 * the card structure a node editor reads at a glance, without the UI
 * owning any vocabulary. Unknown node types keep their explicit warning
 * state. Port labels share the row center line with their Handle
 * (`FLOW_GEOMETRY` — one geometry, no second dot to misalign).
 *
 * Canvas chrome (grid, controls, minimap) is pure presentation: it never
 * adds a node, port, or semantic fact.
 */
import { createContext, useContext, useEffect, useRef, type DragEvent } from "react";
import {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MiniMap,
    Position,
    ReactFlow,
    ReactFlowProvider,
    useEdges,
    useNodesState,
    type Connection,
    type Node,
    type NodeProps,
} from "@xyflow/react";
import { getNodeDefinition } from "@gglab/shader-graph-core";
import "@xyflow/react/dist/style.css";
import type { ShaderFlowNode, ShaderNodeData } from "./flow-adapter.js";
import { FLOW_NODE_TYPE, flowGeometryCssVars, handleStyle } from "./flow-adapter.js";
import { AUTHORING_DROP_MIME, decodeAuthoringDrop, resolveDropCoordinate, type AuthoringDropPayload } from "../session/authoring-operations.js";

export { ReactFlowProvider };

type ShaderNodeT = ShaderFlowNode;

/**
 * A port activation — the raw gesture fact (which node/port, which side,
 * was Alt held). Delivered to the composition root as data; the root
 * gives it meaning (Alt = disconnect at port; a plain click means
 * something only while a reconnect is armed). The callback rides a
 * context instead of node `data`: the projection stays pure.
 */
export type PortActivation = {
    readonly nodeId: string;
    readonly portId: string;
    readonly isInput: boolean;
    readonly altKey: boolean;
};

const PortGestureContext = createContext<((activation: PortActivation) => void) | null>(null);

function portRows(inputPorts: readonly string[], outputPorts: readonly string[]): { key: string; inputId: string | undefined; outputId: string | undefined }[] {
    const rows = Math.max(inputPorts.length, outputPorts.length, 1);
    const result: { key: string; inputId: string | undefined; outputId: string | undefined }[] = [];
    for (let index = 0; index < rows; index += 1) {
        const inputId = inputPorts[index];
        const outputId = outputPorts[index];
        result.push({ key: `${inputId ?? "-"}|${outputId ?? "-"}`, inputId, outputId });
    }
    return result;
}

/** One graph node, in the ShaderNode design language. */
export function ShaderNode(props: NodeProps<ShaderNodeT>) {
    const data: ShaderNodeData = props.data;
    const rows = portRows(data.inputPorts, data.outputPorts);
    // Connection STATE is presentation (hollow ring vs solid socket); the
    // Handles themselves — count, ids, types, positions — never change.
    const edges = useEdges();
    const connected = (side: "input" | "output", portId: string): boolean =>
        edges.some((edge) =>
            side === "output" ? edge.source === props.id && edge.sourceHandle === portId : edge.target === props.id && edge.targetHandle === portId,
        );
    const socketClass = (side: "input" | "output", portId: string): string => (connected(side, portId) ? " gglab-handle-connected" : "");
    // Port activation (Alt+click disconnect, reconnect-target click) —
    // reported as raw data; the app owns the interpretation. Absent
    // (null) means the port is a pure socket, which stays the default.
    const activatePort = useContext(PortGestureContext);
    const portClick = (portId: string, isInput: boolean) =>
        activatePort !== null
            ? (event: { readonly altKey: boolean }) => activatePort({ nodeId: props.id, portId, isInput, altKey: event.altKey })
            : undefined;
    return (
        <div className={`gglab-node gglab-node-cat-${data.nodeCategory ?? "unknown"}${data.knownToCatalog === false ? " gglab-node-unknown" : ""}${data.focused ? " gglab-node-focus" : ""}`}>
            <div className="gglab-node-header">
                <div className="gglab-node-title">{data.label}</div>
                <div className="gglab-node-meta">
                    <span className="gglab-node-type">{data.nodeType}</span>
                    <span className="gglab-node-category">{data.nodeCategory ?? "unknown"}</span>
                </div>
                {data.knownToCatalog === false && <div className="gglab-node-flag">unknown to the node catalog — preserved, not replaced</div>}
            </div>
            <div className="gglab-node-rows">
                {/* Unity-style integrated ports: each PortRow IS one
                    visual port — the real React Flow Handle (the sole
                    socket glyph, carrying the data-category color and the
                    focus state) and the semantic label share the row.
                    The row cell is the Handle's positioning context:
                    row center = socket center = edge anchor. */}
                {rows.map((row, index) => {
                    // The type is ON-DEMAND info (Unreal-style): named + typed
                    // in the hover tooltip, never a permanent second text
                    // column — the card width belongs to the names.
                    const typeTitle = (name: string | undefined, type: string | undefined): string | undefined =>
                        name !== undefined && type !== undefined ? `${name} — ${type}` : undefined;
                    return (
                        <div className="gglab-port-row" key={row.key}>
                            <span
                                className={`gglab-port gglab-port-in${data.focusedPorts.includes(row.inputId ?? "") ? " gglab-port-focus" : ""}`}
                                title={typeTitle(row.inputId, data.inputPortTypes[index])}
                            >
                                {row.inputId !== undefined && (
                                    <Handle
                                        id={row.inputId}
                                        type="target"
                                        position={Position.Left}
                                        style={handleStyle("input")}
                                        onClick={portClick(row.inputId, true)}
                                        className={`gglab-handle-kind-${data.inputPortKinds[index] ?? "generic"}${socketClass("input", row.inputId)}${data.focusedPorts.includes(row.inputId) ? " gglab-handle-focus" : ""}`}
                                    />
                                )}
                                <span className="gglab-port-name">{row.inputId ?? ""}</span>
                            </span>
                            <span
                                className={`gglab-port gglab-port-out${data.focusedPorts.includes(row.outputId ?? "") ? " gglab-port-focus" : ""}`}
                                title={typeTitle(row.outputId, data.outputPortTypes[index])}
                            >
                                <span className="gglab-port-name">{row.outputId ?? ""}</span>
                                {row.outputId !== undefined && (
                                    <Handle
                                        id={row.outputId}
                                        type="source"
                                        position={Position.Right}
                                        style={handleStyle("output")}
                                        onClick={portClick(row.outputId, false)}
                                        className={`gglab-handle-kind-${data.outputPortKinds[index] ?? "generic"}${socketClass("output", row.outputId)}${data.focusedPorts.includes(row.outputId) ? " gglab-handle-focus" : ""}`}
                                    />
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export interface ConnectionRequest {
    readonly from: { readonly nodeId: string; readonly portId: string };
    readonly to: { readonly nodeId: string; readonly portId: string };
}

export interface FlowViewportProps {
    readonly nodes: readonly ShaderFlowNode[];
    readonly edges: readonly import("@xyflow/react").Edge[];
    /** A connection attempt (interaction intent) — the core decides whether it holds. */
    readonly onConnectRequest?: (request: ConnectionRequest) => void;
    /** A node placement (session state) — never a semantic change. */
    readonly onNodePlaced?: (nodeId: string, position: { x: number; y: number }) => void;
    /**
     * Called once with a `fitView` trigger when the viewport finishes
     * initializing — the composition root uses it for "auto layout" and
     * "load" (session convenience, no semantics).
     */
    readonly onFlowReady?: (fitView: () => void) => void;
    /**
     * A palette → canvas drop (authoring intent at a coordinate).
     * React Flow contributes the screen→flow coordinate
     * (`instance.screenToFlowPosition`) and nothing else: the payload was
     * shaped by the palette from core/catalog/descriptor facts, and the
     * creation itself is the core-judged authoring operation.
     */
    readonly onDropRequest?: (payload: AuthoringDropPayload, position: { x: number; y: number }) => void;
    /**
     * Connection selection is the SESSION's state: the viewport only
     * reports the raw gesture (edge click, pane click, edge right-click)
     * with the edge id. The app decides what it means; React Flow never
     * owns selection, and it is never the deletion authority.
     */
    readonly onEdgeSelect?: (connectionId: string) => void;
    readonly onCanvasClick?: () => void;
    readonly onEdgeContextMenu?: (event: { readonly clientX: number; readonly clientY: number }, connectionId: string) => void;
    /**
     * Advanced gesture, raw facts only: Ctrl(+Meta) + click on an edge
     * arms the RECONNECT of that specific connection; a plain port
     * activation reports node/port/side/Alt. The app owns both meanings;
     * nothing here mutates a document.
     */
    readonly onEdgeReconnectArm?: (connectionId: string) => void;
    readonly onPortActivate?: (activation: PortActivation) => void;
}

/**
 * The viewport's transient node state — the owned half of the control
 * loop. The projection (document + focus) is the source of truth; local
 * nodes follow it, and they also follow the mouse: React Flow's position
 * changes are consumed here in real time (no teleport on release), while
 * the document is only written once, on drag stop, as session state.
 * Transient state (positions mid-drag, selection) never leaves this
 * component; a new projection replaces it.
 */
export function useSyncedFlowNodes(sourceNodes: readonly ShaderFlowNode[]) {
    const [nodes, setNodes, onNodesChange] = useNodesState<ShaderNodeT>([...sourceNodes]);
    const syncedFrom = useRef(sourceNodes);
    useEffect(() => {
        if (syncedFrom.current !== sourceNodes) {
            syncedFrom.current = sourceNodes;
            setNodes([...sourceNodes]);
        }
    }, [sourceNodes, setNodes]);
    return { nodes, onNodesChange };
}

function minimapNodeColor(node: Node): string {
    const nodeType = typeof node.data?.nodeType === "string" ? node.data.nodeType : "";
    const definition = getNodeDefinition(nodeType);
    if (definition !== undefined) {
        switch (definition.category) {
            case "constant":
                return "#d9a85f";
            case "parameter":
                return "#cf8a6a";
            case "math":
                return "#6fbfa8";
            case "input":
                return "#7fa7d9";
            case "texture":
                return "#a58fd9";
            case "output":
                return "#d98fa5";
        }
    }
    return "#67748a";
}

export function FlowViewport(props: FlowViewportProps) {
    const nodeTypes = { [FLOW_NODE_TYPE]: ShaderNode };
    const { nodes, onNodesChange } = useSyncedFlowNodes(props.nodes);
    // The flow instance (for screen→flow coordinate conversion on drop).
    const flowInstanceRef = useRef<import("@xyflow/react").ReactFlowInstance<ShaderNodeT> | null>(null);

    const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
        // Only accept when an authoring payload is being dragged.
        if (event.dataTransfer.types.includes(AUTHORING_DROP_MIME) === false) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
        const raw = event.dataTransfer.getData(AUTHORING_DROP_MIME);
        if (raw === "") {
            return;
        }
        event.preventDefault();
        const payload = decodeAuthoringDrop(raw);
        if (payload === null) {
            return;
        }
        // React Flow owns the coordinate system (screen point → flow point).
        // If the instance is not ready there is NO coordinate — and a drop
        // without a coordinate is a no-op, never a silent creation at (0,0).
        const position = resolveDropCoordinate(flowInstanceRef.current, { x: event.clientX, y: event.clientY });
        if (position === null) {
            return;
        }
        props.onDropRequest?.(payload, position);
    };

    return (
        // The geometry custom properties come from the single geometry
        // source (flow-geometry.ts), so the CSS references the same numbers
        // the TS projection uses — no parallel literals to drift.
        <div className="gglab-viewport" style={flowGeometryCssVars()}>
            <PortGestureContext.Provider value={props.onPortActivate ?? null}>
            <ReactFlow<ShaderNodeT>
                nodes={nodes}
                onNodesChange={onNodesChange}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                edges={[...props.edges]}
                nodeTypes={nodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
                onInit={(instance) => {
                    flowInstanceRef.current = instance;
                    props.onFlowReady?.(() => instance.fitView({ duration: 160 }));
                }}
                defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
                minZoom={0.2}
                maxZoom={2.5}
                onConnect={(connection: Connection) => {
                    const sourceHandle = connection.sourceHandle;
                    const targetHandle = connection.targetHandle;
                    if (typeof connection.source !== "string" || typeof connection.target !== "string") {
                        return;
                    }
                    if (sourceHandle === undefined || sourceHandle === null || targetHandle === undefined || targetHandle === null) {
                        return;
                    }
                    props.onConnectRequest?.({
                        from: { nodeId: connection.source, portId: sourceHandle },
                        to: { nodeId: connection.target, portId: targetHandle },
                    });
                }}
                onNodeDragStop={(_event, node) => {
                    const x = node.position?.x;
                    const y = node.position?.y;
                    if (typeof x === "number" && typeof y === "number") {
                        props.onNodePlaced?.(node.id, { x, y });
                    }
                }}
                selectionOnDrag={false}
                // Delete/Backspace is the APP's shortcut (with the text-field
                // guard) calling the core's removeConnection — React Flow's
                // built-in key-delete must stay OFF: it would bypass the
                // session state and the core-owned removal.
                deleteKeyCode={null}
                onEdgeClick={(event, edge) => {
                    // Ctrl(+Meta) + click is the ADVANCED gesture: arm the
                    // reconnect of this connection (the app owns what
                    // "armed" means — click a port to move one endpoint;
                    // Esc / blank cancels with the original untouched).
                    if (event.ctrlKey || event.metaKey) {
                        props.onEdgeReconnectArm?.(edge.id);
                        return;
                    }
                    props.onEdgeSelect?.(edge.id);
                }}
                onEdgeContextMenu={(event, edge) => {
                    event.preventDefault();
                    props.onEdgeContextMenu?.(event, edge.id);
                }}
                onPaneClick={() => {
                    props.onCanvasClick?.();
                }}
            >
                {/* Overlay layout: controls top-right, minimap bottom-right —
                    two fixed corners, no overlap, no margin hacks. The
                    xyflow attribution is hidden (proOptions) per the editor's
                    branding policy; the app's own brand bar stays. */}
                <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#28313f" />
                <Controls showInteractive={false} position="top-right" />
                <MiniMap pannable zoomable nodeColor={minimapNodeColor} maskColor="rgba(15,19,25,0.78)" position="bottom-right" className="gglab-minimap" />
            </ReactFlow>
            </PortGestureContext.Provider>
        </div>
    );
}
