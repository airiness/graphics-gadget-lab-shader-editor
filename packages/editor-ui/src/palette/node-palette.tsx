/**
 * Node palette + parameter authoring. The catalog shown here is the core's
 * node catalog itself (the single node/port/type authority) — there is no
 * UI-side node registry, and no second list of types to keep in sync.
 * Clicking an entry is an intent: the composition root performs the
 * document operation and the core's services judge the result.
 *
 * The parameter choices offered are a convenience subset of the surface
 * profile's parameter class vocabulary. Which classes a loaded descriptor
 * admits is the core's conformance verdict, not this component's opinion.
 */
import { NODE_DEFINITIONS, type NodeCategory } from "@gglab/shader-graph-core";
import type { ParameterRequest } from "../session/authoring-operations.js";

const CATEGORY_ORDER: readonly NodeCategory[] = ["parameter", "constant", "math", "input", "texture", "output"];

interface NodeCategoryGroup {
    readonly category: NodeCategory;
    readonly definitions: readonly { type: string; displayName: string; description: string }[];
}

export function nodeCatalogGroups(): readonly NodeCategoryGroup[] {
    return CATEGORY_ORDER.map((category) => ({
        category,
        definitions: NODE_DEFINITIONS.filter((definition) => definition.category === category).map((definition) => ({
            type: definition.type,
            displayName: definition.displayName,
            description: definition.description,
        })),
    })).filter((group) => group.definitions.length > 0);
}

export interface ParameterChoice {
    readonly class: string;
    readonly label: string;
    readonly valueType: "float" | "float3" | "Texture2D";
}

/** Convenience subset of the surface profile's parameter class vocabulary. */
export const PARAMETER_CHOICES: readonly ParameterChoice[] = [
    { class: "ScalarParameter", label: "Scalar (float)", valueType: "float" },
    { class: "VectorParameter", label: "Vector (float3)", valueType: "float3" },
    { class: "Texture2DParameter", label: "Texture2D", valueType: "Texture2D" },
];

export interface NodePaletteProps {
    readonly onAddNode: (type: string) => void;
    readonly onAddParameter: (request: ParameterRequest) => void;
}

export function NodePalette(props: NodePaletteProps) {
    const groups = nodeCatalogGroups();
    return (
        <nav className="gglab-palette" aria-label="Node palette">
            <section className="gglab-palette-section">
                <h2>Parameters</h2>
                {PARAMETER_CHOICES.map((choice) => (
                    <button
                        key={choice.class}
                        type="button"
                        className="gglab-palette-entry"
                        onClick={() => props.onAddParameter({ name: "New Parameter", class: choice.class, valueType: choice.valueType })}
                    >
                        <span className="gglab-palette-name">{choice.label}</span>
                        <span className="gglab-palette-kind">parameter</span>
                    </button>
                ))}
            </section>
            {groups.map((group) => (
                <section className="gglab-palette-section" key={group.category}>
                    <h2>{group.category}</h2>
                    {group.definitions.map((definition) => (
                        <button key={definition.type} type="button" className="gglab-palette-entry" onClick={() => props.onAddNode(definition.type)} title={definition.description}>
                            <span className="gglab-palette-name">{definition.displayName}</span>
                        </button>
                    ))}
                </section>
            ))}
        </nav>
    );
}
