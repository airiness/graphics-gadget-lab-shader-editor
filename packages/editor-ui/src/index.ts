/**
 * Presentation-layer surface of the GGLab shader graph editor.
 *
 * Every component here renders core-owned facts and forwards raw intents to
 * the composition root; the headless core remains the single
 * node/port/type and semantic authority. React Flow (@xyflow/react) appears
 * only as the canvas projection (flow-viewport), never as the model or the
 * semantics.
 */
export { documentToFlow, authoredPosition, portTop, handleStyle, FLOW_NODE_TYPE, FLOW_LAYOUT } from "./flow/flow-adapter.js";
export type { ShaderNodeData, ShaderFlowNode, CanvasFocus } from "./flow/flow-adapter.js";
export { FlowViewport, ShaderNode, ReactFlowProvider, useSyncedFlowNodes } from "./flow/flow-viewport.js";
export type { ConnectionRequest, FlowViewportProps } from "./flow/flow-viewport.js";
export { NodePalette, nodeCatalogGroups, parameterChoices } from "./palette/node-palette.js";
export type { NodePaletteProps, ParameterChoice } from "./palette/node-palette.js";
export { DiagnosticsPanel } from "./panels/diagnostics-panel.js";
export type { DiagnosticsPanelProps } from "./panels/diagnostics-panel.js";
export { DescriptorPanel, readDescriptorText, textureSignatureSerialized } from "./panels/descriptor-panel.js";
export type { DescriptorPanelState, DescriptorPanelProps } from "./panels/descriptor-panel.js";
export { addNode, removeNode, addConnection, addParameter } from "./session/authoring-operations.js";
export type { AuthoringResult, AuthoringRefusal, ParameterRequest } from "./session/authoring-operations.js";
export { diagnosticFocus } from "./session/diagnostic-focus.js";
