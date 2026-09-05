/**
 * Runtime lifetime authority for the attached Shader Graph Preview Lab.
 *
 * This module owns, and only owns:
 *
 * - the Runtime state machine (`idle`, `launching`, `running`,
 *   `terminating`, `exit-unproven`, `launch-refused`);
 * - launch admission: ONLY from `idle` (and the retry path from
 *   `launch-refused`) — structurally, a Runtime whose exit could not be
 *   proven can never be superseded by a second Runtime;
 * - the owned deployment binding: the exact `ToolCandidate.toolPath`
 *   deployment that launched the Runtime, RETAINED through `terminating`
 *   and `exit-unproven`; released only by a PROVEN exit;
 * - `terminateAndJoin`: the tri-value termination proof, sticky for
 *   `exit-unproven` in this slice (no host re-proof exists: the host
 *   registry entry is a miss, not a proof).
 *
 * What it never owns: build eligibility, the initial-publication proof
 * (a build-line fact), target state, and any build-domain refusal
 * vocabulary. It exposes Runtime facts only; the Coordinator maps them
 * into domain vocabulary.
 */
import type {
    PreviewRuntimeBoundary,
    PreviewRuntimeExit,
    PreviewRuntimeId,
    PreviewRuntimeLaunchResult,
    ToolCandidate,
} from "@gglab/shader-toolchain-client";

export type AttachedRuntimeState =
    | { readonly kind: "idle" }
    | { readonly kind: "launching" }
    | { readonly kind: "running"; readonly runtimeId: PreviewRuntimeId; readonly runtimeIdentity: string }
    | { readonly kind: "terminating"; readonly runtimeId: PreviewRuntimeId; readonly runtimeIdentity: string }
    | {
          readonly kind: "exit-unproven";
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string;
          /** The host's own fact: it could only best-effort kill/wait. */
          readonly exit: PreviewRuntimeExit;
      }
    | {
          readonly kind: "launch-refused";
          readonly result: Exclude<PreviewRuntimeLaunchResult, { readonly kind: "launched" }>;
      };

/** The Runtime ownership binding, projected as facts. Present for
 *  `running`, `terminating`, and `exit-unproven`; null otherwise. */
export interface OwnedRuntimeBinding {
    readonly runtimeId: PreviewRuntimeId;
    readonly runtimeIdentity: string;
    /** Exact ToolCandidate.toolPath of the deployment that launched it. */
    readonly deploymentToolPath: string;
}

/** The stable termination proof contract (Slice 1 -> Slice 2): the host
 *  may gain a native re-proof, the upper contract never changes. */
export type TerminationProof =
    | { readonly outcome: "terminated" }
    | { readonly outcome: "already-exited" }
    | { readonly outcome: "exit-unproven"; readonly runtimeId: PreviewRuntimeId };

export type AttachedRuntimeLaunch =
    | { readonly launched: false; readonly reason: "launch-in-flight" }
    | { readonly launched: false; readonly reason: "runtime-attached"; readonly runtimeId: PreviewRuntimeId }
    | { readonly launched: false; readonly reason: "exit-unproven"; readonly runtimeId: PreviewRuntimeId }
    | {
          readonly launched: false;
          readonly reason: "host-refused";
          readonly result: Exclude<PreviewRuntimeLaunchResult, { readonly kind: "launched" }>;
      }
    | {
          readonly launched: true;
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string;
          readonly exited: Promise<PreviewRuntimeExit>;
      };

export type AttachedRuntimeStop =
    | { readonly outcome: "stop-requested"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "join-in-progress"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "unproven-rejoin"; readonly runtimeId: PreviewRuntimeId }
    | { readonly outcome: "not-attached" };

export class AttachedPreviewRuntimeManager {
    private stateValue: AttachedRuntimeState = { kind: "idle" };
    private launchLane: Promise<AttachedRuntimeLaunch> | null = null;
    /** The exact candidate deployment that owns the current (or last
     *  launched) Runtime. Retained while ownership is retained. */
    private ownedCandidateValue: ToolCandidate | null = null;
    /** The exit settlement of the current attached Runtime. Awaiting
     *  exactly this promise is the proof that this specific process left;
     *  the stop request's outcome is not a proof. */
    private exitSettlement: {
        readonly runtimeId: PreviewRuntimeId;
        readonly exited: Promise<PreviewRuntimeExit>;
    } | null = null;

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

