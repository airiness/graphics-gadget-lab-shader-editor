/** Attached Preview Runtime lifetime authority.
 *
 * Ownership rules (frozen):
 * - launch admission is ONLY from `idle` / `launch-refused`;
 * - the `OwnedRuntimeBinding` is retained while `running`, `terminating`, and
 *   `exit-unproven` — released ONLY by a proven exit;
 * - `exit-unproven` (a host `wait-failed` settlement) is sticky: the process
 *   may still exist, so a second launch is structurally impossible, a
 *   re-Stop re-reports the stored fact with NO host call, and strict
 *   teardown re-reports the stored fact;
 * - a single host stop request is shared: `stop()` and
 *   `terminateAndJoin()` join the same request and never issue a second one
 *   for the same RuntimeId; a failed request rolls the state back to
 *   `running` and REJECTS the waiting teardown — it never hangs on a stale
 *   settlement nor is it treated as a proven teardown.
 */
import type {
    PreviewRuntimeBoundary,
    PreviewRuntimeExit,
    PreviewRuntimeId,
    PreviewRuntimeLaunchResult,
    ToolCandidate,
} from "@gglab/shader-toolchain-client";

/** The Runtime lifecycle state, as owned by this manager. */
export type AttachedRuntimeState =
    | { readonly kind: "idle" }
    | { readonly kind: "launching" }
    | { readonly kind: "running"; readonly runtimeId: PreviewRuntimeId; readonly runtimeIdentity: string }
    | { readonly kind: "terminating"; readonly runtimeId: PreviewRuntimeId }
    /** `exit-unproven` ALWAYS carries the same owned binding (identity
     *  non-nullable): the frozen invariant is that ownership persists, and
     *  the type must not allow `exit-unproven` + `ownedRuntime === null`. */
    | {
          readonly kind: "exit-unproven";
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string;
          readonly exit: PreviewRuntimeExit;
      }
    | {
          readonly kind: "launch-refused";
          readonly result: PreviewLaunchRefusal;
      }
    /** The host EXPLICITLY reported a live Runtime for this session, but
     *  this manager has no lease / launch identity / exit settlement for
     *  it, so it cannot prove or manage that Runtime's lifetime. A second
     *  Runtime launch is forbidden, an ownership transition CANNOT commit,
     *  and the absence of an owned binding here is NOT evidence that no
     *  Runtime exists. */
    | { readonly kind: "runtime-ownership-conflict"; readonly runtimeId: PreviewRuntimeId }
    /** The launch command's final admission outcome is UNKNOWN: the host
     *  call REJECTED (e.g. the invoke never delivered a result), but the
     *  host may HAVE spawned the Runtime before failing. This manager has
     *  no RuntimeId / launch identity / exit settlement for it. A second
     *  Runtime launch is forbidden, an ownership transition CANNOT commit,
     *  and the absence of an owned binding here is NOT evidence that no
     *  Runtime exists. No fake recovery in Slice 1; re-proof is a
     *  host-contract matter (session / Runtime query). The attempted
     *  deployment is retained as an IMMUTABLE attempted-candidate fact
     *  (diagnostics / Slice 2 recovery) — it is NOT an owned binding. */
    | {
          readonly kind: "launch-outcome-unproven";
          readonly attemptedDeploymentToolPath: string;
      };

/** The owned Runtime + the deployment toolPath it was launched from
 *  (exact `ToolCandidate.toolPath`; never a Program Descriptor identity).
 *  Null while no Runtime is attached or being launched. */
export type OwnedRuntimeBinding = {
    readonly runtimeId: PreviewRuntimeId;
    readonly runtimeIdentity: string;
    readonly deploymentToolPath: string;
};

export type AttachedRuntimeLaunch =
    | {
          readonly launched: true;
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string;
          readonly exited: Promise<PreviewRuntimeExit>;
      }
    | {
          readonly launched: false;
          readonly reason: "launch-in-flight" | "runtime-attached" | "exit-unproven" | "runtime-ownership-conflict";
          readonly runtimeId: PreviewRuntimeId;
      }
    | { readonly launched: false; readonly reason: "host-refused"; readonly result: PreviewLaunchRefusal }
    | { readonly launched: false; readonly reason: "launch-outcome-unproven" };

