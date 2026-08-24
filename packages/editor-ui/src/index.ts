/**
 * Presentation-layer surface of the GGLab shader graph editor.
 *
 * Every component here renders core-owned facts and forwards raw intents to
 * the composition root; the headless core remains the single
 * node/port/type and semantic authority. React Flow (@xyflow/react) appears
 * only as the canvas projection (flow-viewport), never as the model or the
 * semantics.
 */
export {
    documentToFlow,
    authoredPosition,
    portTop,
    handleStyle,
    portKind,
    FLOW_NODE_TYPE,
    FLOW_LAYOUT,
    FLOW_GEOMETRY,
    EDGE_HIT_WIDTH,
    portCenterY,
    portRowCount,
    portRowTop,
    handleTop,
    nodeCardHeight,
    flowGeometryCssVars,
} from "./flow/flow-adapter.js";
export type { ShaderNodeData, ShaderFlowNode, CanvasFocus, PortKind, FlowGeometry } from "./flow/flow-adapter.js";
export { FlowViewport, ShaderNode, ReactFlowProvider, useSyncedFlowNodes } from "./flow/flow-viewport.js";
export type { ConnectionRequest, FlowViewportProps, PortActivation } from "./flow/flow-viewport.js";
export { NodePalette, nodeCatalogGroups, parameterChoices, libraryMatchesQuery } from "./palette/node-palette.js";
export type { NodePaletteProps, ParameterChoice } from "./palette/node-palette.js";
export { DiagnosticsPanel } from "./panels/diagnostics-panel.js";
export type { DiagnosticsPanelProps } from "./panels/diagnostics-panel.js";
export { DescriptorPanel, readDescriptorText, textureSignatureSerialized } from "./panels/descriptor-panel.js";
export type { DescriptorPanelState, DescriptorPanelProps } from "./panels/descriptor-panel.js";
export {
    addNode,
    removeNode,
    addConnection,
    removeConnection,
    removeConnectionsAtPort,
    reconnectConnection,
    addParameter,
    AUTHORING_DROP_MIME,
    encodeAuthoringDrop,
    decodeAuthoringDrop,
    resolveDropCoordinate,
} from "./session/authoring-operations.js";
export type { AuthoringResult, AuthoringRefusal, ParameterRequest, AuthoringDropPayload } from "./session/authoring-operations.js";
export { withNodePosition } from "./session/node-position.js";
export { isEditingTextTarget } from "./session/keyboard-guard.js";
export { createHistory, recordHistory, undoHistory, redoHistory, canUndoHistory, canRedoHistory, HISTORY_LIMIT } from "./session/history.js";
export type { DocumentHistory, HistoryEntry } from "./session/history.js";
export { LayoutIcon, FileIcon, PanelCloseIcon, PanelOpenIcon, UndoIcon, RedoIcon, TrashIcon } from "./components/icons.js";
export { diagnosticFocus } from "./session/diagnostic-focus.js";
export { autoLayout } from "./session/auto-layout.js";
export type { AutoLayoutResult } from "./session/auto-layout.js";
export { cn } from "./components/ui/cn.js";
export { Button, buttonVariants } from "./components/ui/button.js";
export type { ButtonProps } from "./components/ui/button.js";
export { ButtonGroup } from "./components/ui/button-group.js";
export { Badge, BadgeDot, badgeVariants } from "./components/ui/badge.js";
export type { BadgeProps } from "./components/ui/badge.js";
export { Input } from "./components/ui/input.js";
export { Collapsible, CollapsibleTrigger, CollapsibleContent, CollapsibleSection } from "./components/ui/collapsible.js";
export { Separator } from "./components/ui/separator.js";
