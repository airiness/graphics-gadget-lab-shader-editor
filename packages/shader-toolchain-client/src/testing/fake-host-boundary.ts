/**
 * The reference fake: the test-side implementation of the declared
 * host boundary (host-boundary). Independent from the product service,
 * deterministic, without a process, a shell, a timer, or an argv — it
 * scripts the boundary's exact output surface (raw stdout bytes, exit
 * code, timeout/cancel state) so the client's logic and the editor's
 * product path can be exercised end-to-end from pure values.
 *
 * In-flight attempts are fully controllable: with `keepCompilePending`,
 * a compile attempt stays pending until `releasePending()` settles it
 * with the next scripted call or `cancel(buildId)` settles it as
 * canceled — no real time elapses in the script.
 */
import type {
    BoundaryOutput,
    CancelOutcome,
    CompileAttemptHandle,
    DiscoverOutcome,
    DiscoveryRuleFailure,
    DiscoverRequest,
    HostToolBoundary,
    ToolCandidate,
} from "../host-boundary.js";
import type { BuildId, NativeCompileRequest } from "../native-compile-request.js";

/** One scripted boundary call: the whole output surface. */
export interface FakeBoundaryCall {
    /** The exact stdout document (a single-line JSON text) or raw bytes. */
    readonly stdout: string | Uint8Array;
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
    /** When true, compile attempts stay in flight until settled by
     *  `releasePending()` or `cancel(buildId)`. */
    readonly keepCompilePending?: boolean | undefined;
}

/**
 * Encodes UTF-8 from the ES2022 standard library only (no TextEncoder,
 * no host API) — byte-exact for the scripts these tests run.
 */
export function utf8Encode(text: string): Uint8Array {
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
        const codePoint = text.codePointAt(index);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint > 0xffff) {
            index += 1;
        }
        if (codePoint < 0x80) {
            bytes.push(codePoint);
        } else if (codePoint < 0x800) {
            bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        } else if (codePoint < 0x10000) {
            bytes.push(
                0xe0 | (codePoint >> 12),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        } else {
            bytes.push(
                0xf0 | (codePoint >> 18),
                0x80 | ((codePoint >> 12) & 0x3f),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        }
    }
    return Uint8Array.from(bytes);
}

interface PendingCompile {
    readonly buildId: BuildId;
    readonly script: FakeBoundaryCall;
    readonly resolve: (output: BoundaryOutput) => void;
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

    async handshake(candidate: ToolCandidate): Promise<BoundaryOutput> {
        void candidate;
        this.handshakeCallCount += 1;
        return this.toOutput(this.spec.handshake);
    }

    async compile(request: NativeCompileRequest): Promise<CompileAttemptHandle> {
        // The boundary serializes and executes the approved request
        // host-internal; the fake returns the scripted output surface.
        void request;
        this.compileCallCount += 1;
        const buildId: BuildId = { sequence: this.compileCallCount };
        const script = this.compileScriptFor(this.compileCallCount);
        if (this.spec.keepCompilePending === true) {
            let settle: (output: BoundaryOutput) => void = () => undefined;
            const result = new Promise<BoundaryOutput>((resolve) => {
                settle = resolve;
            });
            this.pending.set(buildId.sequence, { buildId, script, resolve: settle });
            return { buildId, result };
        }
        await Promise.resolve();
        return { buildId, result: Promise.resolve(this.toOutput(script)) };
    }

    async cancel(buildId: BuildId): Promise<CancelOutcome> {
        const pending = this.pending.get(buildId.sequence);
        if (pending !== undefined) {
            this.pending.delete(buildId.sequence);
            pending.resolve({
                stdout: new Uint8Array(0),
                exitCode: -1,
                timedOut: false,
                canceled: true,
            });
            return { buildId, canceled: true, alreadySettled: false };
        }
        return { buildId, canceled: false, alreadySettled: true };
    }

    /**
     * Settles one in-flight attempt (its own scripted call) — a specific
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
        pending.resolve(this.toOutput(pending.script));
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
        return {
            stdout,
            exitCode: call.exitCode,
            timedOut: call.timedOut === true,
            canceled: false,
        };
    }
}
