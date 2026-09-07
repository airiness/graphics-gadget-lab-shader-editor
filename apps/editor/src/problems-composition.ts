/**
 * The Problems snapshot composition — pure over the owners' CURRENT facts,
 * consumed through the panel vocabulary's projectors (frozen boundary):
 *
 * - the CURRENT authoring diagnostics (the core's structured facts of the
 *   active document, under the document context),
 * - the build record that is the CURRENT diagnostic coordinate,
 * - the preview row that is the CURRENT diagnostic coordinate,
 * - a SET (unique by stable identity) — replacement, never accumulation.
 *
 * The CURRENT diagnostic coordinate (the rule that keeps the snapshot a
 * snapshot): the NEWEST SETTLED attempt of the line. A pending attempt is
 * not a settlement yet, so it does not move the anchor — while it is in
 * flight the latest settlement's diagnostics remain the current state,
 * and the moment that attempt settles, its settlement becomes the anchor
 * and an older failure's diagnostics drop out. Historical evidence stays
 * with the Build / Preview chronology views; it does not accumulate here.
 * The anchor's selection is over the owners' own records in sequence
 * order — no owner state is re-derived, and the diagnostics themselves
 * project through the vocabulary only (failure envelope -> entries,
 * anything else -> none).
 *
 * Re-composed on every render from the current facts: the owner objects
 * keep their identity across issue / settle while their sessions move
 * underneath — object identity is not a freshness token, so this module
 * never memoizes on it.
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import type { AttemptRecord } from "@gglab/shader-toolchain-client";
import type { NativeBuildSession } from "./native-build-session.js";
import type { PreviewBuildSession } from "./preview-build-session.js";
import {
    createProblemSnapshot,
    problemEntriesFromBuildAttempt,
    problemEntriesFromGraphDiagnostics,
    problemEntriesFromPreviewAttempt,
    previewChronology,
    type PanelDocumentContext,
    type PreviewRow,
    type ProblemSnapshot,
    type ProblemSnapshotEntry,
} from "./panel-vocabulary.js";

/** The build record whose failure diagnostics are the CURRENT state:
 *  the newest settled attempt, and only when it settled as a failure
 *  envelope. A settlement of any other kind — or one that simply does
 *  not exist — carries nothing current. */
export function currentBuildFailureRecord(session: NativeBuildSession | null): AttemptRecord | null {
    if (session === null) {
        return null;
    }
    const attempts = session.line.attempts;
    if (attempts.length === 0) {
        return null;
    }
    // The anchor is the newest SETTLED attempt (the line holds settlements
    // only; the pending attempts live in `inFlight` and are not
    // settlements, so they do not move the anchor).
    const anchor = [...attempts].sort((a, b) => a.buildId.sequence - b.buildId.sequence).at(-1);
    if (anchor === undefined) {
        return null;
    }
    if (anchor.outcome.kind !== "failed" || "envelope" in anchor.outcome === false) {
        return null;
    }
    return anchor;
}

/** The preview row whose failure diagnostics are the CURRENT state: the
 *  newest SETTLED row of the chronology (a pending attempt is not a
 *  settlement yet), and only when it settled as a failure envelope. The
 *  row couples the record with its owning session identity — the
 *  vocabulary's projector reads the row's own correlation, never a
 *  re-pairing. */
export function currentPreviewFailureRow(session: PreviewBuildSession | null): PreviewRow | null {
    if (session === null) {
        return null;
    }
    // The anchor is the newest SETTLED row: walk the chronology (ordered by
    // attempt sequence) from the newest; pending rows are skipped — they are
    // not settlements yet.
    const ordered = [...previewChronology(session)].sort((a, b) => a.record.attemptSequence - b.record.attemptSequence);
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
        const row = ordered[index];
        if (row === undefined || row.record.state !== "settled") {
            continue;
        }
        if (row.record.outcome.kind !== "failed" || "envelope" in row.record.outcome === false) {
            return null; // The newest settlement is not a failure envelope: no current problem.
        }
        return row;
    }
    return null;
}

/** Compose the CURRENT Problems snapshot over the given facts: the
 *  current authoring diagnostics (the core's layer, under the document
 *  context) plus the two lines' current diagnostic coordinates, deduped
 *  by stable identity into the fresh snapshot value. Every input is
 *  lifted verbatim from its owner; nothing here is invented, carried over
 *  from a previous snapshot, or accumulated. */
export function composeProblemSnapshot(
    diagnostics: readonly ShaderGraphDiagnostic[],
    context: PanelDocumentContext,
    buildSession: NativeBuildSession | null,
    previewSession: PreviewBuildSession | null,
): ProblemSnapshot {
    const entries: ProblemSnapshotEntry[] = [...problemEntriesFromGraphDiagnostics(diagnostics, context)];
    const buildRecord = currentBuildFailureRecord(buildSession);
    if (buildRecord !== null) {
        entries.push(...problemEntriesFromBuildAttempt(buildRecord));
    }
    const previewRow = currentPreviewFailureRow(previewSession);
    if (previewRow !== null) {
        entries.push(...problemEntriesFromPreviewAttempt(previewRow));
    }
    // The snapshot is a SET of current problems: one entry per stable
    // identity (the same owner fact appears once, first-seen wins).
    const seen = new Set<string>();
    const unique: ProblemSnapshotEntry[] = [];
    for (const entry of entries) {
        if (!seen.has(entry.identity)) {
            seen.add(entry.identity);
            unique.push(entry);
        }
    }
    return createProblemSnapshot(unique);
}