export type AttachedRuntimeStop =
    | { readonly outcome: "stop-requested"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "join-in-progress"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "unproven-rejoin"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "not-attached" };

/** The EXPLICIT host refusal kinds that `launch-refused` may carry.
 *  `session-already-running` is deliberately EXCLUDED: that result is an
 *  ownership fact (the host KNOWS a Runtime exists), never a refusal —
 *  `launch-refused + session-already-running` is unrepresentable. */
export type PreviewLaunchRefusal = Exclude<
    PreviewRuntimeLaunchResult,
    { readonly kind: "launched" } | { readonly kind: "session-already-running" }
>;

/** The tri-valued strict-teardown proof. `exit-unproven` is a HONEST fact
 *  (the host could only best-effort kill/wait): callers must keep the prior
 *  ownership. `terminated` requires a proven `terminated`/`exited` exit. */
export type TerminationProof =
    | { readonly outcome: "terminated" }
    | { readonly outcome: "already-exited" }
    | { readonly outcome: "exit-unproven"; readonly runtimeId: PreviewRuntimeId };

export class AttachedPreviewRuntimeManager {
    private stateValue: AttachedRuntimeState = { kind: "idle" };
    /** The attached Runtime's launch candidate (retained while the Runtime
     *  is NOT proven gone). */
    private ownedCandidateValue: ToolCandidate | null = null;
    /** The Runtime's exit settlement captured at attach time (never by a
     *  registry lookup). */
    private exitSettlement: { readonly runtimeId: PreviewRuntimeId; readonly exited: Promise<PreviewRuntimeExit> } | null = null;
    /** The candidate whose launch was attempted — retained through an
     *  UNKNOWN outcome as an immutable attempted-candidate fact
     *  (diagnostics / Slice 2 recovery). It is NOT an owned binding:
     *  `ownedCandidate` stays null until attach. */
    private attemptedCandidateValue: ToolCandidate | null = null;
    /** The attached Runtime's launch identity (retained for the unproven
     *  projection while the Runtime is NOT proven gone). */
    private attachedIdentity: string | null = null;
    /** Single-flight lane: one candidate/session launch at a time; a
     *  concurrent `launch()` joins the SAME attempt. */
    private launchLane: Promise<AttachedRuntimeLaunch> | null = null;
    /** Single-flight lane: one host stop request for the current attached
     *  RuntimeId. `stop()` and `terminateAndJoin()` join the SAME request;
     *  a concurrent re-request after a failure increments the id, so the
     *  stale request's rollback never clobbers the fresh one. */
    private stopLane: Promise<AttachedRuntimeStop> | null = null;
    private stopRequestId = 0;

    constructor(
        private readonly boundary: PreviewRuntimeBoundary,
        private sessionId: string,
    ) {}

    /** Change only a proven-detached session; no old process can adopt the new ID. */
    resetSession(sessionId: string): void {
        if (!/^[0-9a-f]{32}$/.test(sessionId) || sessionId === this.sessionId) throw new Error("A new valid Preview session identity is required");
        if (this.stateValue.kind !== "idle" && this.stateValue.kind !== "launch-refused") throw new Error("Preview session reset requires proven Runtime exit");
        if (this.launchLane !== null || this.stopLane !== null) throw new Error("Preview session reset cannot overlap a Runtime operation");
        this.sessionId = sessionId;
        this.stateValue = { kind: "idle" };
        this.ownedCandidateValue = null;
        this.attemptedCandidateValue = null;
        this.attachedIdentity = null;
        this.exitSettlement = null;
    }

    get state(): AttachedRuntimeState {
        return this.stateValue;
    }

    get launchInFlight(): boolean {
        return this.stateValue.kind === "launching";
    }

    /** The launch candidate the attached Runtime was started from (the
     *  deployment identity for build/observation scoping). */
    get ownedCandidate(): ToolCandidate | null {
        return this.ownedCandidateValue;
    }

