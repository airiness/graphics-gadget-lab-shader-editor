/**
 * The revisioned build-line rules (design authority: the toolchain
 * integration design, section 11) — pure logic, client-owned,
 * host-independent, tested against fakes. The session storage (the
 * ordered line of results for the current session) is editor session
 * state composed over these rules; the line itself is never a persisted
 * contract.
 *
 * Every build result occupies exactly one explicit state:
 *
 * - current      the newest successful result belonging to the current
 *                BuildIntent, and the newest successful attempt within
 *                that intent (BuildId ordering within the intent);
 * - stale        a once-current result displaced by a newer BuildIntent;
 *                retained as evidence, never silently dropped;
 * - last-good    the most recent successful result — preserved across
 *                newer failures;
 * - failed       explicit structured diagnostics from the machine
 *                contract, never prose;
 * - canceled     an in-flight build canceled by the user; explicit, never
 *                lost.
 *
 * A failed or canceled build never erases a safe last-good; a slow old
 * completion that lands after a newer intent cannot become current and
 * cannot replace a newer state — it is classified stale or failed, with
 * its BuildIntent and BuildId visible.
 */
import type { BuildId, BuildIntent } from "./native-compile-request.js";
import { buildIntentsEqual } from "./native-compile-request.js";
import type {
    CompileFailureDocument,
    CompileRejection,
    CompileSuccessDocument,
} from "./result-envelope.js";
import type { ChannelViolation } from "./process-output.js";
import type { BoundaryResult, CandidateObservation } from "./host-boundary.js";
import { readCompileOutput } from "./process-output.js";

/** One structured termination of a failed attempt — each distinct, and
 *  carrying the host's or the contract's own facts (the Build Inspector
 *  can surface them verbatim): `timed-out` (bounded execution ended
 *  it), `channel-violated` (a channel rule of the process contract
 *  broke — with the violation), `no-machine-document` (nothing
 *  machine-readable on the channel — with the structured rejection),
 *  `candidate-invalidated` (the host's pre-spawn provenance check
 *  refused the launch — with the host's own observation facts: changed /
 *  missing / unreadable + the current identity), or `launch-failed`
 *  (bounded execution itself could not launch the candidate). */
export type AttemptTermination =
    | { readonly kind: "timed-out" }
    | { readonly kind: "channel-violated"; readonly violation: ChannelViolation }
    | { readonly kind: "no-machine-document"; readonly rejection: CompileRejection }
    | {
        readonly kind: "candidate-invalidated";
        readonly observation: CandidateObservation;
        readonly observedIdentity: string | null;
      }
    | { readonly kind: "launch-failed" };

/** The read outcome of one attempt. A success carries the tool's own
 *  evidence envelope; a failure carries the tool's own failure envelope
 *  when one was produced and read, or a structured termination fact
 *  (see `AttemptTermination`) when the attempt ended before a machine
 *  document could be read; a cancellation is explicit on its own. */
export type AttemptOutcome =
    | { readonly kind: "succeeded"; readonly envelope: CompileSuccessDocument }
    | {
        readonly kind: "failed";
        readonly envelope?: CompileFailureDocument | undefined;
        readonly termination?: AttemptTermination | undefined;
      }
    | { readonly kind: "canceled" };

/**
 * The client's single mapping of everything the boundary can settle a
 * compile attempt into one attempt outcome — the Build Inspector and the
 * editor record outcomes, they never interpret settlements:
 *
 * - `candidate-invalidated` → a failed attempt, termination carrying
 *   the host's own observation facts (changed / missing / unreadable,
 *   and the current identity when it holds one);
 * - `launch-failed` → a failed attempt under that termination fact;
 * - a spawned `canceled` → `canceled`;
 * - a spawned `timed-out` → a failed attempt (timed-out);
 * - a spawned `channel-violated` → a failed attempt (with the
 *   violation);
 * - a spawned `rejected` → a failed attempt (no-machine-document, with
 *   the structured rejection);
 * - a spawned failure document → a failed attempt with the tool's own
 *   envelope;
 * - a spawned success document → a successful attempt with the tool's
 *   own envelope.
 */
export function attemptOutcomeOfCompileResult(result: BoundaryResult): AttemptOutcome {
    if (result.kind === "candidate-invalidated") {
        return {
            kind: "failed",
            termination: {
                kind: "candidate-invalidated",
                observation: result.observation,
                observedIdentity: result.observedIdentity,
            },
        };
    }
    if (result.kind === "launch-failed") {
        return { kind: "failed", termination: { kind: "launch-failed" } };
    }
    const process = readCompileOutput(result.output);
    if (process.kind === "canceled") {
        return { kind: "canceled" };
    }
    if (process.kind === "timed-out") {
        return { kind: "failed", termination: { kind: "timed-out" } };
    }
    if (process.kind === "channel-violated") {
        return { kind: "failed", termination: { kind: "channel-violated", violation: process.violation } };
    }
    if (process.kind === "rejected") {
        return {
            kind: "failed",
            termination: { kind: "no-machine-document", rejection: process.rejection },
        };
    }
    const document = process.document;
    if (document.success === true) {
        return { kind: "succeeded", envelope: document };
    }
    return { kind: "failed", envelope: document };
}

