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
 * The product guarantees it enforces (design section 6):
 *
 * - ONLY a `Ready` readiness composition issues a native compile
 *   request. Structural, not conventional: the flow's single compile
 *   entry (`compile`) is the only path to an issuer, and the issuer
 *   itself (`beginAdmittedCompile`) is PRIVATE — a `NotReady`
 *   composition cannot reach the boundary through any public call.
 * - The TARGET has exactly one authority (the design's target rule):
 *   the explicit build configuration. `compile` takes the caller's
 *   request FACTS (no target field) and injects the configured target
 *   itself, before the well-formed gate — one request value is both
 *   judged and issued. No call shape can judge one target and issue
 *   another.
 * - DISCOVERY and HANDSHAKE are single-flight: a call made while one is
 *   in flight JOINS that execution (the same promise), so the newest
 *   boundary call is the only one in flight by construction — no late
 *   settlement of an older call can supersede a newer one, and no two
 *   concurrent handshakes for one candidate can even arise. Every
 *   entry point (startup bring-up, the buttons) shares the lane.
 *
 * A handshake, on the other hand, is legal for every resolved
 * candidate — it is the operation that establishes proof; the flow
 * never refuses one on that ground.
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
    requirementsEqual,
    type AttemptOutcome,
    type BuildId,
    type CompileDefine,
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

/** The single one-way target stream: the target's authority is the
 *  explicit build configuration; the request value issued is the caller's
 *  facts plus THAT target — and no other source may provide one. An
 *  unset target composes to an empty value, so the well-formed gate's
 *  own report names it (the readiness side already reported
 *  `TargetNotConfigured`; the gate's reasons stay complete either way). */
function compileRequestFor(facts: CompileRequestFacts, configuredTarget: string | null): NativeCompileRequest {
    return {
        source: facts.source,
        sourceIdentity: facts.sourceIdentity,
        target: configuredTarget ?? "",
        stage: facts.stage,
        entry: facts.entry,
        defines: [...facts.defines],
        includes: [...facts.includes],
    };
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

/** The product compile's verdict on a request (design section 6: only a
 *  `Ready` composition issues): either a structured refusal carrying
 *  the gate's complete reasons (nothing was issued — a value, never a
 *  throw), or the admitted attempt: its identity and its settlement
 *  promise, in flight on the session line from this moment. */
export type CompileAdmission =
    | { readonly admitted: false; readonly gate: CompileGate }
    | { readonly admitted: true; readonly gate: CompileGate; readonly buildId: BuildId; readonly outcome: Promise<AttemptOutcome> };

/** The CALLER's input to a compile: every request fact EXCEPT the
 *  target. The target has exactly one authority — the explicit build
 *  configuration (its own input) — and `compile` itself injects it into
 *  the request value and well-formedness-checks the result. The caller
 *  cannot feed one target to the gate to be judged and another to the
 *  boundary to be issued: the fact stream is single-directional —
 *  configuration → request → BuildIntent. */
export interface CompileRequestFacts {
    readonly source: Uint8Array;
    readonly sourceIdentity: string;
    readonly stage: string;
    readonly entry: string;
    readonly defines: readonly CompileDefine[];
    readonly includes: readonly string[];
}

/** What the inspector reads for the newest compile GATE: the gate's
 *  verdict and, when refused, its complete reasons — and nothing about
 *  any attempt's outcome. That record must stay gate-only: a settle
 *  event arrives for a specific attempt, and stamping that attempt's
 *  outcome onto the newest gate would, under out-of-order settlements,
 *  forge an attempt that never existed (gate N's verdict with attempt
 *  M's outcome). The outcomes have exactly one authority: the build
 *  session's line records (BuildId → intent → outcome), read through
 *  the session anchor. */
export interface CompileGateRecord {
    readonly readiness: NativeBuildReadiness;
    readonly requestWellFormed: { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly detail: string };
    readonly admitted: boolean;
}

export class NativeBuildFlow {
    /** The client's tool verdict — its single state space, updated ONLY
     *  by tool-side events (this flow's wiring of the boundary's facts). */
    private toolState: ToolCompatibilityState = initialToolState;
    private session: NativeBuildSession = createNativeBuildSession();
    private lastDiscovery: DiscoverOutcome | null = null;
    private lastHandshake: HandshakeAttemptRecord | null = null;
    /** The newest gate invocation's RECORD — gate verdict and refusal
     *  facts only. It NEVER carries an attempt's buildId or outcome:
     *  the session line is the single authority for those (a settle
     *  stamping the newest gate would forge attempts under out-of-order
     *  settlements). */
    private gateRecord: CompileGateRecord | null = null;
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
     *  descriptor's own type surface).
     *
     * A re-statement with the SAME value changed nothing — the verdict
     * stands. A DIFFERENT requirement voids any existing verdict: it was
     * judged under the old one, and it is no longer valid for this tool.
     * The candidate observation is still a fact (the tool did not
     * change; the demand did), so the client drops the tool to
     * `discovered` keeping its candidate — and a fresh handshake
     * re-proves it under the new requirement. The editor never compares
     * versions itself, and never re-judges from stored facts: the
     * handshake is the path (the client's own state machine decides;
     * this flow only wires the event).
     *
     * Returns whether a proven / unproven / incompatible verdict was
     * invalidated (the surface can surface that fact).
     */
    updateJudgment(requirement: CompatibilityJudgment["requirement"]): boolean {
        if (requirementsEqual(this.judgment.requirement, requirement)) {
            return false;
        }
        const hadVerdict =
            this.toolState.status === "unproven" || this.toolState.status === "incompatible" || this.toolState.status === "compatible";
        this.judgment = { requirement };
        this.toolState = applyCompatibilityEvent(this.toolState, { kind: "requirement-changed" }, this.judgment);
        // The handshake record stands under the OLD requirement: the
        // inspector must not show it as a proof attempt against the
        // current one (the same rule that voids it on a new observation).
        this.lastHandshake = null;
        return hadVerdict;
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

    /** The GATE record of the newest compile invocation (the
     *  inspector's read for the gate's verdict and, when refused, the
     *  complete reasons) — gate facts only; the attempt outcomes are
     *  read from the build session's line, never from this record.
     *  Named for what it is: the last gate, not the last attempt. */
    get lastGate(): CompileGateRecord | null {
        return this.gateRecord;
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

    private discoveryLane: Promise<DiscoverOutcome> | null = null;

    /** Whether a discovery is in flight — the surface disables
     *  Re-discover for the whole window (a fact, not a UI state). */
    get discoveryInFlight(): boolean {
        return this.discoveryLane !== null;
    }

    private handshakeLane: Promise<HandshakeAttemptRecord> | null = null;

    /** Whether a handshake is in flight — the surface disables the
     *  Handshake button for the whole window (a fact, not a UI state). */
    get handshakeInFlight(): boolean {
        return this.handshakeLane !== null;
    }

    /**
     * `discover`: the boundary resolves over its configuration facts;
     *  the result is a LIFECYCLE EVENT for the tool state (a new
     *  observation is a new fact — the one event that may supersede;
     *  a full failure returns the tool to `unavailable`).
     *
     * Single-flight: while a discovery is IN FLIGHT, a further
     * `discover` call JOINS that exact execution instead of starting a
     * competing one. The newest boundary call is then the only one in
     * flight by construction, so a late settlement can never supersede a
     * newer observation — the same discipline the build line applies to
     * slow old attempts. The service's own lock serializes the
     * implementation; it cannot (and need not) decide which invocation
     * is current — that decision is the flow's, and it is this. The lane
     * closes on settlement, so the next call is a fresh discovery.
     */
    discover(request: DiscoverRequest): Promise<DiscoverOutcome> {
        if (this.discoveryLane === null) {
            this.discoveryLane = this.runDiscovery(request).finally(() => {
                this.discoveryLane = null;
            });
        }
        return this.discoveryLane;
    }

    private async runDiscovery(request: DiscoverRequest): Promise<DiscoverOutcome> {
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

    /**
     * `handshake`: the operation that establishes or refreshes proof.
     *  The flow never refuses a resolved candidate — re-handshaking
     *  `unproven` and `incompatible` is exactly how they enter
     *  `compatible` (and re-enter it after an update at the same path).
     *
     * Single-flight, like discovery: while a handshake is IN FLIGHT, a
     * further `handshake()` call JOINS that exact execution — there is no
     * second concurrent handshake for the same candidate, so no
     * two-attempt "last one settles" question can even arise. Every entry
     * point shares this lane: the startup bring-up and the button. The
     * lane closes on settlement.
     */
    handshake(): Promise<HandshakeAttemptRecord> {
        if (this.handshakeLane === null) {
            this.handshakeLane = this.runHandshake().finally(() => {
                this.handshakeLane = null;
            });
        }
        return this.handshakeLane;
    }

    private async runHandshake(): Promise<HandshakeAttemptRecord> {
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
     *
     * The target the gate JUDGES is composed HERE from the configuration
     * — the caller cannot judge one target and issue another: the very
     * request value the gate checks is the one `compile` hands the
     * boundary.
     */
    compileGate(requestFacts: CompileRequestFacts, input: DescriptorAndTargetInput) {
        const request = compileRequestFor(requestFacts, input.configuredTarget);
        const readiness = this.readiness(input);
        const requestWellFormed = isWellFormedRequest(request);
        const admitted = readinessAdmitsCompile(readiness) && requestWellFormed.ok === true;
        const gate: CompileGate = { readiness, requestWellFormed, admitted };
        // The newest gate invocation's record: gate facts only. Attempt
        // outcomes are NOT stamped here (the session line owns them) —
        // see the CompileGateRecord rationale.
        this.gateRecord = {
            readiness: gate.readiness,
            requestWellFormed: gate.requestWellFormed,
            admitted: gate.admitted,
        };
        return gate;
    }

    /**
     * The product's single compile entry (design section 6: ONLY a
     * `Ready` composition issues a native compile request — no bypass).
     * The gate is composed HERE, and only an admitted request reaches
     * the private admit step: a `NotReady` composition or an ill-formed
     * request is a structured refusal value with its complete reasons,
     * and nothing is issued — there is no public method that issues
     * around it.
     */
    async compile(requestFacts: CompileRequestFacts, input: DescriptorAndTargetInput): Promise<CompileAdmission> {
        const gate = this.compileGate(requestFacts, input);
        if (gate.admitted !== true) {
            return { admitted: false, gate };
        }
        // THE request the gate judged — re-composed identically, so the
        // admitted value and the issued value are one and the same
        // target stream (configuration → request → BuildIntent).
        const request = compileRequestFor(requestFacts, input.configuredTarget);
        const attempt = await this.beginAdmittedCompile(request);
        return { admitted: true, gate, buildId: attempt.buildId, outcome: attempt.outcome };
    }

    /**
     * Issues an ADMITTED compile (the gate already passed — this step is
     * PRIVATE, the only caller above is the gate itself).
     *
     * The snapshot rule (the intent binding): the admitted FACTS —
     * candidate and proven facts — are read ONCE, before the boundary
     * is asked to admit. This attempt's `BuildIntent` is bound to the
     * proof that existed AT ADMISSION, and never to whatever the tool
     * state becomes while the boundary runs or the attempt settles: a
     * rediscovery, a re-handshake, a late invalidation may all land in
     * that window, but they are events for the CURRENT state — they do
     * not backfill a past attempt's identity (a proof binds to the
     * candidate observation it was taken under, and never travels).
     *
     * The attempt is immediately IN FLIGHT in the session store, once
     * the admission has landed; its settlement flows back on the
     * handle's own promise (the client's OUTCOME vocabulary — the line
     * and the inspector read outcomes, never raw bytes). Settling is
     * independent of the await: a cancel (or a slow boundary) resolves
     * the promise, and the session line records the outcome exactly
     * once.
     */
    private async beginAdmittedCompile(request: NativeCompileRequest): Promise<{ buildId: BuildId; outcome: Promise<AttemptOutcome> }> {
        const admitted = this.toolState;
        if (admitted.status !== "compatible") {
            throw new Error("an admitted compile was begun on a tool state the gate would not admit; the gate was bypassed");
        }
        const candidate = admitted.candidate;
        const admission = admitCompile(admitted, candidate);
        if (admission.admitted === false) {
            throw new Error(`an admitted compile would not be admitted by the client: ${admission.reasons.map((r) => r.reason).join(", ")}`);
        }
        const handle = await this.boundary.compile(candidate, request);
        // Snapshot, NOT the current state: the world has had the whole
        // admission window to move on; this attempt's intent does not.
        const intent = buildIntentOf(request, admitted.provenFacts);
        this.session = sessionIssue(this.session, handle.buildId, intent);
        const outcome = (async (): Promise<AttemptOutcome> => {
            const result = await handle.result;
            if (result.kind === "candidate-invalidated") {
                // The compile settlement reported the host's provenance
                // refutation: the SAME lifecycle event as on a handshake
                // — the observation is no longer a fact for the CURRENT
                // state (the machine applies it candidate-scoped and
                // ignores it when it is stale), voiding any proof bound
                // to it, until a fresh discovery + handshake re-enters.
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
            this.session = sessionSettle(this.session, handle.buildId, settled);
            // The outcome lives in the session line (its OWN record,
            // keyed by this attempt's BuildId) — the single authority for
            // "BuildId → intent → outcome". The gate record does NOT get
            // it: stamping a settle onto the newest gate would forge
            // attempts under out-of-order settlements.
            return settled;
        })();
        return { buildId: handle.buildId, outcome };
    }

    /** `cancel`: an explicit action with a value (canceled now, or
     *  already settled). The attempt's settlement itself flows through
     *  the awaiting `compile` — a cancel is a fact the boundary
     *  reports (`timedOut`/`canceled` on the output), not a special
     *  settlement the session invents. */
    async cancel(buildId: BuildId): Promise<{ canceled: boolean; alreadySettled: boolean }> {
        const outcome = await this.boundary.cancel(buildId);
        return { canceled: outcome.canceled, alreadySettled: outcome.alreadySettled };
    }
}