    /** The candidate deployment that owns the Runtime (null when no
     *  ownership is held). Used by the build authority to scope
     *  deployment-isolated facts; it is a projection, not an authority. */
    get ownedCandidate(): ToolCandidate | null {
        return this.ownedCandidateValue;
    }

    /** The Runtime ownership binding as facts: present for `running`,
     *  `terminating`, and `exit-unproven`; null otherwise. */
    get ownedRuntime(): OwnedRuntimeBinding | null {
        if (this.ownedCandidateValue === null) {
            return null;
        }
        const state = this.stateValue;
        if (state.kind === "running" || state.kind === "terminating" || state.kind === "exit-unproven") {
            return {
                runtimeId: state.runtimeId,
                runtimeIdentity: state.runtimeIdentity,
                deploymentToolPath: this.ownedCandidateValue.toolPath,
            };
        }
        return null;
    }

    /** Strict single-flight launch. Admission is ONLY from `idle` or
     *  `launch-refused` (the retry path). Any attached or unproven state
     *  is a structured refusal — never a queued relaunch: one attached
     *  Runtime at a time, and an unproven exit is never superseded. */
    launch(candidate: ToolCandidate): Promise<AttachedRuntimeLaunch> {
        const state = this.stateValue;
        if (state.kind === "running" || state.kind === "terminating") {
            return Promise.resolve({ launched: false, reason: "runtime-attached", runtimeId: state.runtimeId });
        }
        if (state.kind === "exit-unproven") {
            return Promise.resolve({ launched: false, reason: "exit-unproven", runtimeId: state.runtimeId });
        }
        if (this.launchLane !== null) {
            // state is `launching`: join the one in-flight launch (strict
            // single-flight) rather than starting a second.
            return this.launchLane;
        }
        if (state.kind === "launching") {
            return Promise.resolve({ launched: false, reason: "launch-in-flight" });
        }
        // state is `idle` or `launch-refused` (retry) — admitted.
        this.stateValue = { kind: "launching" };
        const promise = this.runLaunch(candidate).finally(() => {
            if (this.launchLane === promise) {
                this.launchLane = null;
            }
        });
        this.launchLane = promise;
        return promise;
    }

    /** Request the stop of the attached Runtime (the plain "Stop" action).
     *  A second request while terminating JOINS the same teardown — it
     *  never issues a second stop request to the host. From `exit-unproven`
     *  it re-reports the stored unproven fact without a host call. */
    async stop(): Promise<AttachedRuntimeStop> {
        const state = this.stateValue;
        if (state.kind === "exit-unproven") {
            return { outcome: "unproven-rejoin", runtimeId: state.runtimeId };
        }
        if (state.kind === "terminating") {
            return { outcome: "join-in-progress", runtimeId: state.runtimeId };
        }
        if (state.kind !== "running") {
            return { outcome: "not-attached" };
        }
        this.stateValue = { kind: "terminating", runtimeId: state.runtimeId, runtimeIdentity: state.runtimeIdentity };
        try {
            await this.boundary.stopAttachedPreview(state.runtimeId);
        } catch (error) {
            const current = this.stateValue;
            if (current.kind === "terminating" && current.runtimeId.sequence === state.runtimeId.sequence) {
                this.stateValue = { kind: "running", runtimeId: state.runtimeId, runtimeIdentity: state.runtimeIdentity };
            }
            throw error;
        }
        return { outcome: "stop-requested", runtimeId: state.runtimeId };
    }

