/**
 * Bottom-panel presentation vocabulary — the shared correlation identities
 * and the headless projections the four views render.
 *
 * What this module IS:
 *  - the shared correlation identity vocabulary (`EvidenceCorrelation`): the
 *    owner-owned axes the views use to connect a presented row to the fact it
 *    projects (the document session, the document revision, the generated
 *    source identity, the build attempt, the build id, the Preview session,
 *    the publication);
 *  - the row vocabulary of the CHRONOLOGICAL views (`EditorEvent`): Output,
 *    Build, and Preview render one chronological event line, each as a
 *    filtered projection of it;
 *  - the row vocabulary of the Problems view (`ProblemSnapshotEntry` inside a
 *    `ProblemSnapshot`): Problems renders the REPLACEABLE CURRENT diagnostic
 *    snapshot, never an append-only log;
 *  - pure, value-semantic projection helpers (append, filter per view, new
 *    snapshot, replace snapshot). Every helper returns a fresh value and
 *    never mutates its inputs.
 *
 * What this module is NOT:
 *  - not an authority. It names and carries identities and facts the owners
 *    already own — the workspace session id, the document revision (the core
 *    canonical serialization), the core's generated-source identity, the
 *    client's build/preview attempt lines, the Preview session and its
 *    publications. It creates no identities, interprets no outcomes, stores
 *    nothing, and keeps no clock or host handle;
 *  - not a universal "any evidence" row: the chronological row and the
 *    snapshot row are DISTINCT types with distinct lifecycles, and a view's
 *    projection is a filter over its owners' lines — not a merged table and
 *    not a second Build / Preview authority beside them.
 *
 * High-value evidence stays structured at the point of production: an event
 * row carries the owners' exact vocabulary (the client's attempt outcomes
 * and intents, the Preview publication document), and a snapshot entry
 * carries the owners' diagnostic location authority (the graph-local data
 * path, or the generated-source identity — or no location at all). Rendering
 * to display text happens last, in the view.
 *
 * Headless by construction: no React, no DOM, no host — unit-testable and
 * reusable by any frontend that presents these owners' facts.
 */