    /** The owned Runtime binding: non-null while `running`, `terminating`, or
     *  `exit-unproven`; null for `idle` / `launching` / `launch-refused`.
     *  NOTE: null under `runtime-ownership-conflict` does NOT mean "no
     *  Runtime" — the host knows one exists; callers must read `state`. */
    get ownedRuntime(): OwnedRuntimeBinding | null {
        const state = this.stateValue;
        if (state.kind !== "running" && state.kind !== "terminating" && state.kind !== "exit-unproven") {
            return null;
        }
        const candidate = this.ownedCandidateValue;
        const identity =
            state.kind === "running" ? state.runtimeIdentity : this.attachedIdentity;
        if (candidate === null || identity === null) {
            return null;
        }
        return { runtimeId: state.runtimeId, runtimeIdentity: identity, deploymentToolPath: candidate.toolPath };
    }

    /** Request (strict, single-flight) or JOIN the current attached Runtime
     *  launch. `launch()` is the UI action only: it never performs a
     *  build/retarget and never owns transition commit. */
    launch(candidate: ToolCandidate): Promise<AttachedRuntimeLaunch> {
        const existing = this.launchLane;
        if (existing !== null) {
            return existing;
        }
        const state = this.stateValue;
        if (state.kind === "launch-outcome-unproven") {
            return Promise.resolve({ launched: false, reason: "launch-outcome-unproven" });
        }
        if (state.kind === "runtime-ownership-conflict") {
            return Promise.resolve({ launched: false, reason: "runtime-ownership-conflict", runtimeId: state.runtimeId });
        }
        if (state.kind === "running" || state.kind === "terminating") {
            return Promise.resolve({ launched: false, reason: "runtime-attached", runtimeId: state.runtimeId });
        }
        if (state.kind === "exit-unproven") {
            return Promise.resolve({ launched: false, reason: "exit-unproven", runtimeId: state.runtimeId });
        }
        // `idle` and `launch-refused` are the ONLY admission. `launch-refused`
        // is the retry lane.
        return this.runLaunch(candidate);
    }

    /** Plain user "Stop". Joins the current stop-lane (or issues the single
     *  request). MAY REJECT (host request failure: the state rolled back to
     *  `running` and the caller decides); a failure is never a proven
     *  teardown.
     */
    stop(): Promise<AttachedRuntimeStop> {
        return this.runStopRequest();
    }

