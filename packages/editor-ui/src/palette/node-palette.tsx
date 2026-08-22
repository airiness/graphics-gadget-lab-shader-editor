/**
 * Node palette + parameter authoring. Two vocabularies, two authorities —
 * the UI projects both, it owns neither:
 *
 *   - Node vocabulary   ← the core's node catalog (the single
 *     node/port/type authority). There is no UI-side node registry.
 *   - Profile vocabulary ← the loaded descriptor instance:
 *     `parameterClasses` (class → allowed value types) and `deferred`
 *     (named, shown as explicitly deferred, never offered for authoring).
 *     Without a loaded descriptor there is no parameter vocabulary to show
 *     — the section says so instead of inventing one.
 *
 * Clicking an entry is an intent: the composition root performs the
 * document operation (atomically) and the core's services judge the
 * result; structured diagnostics are what the user sees.
 */
import { NODE_DEFINITIONS, type GraphType, type NodeCategory, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
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
    readonly valueTypes: readonly string[];
    /** True for classes the descriptor lists in its deferred set: shown, never authorable. */
    readonly deferred: boolean;
}

/**
 * The parameter authoring choices, projected from the descriptor instance
 * (profile vocabulary is descriptor-owned). Without a descriptor: empty —
 * the palette shows why, instead of a second vocabulary of its own.
 */
export function parameterChoices(descriptor: SurfaceProfileDescriptor | null): readonly ParameterChoice[] {
    if (descriptor === null) {
        return [];
    }
    const active: ParameterChoice[] = [];
    const deferred: ParameterChoice[] = [];
    const deferredNames = new Set(descriptor.deferred.parameterClasses);
    for (const entry of descriptor.parameterClasses) {
        if (deferredNames.has(entry.class)) {
            continue;
        }
        const valueTypes = entry.valueTypes !== undefined ? [...entry.valueTypes] : entry.valueType !== undefined ? [entry.valueType] : [];
        active.push({ class: entry.class, valueTypes, deferred: false });
    }
    for (const name of descriptor.deferred.parameterClasses) {
        deferred.push({ class: name, valueTypes: [], deferred: true });
    }
    return [...active, ...deferred];
}

export interface NodePaletteProps {
    readonly onAddNode: (type: string) => void;
    readonly onAddParameter: (request: ParameterRequest) => void;
    /** The loaded descriptor instance (or null) — the profile vocabulary's authority. */
    readonly descriptor: SurfaceProfileDescriptor | null;
}

export function NodePalette(props: NodePaletteProps) {
    const groups = nodeCatalogGroups();
    const choices = parameterChoices(props.descriptor);
    return (
        <nav className="gglab-palette" aria-label="Node palette">
            <section className="gglab-palette-section">
                <h2>Parameters</h2>
                {props.descriptor === null && (
                    <p className="gglab-palette-hint">
                        Load a profile descriptor to author parameters — the profile vocabulary (parameter classes and value types) is
                        descriptor-owned, and the UI will not invent it.
                    </p>
                )}
                {choices.map((choice) => (
                    <div className="gglab-parameter-choice" key={choice.class}>
                        <span className="gglab-palette-name">
                            {choice.class}
                            {choice.deferred && <span className="gglab-palette-deferred"> deferred</span>}
                        </span>
                        {choice.deferred ? (
                            <span className="gglab-palette-deferred-note">named by the descriptor's deferred set — not authorable</span>
                        ) : (
                            choice.valueTypes.map((valueType) => (
                                <button
                                    key={valueType}
                                    type="button"
                                    className="gglab-palette-entry gglab-palette-value"
                                    onClick={() => props.onAddParameter({ name: "New Parameter", class: choice.class, valueType: valueType as GraphType })}
                                    title={`Add a ${choice.class} (valueType ${valueType})`}
                                >
                                    <span className="gglab-palette-name">{valueType}</span>
                                </button>
                            ))
                        )}
                    </div>
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
