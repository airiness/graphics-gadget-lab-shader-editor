/**
 * The reference fake: the test-side implementation of the declared
 * host boundary (host-boundary). Independent from the product service,
 * deterministic, without a process, a shell, a timer, or an argv — it
 * scripts the boundary's exact settlement surface: the raw output
 * (stdout bytes, stderr bytes, exit code, timeout/cancel state), and —
 * for its pre-spawn guard — the structured candidate-invalidated
 * refusal (changed / missing / unreadable) and the launch-failed fact.
 *
 * In-flight attempts are fully controllable: with `keepCompilePending`,
 * a compile attempt stays pending until `releasePending()` settles it
 * with its scripted call or `cancel(buildId)` settles it as canceled —
 * no real time elapses in the script.
 *
 * The whole output surface is scriptable, stderr INCLUDED (the default
 * is the contract's own channel shape: stdout document, stderr empty),
 * and the pre-spawn settlement is scriptable too: `preSpawn` makes the
 * fake's provenance guard REFUSE the spawn — the boundary's guarantee
 * in its scripted form.
 */
import type {
    BoundaryOutput,
    BoundaryResult,
    CandidateObservation,
    CancelOutcome,
    CompileAttemptHandle,
    DiscoverOutcome,
    DiscoveryRuleFailure,
    DiscoverRequest,
    HostToolBoundary,
    ToolCandidate,
} from "../host-boundary.js";
import type { BuildId, NativeCompileRequest } from "../native-compile-request.js";
import { utf8Encode } from "../utf8.js";

/** One scripted execution: the whole output surface. */
export interface FakeBoundaryCall {
    /** The exact stdout document (a single-line JSON text) or raw bytes. */
    readonly stdout: string | Uint8Array;
    /** The exact stderr bytes: empty (the contract's own channel shape)
     *  by default, scriptable for pollution cases. */
    readonly stderr?: string | Uint8Array | undefined;
    readonly exitCode: number;
    readonly timedOut?: boolean | undefined;
}

export type FakeDiscovery =
    | { readonly kind: "resolved"; readonly candidate: ToolCandidate }
    | { readonly kind: "unavailable"; readonly failures: readonly DiscoveryRuleFailure[] };

export interface FakeToolchainSpec {
    readonly discovery: FakeDiscovery;
    readonly handshake: FakeBoundaryCall;
    /** The scripted compile settlements, consumed in issue order; the
     *  last entry repeats for further attempts. */
    readonly compile: readonly FakeBoundaryCall[];
    /** When set, the fake's pre-spawn settlement REFUSES the spawn —
     *  the candidate-invalidated refusal (with its observation) or the
     *  launch-failed fact, exactly as the boundary contract requires
     *  the host to report it. */
    readonly preSpawn?:
        | {
            readonly refusal: "candidate-invalidated";
            readonly observation: CandidateObservation;
            readonly observedIdentity?: string | undefined;
          }
        | { readonly refusal: "launch-failed" }
        | undefined;
    /** When true, spawn attempts stay in flight until settled by
     *  `releasePending()` or `cancel(buildId)`. */
    readonly keepCompilePending?: boolean | undefined;
    /** When true, discoveries stay in flight until settled by
     *  `releaseDiscovery()` — a controlled window for the flow's
     *  single-flight tests. */
    readonly keepDiscoveryPending?: boolean | undefined;
    /** When true, handshake settlements stay in flight until settled by
     *  `releaseHandshake()` — refusals (pre-spawn) never queue. */
    readonly keepHandshakePending?: boolean | undefined;
}

interface PendingCompile {
    readonly buildId: BuildId;
    readonly script: FakeBoundaryCall;
    readonly resolve: (result: BoundaryResult) => void;
}

export class FakeHostBoundary implements HostToolBoundary {
    private readonly pending = new Map<number, PendingCompile>();
    private handshakeCallCount = 0;
    private compileCallCount = 0;
    private discoverCallCount = 0;
    private discoveryRequestRecord: DiscoverRequest | null = null;
    private pendingDiscovery: { resolve: (outcome: DiscoverOutcome) => void; outcome: DiscoverOutcome } | null = null;
    private pendingHandshake: { resolve: (result: BoundaryResult) => void } | null = null;

    constructor(private readonly spec: FakeToolchainSpec) {}

    /** How many times the scripted surface was exercised — evidence for
     *  the suites, never a protocol fact. */
    get handshakeCalls(): number {
        return this.handshakeCallCount;
    }

    get compileCalls(): number {
        return this.compileCallCount;
    }

    get discoverCalls(): number {
        return this.discoverCallCount;
    }

    /** The LAST request a discovery call carried — the test's evidence of
     *  what the boundary received verbatim (a caller that passed one
     *  world and asked about another is caught here). */
    get lastDiscoveryRequest(): DiscoverRequest | null {
        return this.discoveryRequestRecord;
    }

    async discover(request: DiscoverRequest): Promise<DiscoverOutcome> {
        this.discoverCallCount += 1;
        this.discoveryRequestRecord = request;
        // The boundary resolves the scripted world for its configuration
        // facts; it owns no readiness judgment of its own.
        void request;
        const discovery = this.spec.discovery;
        const outcome: DiscoverOutcome =
            discovery.kind === "resolved"
                ? { candidate: discovery.candidate, failures: [] }
                : { candidate: undefined, failures: [...discovery.failures] };
        if (this.spec.keepDiscoveryPending === true) {
            // The world's discovery stays in flight until the test
            // settles it: a controlled window, no real time.
            return new Promise<DiscoverOutcome>((resolve) => {
                this.pendingDiscovery = { resolve, outcome };
            });
        }
        return outcome;
    }

