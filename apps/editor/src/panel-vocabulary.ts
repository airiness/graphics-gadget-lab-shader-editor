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
 *      arrival position). Settled rows carry the owner's own attempt-state
 *      vocabulary (current / stale / last-good / failed / canceled, judged
 *      by the owner's line rules against the session's issued anchor);
 *      in-flight rows are presented as `in-flight`;
 *    - `PreviewRow` / `previewChronology` over the editor's
 *      `PreviewBuildSession` — every attempt (pending and settled), ordered
 *      by the line's own authority (the `attemptSequence`). The
 *      record/session pairing is produced INSIDE this projection only —
 *      a row carries its session binding, and downstream projections work
 *      from the row, so another session's identity can never be mixed in;
 *    - `ProblemSnapshotEntry` / `ProblemSnapshot` over the diagnostic
 *      layers — the REPLACEABLE CURRENT snapshot, never an append-only log.
 *      Toolchain entries are projected FROM the enclosing attempt only:
 *      failure-envelope diagnostics enter as errors (the settlement says
 *      so — the diagnostic contract itself carries no severity, and the
 *      panel does not invent one); a successful settlement's notes stay
 *      structured evidence with the owner's outcome on the chronology row;
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
 *  - not a place to invent origin: graph facts carry their current document
 *    context; build facts project the editor session's issue-time origin map.
 *    An unbound attempt stays unbound, including for identical generated HLSL.
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
import type { DocumentEvidenceOrigin } from "./document-evidence.js";
import type {
    AttemptOutcome,
    AttemptRecord,
    AttemptState,
    BuildId,
    BuildIntent,
    PreviewAttemptOutcome,
    PreviewAttemptRecord,
    ToolDiagnostic,
} from "@gglab/shader-toolchain-client";
import { reportBuildLine } from "@gglab/shader-toolchain-client";
import type { DiagnosticSeverity, ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
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
 * Document axes come from the current graph context or the owning editor
 * session's issue-time origin. They are never supplied by the active tab at
 * settlement or render time.
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
 *  carried by reference, under the correlation derived from that record and
 *  the attempt state the owner's line rules assign to it. */
export interface SettledBuildRow {
    /** The owner's own attempt-state vocabulary: exactly one of
     *  current / stale / last-good / failed / canceled — judged by the
     *  owner's line rules, not re-interpreted by the panel. */
    readonly state: AttemptState;
    readonly buildId: BuildId;
    readonly intent: BuildIntent;
    readonly record: AttemptRecord;
    readonly outcome: AttemptOutcome;
    readonly correlation: EvidenceCorrelation;
}

/** One row of the Build chronology: in-flight attempts present as
 *  `in-flight` (the owner's report discipline for issued-and-not-settled
 *  work), settled attempts present under the owner's attempt-state
 *  vocabulary. Both are owned by the owner's session — the panel presents,
 *  it does not keep its own in-flight bookkeeping or re-judge states. */
export type BuildRow = InFlightBuildRow | SettledBuildRow;

function buildCorrelationFrom(record: { readonly buildId: BuildId; readonly intent: BuildIntent }, session?: NativeBuildSession): EvidenceCorrelation {
    // Origin is an editor-session fact captured at issue, never a source lookup.
    return {
        ...EMPTY_EVIDENCE_CORRELATION,
        generatedSourceIdentity: record.intent.sourceIdentity,
        documentSessionId: session?.origins?.get(record.buildId.sequence)?.documentSessionId ?? null,
        documentRevision: session?.origins?.get(record.buildId.sequence)?.documentRevision ?? null,
        buildId: record.buildId,
    };
}

/**
 * The Build view's chronology: the owner's session — settled AND in-flight
 * attempts — projected in the line's own ordering authority. Arrival order
 * is NOT chronology (a slow old attempt may land after a newer one) — the
 * ordering is judged by the BuildId sequence, never by position. A build
 * in flight is a row in this chronology, not an invisible gap: it is
 * presented as `in-flight` until its owner settles it. Each settled row
 * carries the attempt state assigned by the OWNER'S line rules (current /
 * stale / last-good / failed / canceled, judged against the session's
 * issued-anchor intent) — the presentation layer renders these states, it
 * never re-interprets them. Returns a fresh array; the owner's session is
 * untouched.
 */
export function buildChronology(session: NativeBuildSession): readonly BuildRow[] {
    const anchor = session.lastIssued;
    if (anchor === null) {
        // The session store's own invariant: once an attempt lands in the
        // line, a last-issued anchor exists (issue precedes settlement).
        // A line without one is a violated invariant — refuse to judge
        // currentness instead of fabricating a state.
        if (session.line.attempts.length > 0) {
            throw new Error("a settled build line must carry its issued anchor for state judgment");
        }
        return [];
    }
    // The owner's own line rules assign exactly one state to every settled
    // attempt in the line (current / stale / last-good / failed /
    // canceled); the panel reads those assignments, it does not derive its
    // own.
    const report = reportBuildLine(session.line, anchor.intent);
    const settled: BuildRow[] = session.line.attempts.map(
        (record): SettledBuildRow => {
            // The owner's own invariant: the line's report assigns exactly
            // ONE state to every settled attempt of the line. A missing
            // state is a broken invariant, not a state the panel may fill
            // in — refuse to project rather than re-judge (in particular,
            // rather than quietly call the absent attempt `stale`).
            const reported = report.states.find((entry) => entry.buildId.sequence === record.buildId.sequence);
            if (reported === undefined) {
                throw new Error(
                    `build line state for BuildId ${record.buildId.sequence} is missing from the owner's line report`,
                );
            }
            return {
                state: reported.state,
                buildId: record.buildId,
                intent: record.intent,
                record,
                outcome: record.outcome,
                correlation: buildCorrelationFrom(record, session),
            };
        },
    );
    const inFlight: BuildRow[] = session.inFlight.map(
        (record): InFlightBuildRow => ({
            state: "in-flight",
            buildId: record.buildId,
            intent: record.intent,
            record,
            correlation: buildCorrelationFrom(record, session),
        }),
    );
    return [...settled, ...inFlight].sort((a, b) => a.buildId.sequence - b.buildId.sequence);
}

// ---- Preview chronology (owner: the editor's Preview build session) --------

/**
 * The module-private brand of a Preview row. The preview-chronology
 * projection alone produces rows: the brand carries the record and its
 * owning session identity as ONE unit, and closes the normal typed path by
 * which a caller could hand-assemble a record/correlation pairing (and
 * thereby mix another session's identity into a row's correlation). An
 * `as any` escape is outside the scope of every such boundary, as usual.
 */
declare const previewRowBrand: unique symbol;

/** One row of the Preview chronology: the owner's preview attempt record,
 *  carried by reference, under the correlation derived from that record and
 *  the session identity that owns the line. A branded projection value —
 *  CONSUMABLE anywhere, PRODUCIBLE only by the preview-chronology
 *  projection (the module's single brand site). */
export interface PreviewRow {
    readonly origin: DocumentEvidenceOrigin | null;
    readonly record: PreviewAttemptRecord;
    readonly correlation: EvidenceCorrelation;
    readonly [previewRowBrand]: true;
}

/**
 * Project one preview-line attempt record into a Preview row, bound to the
 * session that OWNS the line. The correlation is derived: the record's
 * build id, its attempt sequence, the session identity that owns the line,
 * the record's intent generated-source identity — and the publication
 * identity ONLY when this attempt actually published (a pending or failed
 * attempt carries none). Document axes and the source map come from the
 * owning editor session's issue-time origin map, when present.
 *
 * Deliberately NOT a public entry point: the record and its session must
 * be paired only inside the owner projection (a row carries the binding,
 * so downstream projections of a row can never mix another session's
 * identity into the row's correlation).
 */
function previewRowFromAttempt(session: PreviewBuildSession, record: PreviewAttemptRecord): PreviewRow {
    const publicationId =
        record.state === "settled" && record.outcome.kind === "published" ? record.outcome.envelope.publicationId : null;
    const correlation: EvidenceCorrelation = {
        ...EMPTY_EVIDENCE_CORRELATION,
        generatedSourceIdentity: record.intent.generatedSourceIdentity,
        documentSessionId: session.origins?.get(record.buildId.sequence)?.documentSessionId ?? null,
        documentRevision: session.origins?.get(record.buildId.sequence)?.documentRevision ?? null,
        buildId: record.buildId,
        previewAttemptSequence: record.attemptSequence,
        previewSessionId: session.sessionId,
        publicationId,
    };
    // The module's SINGLE brand site: the record and its owning session
    // identity are coupled into one projection value here, and nowhere
    // else. (A phantom brand cannot be set by an object literal, so the
    // one type assertion lives at this one producer, by construction.)
    return { record, correlation, origin: session.origins?.get(record.buildId.sequence) ?? null } as PreviewRow;
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
    | { readonly kind: "environment"; readonly root: string; readonly dataPath: string }
    | { readonly kind: "graph"; readonly dataPath: string }
    | { readonly kind: "generated-source"; readonly sourceIdentity: string }
    | { readonly kind: "unplaced" };

/** One entry of the PROBLEMS snapshot: a current diagnostic fact, kept
 *  structured (severity, the owner's stable code when the layer has one,
 *  the owner's location authority) under the identities that correlate it.
 */
export interface ProblemSnapshotEntry {
    readonly origin?: DocumentEvidenceOrigin | null;
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
        identity: `graph:${context.documentSessionId}:${diagnostic.code}:${diagnostic.dataPath}@${index}`,
        severity: diagnostic.severity,
        code: diagnostic.code,
        text: diagnostic.message,
        location: { kind: "graph", dataPath: diagnostic.dataPath },
        correlation,
    }));
}