/** One concrete attempt, bound to the intent it belongs to and ordered
 *  by its BuildId. */
export interface AttemptRecord {
    readonly buildId: BuildId;
    readonly intent: BuildIntent;
    readonly outcome: AttemptOutcome;
}

/** The ordered line of attempts for the current session. */
export interface BuildLine {
    readonly attempts: readonly AttemptRecord[];
}

/** The five explicit states a result occupies (section 11 vocabulary). */
export type AttemptState = "current" | "stale" | "last-good" | "failed" | "canceled";

export function emptyLine(): BuildLine {
    return { attempts: [] };
}

/**
 * Appends one settled attempt to the line. Arrival order is the order
 * results settle — a slow old attempt may land after a newer one — so
 * ordering within an intent is ALWAYS judged by BuildId sequence, never
 * by position. One BuildId names exactly one attempt.
 */
export function recordToLine(line: BuildLine, record: AttemptRecord): BuildLine {
    for (const existing of line.attempts) {
        if (existing.buildId.sequence === record.buildId.sequence) {
            throw new Error(`build id ${record.buildId.sequence} already names an attempt; one BuildId is one attempt`);
        }
    }
    return { attempts: [...line.attempts, record] };
}

function newestSuccessWithin(
    line: BuildLine,
    intent: BuildIntent | undefined,
): AttemptRecord | undefined {
    let best: AttemptRecord | undefined;
    for (const record of line.attempts) {
        if (record.outcome.kind !== "succeeded") {
            continue;
        }
        if (intent !== undefined && !buildIntentsEqual(record.intent, intent)) {
            continue;
        }
        if (best === undefined || record.buildId.sequence > best.buildId.sequence) {
            best = record;
        }
    }
    return best;
}

/**
 * The `current` result: the newest successful attempt WITHIN the current
 * BuildIntent. A result whose intent no longer matches is never current,
 * however recently it arrived.
 */
export function currentAttemptOf(line: BuildLine, currentIntent: BuildIntent): AttemptRecord | undefined {
    return newestSuccessWithin(line, currentIntent);
}

/**
 * The `last-good` result: the most recent successful attempt, preserved
 * across any number of newer failures — a failed newer build never
 * blanks, erases, or downgrades a safe last-good.
 */
export function lastGoodAttemptOf(line: BuildLine): AttemptRecord | undefined {
    return newestSuccessWithin(line, undefined);
}

const isSameAttempt = (a: AttemptRecord, b: AttemptRecord): boolean => a.buildId.sequence === b.buildId.sequence;

/**
 * Classifies one attempt's explicit state for the inspector: every result
 * is exactly one of current / stale / last-good / failed / canceled.
 * `current` wins when the attempt is both the current result and the
 * most recent success — one state per result, the more specific one
 * shown, with the last-good pointer still carried in the report.
 */
export function attemptStateOf(
    line: BuildLine,
    record: AttemptRecord,
    currentIntent: BuildIntent,
): AttemptState {
    if (record.outcome.kind === "canceled") {
        return "canceled";
    }
    if (record.outcome.kind === "failed") {
        return "failed";
    }
    const current = newestSuccessWithin(line, currentIntent);
    if (current !== undefined && isSameAttempt(current, record)) {
        return "current";
    }
    const lastGood = newestSuccessWithin(line, undefined);
    if (lastGood !== undefined && isSameAttempt(lastGood, record)) {
        return "last-good";
    }
    return "stale";
}

/**
 * The readiness/inspector projection of one line against the current
 * intent. In-flight builds (issued, not yet settled) are reported as
 * "in flight", not "current" — readiness and state reports say exactly
 * that. The per-attempt states are newest (by BuildId) first.
 */
export interface BuildLineReport {
    readonly current?: AttemptRecord | undefined;
    readonly lastGood?: AttemptRecord | undefined;
    readonly inFlight: readonly BuildId[];
    readonly states: ReadonlyArray<{
        readonly buildId: BuildId;
        readonly state: AttemptState;
        readonly intent: BuildIntent;
    }>;
}

export function reportBuildLine(
    line: BuildLine,
    currentIntent: BuildIntent,
    inFlight: readonly BuildId[] = [],
): BuildLineReport {
    const states = [...line.attempts]
        .sort((a, b) => b.buildId.sequence - a.buildId.sequence)
        .map((record) => ({
            buildId: record.buildId,
            state: attemptStateOf(line, record, currentIntent),
            intent: record.intent,
        }));
    return {
        current: newestSuccessWithin(line, currentIntent),
        lastGood: newestSuccessWithin(line, undefined),
        inFlight: [...inFlight].sort((a, b) => a.sequence - b.sequence),
        states,
    };
}
