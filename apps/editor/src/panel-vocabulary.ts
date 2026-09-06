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
 *    - `BuildRow` / `buildChronology` over the editor's `NativeBuildSession`
 *      — settled AND in-flight attempts, both carried by reference, ordered
 *      by the line's own authority (the `BuildId` sequence, never by
 *      arrival position);
 *    - `PreviewRow` / `previewChronology` over the editor's
 *      `PreviewBuildSession` — every attempt (pending and settled), ordered
 *      by the line's own authority (the `attemptSequence`);
 *    - `ProblemSnapshotEntry` / `ProblemSnapshot` over the diagnostic
 *      layers — the REPLACEABLE CURRENT snapshot, never an append-only log.
 *      Toolchain entries are projected FROM their enclosing attempt record
 *      (the correlation and the severity are derived from that record and
 *      its outcome context, not supplied);
 *    - `OutputEvent`, the Output view's own presentation line (a simple
 *      general chronology with its own presentation sequence);
 *  - the shared correlation helpers (`correlationRefines`,
 *    `correlationsEqual`) for grouping rows across views by identity.
 *
 * What this module is NOT:
 *  - not an authority: it names and carries the identities and facts the
 *    owners already keep. It creates no identities, interprets no outcomes,
 *    stores nothing, holds no clock or host handle. Each projection carries
 *    the owner's record by reference; there is no free "payload +
 *    correlation" row to assemble, so a contradictory combination of
 *    evidence cannot be produced;
 *  - not a place to invent origin: a row's correlation carries the document
 *    context axes ONLY where the owner fact itself has them. Graph-native
 *    diagnostics are computed against THE CURRENT authoring revision, so
 *    those entries carry the document context. Historical build and preview
 *    attempts do NOT: their origin (session, revision) is fixed at issue
 *    time, and the owners keep no origin binding on the records today — so
 *    those axes stay ABSENT rather than stamped with today's values at
 *    render time. A row never receives a fact the owner does not hold;
 *  - not a universal "any evidence" row and not a second chronology clock:
 *    the four views keep DISTINCT row types with distinct lifecycles, and
 *    each chronological view keeps its own ordering axis (the build line's
 *    `BuildId` sequences, the preview line's `attemptSequence`s, the output
 *    presentation sequence). Only the correlation vocabulary is shared —
 *    Build #1 and Preview attempt #1 live in distinct namespaces because a
 *    preview row always carries the preview axes alongside;
 *  - not a second Build / Preview history: a Build chronology row IS the
 *    owner's `AttemptRecord` / `InFlightBuild` under a derived correlation,
 *    a Preview row IS the owner's `PreviewAttemptRecord` under a derived
 *    correlation — the panel projects, it does not reproduce.
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
    AttemptOutcome,
    AttemptRecord,
    BuildId,
    BuildIntent,
    PreviewAttemptOutcome,
    PreviewAttemptRecord,
    ToolDiagnostic,
} from "@gglab/shader-toolchain-client";
import type { InFlightBuild, NativeBuildSession } from "./native-build-session.js";
import type { PreviewBuildSession } from "./preview-build-session.js";
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
 *
 * The document context axes are carried only where the owner fact is
 * CURRENT: graph-native diagnostics (computed against the current authoring
 * revision). Historical attempt rows never receive them from render time —
 * see the module invariants above.
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

function sameBuildId(required: BuildId | null, carried: BuildId | null): boolean {
    if (required === null || carried === null) {
        return required === carried;
    }
    // Exactly one axis carries the BuildId object identity: compare it
    // explicitly, by its ordering value or reference.
    return required === carried || required.sequence === carried.sequence;
}

/**
 * `correlated` REFINES `filter` when it agrees with the filter on every
 * axis the filter specifies. An axis the filter does not specify imposes no
 * constraint; an axis the filter DOES specify must be carried and equal —
 * a row that lacks a required identity is not a match (absence of an
 * identity is not identity).
 */
