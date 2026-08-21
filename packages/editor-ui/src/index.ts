/**
 * Presentation-layer surface of the GGLab shader graph editor.
 *
 * Every component here renders core-owned facts and forwards raw intents to
 * the composition root; the headless core remains the single
 * node/port/type and semantic authority. React Flow appears only as the
 * canvas projection (flow-viewport), never as the model or the semantics.
 */
export { documentToFlow, authoredPosition, FLOW_NODE_TYPE } from "./flow/flow-adapter.js";
export type { ShaderNodeData, ShaderFlowNode } from "./flow/flow-adapter.js";
export { FlowViewport } from "./flow/flow-viewport.js";
export type { ConnectionRequest, FlowViewportProps } from "./flow/flow-viewport.js";
export { NodePalette, nodeCatalogGroups, PARAMETER_CHOICES } from "./palette/node-palette.js";
export type { NodePaletteProps, ParameterChoice } from "./palette/node-palette.js";
export { DiagnosticsPanel } from "./panels/diagnostics-panel.js";
export type { DiagnosticsPanelProps } from "./panels/diagnostics-panel.js";
export { DescriptorPanel, readDescriptorText, textureSignatureSerialized } from "./panels/descriptor-panel.js";
export type { DescriptorPanelState, DescriptorPanelProps } from "./panels/descriptor-panel.js";
export { addNode, removeNode, addConnection, addParameter } from "./session/authoring-operations.js";
export type { AuthoringResult, AuthoringRefusal, ParameterRequest } from "./session/authoring-operations.js";
