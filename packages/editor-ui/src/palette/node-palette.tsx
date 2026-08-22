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
 * Structure: each section is collapsible (UI session state, never part of
 * the persisted document), and the whole library can collapse to a rail
 * (the composition root owns that layout state and the `rail` presentation
 * here). Search is a pure string filter over display names — presentation
 * convenience. Clicking an entry is an intent: the composition root
 * performs the document operation (atomically) and the core's services
 * judge the result.
 */
import { useState, type ReactNode } from "react";
import { NODE_DEFINITIONS, type GraphType, type NodeCategory, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { CollapsibleContent, CollapsibleSection } from "../components/ui/collapsible.js";
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

/** Chevron marker for a section header (presentation only). */
function ChevronIcon({ open }: { open: boolean }) {
    return (
        <svg className={`gglab-chevron${open ? " gglab-chevron-open" : ""}`} width="9" height="6" viewBox="0 0 9 6" aria-hidden>
            <path d="M1 1l3.5 3.5L8 1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
    );
}

/** Panel collapse glyph (presentation only). */
function PanelCloseIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden>
            <rect x="1" y="1.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5.5" y1="1.5" x2="5.5" y2="11.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

/** Panel expand glyph (presentation only). */
function PanelOpenIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden>
            <rect x="1" y="1.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5.5" y1="1.5" x2="5.5" y2="11.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7.6 5.4l1.9 1.6-1.9 1.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

export interface NodePaletteProps {
    readonly onAddNode: (type: string) => void;
    readonly onAddParameter: (request: ParameterRequest) => void;
    /** The loaded descriptor instance (or null) — the profile vocabulary's authority. */
    readonly descriptor: SurfaceProfileDescriptor | null;
    /** Optional library-search query (presentation filter only). */
    readonly query?: string;
    /** Rail mode: the whole library collapsed (layout state owned by the app). */
    readonly rail?: boolean;
    readonly onExpandLibrary?: () => void;
    readonly onCollapseLibrary?: () => void;
}

interface SectionProps {
    readonly title: string;
    readonly collapsed: boolean;
    readonly onToggle: () => void;
    readonly children: ReactNode;
}

/** One collapsible library section (collapse state = UI session state). */
function LibrarySection(props: SectionProps) {
    const open = !props.collapsed;
    return (
        <CollapsibleSection open={open} onOpenChange={() => props.onToggle()}>
            <button type="button" className="gglab-section-head" aria-expanded={open} onClick={props.onToggle}>
                <ChevronIcon open={open} />
                <h2 className="gglab-section-title">{props.title}</h2>
            </button>
            <CollapsibleContent>
                <div className="gglab-section-body">{props.children}</div>
            </CollapsibleContent>
        </CollapsibleSection>
    );
}

export function NodePalette(props: NodePaletteProps) {
    const query = props.query ?? "";
    // Section collapse state: per-key, UI session state (never persisted as
    // document data). Default: everything open.
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const toggle = (id: string): void => setCollapsed((previous) => ({ ...previous, [id]: !previous[id] }));

    if (props.rail) {
        return (
            <div className="gglab-library-rail" aria-label="Node library (collapsed)">
                <button type="button" className="gglab-rail-btn" onClick={() => props.onExpandLibrary?.()} title="Expand the node library">
                    <PanelOpenIcon />
                    <span className="gglab-rail-text">Node Library</span>
                </button>
            </div>
        );
    }

    const groups = nodeCatalogGroups().map((group) => ({
        ...group,
        definitions: group.definitions.filter((definition) => libraryMatchesQuery(query, [definition.displayName, definition.type])),
    }));
    const choices = parameterChoices(props.descriptor).filter((choice) => libraryMatchesQuery(query, [choice.class, ...choice.valueTypes]));

    return (
        <nav className="gglab-palette" aria-label="Node library">
            <div className="gglab-library-head">
                <h2 className="gglab-library-title">
                    Node Library
                    {props.onCollapseLibrary !== undefined && (
                        <button
                            type="button"
                            className="gglab-icobtn"
                            aria-label="Collapse the node library"
                            title="Collapse library"
                            onClick={() => props.onCollapseLibrary?.()}
                        >
                            <PanelCloseIcon />
                        </button>
                    )}
                </h2>
            </div>
            <LibrarySection title="Parameters" collapsed={collapsed["parameters"] ?? false} onToggle={() => toggle("parameters")}>
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
            </LibrarySection>
            {groups.map((group) => (
                <LibrarySection
                    key={group.category}
                    title={group.category}
                    collapsed={collapsed[group.category] ?? false}
                    onToggle={() => toggle(group.category)}
                >
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
                </LibrarySection>
            ))}
        </nav>
    );
}
