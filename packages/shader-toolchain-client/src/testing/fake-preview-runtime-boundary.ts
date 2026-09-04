/** Deterministic fake for attached Preview Runtime lifecycle tests. */
import type { ToolCandidate } from "../host-boundary.js";
import type {
    PreviewRuntimeBoundary,
    PreviewRuntimeExit,
    PreviewRuntimeId,
    PreviewRuntimeLaunchResult,
    PreviewRuntimeStopOutcome,
} from "../preview-runtime-boundary.js";

export type FakePreviewRuntimeLaunch = Exclude<
    PreviewRuntimeLaunchResult,
    { readonly kind: "launched" }
> | { readonly kind: "launched"; readonly runtimeIdentity?: string | undefined };

export interface FakePreviewRuntimeSpec {
    readonly launches: readonly FakePreviewRuntimeLaunch[];
    readonly keepLaunchPending?: boolean | undefined;
    /** When set, `stopAttachedPreview` acknowledges the stop request but
     *  holds the process's exit settlement open until `releaseStop()` — a
     *  deterministic "stopping" window for ownership-transition tests. */
    readonly holdStopUntilRelease?: boolean | undefined;
    /** The exit kind `releaseStop()` settles with. `"wait-failed"` models a
     *  host that could only best-effort kill/wait (cannot prove exit).
     *  Defaults to `"stopped"`. */
    readonly stopReleaseKind?: "stopped" | "wait-failed";
}

export class FakePreviewRuntimeBoundary implements PreviewRuntimeBoundary {
    private launchCount = 0;
    private nextRuntimeSequence = 1;
    private lastLaunchRecord: { readonly candidate: ToolCandidate; readonly sessionId: string } | null = null;
    private pendingLaunch: {
        readonly result: PreviewRuntimeLaunchResult;
        readonly resolve: (result: PreviewRuntimeLaunchResult) => void;
    } | null = null;
    private exits = new Map<number, (exit: PreviewRuntimeExit) => void>();
    private heldStop: { readonly runtimeId: PreviewRuntimeId; readonly settle: (exit: PreviewRuntimeExit) => void } | null = null;

    constructor(private readonly spec: FakePreviewRuntimeSpec) {}

    get launchCalls(): number {
        return this.launchCount;
    }

    get lastLaunch(): { readonly candidate: ToolCandidate; readonly sessionId: string } | null {
        return this.lastLaunchRecord;
    }

    async launchAttachedPreview(
        candidate: ToolCandidate,
        sessionId: string,
    ): Promise<PreviewRuntimeLaunchResult> {
        this.launchCount += 1;
        this.lastLaunchRecord = { candidate, sessionId };
        const script = this.scriptFor(this.launchCount);
        const result = script.kind === "launched" ? this.launched(script.runtimeIdentity) : script;
        if (this.spec.keepLaunchPending === true) {
            return new Promise<PreviewRuntimeLaunchResult>((resolve) => {
                this.pendingLaunch = { result, resolve };
            });
        }
        return result;
    }

    async stopAttachedPreview(runtimeId: PreviewRuntimeId): Promise<PreviewRuntimeStopOutcome> {
        const settle = this.exits.get(runtimeId.sequence);
        if (settle === undefined) {
            return { runtimeId, stopRequested: false, alreadySettled: true };
        }
        this.exits.delete(runtimeId.sequence);
        if (this.spec.holdStopUntilRelease === true) {
            this.heldStop = { runtimeId, settle };
            return { runtimeId, stopRequested: true, alreadySettled: false };
        }
        settle({ runtimeId, kind: "stopped", exitCode: null });
        return { runtimeId, stopRequested: true, alreadySettled: false };
    }

    releaseLaunch(): boolean {
        const pending = this.pendingLaunch;
        if (pending === null) {
            return false;
        }
        this.pendingLaunch = null;
        pending.resolve(pending.result);
        return true;
    }

    /** Release a stop held by `holdStopUntilRelease`: the process "exits"
     *  now, settling the `exited` promise of that exact Runtime. */
    releaseStop(): boolean {
        const held = this.heldStop;
        if (held === null) {
            return false;
        }
        this.heldStop = null;
        held.settle({
            runtimeId: held.runtimeId,
            kind: this.spec.stopReleaseKind ?? "stopped",
            exitCode: null,
        });
        return true;
    }

    exit(runtimeId: PreviewRuntimeId, exitCode = 0): boolean {
        const settle = this.exits.get(runtimeId.sequence);
        if (settle === undefined) {
            return false;
        }
        this.exits.delete(runtimeId.sequence);
        settle({ runtimeId, kind: "exited", exitCode });
        return true;
    }

    private launched(runtimeIdentity = "runtime-identity"): PreviewRuntimeLaunchResult {
        const runtimeId = { sequence: this.nextRuntimeSequence };
        this.nextRuntimeSequence += 1;
        let settle: (exit: PreviewRuntimeExit) => void = () => undefined;
        const exited = new Promise<PreviewRuntimeExit>((resolve) => {
            settle = resolve;
        });
        this.exits.set(runtimeId.sequence, settle);
        return { kind: "launched", runtimeId, runtimeIdentity, exited };
    }

    private scriptFor(call: number): FakePreviewRuntimeLaunch {
        if (this.spec.launches.length === 0) {
            throw new Error("the fake Preview Runtime boundary needs at least one launch script");
        }
        const script = this.spec.launches[Math.min(call - 1, this.spec.launches.length - 1)];
        if (script === undefined) {
            throw new Error(`the fake Preview Runtime boundary ran past launch ${call}`);
        }
        return script;
    }
}
