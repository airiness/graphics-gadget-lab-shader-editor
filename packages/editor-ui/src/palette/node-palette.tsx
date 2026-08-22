/**
 * Node library + parameter authoring. Two vocabularies, two authorities —
 * the UI projects both, it owns neither:
 *
 *   - Node vocabulary   ← the core's node catalog (the single
 *     node/port/type authority). There is no UI-side node registry.
 *   - Profile vocabulary ← the loaded descriptor instance:
 *     `parameterClasses` (class → allowed value types) and `deferred`
 *     (named, shown explicitly, never offered for authoring). Without a
 *     loaded descriptor there is no parameter vocabulary to show — the
 *     section says so instead of inventing one.
 *
 * Library search is a pure string filter over display names — presentation
 * convenience, never a semantic fact. Clicking an entry is an intent: the
 * composition root performs the document operation (atomically) and the
 * core's services judge the result.
 */
import { NODE_DEFINITIONS, type GraphType, type NodeCategory, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { portKind, type PortKind } from "../flow/flow-adapter.js";
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

/** Pure presentation filter: does the (case-insensitive) query match any name? */
export function libraryMatchesQuery(query: string, names: readonly string[]): boolean {
    const q = query.trim().toLowerCase();
    if (q === "") {
        return true;
    }
    return names.some((name) => name.toLowerCase().includes(q));
}

export interface ParameterChoice {
    readonly class: string;
    readonly valueTypes: readonly string[];
    /** The data family of the first value type (dot color only). */
    readonly kind: PortKind;
    /** True for classes the descriptor lists in its deferred set: shown, never authorable. */
    readonly deferred: boolean;
}

/**
 * The parameter authoring choices, projected from the descriptor instance
 * (profile vocabulary is descriptor-owned). Without a descriptor: empty —
 * the panel says so instead of offering a vocabulary of its own.
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
        active.push({ class: entry.class, valueTypes, kind: valueTypes.length > 0 ? portKind(valueTypes as readonly GraphType[]) : "generic", deferred: false });
    }
    for (const name of descriptor.deferred.parameterClasses) {
        deferred.push({ class: name, valueTypes: [], kind: "generic", deferred: true });
    }
    return [...active, ...deferred];
}

function kind(valueType: string): PortKind {
    return portKind([valueType as GraphType]);
}

export interface NodePaletteProps {
    readonly onAddNode: (type: string) => void;
    readonly onAddParameter: (request: ParameterRequest) => void;
    /** The loaded descriptor instance (or null) — the profile vocabulary's authority. */
    readonly descriptor: SurfaceProfileDescriptor | null;
    /** Optional library-search query (presentation filter only). */
    readonly query?: string;
}

export function NodePalette(props: NodePaletteProps) {
    const query = props.query ?? "";
    const groups = nodeCatalogGroups().map((group) => ({
        ...group,
        definitions: group.definitions.filter((definition) => libraryMatchesQuery(query, [definition.displayName, definition.type])),
    }));
    const choices = parameterChoices(props.descriptor).filter((choice) => libraryMatchesQuery(query, [choice.class, ...choice.valueTypes]));
    return (
        <nav className="gglab-palette" aria-label="Node library">
            <section className="gglab-library-section">
                <h2>Parameters</h2>
                {props.descriptor === null && (
                    <p className="gglab-palette-hint">
                        Load a profile descriptor to author parameters — the profile vocabulary (parameter classes and value types) is
                        descriptor-owned, and the UI will not invent it.
                    </p>
                )}
                {choices.length === 0 && props.descriptor !== null && <p className="gglab-palette-hint">No parameter classes match "{query}".</p>}
                {choices.map((choice) => (
                    <div className={`gglab-parameter-choice${choice.deferred ? " gglab-parameter-deferred" : ""}`} key={choice.class}>
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
                                    <span aria-hidden className={`gglab-dot gglab-dot-${kind(valueType)}`} />
                                    <span className="gglab-palette-name">{valueType}</span>
                                </button>
                            ))
                        )}
                    </div>
                ))}
            </section>
            {groups.map((group) => (
                <section className="gglab-library-section" key={group.category}>
                    <h2>{group.category}</h2>
                    {group.definitions.length === 0 && <p className="gglab-palette-hint">No nodes match "{query}".</p>}
                    {group.definitions.map((definition) => (
                        <button
                            key={definition.type}
                            type="button"
                            className="gglab-palette-entry"
                            onClick={() => props.onAddNode(definition.type)}
                            title={definition.description}
                        >
                            <span className="gglab-palette-name">{definition.displayName}</span>
                            <span className="gglab-palette-tag">{definition.type}</span>
                        </button>
                    ))}
                </section>
            ))}
        </nav>
    );
}
