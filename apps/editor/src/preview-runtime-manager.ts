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
    | {
          readonly kind: "exit-unproven";
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string | null;
          readonly exit: PreviewRuntimeExit;
      }
    | {
          readonly kind: "launch-refused";
          readonly result: Exclude<PreviewRuntimeLaunchResult, { readonly launched: true }>;
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
          readonly reason: "launch-in-flight" | "runtime-attached" | "exit-unproven";
          readonly runtimeId: PreviewRuntimeId;
      }
    | { readonly launched: false; readonly reason: "host-refused"; readonly result: Exclude<PreviewRuntimeLaunchResult, { readonly launched: true }> };

export type AttachedRuntimeStop =
    | { readonly outcome: "stop-requested"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "join-in-progress"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "unproven-rejoin"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "not-attached" };

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
        private readonly sessionId: string,
    ) {}

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
     *  `exit-unproven`; null for `idle` / `launching` / `launch-refused`. */
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
        const launchLane = this.launchLane;
        if (launchLane !== null) {
            const outcome = await launchLane;
            if (outcome.launched === false) {
                const state = this.stateValue;
                if (state.kind === "exit-unproven") {
                    return { outcome: "exit-unproven", runtimeId: state.runtimeId };
                }
                return { outcome: "already-exited" };
            }
        }
        const state = this.stateValue;
        if (state.kind === "idle" || state.kind === "launch-refused" || state.kind === "launching") {
            return { outcome: "already-exited" };
        }
        if (state.kind === "exit-unproven") {
            return { outcome: "exit-unproven", runtimeId: state.runtimeId };
        }
        const runtimeId = state.runtimeId;
        if (state.kind === "running") {
            this.runStopRequest();
        }
        // A stop request for this Runtime is in flight (ours or a concurrent
        // caller's): join its outcome and let a FAILURE propagate instead of
        // hanging on the stale settlement.
        const stopLane = this.stopLane;
        if (stopLane !== null) {
            try {
                await stopLane;
            } catch (error) {
                const current = this.stateValue;
                if (current.kind !== "terminating") {
                    throw new Error(
                        `attached Preview Runtime #${runtimeId.sequence} could not be stopped (the process may still exist, so the strict teardown was not committed).`,
                        { cause: error },
                    );
                }
                // A fresh stop request is already in progress; join it below.
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
            this.stateValue = {
                kind: "exit-unproven",
                runtimeId: settlement.runtimeId,
                runtimeIdentity: this.attachedIdentity,
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
        const attempt = this.boundary.launchAttachedPreview(candidate, this.sessionId);
        const lane: Promise<AttachedRuntimeLaunch> = attempt.then(
            (result) => {
                if (result.kind !== "launched") {
                    this.stateValue = { kind: "launch-refused", result };
                    return { launched: false as const, reason: "host-refused" as const, result };
                }
                this.ownedCandidateValue = candidate;
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
                this.resetAfterFailure();
                throw error;
            },
        );
        this.launchLane = lane;
        void lane.finally(() => {
            if (this.launchLane === lane) {
                this.launchLane = null;
            }
        });
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
        const matches =
            (state.kind === "running" || state.kind === "terminating") &&
            settlement !== null &&
            settlement.runtimeId.sequence === exit.runtimeId.sequence;
        if (!matches) {
            return;
        }
        if (exit.kind === "wait-failed") {
            this.stateValue = {
                kind: "exit-unproven",
                runtimeId: settlement.runtimeId,
                runtimeIdentity: this.attachedIdentity,
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
        this.stateValue = { kind: "idle" };
        this.ownedCandidateValue = null;
        this.exitSettlement = null;
        this.attachedIdentity = null;
    }
}
