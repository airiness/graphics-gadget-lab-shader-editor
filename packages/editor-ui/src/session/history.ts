/**
 * Document history — the session state behind undo/redo.
 *
 * The stack is a pure value (present + bounded past + future), so it is
 * trivially testable outside React and the app keeps it in one useState.
 * Entries pair the document BEFORE and AFTER one completed change plus a
 * LABEL that names the user intent ("removed connection c3") — the
 * vocabulary the future History panel and any intent list build on.
 *
 * Rules this module enforces:
 * - recording is EXPLICIT: a refused/failed authoring operation must not
 *   be recorded (recording a no-op would make the next undo "undo nothing"
 *   — exposed stale state is not a change);
 * - a no-op NEVER records (recordHistory with the SAME instance returns
 *   the history untouched — and, equally important, it does NOT clear
 *   the redo branch: a change of zero magnitude must not throw away the
 *   user's redo steps);
 * - bounded (HISTORY_LIMIT, one deterministic cap): the oldest steps drop
 *   first, deterministically, for identical input sequences;
 * - undoing/redoing swaps the exact previous/next document instances —
 *   no re-derivation, nothing to drift;
 * - redo is a FUTURE branch: any new recording after an undo discards it
 *   (the classic branch rule — the user has committed a different path).
 *
 * What history does NOT own: the document itself (core model), the dirty
 * baseline (the session), or any React Flow state — the projection
 * follows whatever document history reports to be present.
 */

export interface HistoryEntry<T> {
    readonly before: T;
    readonly after: T;
    readonly label: string;
}

export interface DocumentHistory<T> {
    readonly present: T;
    readonly past: readonly HistoryEntry<T>[];
    readonly future: readonly HistoryEntry<T>[];
    readonly limit: number;
}

/** The maximum number of undo steps retained (one deterministic cap). */
export const HISTORY_LIMIT = 50;

export function createHistory<T>(present: T, limit: number = HISTORY_LIMIT): DocumentHistory<T> {
    return { present, past: [], future: [], limit: Math.max(1, limit) };
}

/**
 * Record one completed change. The label names the intent; the before/
 * after pair is exactly what undo/redo restore — the atomic documents.
 */
export function recordHistory<T>(history: DocumentHistory<T>, next: T, label: string): DocumentHistory<T> {
    // A no-op (the same instance) is not a change: nothing is recorded
    // AND the existing redo branch is preserved — a zero-magnitude
    // action must never discard the user's redo steps.
    if (Object.is(history.present, next)) {
        return history;
    }
    const entry: HistoryEntry<T> = { before: history.present, after: next, label };
    let past: HistoryEntry<T>[] = [...history.past, entry];
    if (past.length > history.limit) {
        past = past.slice(past.length - history.limit);
    }
    return { present: next, past, future: [], limit: history.limit };
}

export function canUndoHistory<T>(history: DocumentHistory<T>): boolean {
    return history.past.length > 0;
}

export function canRedoHistory<T>(history: DocumentHistory<T>): boolean {
    return history.future.length > 0;
}

/** Undo the most recent step (no-op when there is nothing to undo). */
export function undoHistory<T>(history: DocumentHistory<T>): DocumentHistory<T> {
    const step = history.past[history.past.length - 1];
    if (step === undefined) {
        return history;
    }
    return {
        present: step.before,
        past: history.past.slice(0, -1),
        future: [step, ...history.future],
        limit: history.limit,
    };
}

/** Redo the most recently undone step (no-op when the future is empty). */
export function redoHistory<T>(history: DocumentHistory<T>): DocumentHistory<T> {
    const step = history.future[0];
    if (step === undefined) {
        return history;
    }
    return {
        present: step.after,
        past: [...history.past, step],
        future: history.future.slice(1),
        limit: history.limit,
    };
}
