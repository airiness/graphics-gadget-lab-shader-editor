/**
 * The canvas — a React Flow (v12, @xyflow/react) presentation/interaction
 * adapter plus the `ShaderNode` design language.
 *
 * ShaderNode: the port is the visual core. Every catalog port renders on
 * its own labeled row at its own handle position; a data-category dot
 * (scalar / vector / texture — the core catalog's own types, mapped to
 * colors) and a category rail (the core's node categories) give the card
 * structure a node editor reads at a glance, without the UI owning any
 * vocabulary. Unknown node types keep their explicit warning state.
 *
 * Canvas chrome (grid, controls, minimap) is pure presentation: it never
 * adds a node, port, or semantic fact.
 */
import { useEffect, useRef } from "react";
import {
    Background,
    BackgroundVariant,
    Controls,
    Handle,
    MiniMap,
    Position,
    ReactFlow,
    ReactFlowProvider,
    useNodesState,
    type Connection,
    type Node,
    type NodeProps,
} from "@xyflow/react";
import { getNodeDefinition } from "@gglab/shader-graph-core";
import "@xyflow/react/dist/style.css";
import type { ShaderFlowNode, ShaderNodeData } from "./flow-adapter.js";
import { FLOW_NODE_TYPE, flowGeometryCssVars, handleStyle } from "./flow-adapter.js";

export { ReactFlowProvider };

type ShaderNodeT = ShaderFlowNode;

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
                {rows.map((row, rowIndex) => (
                    <div className="gglab-port-row" key={row.key}>
                        <span className={`gglab-port gglab-port-in${data.focusedPorts.includes(row.inputId ?? "") ? " gglab-port-focus" : ""}`}>
                            {row.inputId !== undefined && <span className={`gglab-dot gglab-dot-${data.inputPortKinds[rowIndex] ?? "generic"}`} aria-hidden />}
                            {row.inputId ?? ""}
                        </span>
                        <span className={`gglab-port gglab-port-out${data.focusedPorts.includes(row.outputId ?? "") ? " gglab-port-focus" : ""}`}>
                            {row.outputId ?? ""}
                            {row.outputId !== undefined && <span className={`gglab-dot gglab-dot-${data.outputPortKinds[rowIndex] ?? "generic"}`} aria-hidden />}
                        </span>
                    </div>
                ))}
            </div>
            {data.inputPorts.map((portId, index) => (
                <Handle
                    key={`in:${portId}`}
                    id={portId}
                    type="target"
                    position={Position.Left}
                    style={handleStyle("input", index)}
                    className={`gglab-handle-kind-${data.inputPortKinds[index] ?? "generic"}${data.focusedPorts.includes(portId) ? " gglab-handle-focus" : ""}`}
                />
            ))}
            {data.outputPorts.map((portId, index) => (
                <Handle
                    key={`out:${portId}`}
                    id={portId}
                    type="source"
                    position={Position.Right}
                    style={handleStyle("output", index)}
                    className={`gglab-handle-kind-${data.outputPortKinds[index] ?? "generic"}${data.focusedPorts.includes(portId) ? " gglab-handle-focus" : ""}`}
                />
            ))}
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
    return (
        // The geometry custom properties come from the single geometry
        // source (flow-geometry.ts), so the CSS references the same numbers
        // the TS projection uses — no parallel literals to drift.
        <div className="gglab-viewport" style={flowGeometryCssVars()}>
            <ReactFlow<ShaderNodeT>
                nodes={nodes}
                onNodesChange={onNodesChange}
                edges={[...props.edges]}
                nodeTypes={nodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
                onInit={(instance) => props.onFlowReady?.(() => instance.fitView({ duration: 160 }))}
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
            >
                {/* Overlay layout: controls top-right, minimap bottom-right —
                    two fixed corners, no overlap, no margin hacks. The
                    xyflow attribution is hidden (proOptions) per the editor's
                    branding policy; the app's own brand bar stays. */}
                <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#28313f" />
                <Controls showInteractive={false} position="top-right" />
                <MiniMap pannable zoomable nodeColor={minimapNodeColor} maskColor="rgba(15,19,25,0.78)" position="bottom-right" className="gglab-minimap" />
            </ReactFlow>
        </div>
    );
}
