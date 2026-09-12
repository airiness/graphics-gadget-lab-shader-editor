import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { getNodeDefinition, type GraphNode, type GraphType, type JsonValue } from "@gglab/shader-graph-core";
import type { ConstantValue } from "../session/authoring-operations.js";
import { Input } from "../components/ui/input.js";

import { CONSTANT_COMPONENT_LABELS, inlineConstantHeight } from "./constant-value-presentation.js";

export interface NodePropertiesPanelProps {
    readonly node: GraphNode | null;
    /** The composition root applies the core-judged authoring operation and
     * reports whether it was accepted. This component owns draft text only. */
    readonly onConstantValueCommit: (nodeId: string, value: ConstantValue) => boolean;
}

function draftFor(value: JsonValue | undefined, componentCount: number): string[] {
    if (componentCount === 1) {
        return [typeof value === "number" && Number.isFinite(value) ? String(value) : ""];
    }
    if (Array.isArray(value) && value.length === componentCount) {
        return value.map((component) =>
            typeof component === "number" && Number.isFinite(component) ? String(component) : "",
        );
    }
    return Array.from({ length: componentCount }, () => "");
}

interface ConstantValueEditorProps {
    readonly node: GraphNode;
    readonly valueType: GraphType;
    readonly componentLabels: readonly string[];
    readonly onCommit: NodePropertiesPanelProps["onConstantValueCommit"];
    readonly compact?: boolean;
}

function ConstantValueEditor(props: ConstantValueEditorProps) {
    const value = props.node.properties["value"];
    const valueIdentity = JSON.stringify(value);
    const initialDraft = useMemo(
        () => draftFor(value, props.componentLabels.length),
        [valueIdentity, props.componentLabels.length],
    );
    const [draft, setDraft] = useState(initialDraft);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setDraft(initialDraft);
        setError(null);
    }, [initialDraft, props.node.id]);

    const reset = (): void => {
        setDraft(initialDraft);
        setError(null);
    };

    const commit = (): void => {
        if (draft.every((component, index) => component === initialDraft[index])) return;
        const parsed = draft.map((component) =>
            component.trim() === "" ? Number.NaN : Number(component),
        );
        if (parsed.some((component) => !Number.isFinite(component))) {
            setError("Every component must be a finite number.");
            return;
        }
        const submitted: ConstantValue = parsed.length === 1 ? (parsed[0] as number) : parsed;
        if (!props.onCommit(props.node.id, submitted)) {
            setError("The graph did not accept this value.");
            return;
        }
        setError(null);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            commit();
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            reset();
        }
    };

    return (
        <div className={props.compact ? "gglab-node-property-editor gglab-node-inline nodrag nopan nowheel" : "gglab-node-property-editor"}
            style={props.compact ? { height: inlineConstantHeight(props.node.type) } : undefined}
            onPointerDown={props.compact ? event => event.stopPropagation() : undefined}
            onClick={props.compact ? event => event.stopPropagation() : undefined}
            onDoubleClick={props.compact ? event => event.stopPropagation() : undefined}>
            <div className="gglab-node-property-grid">
                {props.componentLabels.map((label, index) => (
                    <label className="gglab-node-property-field" key={label}>
                        <span className="gglab-node-property-label">{label}</span>
                        <Input
                            className="gglab-node-property-input"
                            aria-label={label}
                            inputMode="decimal"
                            value={draft[index] ?? ""}
                            onChange={(event) => {
                                const next = [...draft];
                                next[index] = event.currentTarget.value;
                                setDraft(next);
                                setError(null);
                            }}
                            onBlur={commit}
                            onKeyDown={onKeyDown}
                        />
                    </label>
                ))}
            </div>
            {!props.compact && <p className="gglab-node-property-hint">
                {props.valueType} constant · Enter or leave the field to commit · Esc restores the current value
            </p>}
            {error !== null && (
                <p className="gglab-node-property-error" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}

export function NodePropertiesPanel(props: NodePropertiesPanelProps) {
    if (props.node === null) {
        return (
            <section className="gglab-panel gglab-node-properties" aria-label="Node properties">
                <h2 className="gglab-panel-title">Selection</h2>
                <p className="gglab-panel-hint">Select a node on the canvas to inspect its authoring properties.</p>
            </section>
        );
    }

    const definition = getNodeDefinition(props.node.type);
    const valueProperty = definition?.category === "constant"
        ? definition.properties.find((property) => property.name === "value")
        : undefined;
    const componentLabels = valueProperty !== undefined
        ? CONSTANT_COMPONENT_LABELS[valueProperty.type]
        : undefined;
    const parameterId = props.node.properties["parameterId"];

    return (
        <section className="gglab-panel gglab-node-properties" aria-label="Node properties">
            <h2 className="gglab-panel-title">Node Properties</h2>
            <div className="gglab-node-properties-heading">
                <strong>{props.node.label ?? props.node.type}</strong>
                <span className="mono">{props.node.id}</span>
            </div>
            <dl className="gglab-facts">
                <div className="gglab-fact">
                    <dt>Type</dt>
                    <dd className="mono">{props.node.type}</dd>
                </div>
                <div className="gglab-fact">
                    <dt>Category</dt>
                    <dd>{definition?.category ?? "unknown"}</dd>
                </div>
                <div className="gglab-fact">
                    <dt>Version</dt>
                    <dd>{props.node.version}</dd>
                </div>
            </dl>
            {valueProperty !== undefined && componentLabels !== undefined ? (
                <ConstantValueEditor
                    node={props.node}
                    valueType={valueProperty.type}
                    componentLabels={componentLabels}
                    onCommit={props.onConstantValueCommit}
                />
            ) : typeof parameterId === "string" ? (
                <div className="gglab-node-property-readonly">
                    <span>Parameter binding</span>
                    <code>{parameterId}</code>
                    <p>Parameter values are Runtime-owned inputs; they are not stored as graph properties.</p>
                </div>
            ) : (
                <p className="gglab-node-property-empty">This node has no editable authoring properties.</p>
            )}
        </section>
    );
}

/** A compact projection of the same constant draft editor used by the Inspector. */
export function InlineConstantEditor(props: { readonly node: GraphNode; readonly onCommit: NodePropertiesPanelProps["onConstantValueCommit"] }) {
    const definition = getNodeDefinition(props.node.type);
    const property = definition?.category === "constant" ? definition.properties.find(p => p.name === "value") : undefined;
    const labels = property === undefined ? undefined : CONSTANT_COMPONENT_LABELS[property.type];
    if (property === undefined || labels === undefined) return null;
    return <ConstantValueEditor node={props.node} valueType={property.type} componentLabels={labels} onCommit={props.onCommit} compact />;
}