/**
 * The diagnostics a FAILURE settlement's envelope reports — and nothing
 * else. The tool diagnostic contract carries NO severity field, so the
 * panel must not invent one: a diagnostic only enters the Problems view
 * where the owner's settlement contract makes it a failure payload (a
 * failure envelope — an error, per that very settlement). Diagnostics
 * accompanying a successful settlement are structured notes that remain
 * with the owner's outcome on the chronology row — visible to the view
 * through the owner's own vocabulary, not re-labelled by the panel.
 * A canceled attempt, a termination without an envelope, or a successful
 * settlement projects none here.
 */
function failedEnvelopeDiagnostics(
    outcome: AttemptOutcome | PreviewAttemptOutcome,
): readonly ToolDiagnostic[] | null {
    if (outcome.kind === "failed" && "envelope" in outcome) {
        return outcome.envelope.diagnostics;
    }
    return null;
}

/**
 * Project the TOOLCHAIN diagnostics of one settled build attempt into
 * snapshot entries. Only a FAILURE ENVELOPE projects entries — its
 * diagnostics are errors (the settlement says so; the panel adds no
 * interpretation). Everything else — a cancellation, a termination without
 * an envelope, a successful settlement's notes — projects zero entries and
 * stays with the owner's outcome. The correlation is derived from the
 * ENCLOSING record — the attempt's own build id, its intent's generated
 * source identity (the diagnostic may carry no location fact of its own,
 * and the enclosure supplies the missing generated-source axis) — never
 * supplied. The location takes the diagnostic's own source identity when
 * it reports one, else stays honestly `unplaced`. Entry identities are
 * deterministic over the enclosing attempt's identity.
 */
