/**
 * The editor orchestration over the host boundary (design authority:
 * the toolchain integration design, sections 6, 8, 9 and 14).
 *
 * This module is the single composition point where the worlds meet:
 *
 * - the client owns the tool state machine, the readers, and the
 *   build-line rules (consumed here as pure logic over fakes in tests);
 * - the boundary (product: the Tauri service; tests: the reference
 *   fake) executes the allowlisted calls and returns raw output facts;
 * - this flow owns ORDER: discover → (admit) handshake → (admit +
 *   compose the well-formed request) compile → settle → line, with the
 *   candidate-lifecycle events fired exactly where the host reports
 *   them (a `candidate-invalidated` settlement IS a tool-lifecycle
 *   event, wherever it lands — handshake or compile, both).
 *
 * The product guarantee it enforces: ONLY a `Ready` readiness
 * composition admits a native compile request (its gate). There is no
 * bypass and no alternative path. A handshake, on the other hand, is
 * legal for every resolved candidate — it is the operation that
 * establishes proof; the flow never refuses one on that ground.
 *
 * No argv exists anywhere in this module: the boundary takes domain-
 * shaped values and owns the serialization host-internal.
 */
import {
    admitCompile,
    admitHandshake,
    applyCompatibilityEvent,
    attemptOutcomeOfCompileResult,
    buildIntentOf,
    initialToolState,
    isWellFormedRequest,
    readHandshakeOutput,
    type AttemptOutcome,
    type BuildId,
    type CompatibilityJudgment,
    type DiscoverOutcome,
    type DiscoverRequest,
    type HostToolBoundary,
    type HandshakeSettlement,
    type NativeCompileRequest,
    type OperationAdmission,
    type ToolFacts,
    type ToolCompatibilityState,
} from "@gglab/shader-toolchain-client";
import {
    createNativeBuildSession,
    sessionIssue,
    sessionSettle,
    type NativeBuildSession,
} from "./native-build-session.js";
import {
    composeNativeBuildReadiness,
    readinessAdmitsCompile,
    type NativeBuildReadiness,
    type NativeReadinessInput,
} from "./native-build-readiness.js";

/** The readiness inputs this flow does NOT own: the descriptor side (the
 *  core's territory, as the app sees it) and the target configuration
 *  (the app's session value). The flow supplies the rest. */
export interface DescriptorAndTargetInput {
    readonly descriptorLoaded: boolean;
    readonly descriptorCompatible: boolean;
    readonly descriptorDetail: string;
    readonly configuredTarget: string | null;
}

/** The host execution capability as the shell observes the service. */
export interface HostCapabilityReport {
    readonly available: boolean;
    readonly detail: string;
}

/** What the inspector reads after a handshake attempt — the admission
 *  gate's verdict and the settlement the flow applied (the state
 *  machine's own transition input). */
export interface HandshakeAttemptRecord {
    readonly admission: OperationAdmission;
    readonly settlement?: HandshakeSettlement | undefined;
    /** True when the settlement was a candidate-invalidated refusal —
     *  a LIFECYCLE event the flow fired (not a proof attempt at all). */
    readonly candidateInvalidated: boolean;
}

/** The gate's verdict: the two parts that AND it (each complete), and
 *  the single admitted fact. Every refusal's reasons live in the parts. */
export interface CompileGate {
    readonly readiness: NativeBuildReadiness;
    readonly requestWellFormed: { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly detail: string };
    readonly admitted: boolean;
}

/** What the inspector reads for the newest compile: the gate's verdict
 *  (complete when refused) and, once the attempt settles, its outcome
 *  and identity — the client's vocabulary, never the raw bytes. */
export interface CompileAttemptRecord {
    readonly readiness: NativeBuildReadiness;
    readonly requestWellFormed: { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly detail: string };
    readonly admitted: boolean;
    readonly buildId?: BuildId | undefined;
    readonly outcome?: AttemptOutcome | undefined;
}

export class NativeBuildFlow {
    /** The client's tool verdict — its single state space, updated ONLY
     *  by tool-side events (this flow's wiring of the boundary's facts). */
    private toolState: ToolCompatibilityState = initialToolState;
    private session: NativeBuildSession = createNativeBuildSession();
    private lastDiscovery: DiscoverOutcome | null = null;
    private lastHandshake: HandshakeAttemptRecord | null = null;
    private lastCompile: CompileAttemptRecord | null = null;
    /** The judgment input over which a handshake proves facts: the
     *  descriptor's process contract, mapped by the composition point —
     *  a CURRENT fact, not a snapshot: a descriptor change refreshes it,
     *  and the next handshake judges against the new contract. */
    private judgment: CompatibilityJudgment;

    constructor(
        private readonly boundary: HostToolBoundary,
        private readonly hostCapability: () => HostCapabilityReport,
        initialJudgment: CompatibilityJudgment,
    ) {
        this.judgment = initialJudgment;
    }