    /** Strict teardown (ownership transition): join the pending launch (if
     *  any — an unmount cleanup may race a launch that settles after
     *  unmount), join (or issue) the single host stop request of the current
     *  attached Runtime, then await that Runtime's exit settlement.
     *  RESOLVES with the tri-valued proof (`terminated` after a proven
     *  `stopped`/`exited` exit; `exit-unproven` sticky; `already-exited`
     *  only from no-owned states). REJECTS when the stop request itself
     *  failed — it NEVER hangs on a stale settlement and never treats a
     *  registry miss as a proof.
     */
    async terminateAndJoin(): Promise<TerminationProof> {
        // Join a pending launch lane first — then re-interpret the FINAL
        // ownership state. The launch OUTCOME (launched / refused / conflict
        // / unproven) never decides on its own: `launched === false` is NOT
        // "no Runtime" (the host may have reported one — conflict — or the
        // outcome may be unknown — unproven). Only an explicitly PROVEN
        // no-Runtime state may resolve `already-exited`.
        // Exact launch-lane discipline (mirrors the stop-lane contract):
        // capture the SPECIFIC launch lane this teardown joins and validate
        // it by identity after the await. A launch lane that settles here
        // can never settle `launching` itself — so if a NEW launch intent
        // started in the gap, the captured lane is no longer the current
        // one and this teardown must REJECT. `launching` is an UNKNOWN
        // outcome, NOT a proven no-Runtime state: it must never resolve
        // `already-exited`.
        const capturedLaunchLane = this.launchLane;
        if (capturedLaunchLane !== null) {
            const captured = await capturedLaunchLane;
            if (captured.launched !== true) {
                if (this.launchLane !== null || this.stateValue.kind === "launching") {
                    throw new Error(
                        `a new Preview Runtime launch intent started while this strict teardown was settling its captured launch; the teardown is bound to its captured lane and a fresh launch is a new intent, so the ownership transition was not committed.`,
                    );
                }
                const final = this.stateValue;
                if (final.kind === "runtime-ownership-conflict") {
                    throw new Error(
                        `attached Preview Runtime #${final.runtimeId.sequence} was reported by the host as already running for this session, but this manager owns no lease for it; the ownership transition cannot commit.`,
                    );
                }
                if (final.kind === "launch-outcome-unproven") {
                    throw new Error(
                        `the last Preview Runtime launch outcome is unproven (the host may have spawned a Runtime); a strict teardown cannot be issued without a lease, so the ownership transition cannot commit.`,
                    );
                }
                if (final.kind === "exit-unproven") {
                    return { outcome: "exit-unproven", runtimeId: final.runtimeId };
                }
                if (final.kind === "idle" || final.kind === "launch-refused") {
                    // Only an EXPLICIT host refusal (host-declined) or a
                    // clean start proves no Runtime exists.
                    return { outcome: "already-exited" };
                }
                // `launching` or anything else here is an anomaly: a lane
                // we captured can never settle itself into `launching`.
                throw new Error(
                    `Preview Runtime invariant: strict teardown joined a launch lane whose final state ${final.kind} carries no proven no-Runtime fact; the ownership transition was not committed.`,
                );
            }
            // a successful launch settles below into the running path
        }
        const state = this.stateValue;
        if (state.kind === "launch-outcome-unproven") {
            // The last launch outcome is UNKNOWN: the host may have spawned
            // a Runtime. `already-exited` would be a false ownership proof —
            // a strict teardown is PROHIBITED, not vacuous; the ownership
            // transition cannot commit, and Slice 1 performs no fake
            // recovery (re-proof is a host-contract matter).
            throw new Error(
                `the last Preview Runtime launch outcome is unproven (the host may have spawned a Runtime); a strict teardown cannot be issued without a lease, so the ownership transition cannot commit.`,
            );
        }
        if (state.kind === "runtime-ownership-conflict") {
            // The host reported a live Runtime for this session and this
            // manager owns NO lease for it: `already-exited` would invert
            // an ownership fact. A strict teardown is PROHIBITED, not
            // vacuous — the ownership transition cannot commit.
            throw new Error(
                `attached Preview Runtime #${state.runtimeId.sequence} was reported by the host as already running for this session, but this manager owns no lease for it; the ownership transition cannot commit.`,
            );
        }
        if (state.kind === "launching") {
            // No captured launch lane yet a `launching` state: the lane was
            // lost without settling — an integrity violation, never a
            // proven no-Runtime fact.
            throw new Error(
                `Preview Runtime invariant: the manager observes a launching state with no active launch lane; the ownership transition was not committed.`,
            );
        }
        if (state.kind === "idle" || state.kind === "launch-refused") {
            return { outcome: "already-exited" };
        }
        if (state.kind === "exit-unproven") {
            return { outcome: "exit-unproven", runtimeId: state.runtimeId };
        }
        const runtimeId = state.runtimeId;
        if (state.kind === "running") {
            this.runStopRequest();
        }
        // Exact stop-lane contract: strict teardown awaits the SINGLE stop
        // lane captured for THIS teardown (ours or the concurrent caller's).
        // If that exact lane REJECTS, the teardown rejects immediately — a
        // later retry is a NEW intent: it is never auto-joined here, so the
        // teardown cannot hang on a settlement no live stop request owns.
        const stopLane = this.stopLane;
        if (stopLane !== null) {
            try {
                await stopLane;
            } catch (error) {
                throw new Error(
                    `attached Preview Runtime #${runtimeId.sequence} could not be stopped (the exact stop request failed and its retry is a new intent; the process may still exist, so the strict teardown was not committed).`,
                    { cause: error },
                );
            }
        }
        // Re-read: the exit may have settled (via the stop ACK or naturally)
        // BEFORE we got here — the async exit handler is the authority for a
        // proven teardown.
        const afterStop = this.stateValue;
        if (afterStop.kind === "idle") {
            return { outcome: "terminated" };
        }
        if (afterStop.kind === "exit-unproven" && afterStop.runtimeId.sequence === runtimeId.sequence) {
            return { outcome: "exit-unproven", runtimeId: afterStop.runtimeId };
        }
        const settlement = this.exitSettlement;
        if (settlement === null || settlement.runtimeId.sequence !== runtimeId.sequence) {
            throw new Error(
                `Preview Runtime invariant: attached Runtime #${runtimeId.sequence} has no exit settlement; the teardown cannot be proven complete.`,
            );
        }
        const exit = await settlement.exited;
        if (exit.kind === "wait-failed") {
            const identity = this.attachedIdentity;
            if (identity === null) {
                throw new Error(
                    `Preview Runtime invariant: attached Runtime #${settlement.runtimeId.sequence} settled as wait-failed without a launch identity; ownership cannot be projected.`,
                );
            }
            this.stateValue = {
                kind: "exit-unproven",
                runtimeId: settlement.runtimeId,
                runtimeIdentity: identity,
                exit,
            };
            return { outcome: "exit-unproven", runtimeId: settlement.runtimeId };
        }
        const isProven =
            exit.runtimeId.sequence === settlement.runtimeId.sequence && (exit.kind === "stopped" || exit.kind === "exited");
        if (!isProven) {
            throw new Error(
                `Preview Runtime invariant: Runtime #${exit.runtimeId.sequence} cannot settle the strict teardown of Runtime #${settlement.runtimeId.sequence}.`,
            );
        }
        this.stateValue = { kind: "idle" };
        this.attachedIdentity = null;
        this.ownedCandidateValue = null;
        this.exitSettlement = null;
        return { outcome: "terminated" };
    }