export function problemEntriesFromBuildAttempt(record: AttemptRecord, session?: NativeBuildSession): readonly ProblemSnapshotEntry[] {
    const diagnostics = failedEnvelopeDiagnostics(record.outcome);
    if (diagnostics === null) {
        return [];
    }
    if (session !== undefined && !session.line.attempts.includes(record)) {
        throw new Error("Build diagnostics must be projected from their owning session");
    }
    const correlation = buildCorrelationFrom(record, session);
    return diagnostics.map(
        (diagnostic, index): ProblemSnapshotEntry => ({
            origin: session?.origins?.get(record.buildId.sequence) ?? null,
            identity: `build:${record.buildId.sequence}:${diagnostic.sourceIdentity ?? "unplaced"}@${index}`,
            severity: "error",
            code: null,
            text: diagnostic.message,
            location:
                diagnostic.sourceIdentity !== undefined
                    ? { kind: "generated-source", sourceIdentity: diagnostic.sourceIdentity }
                    : { kind: "unplaced" },
            correlation,
        }),
    );
}

/**
 * Project the TOOLCHAIN diagnostics of one PREVIEW attempt into snapshot
 * entries, working from a Preview ROW — the safely-bound pairing of the
 * record with the session that owns the line (built by the preview
 * chronology projection, where the record and its session identity are
 * coupled once). Only a FAILURE ENVELOPE projects entries — its diagnostics
 * are errors (the settlement says so); a published settlement's notes, a
 * cancellation, or a termination without an envelope projects zero entries
 * and stays with the owner's outcome. The correlation is the row's own —
 * the attempt's build id, attempt sequence, the owning session identity,
 * the intent's generated-source identity — carried over, never re-derived
 * or re-paired. Entry identities are deterministic over the enclosing
 * attempt's sequence.
 */
export function problemEntriesFromPreviewAttempt(row: PreviewRow): readonly ProblemSnapshotEntry[] {
    const record = row.record;
    if (record.state !== "settled") {
        return [];
    }
    const diagnostics = failedEnvelopeDiagnostics(record.outcome);
    if (diagnostics === null) {
        return [];
    }
    return diagnostics.map(
        (diagnostic, index): ProblemSnapshotEntry => ({
            origin: row.origin,
            identity: `preview:${row.correlation.previewSessionId}:${record.attemptSequence}:${diagnostic.sourceIdentity ?? "unplaced"}@${index}`,
            severity: "error",
            code: null,
            text: diagnostic.message,
            location:
                diagnostic.sourceIdentity !== undefined
                    ? { kind: "generated-source", sourceIdentity: diagnostic.sourceIdentity }
                    : { kind: "unplaced" },
            correlation: row.correlation,
        }),
    );
}

/** A fresh snapshot over the given entries (copied — the caller's array is
 *  never aliased into the view). */
export function createProblemSnapshot(entries: readonly ProblemSnapshotEntry[]): ProblemSnapshot {
    const unique = new Map<string, ProblemSnapshotEntry>();
    for (const entry of entries) if (!unique.has(entry.identity)) unique.set(entry.identity, entry);
    return { entries: [...unique.values()] };
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
    return createProblemSnapshot(entries);
}

// ---- View axis --------------------------------------------------------------

/** The three views that render a chronology (Problems is the snapshot view
 *  and is deliberately excluded here). Each keeps its OWN ordering axis:
 *  the Output line's presentation sequence, the build line's BuildId
 *  sequences, the preview line's attempt sequences — a shared clock is
 *  deliberately NOT imposed. */
export type PanelChronologyView = Exclude<BottomPanelTab, "problems">;
