/**
 * The canvas — a React Flow presentation/interaction adapter (architecture
 * boundary: React Flow is not the persisted model and not a semantic
 * authority). It renders the document→flow projection and forwards two raw
 * interaction intents (a connection attempt; a node placement) to the
 * composition root, which asks the core's services before anything is
 * treated as a fact. Nothing here validates a connection or infers a type.
 */
import { Handle, Position, ReactFlow, type Connection, type NodeProps } from "@reactflow/core";
import "@reactflow/core/dist/style.css";
import type { ShaderFlowNode } from "./flow-adapter.js";
import { FLOW_NODE_TYPE } from "./flow-adapter.js";
import type { ShaderNodeData } from "./flow-adapter.js";

interface ShaderNodeProps extends NodeProps<ShaderNodeData> {
    readonly data: ShaderNodeData;
}

/** One graph node: title + a handle per core-catalog port. */
function ShaderNode(props: ShaderNodeProps) {
    return (
        <div className={`gglab-node${props.data.knownToCatalog === false ? " gglab-node-unknown" : ""}`}>
            <div className="gglab-node-title">{props.data.label}</div>
            <div className="gglab-node-type">{props.data.nodeType}</div>
            {props.data.knownToCatalog === false && <div className="gglab-node-flag">unknown to the node catalog</div>}
            {props.data.inputPorts.map((portId) => (
                <Handle key={`in:${portId}`} id={portId} type="target" position={Position.Left} />
            ))}
            {props.data.outputPorts.map((portId) => (
                <Handle key={`out:${portId}`} id={portId} type="source" position={Position.Right} />
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
    readonly edges: readonly import("@reactflow/core").Edge[];
    /** A connection attempt (interaction intent) — the core decides whether it holds. */
    readonly onConnectRequest?: (request: ConnectionRequest) => void;
    /** A node placement (session state) — never a semantic change. */
    readonly onNodePlaced?: (nodeId: string, position: { x: number; y: number }) => void;
}

export function FlowViewport(props: FlowViewportProps) {
    const nodeTypes = { [FLOW_NODE_TYPE]: ShaderNode };
    return (
        <div className="gglab-viewport">
            <ReactFlow
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