    async handshake(candidate: ToolCandidate): Promise<BoundaryResult> {
        this.handshakeCallCount += 1;
        const refusal = this.preSpawnRefusal(candidate);
        if (refusal !== undefined) {
            // The provenance refusal settles at the guard, not in flight:
            // it never queues.
            return refusal;
        }
        const settlement: BoundaryResult = { kind: "spawned", output: this.toOutput(this.spec.handshake) };
        if (this.spec.keepHandshakePending === true) {
            // The world's handshake stays in flight until the test
            // settles it: a controlled window, no real time.
            return new Promise<BoundaryResult>((resolve) => {
                this.pendingHandshake = { resolve };
            });
        }
        return settlement;
    }

    /** Settles the in-flight discovery with its own scripted outcome.
     *  Returns false when nothing is pending — an explicit fact, never a
     *  silent skip. */
    releaseDiscovery(): boolean {
        const pending = this.pendingDiscovery;
        if (pending === null) {
            return false;
        }
        this.pendingDiscovery = null;
        pending.resolve(pending.outcome);
        return true;
    }

    /** Settles the in-flight handshake with its own scripted settlement.
     *  Returns false when nothing is pending — an explicit fact, never a
     *  silent skip. */
    releaseHandshake(): boolean {
        const pending = this.pendingHandshake;
        if (pending === null) {
            return false;
        }
        this.pendingHandshake = null;
        pending.resolve({ kind: "spawned", output: this.toOutput(this.spec.handshake) });
        return true;
    }

    async compile(candidate: ToolCandidate, request: NativeCompileRequest): Promise<CompileAttemptHandle> {
        // The boundary serializes and executes the approved request at
        // the candidate path, host-internal; the fake returns the
        // scripted settlement for the candidate given.
        void candidate;
        void request;
        this.compileCallCount += 1;
        const buildId: BuildId = { sequence: this.compileCallCount };
        const refusal = this.preSpawnRefusal(candidate);
        if (refusal !== undefined) {
            // The provenance check runs BEFORE the spawn and refuses it:
            // the settlement is the structured refusal, never a spawn.
            return {
                buildId,
                result: Promise.resolve(refusal),
            };
        }
        const script = this.compileScriptFor(this.compileCallCount);
        if (this.spec.keepCompilePending === true) {
            let settle: (result: BoundaryResult) => void = () => undefined;
            const result = new Promise<BoundaryResult>((resolve) => {
                settle = resolve;
            });
            this.pending.set(buildId.sequence, { buildId, script, resolve: settle });
            return { buildId, result };
        }
        await Promise.resolve();
        return { buildId, result: Promise.resolve({ kind: "spawned", output: this.toOutput(script) }) };
    }

    async cancel(buildId: BuildId): Promise<CancelOutcome> {
        const pending = this.pending.get(buildId.sequence);
        if (pending !== undefined) {
            this.pending.delete(buildId.sequence);
            pending.resolve({
                kind: "spawned",
                output: {
                    stdout: new Uint8Array(0),
                    stderr: new Uint8Array(0),
                    exitCode: -1,
                    timedOut: false,
                    canceled: true,
                },
            });
            return { buildId, canceled: true, alreadySettled: false };
        }
        return { buildId, canceled: false, alreadySettled: true };
    }

    /**
     * Settles one in-flight spawn (its own scripted call) — a specific
     * BuildId when given, otherwise the earliest waiting one. An explicit
     * settlement (a structured pre-spawn refusal the world reports about
     * that attempt) may ride the release: the script is the default, the
     * explicit value is the world's own fact. Returns false when nothing
     * is in flight — an explicit fact, never a silent skip. Settling one
     * attempt never touches the others.
     */
    releasePending(buildId?: BuildId, settlement?: BoundaryResult): boolean {
        const sequence = buildId?.sequence ?? [...this.pending.keys()].sort((a, b) => a - b)[0];
        if (sequence === undefined) {
            return false;
        }
        const pending = this.pending.get(sequence);
        if (pending === undefined) {
            return false;
        }
        this.pending.delete(sequence);
        pending.resolve(settlement ?? { kind: "spawned", output: this.toOutput(pending.script) });
        return true;
    }

    /** The scripted pre-spawn refusal for a candidate, or undefined when
     *  the guard admits the spawn. */
    private preSpawnRefusal(candidate: ToolCandidate): BoundaryResult | undefined {
        const pre = this.spec.preSpawn;
        if (pre === undefined) {
            return undefined;
        }
        if (pre.refusal === "candidate-invalidated") {
            return {
                kind: "candidate-invalidated",
                candidate,
                observation: pre.observation,
                observedIdentity: pre.observedIdentity === undefined ? null : pre.observedIdentity,
            };
        }
        return { kind: "launch-failed", candidate };
    }

    private compileScriptFor(sequence: number): FakeBoundaryCall {
        const list = this.spec.compile;
        if (list.length === 0) {
            throw new Error("the fake toolchain script needs at least one compile call");
        }
        const index = Math.min(sequence - 1, list.length - 1);
        const script = list[index];
        if (script === undefined) {
            throw new Error(`the fake toolchain script ran past its compile calls (sequence ${sequence})`);
        }
        return script;
    }

    private toOutput(call: FakeBoundaryCall): BoundaryOutput {
        const stdout = typeof call.stdout === "string" ? utf8Encode(call.stdout) : call.stdout;
        const stderr =
            call.stderr === undefined
                ? new Uint8Array(0)
                : typeof call.stderr === "string"
                  ? utf8Encode(call.stderr)
                  : call.stderr;
        return {
            stdout,
            stderr,
            exitCode: call.exitCode,
            timedOut: call.timedOut === true,
            canceled: false,
        };
    }
}
