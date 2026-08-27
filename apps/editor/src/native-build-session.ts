/**
 * The build-line SESSION STORE — editor session state composed over the
 * client's pure build-line rules (design authority: the toolchain
 * integration design, sections 11 and 14).
 *
 * The division of labor is explicit: the RULES (which result is
 * current / stale / last-good inside and across intents, BuildId
 * ordering, late-slow-result discipline) live in
 * @gglab/shader-toolchain-client as pure, fake-tested logic. This module
 * owns only what one session remembers: the ordered line of attempts,
 * which attempts are still in flight, and the most recent issued intent
 * (the `current`-ness anchor of the projection). The session storage is
 * never a persisted contract — a session restart starts fresh, and the
 * durable content identity stays the core's SHA-256 of the emitted
 * bytes.
 *
 * The store is pure values with no host and no clock: the boundary's
 * BuildId is the only ordering input, and the outcomes are the client's
 * `AttemptOutcome` vocabulary — this module adds no interpretation of
 * its own.
 */
import {
    emptyLine,
    recordToLine,
    reportBuildLine,
    type AttemptOutcome,
    type BuildId,
    type BuildIntent,
    type BuildLine,
    type BuildLineReport,
} from "@gglab/shader-toolchain-client";

/** One attempt that was issued and has not settled yet: its identity
 *  and the intent it belongs to (fixed at issue — the intent is the
 *  semantic identity of the compile request, not a guess at settlement
 *  time). */
export interface InFlightBuild {
    readonly buildId: BuildId;
    readonly intent: BuildIntent;
}

/** The session's build-line state. */
export interface NativeBuildSession {
    /** The ordered line of SETTLED attempts (the client's value). */
    readonly line: BuildLine;
    /** The attempts issued and not yet settled (the `in flight` set). */
    readonly inFlight: readonly InFlightBuild[];
    /** The most recent issued attempt — the intent anchor of the
     *  readiness and inspector projections (what "current" means
     *  against), and the target of an in-flight cancel. */
    readonly lastIssued: InFlightBuild | null;
}

export function createNativeBuildSession(): NativeBuildSession {
    return { line: emptyLine(), inFlight: [], lastIssued: null };
}

function findInFlight(session: NativeBuildSession, buildId: BuildId): InFlightBuild | undefined {
    return session.inFlight.find((attempt) => attempt.buildId.sequence === buildId.sequence);
}

function hasBuildId(line: BuildLine, buildId: BuildId): boolean {
    return line.attempts.some((record) => record.buildId.sequence === buildId.sequence);
}

/**
 * Records an issued attempt as in flight. One BuildId names exactly one
 * attempt — issuing a duplicate identity is a programming error, not a
 * state.
 */
export function sessionIssue(session: NativeBuildSession, buildId: BuildId, intent: BuildIntent): NativeBuildSession {
    if (hasBuildId(session.line, buildId) || findInFlight(session, buildId) !== undefined) {
        throw new Error(`build id ${buildId.sequence} already names an attempt; one BuildId is one attempt`);
    }
    const issued: InFlightBuild = { buildId, intent };
    return {
        line: session.line,
        inFlight: [...session.inFlight, issued],
        lastIssued: issued,
    };
}

/**
 * Settles an in-flight attempt into the line, under its outcome (the
 * client's vocabulary). A settlement for an id that was never issued is
 * a programming error — the session has no such attempt to settle.
 */
export function sessionSettle(session: NativeBuildSession, buildId: BuildId, outcome: AttemptOutcome): NativeBuildSession {
    const issued = findInFlight(session, buildId);
    if (issued === undefined) {
        throw new Error(`build id ${buildId.sequence} was never issued into this session`);
    }
    const line = recordToLine(session.line, { buildId: issued.buildId, intent: issued.intent, outcome });
    const inFlight = session.inFlight.filter((attempt) => attempt.buildId.sequence !== buildId.sequence);
    // The intent anchor keeps naming the newest in-flight attempt while
    // any remain; when the line goes quiet it keeps the last settled
    // attempt's intent (the projection stays meaningful after quieting).
    const lastIssued = inFlight[inFlight.length - 1] ?? { buildId: issued.buildId, intent: issued.intent };
    return { line, inFlight, lastIssued };
}

/**
 * The session's projection against one current intent: the client's own
 * report (current / last-good / in-flight / per-attempt states, newest
 * by BuildId first). The `current`-ness anchor is the intent passed in
 * — usually the intent of the last issued attempt.
 */
export function sessionReport(session: NativeBuildSession, currentIntent: BuildIntent): BuildLineReport {
    return reportBuildLine(session.line, currentIntent, session.inFlight.map((attempt) => attempt.buildId));
}

/** The intent anchor of the projection, or an explicit none. */
export function sessionIntentAnchor(session: NativeBuildSession): BuildIntent | null {
    return session.lastIssued?.intent ?? null;
}