    private runLaunch(candidate: ToolCandidate): Promise<AttachedRuntimeLaunch> {
        this.stateValue = { kind: "launching" };
        this.attemptedCandidateValue = candidate;
        const attempt = this.boundary.launchAttachedPreview(candidate, this.sessionId);
        const lane: Promise<AttachedRuntimeLaunch> = attempt.then(
            (result) => {
                // Clear the lane SYNCHRONOUsly here (before any awaited
                // continuation can run): once the settle is decided, a new
                // launch intent may be admitted — while strict teardowns
                // that captured THIS lane validate it by identity and
                // REJECT rather than adopting that new intent.
                if (this.launchLane === lane) {
                    this.launchLane = null;
                }
                if (result.kind === "session-already-running") {
                    // The host EXPLICITLY knows a live Runtime for this
                    // session; this manager has no lease / identity /
                    // settlement for it. This is an OWNERSHIP fact, not a
                    // plain refusal (the host is not declining). The
                    // attempted-candidate fact no longer describes an
                    // unknown outcome — clear it.
                    this.stateValue = { kind: "runtime-ownership-conflict", runtimeId: result.runtimeId };
                    this.attemptedCandidateValue = null;
                    return { launched: false as const, reason: "runtime-ownership-conflict" as const, runtimeId: result.runtimeId };
                }
                if (result.kind !== "launched") {
                    this.stateValue = { kind: "launch-refused", result };
                    this.attemptedCandidateValue = null;
                    return { launched: false as const, reason: "host-refused" as const, result };
                }
                this.ownedCandidateValue = candidate;
                this.attemptedCandidateValue = null;
                this.attachedIdentity = result.runtimeIdentity;
                this.exitSettlement = { runtimeId: result.runtimeId, exited: result.exited };
                this.stateValue = {
                    kind: "running",
                    runtimeId: result.runtimeId,
                    runtimeIdentity: result.runtimeIdentity,
                };
                void result.exited.then((exit) => this.onExit(exit));
                return {
                    launched: true as const,
                    runtimeId: result.runtimeId,
                    runtimeIdentity: result.runtimeIdentity,
                    exited: result.exited,
                };
            },
            (error: unknown) => {
                if (this.launchLane === lane) {
                    this.launchLane = null;
                }
                this.resetAfterFailure();
                throw error;
            },
        );
        this.launchLane = lane;
        return lane;
    }

