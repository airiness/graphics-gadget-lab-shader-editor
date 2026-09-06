/**
 * Bottom-panel presentation vocabulary — the shared correlation identity
 * vocabulary and the headless projections the four views render.
 *
 * What this module IS:
 *  - the shared correlation identity vocabulary (`EvidenceCorrelation`): the
 *    owner-owned axes that tie a presented row to the fact it projects
 *    (the document session, the document revision, the generated source
 *    identity, the build id, the preview attempt sequence, the preview
 *    session, the publication);
 *  - typed projections FROM the owners' records for the four views:
 *    - `BuildRow` / `buildChronology` over the client's build line, ordered
 *      by the line's own authority — the `BuildId` sequence, never by
 *      arrival position;
 *    - `PreviewRow` / `previewChronology` over the client's preview build
 *      line under its session identity, ordered by the line's own authority
 *      — the `attemptSequence`;
 *    - `ProblemSnapshotEntry` / `ProblemSnapshot` over the diagnostic
 *      layers: the REPLACEABLE CURRENT snapshot, never an append-only log;
 *    - `OutputEvent`, the Output view's own presentation line (a simple
 *      general chronology with its own presentation sequence);
 *  - the shared correlation helpers (`correlationRefines`,
 *    `correlationsEqual`) for grouping rows across views by identity.
 *
 * What this module is NOT:
 *  - not an authority: it names and carries the identities and facts the
 *    owners already keep. It creates no identities, interprets no outcomes,
 *    stores nothing, holds no clock or host handle. Each projection carries
 *    the owner's record by reference and derives its correlation from the
 *    record's own fields (plus the owning session identity for preview
 *    lines, or the document context for diagnostics) — there is no free
 *    "payload + correlation" row to assemble, so a contradictory combination
 *    of evidence cannot be produced;
 *  - not a universal "any evidence" row and not a second chronology clock:
 *    the four views keep DISTINCT row types with distinct lifecycles, and
 *    each chronological view keeps its own ordering axis (the build line's
 *    `BuildId` sequences, the preview line's `attemptSequence`s, the output
 *    presentation sequence). Only the correlation vocabulary is shared —
 *    Build #1 and Preview attempt #1 live in distinct namespaces because a
 *    preview row always carries the preview axes alongside;
 *  - not a second Build / Preview authority: a Build chronology row IS the
 *    client's `AttemptRecord` under a derived correlation, a Preview row IS
 *    the client's `PreviewAttemptRecord` under a derived correlation — the
 *    panel projects, it does not reproduce.
 *
 * High-value evidence stays structured at the point of production: a build
 * row presents the client's intent and outcome vocabulary verbatim, a
 * preview row presents the client's preview attempt vocabulary verbatim
 * (the publication identity appears in the correlation only when that
 * attempt actually published), a snapshot entry presents the owner's
 * diagnostic layer with its location authority (the graph-local `dataPath`,
 * the generated-source identity — or honestly no location). Rendering to
 * display text happens last, in the view.
 *
 * Headless by construction: no React, no DOM, no host — unit-testable and
 * reusable by any frontend that presents these owners' facts.
 */
