/**
 * The canvas — a React Flow (v12, @xyflow/react) presentation/interaction
 * adapter. It renders the document→flow projection and forwards two raw
 * interaction intents (a connection attempt; a node placement) to the
 * composition root, which asks the core's services before anything is
 * treated as a fact. Nothing here validates a connection or infers a type.
 *
 * Port layout is the UI's only layout job: one row per port (a shader
 * graph's true UI unit), each handle dot pinned to its row by the same
 * constants the adapter exposes — six channel outputs are six distinct,
 * individually grabbable points, each labeled by its catalog name.
 */
import { Handle, Position, ReactFlow, ReactFlowProvider, type Connection, type NodeProps } from "@xyflow/react";

/** Re-exported so consumers can wrap standalone custom nodes that use Handle. */
export { ReactFlowProvider };
import "@xyflow/react/dist/style.css";
import type { ShaderFlowNode, ShaderNodeData } from "./flow-adapter.js";
import { FLOW_NODE_TYPE, handleStyle } from "./flow-adapter.js";

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

/** One graph node: header + one row per port + one Handle per port. */
export function ShaderNode(props: NodeProps<ShaderNodeT>) {
    const data: ShaderNodeData = props.data;
    const rows = portRows(data.inputPorts, data.outputPorts);
    return (
        <div className={`gglab-node${data.knownToCatalog === false ? " gglab-node-unknown" : ""}${data.focused ? " gglab-node-focus" : ""}`}>
            <div className="gglab-node-header">
                <div className="gglab-node-title">{data.label}</div>
                <div className="gglab-node-type">{data.nodeType}</div>
                {data.knownToCatalog === false && <div className="gglab-node-flag">unknown to the node catalog — preserved, not replaced</div>}
            </div>
            <div className="gglab-node-rows">
                {rows.map((row) => (
                    <div className="gglab-port-row" key={row.key}>
                        <span className={`gglab-port gglab-port-in${data.focusedPorts.includes(row.inputId ?? "") ? " gglab-port-focus" : ""}`}>{row.inputId ?? ""}</span>
                        <span className={`gglab-port gglab-port-out${data.focusedPorts.includes(row.outputId ?? "") ? " gglab-port-focus" : ""}`}>{row.outputId ?? ""}</span>
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
                    className={data.focusedPorts.includes(portId) ? "gglab-handle-focus" : undefined}
                />
            ))}
            {data.outputPorts.map((portId, index) => (
                <Handle
                    key={`out:${portId}`}
                    id={portId}
                    type="source"
                    position={Position.Right}
                    style={handleStyle("output", index)}
                    className={data.focusedPorts.includes(portId) ? "gglab-handle-focus" : undefined}
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
}

export function FlowViewport(props: FlowViewportProps) {
    const nodeTypes = { [FLOW_NODE_TYPE]: ShaderNode };
    return (
        <div className="gglab-viewport">
            <ReactFlow<ShaderNodeT>
                nodes={[...props.nodes]}
                edges={[...props.edges]}
                nodeTypes={nodeTypes}
                fitView
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
            />
        </div>
    );
}