    /** Issue (or JOIN) the single host stop request for the current attached
     *  Runtime. A failed request rolls the state back to `running`
     *  (ownership retained — the process may still exist) and REJECTS the
     *  lane; the stale request's rollback never clobbers a fresher one.
     */
    private runStopRequest(): Promise<AttachedRuntimeStop> {
        const existing = this.stopLane;
        if (existing !== null) {
            return existing;
        }
        const state = this.stateValue;
        if (
            state.kind === "runtime-ownership-conflict" ||
            state.kind === "launch-outcome-unproven"
        ) {
            // No lease to act on in either case: a host stop request for a
            // Runtime we never observed (or whose very existence is
            // unproven) is out of contract. (Strict callers use
            // `terminateAndJoin()`, which PROHIBITS both situations.)
            return Promise.resolve({ outcome: "not-attached" });
        }
        if (state.kind === "exit-unproven") {
            return Promise.resolve({ outcome: "unproven-rejoin", runtimeId: state.runtimeId });
        }
        if (state.kind === "terminating") {
            // No stop lane: the request already settled; the teardown of the
            // same Settlement is finalizing — join that, never re-issue.
            return Promise.resolve({ outcome: "join-in-progress", runtimeId: state.runtimeId });
        }
        if (state.kind !== "running") {
            return Promise.resolve({ outcome: "not-attached" });
        }
        const runtimeId = state.runtimeId;
        const runtimeIdentity = state.runtimeIdentity;
        const requestId = ++this.stopRequestId;
        this.stateValue = { kind: "terminating", runtimeId };
        const settleLane = (): void => {
            if (this.stopRequestId === requestId) {
                this.stopLane = null;
            }
        };
        const lane: Promise<AttachedRuntimeStop> = this.boundary.stopAttachedPreview(runtimeId).then(
            () => {
                settleLane();
                return { outcome: "stop-requested" as const, runtimeId };
            },
            (error: unknown) => {
                if (this.stopRequestId === requestId) {
                    const current = this.stateValue;
                    if (current.kind === "terminating" && current.runtimeId.sequence === runtimeId.sequence) {
                        // Roll back: the stop request FAILED; ownership is
                        // retained and a retry is admitted from `running`.
                        // (The exit settlement is NOT invalidated — a natural
                        // exit can still prove the teardown later.)
                        this.stateValue = { kind: "running", runtimeId, runtimeIdentity };
                    }
                }
                settleLane();
                throw error;
            },
        );
        this.stopLane = lane;
        return lane;
    }

    private onExit(exit: PreviewRuntimeExit): void {
        const state = this.stateValue;
        const settlement = this.exitSettlement;
        // Only a settlement we own may migrate state; in particular a
        // stale exit event can never clobber `runtime-ownership-conflict`
        // (the host knows a Runtime exists for this session) or
        // `exit-unproven`.
        const matches =
            (state.kind === "running" || state.kind === "terminating") &&
            settlement !== null &&
            settlement.runtimeId.sequence === exit.runtimeId.sequence;
        if (!matches) {
            return;
        }
        if (exit.kind === "wait-failed") {
            const identity = this.attachedIdentity;
            if (identity === null) {
                throw new Error(
                    `Preview Runtime invariant: Runtime #${settlement.runtimeId.sequence} settled as wait-failed without a launch identity; ownership cannot be projected.`,
                );
            }
            this.stateValue = {
                kind: "exit-unproven",
                runtimeId: settlement.runtimeId,
                runtimeIdentity: identity,
                exit,
            };
            return;
        }
        this.stateValue = { kind: "idle" };
        this.attachedIdentity = null;
        this.ownedCandidateValue = null;
        this.exitSettlement = null;
    }

    private resetAfterFailure(): void {
        // A launch command REJECTION is NOT proof that no Runtime exists:
        // the host can spawn the process and then fail to deliver the
        // result. Enter `launch-outcome-unproven` (an admission refusal
        // is an explicit host fact; a rejection is only an absence of
        // proof). The attempted deployment is retained as an immutable
        // attempted-candidate fact (diagnostics / Slice 2 recovery) —
        // NOT an owned binding.
        const attempted = this.ownedCandidateValue?.toolPath ?? this.attemptedCandidateValue?.toolPath;
        if (attempted === undefined) {
            // An unknown outcome MUST carry its attempted deployment — a
            // missing fact is an integrity violation, never a silent
            // placeholder.
            throw new Error(
                "Preview Runtime invariant: a rejected launch outcome has no recorded attempted deployment; ownership facts are incomplete.",
            );
        }
        this.stateValue = { kind: "launch-outcome-unproven", attemptedDeploymentToolPath: attempted };
        this.ownedCandidateValue = null;
        this.attemptedCandidateValue = null;
        this.exitSettlement = null;
        this.attachedIdentity = null;
    }
}