    /** The strict teardown proof. Idempotent: from `exit-unproven` it
     *  returns the stored unproven fact with NO host call (the host keeps
     *  no re-proof authority after the settle loop ends — a later registry
     *  miss is not termination evidence, so no re-proof is attempted).
     *  Resolves `terminated` only for a proven exit; `already-exited` when
     *  no attached Runtime exists. */
    async terminateAndJoin(): Promise<TerminationProof> {
        if (this.launchLane !== null) {
            // A launch in flight settles first, so state reflects the
            // Runtime that actually exists.
            await this.launchLane;
        }
        const state = this.stateValue;
        if (state.kind === "idle" || state.kind === "launch-refused" || state.kind === "launching") {
            return { outcome: "already-exited" };
        }
        if (state.kind === "exit-unproven") {
            return { outcome: "exit-unproven", runtimeId: state.runtimeId };
        }
        // running | terminating
        const settlement = this.exitSettlement;
        if (settlement === null) {
            // An attached Runtime ALWAYS has an exit settlement (set at
            // launch, cleared at exit); reaching this point means the
            // ownership bookkeeping is broken. Failing loudly is strictly
            // safer than pretending the teardown is a no-op.
            throw new Error(
                `Preview Runtime invariant: attached Runtime #${state.runtimeId.sequence} is ${state.kind} but has no exit settlement; the teardown cannot be proven complete.`,
            );
        }
        if (state.kind === "running") {
            await this.stop();
        }
        const exit = await settlement.exited;
        // The exit handler (registered at launch) has already moved the
        // state before this continuation runs: `idle` on a proven exit,
        // `exit-unproven` on a wait-failed one.
        if (this.stateValue.kind === "exit-unproven") {
            return { outcome: "exit-unproven", runtimeId: state.runtimeId };
        }
        if (exit.kind !== "stopped" && exit.kind !== "exited") {
            throw new Error(`Preview Runtime invariant: the exit fact #${exit.runtimeId.sequence} settled as the non-proof kind ${exit.kind} outside the unproven path.`);
        }
        return { outcome: "terminated" };
    }

    private async runLaunch(candidate: ToolCandidate): Promise<AttachedRuntimeLaunch> {
        let result: PreviewRuntimeLaunchResult;
        try {
            result = await this.boundary.launchAttachedPreview(candidate, this.sessionId);
        } catch (error) {
            this.resetAfterFailure();
            throw error;
        }
        if (result.kind !== "launched") {
            this.ownedCandidateValue = null;
            this.exitSettlement = null;
            this.stateValue = { kind: "launch-refused", result };
            return { launched: false, reason: "host-refused", result };
        }
        this.stateValue = { kind: "running", runtimeId: result.runtimeId, runtimeIdentity: result.runtimeIdentity };
        this.ownedCandidateValue = candidate;
        this.exitSettlement = { runtimeId: result.runtimeId, exited: result.exited };
        // Register the exit handler BEFORE any teardown can await the same
        // settlement, so state moves first and awaiters observe reality.
        void result.exited.then((exit) => this.onExit(exit));
        return {
            launched: true,
            runtimeId: result.runtimeId,
            runtimeIdentity: result.runtimeIdentity,
            exited: result.exited,
        };
    }

    private resetAfterFailure(): void {
        this.ownedCandidateValue = null;
        this.exitSettlement = null;
        this.stateValue = { kind: "idle" };
    }

    private onExit(exit: PreviewRuntimeExit): void {
        const state = this.stateValue;
        const matches =
            (state.kind === "running" || state.kind === "terminating") &&
            state.runtimeId.sequence === exit.runtimeId.sequence;
        if (!matches) {
            // A settlement for a different Runtime sequence — or a state
            // that is no longer attached — must never migrate state.
            return;
        }
        if (exit.kind === "wait-failed") {
            // The host could only best-effort kill/wait: it CANNOT prove
            // the process left. Ownership (and the deployment binding —
            // the process may still exist) is retained as unproven.
            this.exitSettlement = null;
            this.stateValue = {
                kind: "exit-unproven",
                runtimeId: exit.runtimeId,
                runtimeIdentity: state.runtimeIdentity,
                exit,
            };
            return;
        }
        // Proven exit (`exited` / `stopped`): ownership is released.
        this.ownedCandidateValue = null;
        this.exitSettlement = null;
        this.stateValue = { kind: "idle" };
    }
}