import type { DiagnosticSeverity, ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import type {
    AttemptRecord,
    BuildId,
    BuildLine,
    PreviewAttemptRecord,
    PreviewBuildLine,
    ToolDiagnostic,
} from "@gglab/shader-toolchain-client";
import type { BottomPanelTab } from "./bottom-panel.js";
import type { DocumentSessionId } from "./workspace-session.js";

// ---- The shared correlation identity vocabulary --------------------------

/**
 * One presented row's correlation: the owner-owned identity axes that tie
 * it back to the fact it projects. Every axis is optional (null): a row
 * correlates on the SUBSET of axes its owner supplies, and the empty
 * correlation (a presented row that names no specific fact) is valid.
 *
 * Axis meanings, mapped to their owners:
 *  - `documentSessionId` — the workspace session's branded id: WHICH open
 *    editing context a row belongs to;
 *  - `documentRevision` — the document's authoring revision as its core
 *    canonical serialization (content-equal revisions are the same
 *    revision — the owner's own revision fact);
 *  - `generatedSourceIdentity` — the SHA-256 of the generated HLSL bytes
 *    (the core's durable generated-source identity): which revision's
 *    emission a build / preview fact, or tool diagnostic, was produced
 *    from;
 *  - `buildId` — the client's per-attempt identity (one BuildId names
 *    exactly one attempt on its owning line — on either the build line or
 *    the preview line; they stay distinct through the axes that follow);
 *  - `previewAttemptSequence` — the preview line's attempt ordinal
 *    (present on Preview rows only; the preview line's own ordering axis);
 *  - `previewSessionId` — the Preview session identity (32 lowercase hex):
 *    which attached Preview session a preview row belongs to;
 *  - `publicationId` — the published Preview publication identity: present
 *    only when that preview attempt actually published.
 *
 * The preview axes exist precisely so Build #1 and Preview attempt #1 do
 * NOT share one correlation namespace: a preview row always co-carries its
 * attempt sequence and session identity, and a build row never does.
 */
export interface EvidenceCorrelation {
    readonly documentSessionId: DocumentSessionId | null;
    readonly documentRevision: string | null;
    readonly generatedSourceIdentity: string | null;
    readonly buildId: BuildId | null;
    readonly previewAttemptSequence: number | null;
    readonly previewSessionId: string | null;
    readonly publicationId: string | null;
}

/** The empty correlation: a presented row that names no specific fact. */
export const EMPTY_EVIDENCE_CORRELATION: EvidenceCorrelation = {
    documentSessionId: null,
    documentRevision: null,
    generatedSourceIdentity: null,
    buildId: null,
    previewAttemptSequence: null,
    previewSessionId: null,
    publicationId: null,
};

function sameAxis(required: unknown, carried: unknown): boolean {
    if (required === carried) {
        return true;
    }
    // Exactly one axis carries an object identity (BuildId); compare its
    // ordering value instead of object identity.
    if (required !== null && typeof required === "object" && carried !== null && typeof carried === "object") {
        return (required as BuildId).sequence === (carried as BuildId).sequence;
    }
    return false;
}

/**
 * `correlated` REFINES `filter` when it agrees with the filter on every
 * axis the filter specifies. An axis the filter does not specify imposes no
 * constraint; an axis the filter DOES specify must be carried and equal —
 * a row that lacks a required identity is not a match (absence of an
 * identity is not identity).
 */
export function correlationRefines(filter: EvidenceCorrelation, correlated: EvidenceCorrelation): boolean {
    const axes: ReadonlyArray<readonly [unknown, unknown]> = [
        [filter.documentSessionId, correlated.documentSessionId],
        [filter.documentRevision, correlated.documentRevision],
        [filter.generatedSourceIdentity, correlated.generatedSourceIdentity],
        [filter.buildId, correlated.buildId],
        [filter.previewAttemptSequence, correlated.previewAttemptSequence],
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

/** Two correlations name the same set of identities — every axis either
 *  agrees on both or is absent on both. */
export function correlationsEqual(left: EvidenceCorrelation, right: EvidenceCorrelation): boolean {
    return correlationRefines(left, right) && correlationRefines(right, left);
}

// ---- The projection context -----------------------------------------------

/**
 * The document context a projection renders over. Both values are OWNER
 * facts (the workspace session id; the document revision as its canonical
 * serialization) that the caller already computes from the owners — the
 * projection carries them verbatim and never recomputes them.
 */
export interface PanelProjectionContext {
    readonly documentSessionId: DocumentSessionId;
    readonly documentRevision: string;
}

// ---- Build chronology (owner: the client's build line) ---------------------

/** One row of the Build chronology: the owner's attempt record, carried by
 *  reference, under the correlation derived from that record. */
export interface BuildRow {
    readonly record: AttemptRecord;
    readonly correlation: EvidenceCorrelation;
}

/**
 * Project one build-line attempt record into a Build row. The correlation
 * is derived from the record's own fields (the record's build id, the
 * record's intent source identity) plus the document context — never
 * supplied piecewise.
 */
export function buildRowFromAttempt(context: PanelProjectionContext, record: AttemptRecord): BuildRow {
    return {
        record,
        correlation: {
            ...EMPTY_EVIDENCE_CORRELATION,
            documentSessionId: context.documentSessionId,
            documentRevision: context.documentRevision,
            generatedSourceIdentity: record.intent.sourceIdentity,
            buildId: record.buildId,
        },
    };
}

/**
 * The Build view's chronology: the owner's build line, projected in the
 * line's own ordering authority. Arrival order is NOT chronology (a slow
 * old attempt may land after a newer one) — within an intent the ordering
 * is judged by the BuildId sequence, never by position. Returns a fresh
 * array; the owner's line is untouched.
 */
export function buildChronology(context: PanelProjectionContext, line: BuildLine): readonly BuildRow[] {
    return [...line.attempts]
        .sort((a, b) => a.buildId.sequence - b.buildId.sequence)
        .map((record) => buildRowFromAttempt(context, record));
}

// ---- Preview chronology (owner: the client's preview line) ------------------

/** One row of the Preview chronology: the owner's preview attempt record,
 *  carried by reference, under the correlation derived from that record,
 *  the owning session identity, and the record's settlement. */
export interface PreviewRow {
    readonly record: PreviewAttemptRecord;
    readonly correlation: EvidenceCorrelation;
}

/**
 * The owner facts a preview line belongs to: the Preview session identity
 * and the client's line under it. (The `nextAttemptSequence` cursor the
 * owner keeps alongside is a bookkeeping axis, not an identity, so it is
 * deliberately not part of this vocabulary.)
 */
export interface PreviewBuildSessionFacts {
    readonly sessionId: string;
    readonly line: PreviewBuildLine;
}

/**
 * Project one preview-line attempt record into a Preview row. The
 * correlation is derived: the record's build id, its attempt sequence, the
 * session identity that owns the line, the record's intent generated-source
 * identity — and the publication identity ONLY when this attempt actually
 * published (a pending or failed attempt carries none).
 */
export function previewRowFromAttempt(
    context: PanelProjectionContext,
    session: PreviewBuildSessionFacts,
    record: PreviewAttemptRecord,
): PreviewRow {
    const publicationId =
        record.state === "settled" && record.outcome.kind === "published" ? record.outcome.envelope.publicationId : null;
    return {
        record,
        correlation: {
            ...EMPTY_EVIDENCE_CORRELATION,
            documentSessionId: context.documentSessionId,
            documentRevision: context.documentRevision,
            generatedSourceIdentity: record.intent.generatedSourceIdentity,
            buildId: record.buildId,
            previewAttemptSequence: record.attemptSequence,
            previewSessionId: session.sessionId,
            publicationId,
        },
    };
}

/**
 * The Preview view's chronology: the owner's preview build line, projected
 * in the line's own ordering authority — the attempt sequence (one
 * sequence names exactly one preview attempt). Returns a fresh array; the
 * owner's line is untouched.
 */
export function previewChronology(
    context: PanelProjectionContext,
    session: PreviewBuildSessionFacts,
): readonly PreviewRow[] {
    return [...session.line.attempts]
        .sort((a, b) => a.attemptSequence - b.attemptSequence)
        .map((record) => previewRowFromAttempt(context, session, record));
}

// ---- Output presentation line (the Output view's own chronology) ------------

/**
 * One presentation event of the Output view: the view's own presentation
 * sequence, a human-readable summary of the fact, and the identities it
 * correlates to. Structured owner evidence does NOT live here — it is
 * presented through the owners' own projections (the build and preview
 * rows), where it stays the owners' exact vocabulary.
 */
export interface OutputEvent {
    readonly sequence: number;
    readonly text: string;
    readonly correlation: EvidenceCorrelation;
}

/** A fresh empty Output line. */
export function emptyOutputLine(): readonly OutputEvent[] {
    return [];
}

/** One presentation event ready to be appended (its position is assigned
 *  by the append). */
export function createOutputEvent(text: string, correlation: EvidenceCorrelation = EMPTY_EVIDENCE_CORRELATION): OutputEvent {
    return { sequence: 0, text, correlation };
}

/**
 * The position the next append takes (1-based, monotonic). The line is
 * ORDERED BY CONSTRUCTION: the only way a line gains a row is through the
 * append, which assigns exactly this position — so the next position is the
 * last row's position plus one. There is no out-of-order contract to
 * reconcile.
 */
export function nextOutputSequence(line: readonly OutputEvent[]): number {
    const last = line.length === 0 ? undefined : line[line.length - 1];
    return (last === undefined ? 0 : last.sequence) + 1;
}

/**
 * Append one presentation event: a fresh line carrying the event at the
 * next position. Value semantics — the input line is untouched.
 */
export function appendOutputEvent(line: readonly OutputEvent[], event: OutputEvent): readonly OutputEvent[] {
    return [...line, { text: event.text, correlation: event.correlation, sequence: nextOutputSequence(line) }];
}

// ---- The replaceable current snapshot (Problems view) ----------------------

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
 *  structured (severity, the owner's stable code when the layer has one,
 *  the owner's location authority) under the identities that correlate it.
 */
export interface ProblemSnapshotEntry {
    /** The stable per-problem key the caller chooses; the snapshot is
     *  replaced wholesale, and this stays the entry's identity within it. */
    readonly identity: string;
    readonly severity: DiagnosticSeverity;
    /** The owner's stable diagnostic code (the graph-native layer); the
     *  toolchain layer reports none, in which case this is null. */
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
 * authority survive verbatim. The correlation is the document context — a
 * graph diagnostic is anchored to the authoring revision, and the diagnostic
 * itself carries no emission identity, so the generated-source axis stays
 * absent rather than invented.
 */
export function problemEntryFromGraphDiagnostic(
    identity: string,
    diagnostic: ShaderGraphDiagnostic,
    context: PanelProjectionContext,
): ProblemSnapshotEntry {
    return {
        identity,
        severity: diagnostic.severity,
        code: diagnostic.code,
        text: diagnostic.message,
        location: { kind: "graph", dataPath: diagnostic.dataPath },
        correlation: {
            ...EMPTY_EVIDENCE_CORRELATION,
            documentSessionId: context.documentSessionId,
            documentRevision: context.documentRevision,
        },
    };
}

/**
 * Project one TOOLCHAIN diagnostic (the client's layer) into a snapshot
 * entry: the tool's own message and location fact survive verbatim (or are
 * honestly `unplaced`), this layer contributes no stable code, and the
 * generated-source axis is taken from the diagnostic's own fact when it
 * reports one. Severity is NOT a tool-layer fact (the diagnostic carries
 * none): it comes from the envelope context the caller already knows (a
 * failure-envelope diagnostic is an error; a success note is a warning or
 * info).
 */
export function problemEntryFromToolDiagnostic(
    identity: string,
    diagnostic: ToolDiagnostic,
    severity: DiagnosticSeverity,
    context: PanelProjectionContext,
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
        correlation: {
            ...EMPTY_EVIDENCE_CORRELATION,
            documentSessionId: context.documentSessionId,
            documentRevision: context.documentRevision,
            generatedSourceIdentity: diagnostic.sourceIdentity ?? null,
        },
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

// ---- View axis --------------------------------------------------------------

/** The three views that render a chronology (Problems is the snapshot view
 *  and is deliberately excluded here). Each keeps its OWN ordering axis:
 *  the Output line's presentation sequence, the build line's BuildId
 *  sequences, the preview line's attempt sequences — a shared clock is
 *  deliberately NOT imposed. */
export type PanelChronologyView = Exclude<BottomPanelTab, "problems">;
