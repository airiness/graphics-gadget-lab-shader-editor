/**
 * The reference fake: the test-side implementation of the declared
 * host boundary (host-boundary). Independent from the product service,
 * deterministic, without a process, a shell, a timer, or an argv — it
 * scripts the boundary's exact output surface (raw stdout bytes, raw
 * stderr bytes, exit code, timeout/cancel state) and its pre-spawn
 * provenance check, so the client's logic and the editor's product path
 * can be exercised end-to-end from pure values.
 *
 * In-flight attempts are fully controllable: with `keepCompilePending`,
 * a compile attempt stays pending until `releasePending()` settles it
 * with its scripted call or `cancel(buildId)` settles it as canceled —
 * no real time elapses in the script.
 *
 * The whole output surface is scriptable, stderr INCLUDED (the default
 * is the contract's own channel shape: stdout document, stderr empty),
 * and the candidate-check behavior is scriptable too:
 * `candidateCheck: { kind: "changed", observedIdentity }` makes the
 * fake's pre-spawn check REFUSE the spawn — exactly the boundary's
 * guarantee in its scripted form.
 */
import type {
    BoundaryOutput,
    BoundaryResult,
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

export { utf8Encode } from "../utf8.js";

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
    /** When set, the fake's pre-spawn provenance check finds the path's
     *  observation CHANGED and refuses to spawn — the structured
     *  candidate-changed settlement, exactly as the boundary contract
     *  requires the host to report it. */
    readonly candidateCheck?: { readonly kind: "changed"; readonly observedIdentity: string } | undefined;
    /** When true, spawn attempts stay in flight until settled by
     *  `releasePending()` or `cancel(buildId)`. */
    readonly keepCompilePending?: boolean | undefined;
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

    constructor(private readonly spec: FakeToolchainSpec) {}

    /** How many times the scripted surface was exercised — evidence for
     *  the suites, never a protocol fact. */
    get handshakeCalls(): number {
        return this.handshakeCallCount;
    }

    get compileCalls(): number {
        return this.compileCallCount;
    }

    async discover(request: DiscoverRequest): Promise<DiscoverOutcome> {
        // The boundary resolves the scripted world for its configuration
        // facts; it owns no readiness judgment of its own.
        void request;
        const discovery = this.spec.discovery;
        if (discovery.kind === "resolved") {
            return { candidate: discovery.candidate, failures: [] };
        }
        return { candidate: undefined, failures: [...discovery.failures] };
    }

    async handshake(candidate: ToolCandidate): Promise<BoundaryResult> {
        this.handshakeCallCount += 1;
        const check = this.spec.candidateCheck;
        if (check !== undefined) {
            return { kind: "candidate-changed", candidate, observedIdentity: check.observedIdentity };
        }
        return {
            kind: "spawned",
            output: this.toOutput(this.spec.handshake),
        };
    }

    async compile(candidate: ToolCandidate, request: NativeCompileRequest): Promise<CompileAttemptHandle> {
        // The boundary serializes and executes the approved request at
        // the candidate path, host-internal; the fake returns the
        // scripted settlement for the candidate given.
        void candidate;
        void request;
        this.compileCallCount += 1;
        const buildId: BuildId = { sequence: this.compileCallCount };
        const check = this.spec.candidateCheck;
        if (check !== undefined) {
            // The provenance check runs BEFORE the spawn and refuses it:
            // the settlement is the structured refusal, never a spawn.
            return {
                buildId,
                result: Promise.resolve({ kind: "candidate-changed", candidate, observedIdentity: check.observedIdentity }),
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
     * BuildId when given, otherwise the earliest waiting one. Returns
     * false when nothing is in flight — an explicit fact, never a silent
     * skip. Settling one attempt never touches the others.
     */
    releasePending(buildId?: BuildId): boolean {
        const sequence = buildId?.sequence ?? [...this.pending.keys()].sort((a, b) => a - b)[0];
        if (sequence === undefined) {
            return false;
        }
        const pending = this.pending.get(sequence);
        if (pending === undefined) {
            return false;
        }
        this.pending.delete(sequence);
        pending.resolve({ kind: "spawned", output: this.toOutput(pending.script) });
        return true;
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