import type { DiagnosticSeverity, ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import type {
    AttemptOutcome,
    BuildId,
    BuildIntent,
    PreviewAttemptOutcome,
    PreviewBuildIntent,
    ToolCandidate,
    ToolDiagnostic,
} from "@gglab/shader-toolchain-client";
import type { BottomPanelTab } from "./bottom-panel.js";
import type { DocumentSessionId } from "./workspace-session.js";

// ---- The shared correlation identity vocabulary --------------------------

/**
 * One presented row's correlation: the owner-owned identity axes that tie it
 * back to the fact it projects. Every axis is optional (null): a row
 * correlates on the SUBSET of axes its owner supplies, and an empty
 * correlation (a general line that names no specific fact) is valid.
 *
 * Axis meanings, mapped to their owners:
 *  - `documentSessionId` — the workspace session's branded id: WHICH open
 *    editing context a row belongs to;
 *  - `documentRevision` — the document's authoring revision as its core
 *    canonical serialization (content-equal revisions are the same revision
 *    — that is the owner's own revision fact);
 *  - `generatedSourceIdentity` — the SHA-256 of the generated HLSL bytes
 *    (the core's durable generated-source identity): which revision's
 *    emission a build / preview fact was produced from;
 *  - `buildAttempt` — the attempt's ordinal within its owning attempt line
 *    (the Preview line's attempt sequence, the build line's ordering axis);
 *  - `buildId` — the client's per-attempt identity (one BuildId names
 *    exactly one attempt);
 *  - `previewSessionId` — the Preview session identity (32 lowercase
 *    hex): which attached Preview session a row belongs to;
 *  - `publicationId` — the published Preview publication identity: present
 *    once a Preview attempt published, absent otherwise.
 */
export interface EvidenceCorrelation {
    readonly documentSessionId: DocumentSessionId | null;
    readonly documentRevision: string | null;
    readonly generatedSourceIdentity: string | null;
    readonly buildAttempt: number | null;
    readonly buildId: BuildId | null;
    readonly previewSessionId: string | null;
    readonly publicationId: string | null;
}

/** The empty correlation: a presented row that names no specific fact. */
export const EMPTY_EVIDENCE_CORRELATION: EvidenceCorrelation = {
    documentSessionId: null,
    documentRevision: null,
    generatedSourceIdentity: null,
    buildAttempt: null,
    buildId: null,
    previewSessionId: null,
    publicationId: null,
};

function sameAxis(required: unknown, carried: unknown): boolean {
    if (required === carried) {
        return true;
    }
    // Exactly one axis carries an object identity today (BuildId); compare
    // its ordering value instead of object identity.
    if (required !== null && typeof required === "object" && carried !== null && typeof carried === "object") {
        return (required as BuildId).sequence === (carried as BuildId).sequence;
    }
    return false;
}

/**
 * `correlated` REFINES `filter` when it agrees with the filter on every
 * axis the filter specifies. An axis the filter does not specify imposes no
 * constraint; an axis the filter DOES specify must be carried and equal —
 * an event that lacks a required identity is not a match (absence of an
 * identity is not identity).
 */
export function correlationRefines(filter: EvidenceCorrelation, correlated: EvidenceCorrelation): boolean {
    const axes: ReadonlyArray<readonly [unknown, unknown]> = [
        [filter.documentSessionId, correlated.documentSessionId],
        [filter.documentRevision, correlated.documentRevision],
        [filter.generatedSourceIdentity, correlated.generatedSourceIdentity],
        [filter.buildAttempt, correlated.buildAttempt],
        [filter.buildId, correlated.buildId],
        [filter.previewSessionId, correlated.previewSessionId],
        [filter.publicationId, correlated.publicationId],
    ];
    for (const [required, carried] of axes) {
        if (required === null) {
            continue;
        }
        if (carried === null || !sameAxis(required, carried)) {
            return false;
        }
    }
    return true;
}

/** Two correlations name the same set of identities (either may omit axes
 *  the other carries only when BOTH omit them — an agreement in both
 *  directions). */
export function correlationsEqual(left: EvidenceCorrelation, right: EvidenceCorrelation): boolean {
    return correlationRefines(left, right) && correlationRefines(right, left);
}

// ---- The chronological rows (Output / Build / Preview views) --------------

/** The views that project a chronological line (Problems is the snapshot
 *  view and is deliberately excluded here). */
export type PanelChronologyView = Exclude<BottomPanelTab, "problems">;

/** The stable, machine-readable kinds of one chronological row. */
export type EditorEventKind = "note" | "build-issue" | "build-settlement" | "preview-issue" | "preview-settlement";

/**
 * One row's structured evidence. Each kind carries the OWNERS' exact
 * vocabulary — the client's build / preview intents and attempt outcomes —
 * so no high-value fact is flattened to a display string on production.
 * The `note` kind is the deliberately low-content general line (Output view)
 * whose only payload is a human-readable summary. Kinds are added together
 * with the views that consume them; none is speculative.
 */
export type EditorEventPayload =
    | { readonly kind: "note"; readonly text: string }
    | { readonly kind: "build-issue"; readonly intent: BuildIntent }
    | { readonly kind: "build-settlement"; readonly outcome: AttemptOutcome }
    | { readonly kind: "preview-issue"; readonly attemptSequence: number; readonly candidate: ToolCandidate; readonly intent: PreviewBuildIntent }
    | { readonly kind: "preview-settlement"; readonly outcome: PreviewAttemptOutcome };

/** One CHRONOLOGICAL row of the panel event line: its position, the
 *  structured owner facts it presents, and the identities it correlates to. */
export interface EditorEvent {
    readonly sequence: number;
    readonly payload: EditorEventPayload;
    readonly correlation: EvidenceCorrelation;
}

/** Which chronological view a kind belongs to. Output is the general
 *  chronology (every kind); Build and Preview keep their own lines. */
const EVENT_KIND_VIEWS: Record<EditorEventKind, readonly PanelChronologyView[]> = {
    note: ["output"],
    "build-issue": ["output", "build"],
    "build-settlement": ["output", "build"],
    "preview-issue": ["output", "preview"],
    "preview-settlement": ["output", "preview"],
};

export function eventInView(event: EditorEvent, view: PanelChronologyView): boolean {
    const views = EVENT_KIND_VIEWS[event.payload.kind];
    return views !== undefined && views.includes(view);
}

/**
 * The row the given view renders: a filtered, chronologically ordered
 * projection of the line. Returns a fresh array — the underlying line and
 * the owners' facts are never reordered or mutated in place.
 */
export function eventsForView(line: readonly EditorEvent[], view: PanelChronologyView): readonly EditorEvent[] {
    return [...line].filter((event) => eventInView(event, view)).sort((a, b) => a.sequence - b.sequence);
}

/** The next chronological position of the line (1-based, monotonic). */
export function nextEventSequence(line: readonly EditorEvent[]): number {
    const last = line.length === 0 ? undefined : line[line.length - 1];
    return (last === undefined ? 0 : last.sequence) + 1;
}

/**
 * Append one row: a fresh line with the next position. Value semantics —
 * the input line is untouched, and the row keeps the owners' facts by
 * reference (they are already immutable owner values).
 */
export function appendEvent(
    line: readonly EditorEvent[],
    payload: EditorEventPayload,
    correlation: EvidenceCorrelation = EMPTY_EVIDENCE_CORRELATION,
): readonly EditorEvent[] {
    return [...line, { sequence: nextEventSequence(line), payload, correlation }];
}

/** A fresh empty line (the "clear the presentation" result). */
export function emptyEventLine(): readonly EditorEvent[] {
    return [];
}

// ---- The replaceable current snapshot (Problems view) ---------------------

/**
 * One entry's location authority. The architecture keeps TWO diagnostic
 * layers, and their location authorities are distinct: graph-native
 * diagnostics are anchored by the core's `dataPath` (graph-local
 * node / port identity), toolchain diagnostics by the generated-source
 * identity. An entry whose owner reported no location fact is `unplaced` —
 * never fabricated.
 */
export type ProblemLocation =
    | { readonly kind: "graph"; readonly dataPath: string }
    | { readonly kind: "generated-source"; readonly sourceIdentity: string }
    | { readonly kind: "unplaced" };

/** One entry of the PROBLEMS snapshot: a current diagnostic fact, kept
 *  structured (severity, stable code when the owner has one, the owner's
 *  location authority) under the identities that correlate it. */
export interface ProblemSnapshotEntry {
    /** The stable per-problem key the caller chooses; the snapshot is
     *  replaced by wholesale, so this stays the entry's identity within it. */
    readonly identity: string;
    readonly severity: DiagnosticSeverity;
    /** The owner's stable diagnostic code (the core layer); the tool layer
     *  reports none, in which case this is null. */
    readonly code: string | null;
    /** The owner's human-readable message (a summary — never the only
     *  carrier of the structured facts above). */
    readonly text: string;
    readonly location: ProblemLocation;
    readonly correlation: EvidenceCorrelation;
}

/** The CURRENT Problems state: the set of entries it holds, and nothing
 *  more. It is the whole current truth of the view — replacement (not
 *  accumulation) is its lifecycle. */
export interface ProblemSnapshot {
    readonly entries: readonly ProblemSnapshotEntry[];
}

/**
 * Project one GRAPH-NATIVE diagnostic (the core's layer) into a snapshot
 * entry: code, severity, message, and the core's `dataPath` location
 * authority survive verbatim.
 */
export function problemEntryFromGraphDiagnostic(
    identity: string,
    diagnostic: ShaderGraphDiagnostic,
    correlation: EvidenceCorrelation = EMPTY_EVIDENCE_CORRELATION,
): ProblemSnapshotEntry {
    return {
        identity,
        severity: diagnostic.severity,
        code: diagnostic.code,
        text: diagnostic.message,
        location: { kind: "graph", dataPath: diagnostic.dataPath },
        correlation,
    };
}

/**
 * Project one TOOLCHAIN diagnostic (the client's layer) into a snapshot
 * entry: the tool's own message and location fact survive verbatim (or are
 * honestly `unplaced`), and this layer contributes no stable code. Severity
 * is NOT a tool-layer fact (the tool diagnostic carries none): it comes from
 * the envelope context the caller already knows (a failure-envelope
 * diagnostic is an error; a success note is a warning or info).
 */
export function problemEntryFromToolDiagnostic(
    identity: string,
    diagnostic: ToolDiagnostic,
    severity: DiagnosticSeverity,
    correlation: EvidenceCorrelation = EMPTY_EVIDENCE_CORRELATION,
): ProblemSnapshotEntry {
    return {
        identity,
        severity,
        code: null,
        text: diagnostic.message,
        location:
            diagnostic.sourceIdentity !== undefined
                ? { kind: "generated-source", sourceIdentity: diagnostic.sourceIdentity }
                : { kind: "unplaced" },
        correlation,
    };
}

/** A fresh snapshot over the given entries (copied — the caller's array is
 *  never aliased into the view). */
export function createProblemSnapshot(entries: readonly ProblemSnapshotEntry[]): ProblemSnapshot {
    return { entries: [...entries] };
}

/** A fresh empty snapshot (the "clear the presentation" result). */
export function emptyProblemSnapshot(): ProblemSnapshot {
    return { entries: [] };
}

/**
 * Replace the snapshot WHOLESALE: the Problems view renders the current
 * state, so a new snapshot IS the view — the previous snapshot is simply no
 * longer the view. There is deliberately no append / accumulate path: the
 * previous snapshot is never extended, and no caller array is aliased in.
 */
export function replaceProblemSnapshot(entries: readonly ProblemSnapshotEntry[]): ProblemSnapshot {
    return { entries: [...entries] };
}