    /** Refreshes the judgment input from the current descriptor (the
     *  composition maps the core's process-contract fact into the
     *  client's plain requirement shape — the client never sees the
     *  descriptor's own type surface). */
    updateJudgment(requirement: CompatibilityJudgment["requirement"]): void {
        this.judgment = { requirement };
    }

    // ---- the inspector's single sources of truth -----------------------

    get tool(): ToolCompatibilityState {
        return this.toolState;
    }

    get buildSession(): NativeBuildSession {
        return this.session;
    }

    get discovery(): DiscoverOutcome | null {
        return this.lastDiscovery;
    }

    get handshakeRecord(): HandshakeAttemptRecord | null {
        return this.lastHandshake;
    }

    get compile(): CompileAttemptRecord | null {
        return this.lastCompile;
    }

    /** The tool's published supported targets as a FACT extracted by the
     *  client — present only while the tool is compatible and proven.
     *  Null is the honest "no proven facts" state, never an empty list
     *  (an empty list would read as "the tool supports no target"). */
    get supportedTargets(): readonly string[] | null {
        if (this.toolState.status !== "compatible") {
            return null;
        }
        return this.toolState.provenFacts.supportedTargets;
    }

    /** The client's proven facts, when the tool is compatible (the
     *  request-composer's tool input for the BuildIntent). */
    get provenFacts(): ToolFacts | null {
        return this.toolState.status === "compatible" ? this.toolState.provenFacts : null;
    }

    /** The host capability, as the shell observed the service. */
    host(): HostCapabilityReport {
        return this.hostCapability();
    }

    // ---- the tool lifecycle ---------------------------------------------

    /** `discover`: the boundary resolves over its configuration facts;
     *  the result is a LIFECYCLE EVENT for the tool state (a new
     *  observation is a new fact — the one event that may supersede;
     *  a full failure returns the tool to `unavailable`). */
    async discover(request: DiscoverRequest): Promise<DiscoverOutcome> {
        const outcome = await this.boundary.discover(request);
        this.lastDiscovery = outcome;
        this.toolState =
            outcome.candidate !== undefined
                ? applyCompatibilityEvent(this.toolState, { kind: "candidate-resolved", candidate: outcome.candidate }, this.judgment)
                : applyCompatibilityEvent(this.toolState, { kind: "discovery-failed" }, this.judgment);
        // A new observation voids the previous handshake record: the
        // inspector must not show a proof attempt for a candidate the
        // state no longer carries.
        this.lastHandshake = null;
        return outcome;
    }

    /** The handshake gate (client's own admission): legal for every
     *  resolved candidate, refused with a structured reason when the
     *  tool is `unavailable` (there is no candidate). */
    handshakeGate(): OperationAdmission {
        return admitHandshake(this.toolState);
    }

    /** `handshake`: the operation that establishes or refreshes proof.
     *  The flow never refuses a resolved candidate — re-handshaking
     *  `unproven` and `incompatible` is exactly how they enter
     *  `compatible` (and re-enter it after an update at the same path). */
    async handshake(): Promise<HandshakeAttemptRecord> {
        const admission = this.handshakeGate();
        if (admission.admitted === false) {
            const record: HandshakeAttemptRecord = { admission, candidateInvalidated: false };
            this.lastHandshake = record;
            return record;
        }
        // The admitted state carries its candidate — the only candidate
        // the boundary may be asked to handshake.
        if (this.toolState.status !== "unavailable" && "candidate" in this.toolState) {
            const candidate = this.toolState.candidate;
            const result = await this.boundary.handshake(candidate);
            if (result.kind === "candidate-invalidated") {
                // The host refuted the resolved observation at spawn
                // time: a LIFECYCLE event (the observation is no longer a
                // fact; a proof bound to it is void). Fired from BOTH
                // sources alike — this one and the compile settlement.
                this.toolState = applyCompatibilityEvent(
                    this.toolState,
                    {
                        kind: "candidate-invalidated",
                        candidate: result.candidate,
                        observation: result.observation,
                        observedIdentity: result.observedIdentity,
                    },
                    this.judgment,
                );
                const record: HandshakeAttemptRecord = {
                    admission,
                    candidateInvalidated: true,
                    settlement: undefined,
                };
                this.lastHandshake = record;
                return record;
            }
            const settlement: HandshakeSettlement =
                result.kind === "launch-failed"
                    ? { kind: "launch-failed" }
                    : { kind: "spawned", process: readHandshakeOutput(result.output) };
            this.toolState = applyCompatibilityEvent(this.toolState, { kind: "handshake", candidate, result: settlement }, this.judgment);
            const record: HandshakeAttemptRecord = { admission, settlement, candidateInvalidated: false };
            this.lastHandshake = record;
            return record;
        }
        // Structurally unreachable: admission passed and the state is
        // resolved, so the candidate arm always held.
        const record: HandshakeAttemptRecord = { admission, candidateInvalidated: false };
        this.lastHandshake = record;
        return record;
    }

