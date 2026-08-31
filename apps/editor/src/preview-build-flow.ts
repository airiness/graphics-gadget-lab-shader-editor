/**
 * Pure Editor orchestration for the attached Shader Graph Preview build path.
 *
 * This module owns order, never compiler policy:
 *
 * - exact graph/descriptor/emission eligibility is composed before a request;
 * - the dedicated Preview handshake is single-flight for one exact
 *   candidate + requirement and its proof never travels to another candidate;
 * - one SessionId issues monotonically increasing AttemptSequence values;
 * - a newer eligible build cancels an older in-flight build and waits for its
 *   terminal settlement before it can issue;
 * - settlements enter the client's Pending/Published/Failed/Canceled line;
 * - candidate/session-scoped Runtime observations are read single-flight,
 *   strictly decoded, cross-linked, and monotonically accepted before they
 *   can project Current/LastGood/Stale/Rejected;
 * - attached Runtime startup is success-first, candidate/session-bound, and
 *   single-flight, with host-issued process identity and explicit teardown.
 */
import {
    admitPreviewBuild,
    candidatesEqual,
    isWellFormedPreviewBuildRequest,
    judgePreviewEligibility,
    previewAttemptOutcomeOfBuildResult,
    previewBuildIntentOf,
    projectPreviewRuntime,
    acceptPreviewObservation,
    readPreviewObservation,
    readPreviewHandshakeOutput,
    type BoundaryResult,
    type BuildId,
    type HostToolBoundary,
    type NativePreviewBuildRequest,
    type PreviewAttemptOutcome,
    type PreviewEligibility,
    type PreviewEligibilityRequirement,
    type PreviewHandshakeProcessOutcome,
    type PreviewObservation,
    type PreviewObservationBoundary,
    type PreviewObservationBinding,
    type PreviewObservationHostReadResult,
    type PreviewObservationOrderingRejection,
    type PreviewObservationReadRejection,
    type PreviewRuntimeProjection,
    type PreviewRuntimeBoundary,
    type PreviewRuntimeExit,
    type PreviewRuntimeId,
    type PreviewRuntimeLaunchResult,
    type PreviewRuntimeStopOutcome,
    type PreviewRequestWellFormed,
    type ToolCandidate,
    type ToolCompatibilityState,
} from "@gglab/shader-toolchain-client";
import {
    sha256Hex,
    utf8Encode,
    type HlslEmission,
    type ShaderGraphDocument,
    type SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";
import {
    createPreviewBuildSession,
    previewSessionIssue,
    previewSessionSettle,
    type PreviewBuildSession,
} from "./preview-build-session.js";
import {
    selectPreviewInputContract,
    type PreviewInputContractMismatch,
    type PreviewInputContractSelection,
} from "./preview-input-contract.js";

type CandidateInvalidatedResult = Extract<BoundaryResult, { readonly kind: "candidate-invalidated" }>;

/** The ordinary tool state remains one authority. The Preview flow reads it
 *  at every gate and sends candidate-invalidated host facts back to that
 *  owner; it never keeps a private copy of ordinary compatibility. */
export interface PreviewToolStatePort {
    current(): ToolCompatibilityState;
    candidateInvalidated(result: CandidateInvalidatedResult): void;
}

/** Current editor/core facts from which the Preview request is composed. No
 *  input-contract ID or source bytes are caller claims: both are derived. */
export interface PreviewCompositionInput {
    readonly document: ShaderGraphDocument;
    readonly descriptor: SurfaceProfileDescriptor | null;
    readonly descriptorCompatible: boolean;
    readonly emission: HlslEmission | null;
    readonly configuredTarget: string | null;
    /** Trusted identity of the main-owned Preview Program Descriptor that
     *  this editor release consumes. */
    readonly previewProgramDescriptorIdentity: string | null;
}

export type PreviewCompositionRefusal =
    | { readonly reason: "descriptor-unavailable" }
    | { readonly reason: "descriptor-incompatible" }
    | { readonly reason: "emission-unavailable" }
    | { readonly reason: "target-not-configured" }
    | { readonly reason: "preview-program-descriptor-identity-unavailable" }
    | { readonly reason: "input-contract-unsupported"; readonly mismatch: PreviewInputContractMismatch }
    | {
          readonly reason: "generated-source-identity-mismatch";
          readonly declared: string;
          readonly computed: string;
      };

interface PreviewCompositionFacts {
    readonly targetProfile: string;
    readonly descriptorIdentity: string;
    readonly inputContract: PreviewInputContractSelection;
    readonly generatedSourceIdentity: string;
    readonly generatedSourceBytes: Uint8Array;
}

type PreviewComposition =
    | { readonly ready: true; readonly facts: PreviewCompositionFacts }
    | { readonly ready: false; readonly refusal: PreviewCompositionRefusal };

export type PreviewHandshakeAttemptRecord =
    | {
          readonly kind: "refused";
          readonly refusal:
              | PreviewCompositionRefusal
              | {
                    readonly reason: "ordinary-tool-not-compatible";
                    readonly toolStatus: ToolCompatibilityState["status"];
                };
      }
    | {
          readonly kind: "candidate-invalidated";
          readonly candidate: ToolCandidate;
          readonly result: CandidateInvalidatedResult;
          readonly stale: boolean;
      }
    | { readonly kind: "launch-failed"; readonly candidate: ToolCandidate; readonly stale: boolean }
    | {
          readonly kind: "settled";
          readonly candidate: ToolCandidate;
          readonly requirement: PreviewEligibilityRequirement;
          readonly process: PreviewHandshakeProcessOutcome;
          readonly eligibility: PreviewEligibility;
          readonly stale: boolean;
      };

export type PreviewBuildGateReason =
    | PreviewCompositionRefusal
    | { readonly reason: "ordinary-tool-not-compatible"; readonly toolStatus: ToolCompatibilityState["status"] }
    | { readonly reason: "attached-runtime-deployment-mismatch" }
    | { readonly reason: "preview-proof-missing" }
    | { readonly reason: "preview-ineligible"; readonly eligibility: PreviewEligibility }
    | { readonly reason: "request-not-well-formed"; readonly verdict: Exclude<PreviewRequestWellFormed, { ok: true }> };

export interface PreviewBuildGate {
    readonly admitted: boolean;
    readonly reasons: readonly PreviewBuildGateReason[];
    /** Present only after Preview proof admitted this exact requirement. The
     *  design requires proof before the request is formed. */
    readonly request: NativePreviewBuildRequest | null;
    readonly eligibility: PreviewEligibility | null;
}

export type PreviewBuildLaunch =
    | { readonly issued: false; readonly reason: "gate-refused"; readonly gate: PreviewBuildGate }
    | { readonly issued: false; readonly reason: "superseded-before-issue"; readonly gate: PreviewBuildGate }
    | {
          readonly issued: true;
          readonly gate: PreviewBuildGate;
          readonly attemptSequence: number;
          readonly buildId: BuildId;
          readonly outcome: Promise<PreviewAttemptOutcome>;
      };

type PreviewObservationCandidateInvalidated = Extract<
    PreviewObservationHostReadResult,
    { readonly kind: "candidate-invalidated" }
>;

export type PreviewObservationRefresh =
    | { readonly kind: "no-attempt" }
    | { readonly kind: "candidate-invalidated"; readonly result: PreviewObservationCandidateInvalidated }
    | { readonly kind: "host-refused"; readonly reason: "not-found" | "too-large" | "read-failed" }
    | { readonly kind: "record-rejected"; readonly rejection: PreviewObservationReadRejection }
    | {
          readonly kind: "binding-rejected";
          readonly binding: Exclude<PreviewObservationBinding, "none" | "bound">;
      }
    | { readonly kind: "ordering-rejected"; readonly rejection: PreviewObservationOrderingRejection }
    | { readonly kind: "accepted"; readonly changed: boolean; readonly observation: PreviewObservation };

export type AttachedPreviewRuntimeState =
    | { readonly kind: "idle" }
    | { readonly kind: "launching" }
    | {
          readonly kind: "running";
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string;
      }
    | {
          readonly kind: "stopping";
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string;
      }
    | {
          readonly kind: "exited";
          readonly runtimeIdentity: string;
          readonly exit: PreviewRuntimeExit;
      }
    | {
          readonly kind: "launch-refused";
          readonly result: Exclude<PreviewRuntimeLaunchResult, { readonly kind: "launched" }>;
      };

export type AttachedPreviewLaunch =
    | { readonly launched: false; readonly reason: "initial-publication-unavailable" }
    | { readonly launched: false; readonly reason: "already-running"; readonly runtimeId: PreviewRuntimeId }
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

function requirementsEqual(left: PreviewEligibilityRequirement, right: PreviewEligibilityRequirement): boolean {
    return (
        left.targetProfile === right.targetProfile &&
        left.previewProgramDescriptorIdentity === right.previewProgramDescriptorIdentity &&
        left.inputContract.id === right.inputContract.id &&
        left.inputContract.profileId === right.inputContract.profileId &&
        left.inputContract.profileVersion === right.inputContract.profileVersion
    );
}

function requirementOf(facts: PreviewCompositionFacts): PreviewEligibilityRequirement {
    return {
        targetProfile: facts.targetProfile,
        previewProgramDescriptorIdentity: facts.descriptorIdentity,
        inputContract: facts.inputContract,
    };
}

function requestOf(
    sessionId: string,
    attemptSequence: number,
    facts: PreviewCompositionFacts,
): NativePreviewBuildRequest {
    return {
        sessionId,
        targetProfile: facts.targetProfile,
        profileId: facts.inputContract.profileId,
        profileVersion: facts.inputContract.profileVersion,
        previewInputContractId: facts.inputContract.id,
        previewProgramDescriptorIdentity: facts.descriptorIdentity,
        generatedSourceIdentity: facts.generatedSourceIdentity,
        generatedSourceBytes: facts.generatedSourceBytes,
        attemptSequence,
    };
}

function handshakeKey(candidate: ToolCandidate, requirement: PreviewEligibilityRequirement): string {
    return [
        candidate.toolPath,
        candidate.observationIdentity,
        requirement.targetProfile,
        requirement.previewProgramDescriptorIdentity,
        requirement.inputContract.id,
        requirement.inputContract.profileId,
        requirement.inputContract.profileVersion.toString(10),
    ].join("\u0000");
}

export class PreviewBuildFlow {
    private sessionState: PreviewBuildSession;
    private lastHandshakeState: PreviewHandshakeAttemptRecord | null = null;
    private currentHandshakeLane: {
        readonly key: string;
        readonly promise: Promise<PreviewHandshakeAttemptRecord>;
    } | null = null;
    private handshakeEpoch = 0;
    private handshakeInFlightCount = 0;
    private buildQueue: Promise<void> = Promise.resolve();
    private latestBuildRequestOrdinal = 0;
    private activeBuild: { readonly buildId: BuildId; cancelRequested: boolean } | null = null;
    private acceptedObservationState: PreviewObservation | null = null;
    private lastObservationRefreshState: PreviewObservationRefresh | null = null;
    private observationLane: Promise<PreviewObservationRefresh> | null = null;
    private runtimeStateValue: AttachedPreviewRuntimeState = { kind: "idle" };
    private runtimeLaunchLane: Promise<AttachedPreviewLaunch> | null = null;
    private runtimeCandidateValue: ToolCandidate | null = null;

    constructor(
        private readonly boundary: HostToolBoundary,
        private readonly toolPort: PreviewToolStatePort,
        sessionId: string,
        private readonly observationBoundary: PreviewObservationBoundary,
        private readonly runtimeBoundary: PreviewRuntimeBoundary,
    ) {
        this.sessionState = createPreviewBuildSession(sessionId);
    }

    get session(): PreviewBuildSession {
        return this.sessionState;
    }

    get lastPreviewHandshake(): PreviewHandshakeAttemptRecord | null {
        return this.lastHandshakeState;
    }

    get previewHandshakeInFlight(): boolean {
        return this.handshakeInFlightCount > 0;
    }

    get activeBuildId(): BuildId | null {
        return this.activeBuild?.buildId ?? null;
    }

    get acceptedObservation(): PreviewObservation | null {
        return this.acceptedObservationState;
    }

    get lastObservationRefresh(): PreviewObservationRefresh | null {
        return this.lastObservationRefreshState;
    }

    get runtimeState(): AttachedPreviewRuntimeState {
        return this.runtimeStateValue;
    }

    private compose(input: PreviewCompositionInput): PreviewComposition {
        if (input.descriptor === null) {
            return { ready: false, refusal: { reason: "descriptor-unavailable" } };
        }
        if (!input.descriptorCompatible) {
            return { ready: false, refusal: { reason: "descriptor-incompatible" } };
        }
        if (input.emission === null || !input.emission.ok || input.emission.sourceMap === null) {
            return { ready: false, refusal: { reason: "emission-unavailable" } };
        }
        if (input.configuredTarget === null || input.configuredTarget.length === 0) {
            return { ready: false, refusal: { reason: "target-not-configured" } };
        }
        if (input.previewProgramDescriptorIdentity === null) {
            return {
                ready: false,
                refusal: { reason: "preview-program-descriptor-identity-unavailable" },
            };
        }
        const inputContract = selectPreviewInputContract(input.document, input.descriptor);
        if (!inputContract.matched) {
            return {
                ready: false,
                refusal: { reason: "input-contract-unsupported", mismatch: inputContract.mismatch },
            };
        }
        const generatedSourceBytes = utf8Encode(input.emission.source);
        const generatedSourceIdentity = input.emission.sourceMap.generatedSourceIdentity;
        const computed = sha256Hex(generatedSourceBytes);
        if (computed !== generatedSourceIdentity) {
            return {
                ready: false,
                refusal: {
                    reason: "generated-source-identity-mismatch",
                    declared: generatedSourceIdentity,
                    computed,
                },
            };
        }
        return {
            ready: true,
            facts: {
                targetProfile: input.configuredTarget,
                descriptorIdentity: input.previewProgramDescriptorIdentity,
                inputContract: inputContract.contract,
                generatedSourceIdentity,
                generatedSourceBytes,
            },
        };
    }

    /** Runs the dedicated compatibility operation only for a composition
     *  capable of naming one exact Preview requirement. Calls for the same
     *  candidate + requirement join one execution. A different candidate or
     *  requirement starts a new lane; the old settlement is returned to its
     *  caller as stale and cannot replace the latest proof record. */
    previewHandshake(input: PreviewCompositionInput): Promise<PreviewHandshakeAttemptRecord> {
        const composition = this.compose(input);
        if (!composition.ready) {
            this.handshakeEpoch += 1;
            this.currentHandshakeLane = null;
            const record: PreviewHandshakeAttemptRecord = {
                kind: "refused",
                refusal: composition.refusal,
            };
            this.lastHandshakeState = record;
            return Promise.resolve(record);
        }
        const tool = this.toolPort.current();
        if (tool.status !== "compatible") {
            this.handshakeEpoch += 1;
            this.currentHandshakeLane = null;
            const record: PreviewHandshakeAttemptRecord = {
                kind: "refused",
                refusal: { reason: "ordinary-tool-not-compatible", toolStatus: tool.status },
            };
            this.lastHandshakeState = record;
            return Promise.resolve(record);
        }
        const candidate = tool.candidate;
        const requirement = requirementOf(composition.facts);
        const key = handshakeKey(candidate, requirement);
        if (this.currentHandshakeLane?.key === key) {
            return this.currentHandshakeLane.promise;
        }

        const epoch = ++this.handshakeEpoch;
        this.handshakeInFlightCount += 1;
        const promise = this.runPreviewHandshake(candidate, requirement, epoch).finally(() => {
            this.handshakeInFlightCount -= 1;
            if (this.currentHandshakeLane?.promise === promise) {
                this.currentHandshakeLane = null;
            }
        });
        this.currentHandshakeLane = { key, promise };
        return promise;
    }

    private async runPreviewHandshake(
        candidate: ToolCandidate,
        requirement: PreviewEligibilityRequirement,
        epoch: number,
    ): Promise<PreviewHandshakeAttemptRecord> {
        const result = await this.boundary.previewHandshake(candidate);
        const stale = epoch !== this.handshakeEpoch;
        let record: PreviewHandshakeAttemptRecord;
        if (result.kind === "candidate-invalidated") {
            this.toolPort.candidateInvalidated(result);
            record = { kind: "candidate-invalidated", candidate, result, stale };
        } else if (result.kind === "launch-failed") {
            record = { kind: "launch-failed", candidate, stale };
        } else {
            const process = readPreviewHandshakeOutput(result.output);
            const handshake = { candidate, process };
            record = {
                kind: "settled",
                candidate,
                requirement,
                process,
                eligibility: judgePreviewEligibility(this.toolPort.current(), handshake, requirement),
                stale,
            };
        }
        if (!stale) {
            this.lastHandshakeState = record;
        }
        return record;
    }

    /** The complete Preview gate. A NativePreviewBuildRequest exists only
     *  after composition and candidate-bound Preview proof both admit. */
    buildGate(input: PreviewCompositionInput): PreviewBuildGate {
        const composition = this.compose(input);
        if (!composition.ready) {
            return { admitted: false, reasons: [composition.refusal], request: null, eligibility: null };
        }
        const tool = this.toolPort.current();
        if (tool.status !== "compatible") {
            return {
                admitted: false,
                reasons: [{ reason: "ordinary-tool-not-compatible", toolStatus: tool.status }],
                request: null,
                eligibility: null,
            };
        }
        if (
            this.runtimeCandidateValue !== null &&
            this.runtimeCandidateValue.toolPath !== tool.candidate.toolPath
        ) {
            return {
                admitted: false,
                reasons: [{ reason: "attached-runtime-deployment-mismatch" }],
                request: null,
                eligibility: null,
            };
        }
        const requirement = requirementOf(composition.facts);
        const proof = this.lastHandshakeState;
        if (
            proof === null ||
            proof.kind !== "settled" ||
            proof.stale ||
            !candidatesEqual(proof.candidate, tool.candidate) ||
            !requirementsEqual(proof.requirement, requirement)
        ) {
            return {
                admitted: false,
                reasons: [{ reason: "preview-proof-missing" }],
                request: null,
                eligibility: null,
            };
        }
        if (proof.eligibility.status !== "eligible") {
            return {
                admitted: false,
                reasons: [{ reason: "preview-ineligible", eligibility: proof.eligibility }],
                request: null,
                eligibility: proof.eligibility,
            };
        }
        const eligibility = judgePreviewEligibility(
            tool,
            { candidate: proof.candidate, process: proof.process },
            requirement,
        );
        if (eligibility.status !== "eligible" || !admitPreviewBuild(eligibility, tool.candidate)) {
            return {
                admitted: false,
                reasons: [{ reason: "preview-ineligible", eligibility }],
                request: null,
                eligibility,
            };
        }
        const request = requestOf(
            this.sessionState.sessionId,
            this.sessionState.nextAttemptSequence,
            composition.facts,
        );
        const requestWellFormed = isWellFormedPreviewBuildRequest(request);
        if (!requestWellFormed.ok) {
            return {
                admitted: false,
                reasons: [{ reason: "request-not-well-formed", verdict: requestWellFormed }],
                request,
                eligibility,
            };
        }
        return { admitted: true, reasons: [], request, eligibility };
    }

    /** Strict same-session single-flight launch. A newer eligible request
     *  immediately asks the active older attempt to cancel, then waits for
     *  that attempt's terminal outcome before re-gating and issuing. Queued
     *  requests superseded before issue never consume AttemptSequence. */
    buildPreview(input: PreviewCompositionInput): Promise<PreviewBuildLaunch> {
        const initialGate = this.buildGate(input);
        if (!initialGate.admitted) {
            return Promise.resolve({ issued: false, reason: "gate-refused", gate: initialGate });
        }

        const ordinal = ++this.latestBuildRequestOrdinal;
        this.requestActiveCancellation();
        const predecessor = this.buildQueue;
        const started = (async (): Promise<PreviewBuildLaunch> => {
            await predecessor;
            if (ordinal !== this.latestBuildRequestOrdinal) {
                return { issued: false, reason: "superseded-before-issue", gate: initialGate };
            }
            const gate = this.buildGate(input);
            if (!gate.admitted || gate.request === null || gate.eligibility?.status !== "eligible") {
                return { issued: false, reason: "gate-refused", gate };
            }
            return this.issueAdmittedBuild(gate, ordinal);
        })();
        this.buildQueue = started
            .then(async (launch) => {
                if (launch.issued) {
                    await launch.outcome;
                }
            })
            .catch(() => undefined);
        return started;
    }

    private async issueAdmittedBuild(gate: PreviewBuildGate, ordinal: number): Promise<PreviewBuildLaunch> {
        const request = gate.request;
        const eligibility = gate.eligibility;
        if (request === null || eligibility?.status !== "eligible") {
            throw new Error("the private Preview issuer was reached without an admitted request and proof");
        }
        const candidate = eligibility.candidate;
        const handle = await this.boundary.buildPreview(candidate, request);
        const attemptSequence = request.attemptSequence;
        this.sessionState = previewSessionIssue(
            this.sessionState,
            attemptSequence,
            handle.buildId,
            candidate,
            previewBuildIntentOf(request, eligibility.facts),
        );

        const active = { buildId: handle.buildId, cancelRequested: false };
        this.activeBuild = active;
        const outcome = (async (): Promise<PreviewAttemptOutcome> => {
            const result = await handle.result;
            if (result.kind === "candidate-invalidated") {
                this.toolPort.candidateInvalidated(result);
            }
            const settled = previewAttemptOutcomeOfBuildResult(result, attemptSequence);
            this.sessionState = previewSessionSettle(this.sessionState, attemptSequence, settled);
            if (this.activeBuild?.buildId.sequence === handle.buildId.sequence) {
                this.activeBuild = null;
            }
            return settled;
        })();

        // A newer request may have arrived while the boundary admitted this
        // handle. It could not cancel before a BuildId existed, so complete
        // the same single-flight rule now that the handle is concrete.
        if (ordinal !== this.latestBuildRequestOrdinal) {
            this.requestActiveCancellation();
        }
        return { issued: true, gate, attemptSequence, buildId: handle.buildId, outcome };
    }

    private requestActiveCancellation(): void {
        const active = this.activeBuild;
        if (active === null || active.cancelRequested) {
            return;
        }
        active.cancelRequested = true;
        void this.boundary.cancel(active.buildId);
    }

    /** Explicit user cancellation of the currently issued Preview attempt. */
    async cancelActive(): Promise<{ canceled: boolean; alreadySettled: boolean } | null> {
        const active = this.activeBuild;
        if (active === null) {
            return null;
        }
        active.cancelRequested = true;
        const outcome = await this.boundary.cancel(active.buildId);
        return { canceled: outcome.canceled, alreadySettled: outcome.alreadySettled };
    }

    /** Reads one observation from the attached Runtime's deployment while it
     *  is live, otherwise from the deployment that owns the newest issued
     *  attempt. Concurrent callers join one host read. A malformed, unbound,
     *  or non-monotonic record never replaces the accepted last-good fact. */
    refreshObservation(): Promise<PreviewObservationRefresh> {
        if (this.observationLane !== null) {
            return this.observationLane;
        }
        const latest = [...this.sessionState.line.attempts].sort(
            (left, right) => right.attemptSequence - left.attemptSequence,
        )[0];
        if (latest === undefined) {
            const record: PreviewObservationRefresh = { kind: "no-attempt" };
            this.lastObservationRefreshState = record;
            return Promise.resolve(record);
        }
        const promise = this.runObservationRefresh(this.observationCandidate(latest.candidate)).finally(() => {
            if (this.observationLane === promise) {
                this.observationLane = null;
            }
        });
        this.observationLane = promise;
        return promise;
    }

    private observationCandidate(latestAttemptCandidate: ToolCandidate): ToolCandidate {
        const runtimeCandidate = this.runtimeCandidateValue;
        if (runtimeCandidate === null) {
            return latestAttemptCandidate;
        }
        const currentTool = this.toolPort.current();
        if (
            "candidate" in currentTool &&
            currentTool.candidate.toolPath === runtimeCandidate.toolPath
        ) {
            return currentTool.candidate;
        }
        return runtimeCandidate;
    }

    private async runObservationRefresh(candidate: ToolCandidate): Promise<PreviewObservationRefresh> {
        const host = await this.observationBoundary.readPreviewObservation(
            candidate,
            this.sessionState.sessionId,
        );
        let record: PreviewObservationRefresh;
        if (host.kind === "candidate-invalidated") {
            this.toolPort.candidateInvalidated(host);
            record = { kind: "candidate-invalidated", result: host };
        } else if (host.kind !== "read") {
            record = { kind: "host-refused", reason: host.kind };
        } else {
            const read = readPreviewObservation(host.bytes);
            if (read.status === "rejected") {
                record = { kind: "record-rejected", rejection: read.rejection };
            } else {
                const projection = projectPreviewRuntime(this.sessionState.line, null, read.observation);
                if (projection.observationBinding !== "bound") {
                    if (projection.observationBinding === "none") {
                        throw new Error("a decoded Preview observation cannot have no binding");
                    }
                    record = {
                        kind: "binding-rejected",
                        binding: projection.observationBinding,
                    };
                } else {
                    const update = acceptPreviewObservation(this.acceptedObservationState, read.observation);
                    if (!update.accepted) {
                        record = { kind: "ordering-rejected", rejection: update.rejection };
                    } else {
                        this.acceptedObservationState = update.observation;
                        record = {
                            kind: "accepted",
                            changed: update.changed,
                            observation: update.observation,
                        };
                    }
                }
            }
        }
        this.lastObservationRefreshState = record;
        return record;
    }

    /** The honest runtime view for the graph currently in the editor. A
     *  present build request is used only to derive semantic intent; this
     *  method never issues work or advances AttemptSequence. */
    runtimeProjection(input: PreviewCompositionInput): PreviewRuntimeProjection {
        const gate = this.buildGate(input);
        const intent =
            gate.admitted && gate.request !== null && gate.eligibility?.status === "eligible"
                ? previewBuildIntentOf(gate.request, gate.eligibility.facts)
                : null;
        return projectPreviewRuntime(this.sessionState.line, intent, this.acceptedObservationState);
    }

    /** Success-first attached launch. A strict Preview build result is the
     *  only way a publication enters the line, so latestPublished is the
     *  initial-publication proof. Later failed attempts do not erase that
     *  active last-good pointer and therefore do not block a relaunch. */
    launchAttachedPreview(): Promise<AttachedPreviewLaunch> {
        if (this.runtimeLaunchLane !== null) {
            return this.runtimeLaunchLane;
        }
        if (this.runtimeStateValue.kind === "running" || this.runtimeStateValue.kind === "stopping") {
            return Promise.resolve({
                launched: false,
                reason: "already-running",
                runtimeId: this.runtimeStateValue.runtimeId,
            });
        }
        const published = [...this.sessionState.line.attempts]
            .sort((left, right) => right.attemptSequence - left.attemptSequence)
            .find(
                (attempt) =>
                    attempt.state === "settled" && attempt.outcome.kind === "published",
            );
        if (published === undefined) {
            return Promise.resolve({ launched: false, reason: "initial-publication-unavailable" });
        }
        this.runtimeStateValue = { kind: "launching" };
        this.runtimeCandidateValue = published.candidate;
        const promise = this.runAttachedLaunch(published.candidate).finally(() => {
            if (this.runtimeLaunchLane === promise) {
                this.runtimeLaunchLane = null;
            }
        });
        this.runtimeLaunchLane = promise;
        return promise;
    }

    private async runAttachedLaunch(candidate: ToolCandidate): Promise<AttachedPreviewLaunch> {
        let result: PreviewRuntimeLaunchResult;
        try {
            result = await this.runtimeBoundary.launchAttachedPreview(
                candidate,
                this.sessionState.sessionId,
            );
        } catch (error) {
            this.runtimeCandidateValue = null;
            this.runtimeStateValue = { kind: "idle" };
            throw error;
        }
        if (result.kind !== "launched") {
            if (result.kind === "candidate-invalidated") {
                this.toolPort.candidateInvalidated(result);
            }
            this.runtimeCandidateValue = null;
            this.runtimeStateValue = { kind: "launch-refused", result };
            return { launched: false, reason: "host-refused", result };
        }
        this.runtimeStateValue = {
            kind: "running",
            runtimeId: result.runtimeId,
            runtimeIdentity: result.runtimeIdentity,
        };
        void result.exited.then((exit) => {
            const state = this.runtimeStateValue;
            if (
                (state.kind === "running" || state.kind === "stopping") &&
                state.runtimeId.sequence === exit.runtimeId.sequence
            ) {
                this.runtimeCandidateValue = null;
                this.runtimeStateValue = {
                    kind: "exited",
                    runtimeIdentity: state.runtimeIdentity,
                    exit,
                };
            }
        });
        return {
            launched: true,
            runtimeId: result.runtimeId,
            runtimeIdentity: result.runtimeIdentity,
            exited: result.exited,
        };
    }

    async stopAttachedPreview(): Promise<PreviewRuntimeStopOutcome | null> {
        const state = this.runtimeStateValue;
        if (state.kind !== "running" && state.kind !== "stopping") {
            return null;
        }
        this.runtimeStateValue = {
            kind: "stopping",
            runtimeId: state.runtimeId,
            runtimeIdentity: state.runtimeIdentity,
        };
        try {
            return await this.runtimeBoundary.stopAttachedPreview(state.runtimeId);
        } catch (error) {
            const current = this.runtimeStateValue;
            if (current.kind === "stopping" && current.runtimeId.sequence === state.runtimeId.sequence) {
                this.runtimeStateValue = {
                    kind: "running",
                    runtimeId: state.runtimeId,
                    runtimeIdentity: state.runtimeIdentity,
                };
            }
            throw error;
        }
    }
}