export function correlationRefines(filter: EvidenceCorrelation, correlated: EvidenceCorrelation): boolean {
    const scalarAxes: ReadonlyArray<readonly [unknown, unknown]> = [
        [filter.documentSessionId, correlated.documentSessionId],
        [filter.documentRevision, correlated.documentRevision],
        [filter.generatedSourceIdentity, correlated.generatedSourceIdentity],
        [filter.previewAttemptSequence, correlated.previewAttemptSequence],
        [filter.previewSessionId, correlated.previewSessionId],
        [filter.publicationId, correlated.publicationId],
    ];
    for (const [required, carried] of scalarAxes) {
        if (required === null) {
            continue;
        }
        if (carried === null || carried !== required) {
            return false;
        }
    }
    if (
        filter.buildId !== null &&
        !sameBuildId(filter.buildId, correlated.buildId)
    ) {
        return false;
    }
    return true;
}

/** Two correlations name the same set of identities — every axis either
 *  agrees on both or is absent on both. */
export function correlationsEqual(left: EvidenceCorrelation, right: EvidenceCorrelation): boolean {
    return correlationRefines(left, right) && correlationRefines(right, left);
}

// ---- Build chronology (owner: the editor's build-line session) ------------

/** One IN-FLIGHT row of the Build chronology: the owner's in-flight fact
 *  (identity and intent, both fixed at issue), carried by reference, under
 *  the correlation derived from that fact. */
export interface InFlightBuildRow {
    readonly state: "in-flight";
    readonly buildId: BuildId;
    readonly intent: BuildIntent;
    readonly record: InFlightBuild;
    readonly correlation: EvidenceCorrelation;
}

/** One SETTLED row of the Build chronology: the owner's attempt record,
 *  carried by reference, under the correlation derived from that record. */
export interface SettledBuildRow {
    readonly state: "settled";
    readonly buildId: BuildId;
    readonly intent: BuildIntent;
    readonly record: AttemptRecord;
    readonly outcome: AttemptOutcome;
    readonly correlation: EvidenceCorrelation;
}

/** One row of the Build chronology: either settlement state, both owned by
 *  the owner's session — the panel presents both, it does not keep its own
 *  in-flight bookkeeping. */
export type BuildRow = InFlightBuildRow | SettledBuildRow;

function buildCorrelationFrom(record: { readonly buildId: BuildId; readonly intent: BuildIntent }): EvidenceCorrelation {
    // The origin of a build attempt (which document session, which
    // revision) is fixed at issue time and the owner record keeps no origin
    // binding — so those axes stay absent. The owner facts this record
    // DOES hold (its build id, its intent's source identity) are carried.
    return {
        ...EMPTY_EVIDENCE_CORRELATION,
        generatedSourceIdentity: record.intent.sourceIdentity,
        buildId: record.buildId,
    };
}

/**
 * The Build view's chronology: the owner's session — settled AND in-flight
 * attempts — projected in the line's own ordering authority. Arrival order
 * is NOT chronology (a slow old attempt may land after a newer one) — the
 * ordering is judged by the BuildId sequence, never by position. A build
 * in flight is a row in this chronology, not an invisible gap: it is
 * presented as `in-flight` until its owner settles it. Returns a fresh
 * array; the owner's session is untouched.
 */
export function buildChronology(session: NativeBuildSession): readonly BuildRow[] {
    const settled: BuildRow[] = session.line.attempts.map(
        (record): SettledBuildRow => ({
            state: "settled",
            buildId: record.buildId,
            intent: record.intent,
            record,
            outcome: record.outcome,
            correlation: buildCorrelationFrom(record),
        }),
    );
    const inFlight: BuildRow[] = session.inFlight.map(
        (record): InFlightBuildRow => ({
            state: "in-flight",
            buildId: record.buildId,
            intent: record.intent,
            record,
            correlation: buildCorrelationFrom(record),
        }),
    );
    return [...settled, ...inFlight].sort(
        (a, b) => a.buildId.sequence - b.buildId.sequence,
    );
}