    // ---- the product gate + the build line -------------------------------

    /** The readiness composition for one moment — recomposed from the
     *  current facts (tool state, the descriptor side, the host report,
     *  the target configuration, the proven supported targets). */
    readiness(input: DescriptorAndTargetInput): NativeBuildReadiness {
        const host = this.host();
        const all: NativeReadinessInput = {
            tool: this.toolState,
            descriptorLoaded: input.descriptorLoaded,
            descriptorCompatible: input.descriptorCompatible,
            descriptorDetail: input.descriptorDetail,
            hostAvailable: host.available,
            hostDetail: host.detail,
            configuredTarget: input.configuredTarget,
            supportedTargets: this.supportedTargets,
        };
        return composeNativeBuildReadiness(all);
    }

    /**
     * The product gate — the ENTIRE compile admission (one function, one
     * verdict, no path around it): a `Ready` readiness composition AND a
     * well-formed request value, nothing more, nothing less. Refusals
     * carry their COMPLETE structured reasons in the two parts —
     * `readiness.reasons` names every non-Ready input,
     * `requestWellFormed` names the ill-formed side — and the gate
     * never invents an additional verdict of its own.
     */
    compileGate(request: NativeCompileRequest, input: DescriptorAndTargetInput) {
        const readiness = this.readiness(input);
        const requestWellFormed = isWellFormedRequest(request);
        const admitted = readinessAdmitsCompile(readiness) && requestWellFormed.ok === true;
        const gate: CompileGate = { readiness, requestWellFormed, admitted };
        this.lastCompile = {
            readiness,
            requestWellFormed,
            admitted,
        };
        return gate;
    }

    /** Records the outcome of an ADMITTED attempt on the gate record
     *  (the inspector's compile side, one record per attempt). */
    private recordCompile(buildId: BuildId, outcome: AttemptOutcome): void {
        const gate = this.lastCompile;
        if (gate !== null) {
            this.lastCompile = { ...gate, buildId, outcome };
        }
    }

    /**
     * Issues an ADMITTED compile (the gate passed — this method trusts
     * its caller's gate, the product path does not bypass it). The
     * attempt is immediately IN FLIGHT in the session store; its
     * settlement flows back on the handle's own promise (the client's
     * OUTCOME vocabulary — the line and the inspector read outcomes,
     * never raw bytes). Settling is independent of the await: a cancel
     * (or a slow boundary) resolves the promise, and the session line
     * records the outcome exactly once.
     */
    async beginCompile(request: NativeCompileRequest): Promise<{ buildId: BuildId; outcome: Promise<AttemptOutcome> }> {
        if (this.toolState.status !== "compatible") {
            throw new Error("a compile was begun on a tool without a compatible proof; the gate was bypassed");
        }
        const candidate = this.toolState.candidate;
        const admission = admitCompile(this.toolState, candidate);
        if (admission.admitted === false) {
            throw new Error(`a compile was begun the client would not admit: ${admission.reasons.map((r) => r.reason).join(", ")}`);
        }
        const attempt = await this.boundary.compile(candidate, request);
        const intent = buildIntentOf(request, this.toolState.provenFacts);
        this.session = sessionIssue(this.session, attempt.buildId, intent);
        const outcome = (async (): Promise<AttemptOutcome> => {
            const result = await attempt.result;
            if (result.kind === "candidate-invalidated") {
                // The compile settlement reported the host's provenance
                // refutation: the SAME lifecycle event as on a handshake
                // — the observation is no longer a fact, the proof bound
                // to it is void, until a fresh discovery + handshake
                // re-enters.
                this.toolState = applyCompatibilityEvent(
                    this.toolState,
                    {
                        kind: "candidate-invalidated",
                        candidate: result.candidate,
                        observation: result.observation,
                        observedIdentity: result.observedIdentity,
                    },
                    this.judgment,
                );
            }
            const settled = attemptOutcomeOfCompileResult(result);
            this.session = sessionSettle(this.session, attempt.buildId, settled);
            this.recordCompile(attempt.buildId, settled);
            return settled;
        })();
        return { buildId: attempt.buildId, outcome };
    }

    /** `cancel`: an explicit action with a value (canceled now, or
     *  already settled). The attempt's settlement itself flows through
     *  the awaiting `beginCompile` — a cancel is a fact the boundary
     *  reports (`timedOut`/`canceled` on the output), not a special
     *  settlement the session invents. */
    async cancel(buildId: BuildId): Promise<{ canceled: boolean; alreadySettled: boolean }> {
        const outcome = await this.boundary.cancel(buildId);
        return { canceled: outcome.canceled, alreadySettled: outcome.alreadySettled };
    }
}