// ---- Preview chronology (owner: the editor's Preview build session) --------

/** One row of the Preview chronology: the owner's preview attempt record,
 *  carried by reference, under the correlation derived from that record and
 *  the session identity that owns the line. */
export interface PreviewRow {
    readonly record: PreviewAttemptRecord;
    readonly correlation: EvidenceCorrelation;
}

/**
 * Project one preview-line attempt record into a Preview row. The
 * correlation is derived: the record's build id, its attempt sequence, the
 * session identity that owns the line, the record's intent generated-source
 * identity — and the publication identity ONLY when this attempt actually
 * published (a pending or failed attempt carries none). The document
 * context axes stay absent: a preview attempt's origin is fixed at issue
 * time, and the owner record keeps no origin binding to project from.
 */
export function previewRowFromAttempt(
    session: PreviewBuildSession,
    record: PreviewAttemptRecord,
): PreviewRow {
    const publicationId =
        record.state === "settled" && record.outcome.kind === "published" ? record.outcome.envelope.publicationId : null;
    return {
        record,
        correlation: {
            ...EMPTY_EVIDENCE_CORRELATION,
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
 * sequence names exactly one preview attempt). Pending attempts are rows
 * here too. Returns a fresh array; the owner's session is untouched.
 */
export function previewChronology(session: PreviewBuildSession): readonly PreviewRow[] {
    return [...session.line.attempts]
        .sort((a, b) => a.attemptSequence - b.attemptSequence)
        .map((record) => previewRowFromAttempt(session, record));
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
    /** The stable per-problem key within the snapshot — the projectors
     *  derive it deterministically from the enclosing owner facts (a same
     *  set of facts projects a same set of entries). */
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
 * The document context of one CURRENT authoring fact. Both values are
 * OWNER facts (the workspace session id; the document revision as its
 * canonical serialization) the caller already computed from the owners —
 * the projection carries them verbatim and never recomputes them. This
 * context is legitimately a fact for graph-native diagnostics: they are
 * computed against the CURRENT authoring revision. It is NOT a stamp for
 * historical attempt rows (build / preview), whose origin was fixed at
 * issue time — those rows carry the context axes only if their own record
 * holds them.
 */
export interface PanelDocumentContext {
    readonly documentSessionId: DocumentSessionId;
    readonly documentRevision: string;
}

/**
 * Project CURRENT graph-native diagnostics (the core's layer) into snapshot
 * entries: code, severity, message, and the core's `dataPath` location
 * authority survive verbatim, under the document context. The diagnostics
 * themselves carry no emission identity, so the generated-source axis stays
 * absent rather than invented. Entry identities are deterministic over the
 * diagnostic's own facts (code + location + position among duplicates), so
 * a repeated set produces a repeated set.
 */
export function problemEntriesFromGraphDiagnostics(
    diagnostics: readonly ShaderGraphDiagnostic[],
    context: PanelDocumentContext,
): readonly ProblemSnapshotEntry[] {
    const correlation: EvidenceCorrelation = {
        ...EMPTY_EVIDENCE_CORRELATION,
        documentSessionId: context.documentSessionId,
        documentRevision: context.documentRevision,
    };
    return diagnostics.map((diagnostic, index) => ({
        identity: `graph:${diagnostic.code}:${diagnostic.dataPath}@${index}`,
        severity: diagnostic.severity,
        code: diagnostic.code,
        text: diagnostic.message,
        location: { kind: "graph", dataPath: diagnostic.dataPath },
        correlation,
    }));
}

/** The severity a tool-chain diagnostic carries, decided by the OUTCOME
 *  context that encloses it (not claimed by the caller): a failure's
 *  diagnostics are errors; a success's notes are warnings. */
function toolDiagnosticSeverity(outcome: AttemptOutcome | PreviewAttemptOutcome): DiagnosticSeverity {
    return outcome.kind === "failed" ? "error" : "warning";
}

/**
 * The diagnostics an attempt's settlement envelope reports (a cancelled
 * attempt, or a termination without a readable envelope, reports none).
 */
function envelopeDiagnostics(outcome: AttemptOutcome | PreviewAttemptOutcome): readonly ToolDiagnostic[] {
    if (outcome.kind === "canceled") {
        return [];
    }
    if (outcome.kind === "failed") {
        return "envelope" in outcome ? outcome.envelope.diagnostics : [];
    }
    // A succeeded / published settlement carries its envelope.
    return outcome.envelope.diagnostics;
}

/**
 * Project the TOOLCHAIN diagnostics of one settled build attempt into
 * snapshot entries. Everything is derived from the ENCLOSING owner record
 * and its outcome — never supplied: the correlation carries the attempt's
 * own build id and its intent's generated source identity (the diagnostic
 * may add no location fact of its own, and the enclosure supplies the
 * missing generated-source axis anyway); the severity is decided by the
 * settlement (failure diagnostics are errors, success notes are warnings);
 * the location takes the diagnostic's own source identity when it reports
 * one, else stays honestly `unplaced`. An in-flight or diagnostic-free
 * attempt projects zero entries. Entry identities are deterministic over
 * the enclosing attempt's identity.
 */
export function problemEntriesFromBuildAttempt(
    record: AttemptRecord,
): readonly ProblemSnapshotEntry[] {
    const diagnostics = envelopeDiagnostics(record.outcome);
    const severity = toolDiagnosticSeverity(record.outcome);
    const correlation: EvidenceCorrelation = {
        ...EMPTY_EVIDENCE_CORRELATION,
        generatedSourceIdentity: record.intent.sourceIdentity,
        buildId: record.buildId,
    };
    return diagnostics.map((diagnostic, index) => ({
        identity: `build:${record.buildId.sequence}:${diagnostic.sourceIdentity ?? "unplaced"}@${index}`,
        severity,
        code: null,
        text: diagnostic.message,
        location:
            diagnostic.sourceIdentity !== undefined
                ? { kind: "generated-source", sourceIdentity: diagnostic.sourceIdentity }
                : { kind: "unplaced" },
        correlation,
    }));
}

/**
 * Project the TOOLCHAIN diagnostics of one settled PREVIEW attempt into
 * snapshot entries. Everything is derived from the ENCLOSING owner record
 * and session — never supplied: the correlation carries the attempt's own
 * build id, attempt sequence, the session identity, the intent's
 * generated-source identity, and the publication identity only when this
 * attempt published; the severity is decided by the settlement. An
 * in-flight (pending) or diagnostic-free attempt projects zero entries.
 * Entry identities are deterministic over the enclosing attempt's
 * sequence.
 */
export function problemEntriesFromPreviewAttempt(
    session: PreviewBuildSession,
    record: PreviewAttemptRecord,
): readonly ProblemSnapshotEntry[] {
    if (record.state !== "settled") {
        return [];
    }
    const outcome = record.outcome;
    const diagnostics = envelopeDiagnostics(outcome);
    const severity = toolDiagnosticSeverity(outcome);
    const publicationId = outcome.kind === "published" ? outcome.envelope.publicationId : null;
    const correlation: EvidenceCorrelation = {
        ...EMPTY_EVIDENCE_CORRELATION,
        generatedSourceIdentity: record.intent.generatedSourceIdentity,
        buildId: record.buildId,
        previewAttemptSequence: record.attemptSequence,
        previewSessionId: session.sessionId,
        publicationId,
    };
    return diagnostics.map((diagnostic, index) => ({
        identity: `preview:${record.attemptSequence}:${diagnostic.sourceIdentity ?? "unplaced"}@${index}`,
        severity,
        code: null,
        text: diagnostic.message,
        location:
            diagnostic.sourceIdentity !== undefined
                ? { kind: "generated-source", sourceIdentity: diagnostic.sourceIdentity }
                : { kind: "unplaced" },
        correlation,
    }));
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
