/**
 * Preview ownership-transition authority.
 *
 * - The target-resolution rules below (guidance §12.1) are the pure
 *   "which document the Runtime Preview composes from" decision: the
 *   Runtime Preview composes from an EXPLICIT Preview target, never from
 *   the editing (active) document; switching the active tab never
 *   re-targets the Runtime (the reducer enforces it).
 * - The `PreviewCoordinator` owns the RETARGET and TARGET-CLOSE ownership
 *   transitions and the Build/Runtime gate composition:
 *
 *     * both transitions claim one strict single-flight slot (claim ->
 *       try / finally release); a new arrival while one is in flight
 *       returns `transition-in-flight` immediately — no queue, no
 *       auto-supersede, the user may retry after the first completes;
 *     * each transition records an identity (`kind`, target document id,
 *       monotonic sequence for EVIDENCE ONLY — not a latest-intent-wins);
 *     * `terminateAndJoin()` is the transition's LAST await whenever a
 *       teardown is required; the three safety states never RESOLVE (the
 *       manager REJECTS ownership transitions from them, or reports
 *       `exit-unproven`), so a transition commits WITHOUT a proven exit
 *       NEVER;
 *     * after that await (or immediately, on the same-target fast path),
 *       exactly ONE synchronous `WorkspaceStore.apply` revalidates the
 *       intent against the CURRENT snapshot, resolves the CURRENT
 *       descriptor + CURRENT target emission, and commits the Workspace
 *       transition inside the same reduce — no descriptor, emission, or
 *       next snapshot is captured before the await or written back
 *       afterwards.
 *
 * A retarget transition itself never auto-launches a Runtime.
 */
import {
    checkProfileDescriptorCompatibility,
    emitHlsl,
    type ShaderGraphDiagnostic,
} from "@gglab/shader-graph-core";
import type {
    PreviewRuntimeId,
    PreviewRuntimeProjection,
} from "@gglab/shader-toolchain-client";
import {
    type PreviewBuildFlow,
    type PreviewBuildGate,
    type PreviewBuildGateReason,
    type PreviewBuildLaunch,
    type PreviewCompositionInput,
} from "./preview-build-flow.js";
import { documentRevision, type DocumentSession } from "./document-session.js";
import { type AttachedPreviewRuntimeManager } from "./preview-runtime-manager.js";
import {
    commitWorkspacePreviewTarget,
    closeWorkspaceDocument,
    type WorkspaceDocumentHandle,
    type WorkspaceSession,
} from "./workspace-session.js";
import {
    WorkspaceStore,
    type WorkspaceAuthoringState,
} from "./workspace-store.js";

/** The DocumentSession the Runtime Preview composes from.
 *
 * The explicit Preview target is authoritative at ALL times. The reducer
 * guarantees the invariant: the first document a Workspace opens IS its
 * Preview target (seeded at open time, not followed live), a target close
 * re-seeds the surviving active document, and only "Preview This Graph"
 * commits a different one. The active-document fallback below is therefore
 * defensive only — reachable when no document is open — and never a live
 * re-coupling of the Preview to tab switching. */
export function resolvePreviewTarget<TDocument extends WorkspaceDocumentHandle>(
    workspace: WorkspaceSession<TDocument>,
): TDocument | undefined {
    const targetId = workspace.preview.targetDocumentId ?? workspace.activeDocumentId;
    if (targetId === null) {
        return undefined;
    }
    return workspace.documents.find((candidate) => candidate.sessionId === targetId);
}

/** Whether an explicit Preview target is present. With the open/close seed
 * invariant this is true whenever any document is open; the UI surfaces the
 * target with the ▶ marker so a user can see WHICH tab the Runtime previews. */
export function hasExplicitPreviewTarget(
    workspace: WorkspaceSession<WorkspaceDocumentHandle>,
): boolean {
    return workspace.preview.targetDocumentId !== null;
}

export type PreviewTransitionKind = "retarget" | "close-target";

/** Identity of one ownership transition (evidence / display only — the
 * sequence is NOT a latest-intent-wins protocol; transitions are not
 * queued or superseded). */
export interface PreviewTransitionIdentity {
    readonly kind: PreviewTransitionKind;
    readonly targetDocumentId: DocumentSession["sessionId"];
    readonly sequence: number;
}

export type PreviewTransitionRefusal =
    | { readonly reason: "transition-in-flight"; readonly inFlight: PreviewTransitionIdentity }
    | { readonly reason: "build-in-flight" }
    | { readonly reason: "target-not-open"; readonly targetDocumentId: DocumentSession["sessionId"] }
    | { readonly reason: "document-not-preview-target"; readonly documentSessionId: DocumentSession["sessionId"] }
    | { readonly reason: "document-changed-during-close"; readonly documentSessionId: DocumentSession["sessionId"] }
    | { readonly reason: "exit-unproven"; readonly runtimeId: PreviewRuntimeId }
    | { readonly reason: "teardown-rejected"; readonly detail: string }
    | { readonly reason: "target-emission-unavailable"; readonly detail: string };

export type PreviewTransitionResult =
    | { readonly ok: true; readonly identity: PreviewTransitionIdentity; readonly targetChanged: boolean }
    | { readonly ok: false; readonly refusal: PreviewTransitionRefusal };

/** One human-facing note for a structured transition refusal. */
export function describeTransitionRefusal(refusal: PreviewTransitionRefusal): string {
    switch (refusal.reason) {
        case "transition-in-flight":
            return `another Preview transition (#${refusal.inFlight.sequence}) is in flight — transitions are not queued; retry once it settles`;
        case "build-in-flight":
            return "a Preview build is in flight (issue → terminal outcome) — ownership transitions are not queued; retry once the build settles";
        case "target-not-open":
            return "that tab no longer exists in this Workspace";
        case "document-not-preview-target":
            return "that tab is not the Preview target";
        case "document-changed-during-close":
            return "that document was edited to a NEWER revision while the close was in flight — it was NOT closed, so the newer work is preserved; retry the close if you now mean to discard it";
        case "exit-unproven":
            return `the attached Preview Runtime #${refusal.runtimeId.sequence} could not be proven exited (host wait-failed) — the ownership transition was not committed`;
        case "teardown-rejected":
            return `the attached Preview Runtime teardown failed (${refusal.detail}) — stop the Preview first, then retry`;
        case "target-emission-unavailable":
            return `the current descriptor cannot legally emit the current target: ${refusal.detail}`;
    }
}

type AttachedRuntimeGateRefusal = Extract<
    PreviewBuildGateReason,
    {
        readonly reason:
            | "attached-runtime-launch-outcome-unproven"
            | "attached-runtime-ownership-conflict"
            | "attached-runtime-launching"
            | "attached-runtime-deployment-mismatch";
    }
>;

function firstDiagnostic(diagnostics: readonly ShaderGraphDiagnostic[]): string {
    return diagnostics[0]?.message ?? "no structured diagnostic detail was reported";
}

function openDocumentIn(
    session: WorkspaceSession<DocumentSession>,
    documentSessionId: DocumentSession["sessionId"],
): DocumentSession | undefined {
    return session.documents.find((document) => document.sessionId === documentSessionId);
}

export class PreviewCoordinator {
    private inFlight: PreviewTransitionIdentity | null = null;
    private sequence = 0;

    /** The descriptor reads the LIVE desktop-host bindings: `manager()` and
     * `flow()` return the bound instances once the host has arrived, or
     * `null` while no desktop Preview host (and thus no attached-Runtime
     * lease and no build line) exists for this mount. One Coordinator
     * instance spans both, so the strict single-flight slot and the
     * transition sequence are preserved across the host arriving — nothing
     * is ever re-created (and thus nothing in flight is lost).
     *
     * The distinction that load-bearing:
     *   `manager() === null`     → PROVEN no Runtime (no host): ownership
     *                              transitions are pure Workspace commits.
     *   `manager() !== null`     → a host exists; its safety states
     *                              (unproven exit / conflict) BLOCK. */
    constructor(
        private readonly managerSource: () => AttachedPreviewRuntimeManager | null,
        private readonly flowSource: () => PreviewBuildFlow | null,
        private readonly store: WorkspaceStore<WorkspaceAuthoringState>,
    ) {}

    private get manager(): AttachedPreviewRuntimeManager | null {
        return this.managerSource();
    }

    private get flow(): PreviewBuildFlow | null {
        return this.flowSource();
    }

    /** Build / Runtime gate composition. The attached-Runtime facts are
     * mapped into the build-refusal vocabulary FIRST (exact order:
     * launch-outcome-unproven, runtime-ownership-conflict, launching,
     * deployment-mismatch), then the Controller's build gate runs.
     * `deploymentToolPath` is compared with the current compatible tool
     * candidate's `toolPath` only — never with a Preview Program
     * Descriptor identity. With no desktop host the gate is a single
     * structural refusal: there is no build line to admit anything. */
    gate(input: PreviewCompositionInput): PreviewBuildGate {
        const flow = this.flow;
        if (flow === null) {
            return { admitted: false, reasons: [{ reason: "preview-host-unavailable" }], request: null, eligibility: null };
        }
        const refusal = this.attachedRuntimeRefusal(flow);
        if (refusal !== null) {
            return { admitted: false, reasons: [refusal], request: null, eligibility: null };
        }
        return flow.buildGate(input);
    }

    private attachedRuntimeRefusal(flow: PreviewBuildFlow): AttachedRuntimeGateRefusal | null {
        const manager = this.manager;
        if (manager === null) {
            return null; // no desktop host → no attached-Runtime facts to map
        }
        const state = manager.state;
        if (state.kind === "launch-outcome-unproven") {
            // The last launch outcome is UNKNOWN (the host may have spawned
            // a Runtime): a build is a structured refusal — never admitted
            // on the assumption that no Runtime exists.
            return { reason: "attached-runtime-launch-outcome-unproven" };
        }
        if (state.kind === "runtime-ownership-conflict") {
            // The host KNOWS a Runtime exists for this session and the
            // manager owns no lease for it: a build is a structured
            // refusal, never a deployment-mismatch (there is no owned
            // binding to compare) and never admission.
            return { reason: "attached-runtime-ownership-conflict" };
        }
        if (manager.launchInFlight) {
            return { reason: "attached-runtime-launching" };
        }
        const ownedRuntime = manager.ownedRuntime;
        const tool = flow.toolState();
        if (
            ownedRuntime !== null &&
            tool.status === "compatible" &&
            ownedRuntime.deploymentToolPath !== tool.candidate.toolPath
        ) {
            return { reason: "attached-runtime-deployment-mismatch" };
        }
        return null;
    }

    /** Strict same-session single-flight Preview build under the composed
     * gate (attached-Runtime facts first, then the build gate). While an
     * ownership transition is in flight (or no host exists) the build is a
     * STRUCTURAL refusal — it is not queued and not superseded: transition
     * lifecycles and build lifecycles are mutually exclusive. */
    buildPreview(input: PreviewCompositionInput): Promise<PreviewBuildLaunch> {
        if (this.inFlight !== null) {
            return Promise.resolve({
                issued: false,
                reason: "gate-refused",
                gate: { admitted: false, reasons: [{ reason: "preview-transition-in-flight" }], request: null, eligibility: null },
            });
        }
        const flow = this.flow;
        if (flow === null) {
            return Promise.resolve({
                issued: false,
                reason: "gate-refused",
                gate: { admitted: false, reasons: [{ reason: "preview-host-unavailable" }], request: null, eligibility: null },
            });
        }
        return flow.buildPreview(input, (candidate) => this.gate(candidate));
    }

    /** The honest runtime view under the composed gate. Never issues work
     * or advances AttemptSequence. With no host it is the neutral "idle"
     * projection — never a bypass around the build line. */
    runtimeProjection(input: PreviewCompositionInput): PreviewRuntimeProjection {
        const flow = this.flow;
        if (flow === null) {
            return {
                freshness: "idle",
                latestBuildState: null,
                currentPublicationId: null,
                lastGoodPublicationId: null,
                rejectionCode: null,
                observationBinding: "none",
            };
        }
        return flow.runtimeProjection(input, (candidate) => this.gate(candidate));
    }

    /** `retargetTo(targetDocumentId)` — the ONLY path that moves the
     * Preview-target axis. Claim -> guard (target exists in the CURRENT
     * snapshot) -> [same-target fast path: NO teardown] -> the LAST await
     * is `terminateAndJoin()` -> exactly ONE synchronous apply (revalidate
     * + resolve CURRENT emission + commit) -> release. */
    async retargetTo(targetDocumentId: DocumentSession["sessionId"]): Promise<PreviewTransitionResult> {
        const existing = this.inFlight;
        if (existing !== null) {
            return { ok: false, refusal: { reason: "transition-in-flight", inFlight: existing } };
        }
        const flow = this.flow;
        if (flow !== null && flow.buildInFlight) {
            return { ok: false, refusal: { reason: "build-in-flight" } };
        }
        const identity: PreviewTransitionIdentity = {
            kind: "retarget",
            targetDocumentId,
            sequence: ++this.sequence,
        };
        this.inFlight = identity;
        try {
            if (openDocumentIn(this.store.getSnapshot().session, targetDocumentId) === undefined) {
                return { ok: false, refusal: { reason: "target-not-open", targetDocumentId } };
            }
            const sameTarget =
                this.store.getSnapshot().session.preview.targetDocumentId === targetDocumentId;
            if (!sameTarget) {
                const refusal = await this.teardownProof();
                if (refusal !== null) {
                    return refusal;
                }
            }
            return this.store.apply<PreviewTransitionResult>((state) => {
                const commit = this.commitTarget(state, targetDocumentId);
                if (commit.refused !== null) {
                    return { next: state, result: { ok: false, refusal: commit.refused } };
                }
                return { next: commit.next, result: { ok: true, identity, targetChanged: commit.targetChanged } };
            });
        } finally {
            this.release(identity);
        }
    }

    /** `closeTarget(documentId, expectedRevision)` — closing the tab that
     * IS the Preview target. `expectedRevision` is the exact document
     * revision the caller (the app) saw when the user confirmed the discard;
     * the commit revalidates it, so a NEWER revision that appears while the
     * teardown is pending is never silently closed. Claim -> guard (open AND
     * still the target in the CURRENT snapshot) -> the LAST await is
     * `terminateAndJoin()` -> exactly ONE synchronous apply that revalidates
     * (open, still-target, AND unchanged revision) and closes -> release. A
     * non-target tab close never enters this authority: it remains a plain
     * Workspace reducer operation. */
    async closeTarget(
        documentSessionId: DocumentSession["sessionId"],
        expectedRevision: string,
    ): Promise<PreviewTransitionResult> {
        const existing = this.inFlight;
        if (existing !== null) {
            return { ok: false, refusal: { reason: "transition-in-flight", inFlight: existing } };
        }
        const flow = this.flow;
        if (flow !== null && flow.buildInFlight) {
            return { ok: false, refusal: { reason: "build-in-flight" } };
        }
        const identity: PreviewTransitionIdentity = {
            kind: "close-target",
            targetDocumentId: documentSessionId,
            sequence: ++this.sequence,
        };
        this.inFlight = identity;
        try {
            const current = this.store.getSnapshot();
            if (openDocumentIn(current.session, documentSessionId) === undefined) {
                return { ok: false, refusal: { reason: "target-not-open", targetDocumentId: documentSessionId } };
            }
            if (current.session.preview.targetDocumentId !== documentSessionId) {
                return { ok: false, refusal: { reason: "document-not-preview-target", documentSessionId } };
            }
            const refusal = await this.teardownProof();
            if (refusal !== null) {
                return refusal;
            }
            return this.store.apply<PreviewTransitionResult>((state) => {
                const stillOpen = openDocumentIn(state.session, documentSessionId);
                if (stillOpen === undefined) {
                    return {
                        next: state,
                        result: { ok: false, refusal: { reason: "target-not-open", targetDocumentId: documentSessionId } },
                    };
                }
                if (state.session.preview.targetDocumentId !== documentSessionId) {
                    return {
                        next: state,
                        result: { ok: false, refusal: { reason: "document-not-preview-target", documentSessionId } },
                    };
                }
                // Revision binding: the caller confirmed discarding
                // `expectedRevision`. If the document moved to a new revision
                // between that confirmation and this commit (e.g. while the
                // teardown was pending), closing it would discard work the
                // user never confirmed — refuse, and leave the newer revision
                // open and intact.
                if (documentRevision(stillOpen) !== expectedRevision) {
                    return {
                        next: state,
                        result: { ok: false, refusal: { reason: "document-changed-during-close", documentSessionId } },
                    };
                }
                const closed = closeWorkspaceDocument(state.session, documentSessionId);
                if (!closed.accepted) {
                    return {
                        next: state,
                        result: { ok: false, refusal: { reason: "document-not-preview-target", documentSessionId } },
                    };
                }
                return {
                    next: { ...state, session: closed.workspace },
                    result: { ok: true, identity, targetChanged: true },
                };
            });
        } finally {
            this.release(identity);
        }
    }

    /** The strict-teardown step of a transition, resolved to EITHER "safe to
     * commit" (null) OR a structured refusal — never an exception crossing
     * the transition boundary.
     *
     * The load-bearing distinction (guidance §479, recovery semantics):
     *   - `manager() === null`  → PROVEN no Runtime (no desktop host bound
     *     for this mount): there is nothing to join, so an ownership
     *     transition is a PURE Workspace commit. This is the "host
     *     unavailable" case, and it must NOT block the Workspace transition.
     *   - `manager() !== null`  → a host exists and owns the lease facts;
     *     its safety states mean the old Runtime's teardown / ownership is
     *     UNRESOLVED, and MUST block:
     *       * `terminateAndJoin()` REJECTS (the Runtime is KNOWN to exist or
     *         MAY exist and the editor has no lease for it) →
     *         `teardown-rejected`;
     *       * `terminateAndJoin()` settles `exit-unproven` (the host could
     *         only best-effort kill/wait and cannot prove exit) →
     *         `exit-unproven`.
     *     Both leave the Workspace snapshot untouched and release the slot.
     */
    private async teardownProof(): Promise<PreviewTransitionResult | null> {
        const manager = this.manager;
        if (manager === null) {
            return null; // proven no Runtime → no teardown to join; commit
        }
        try {
            const proof = await manager.terminateAndJoin();
            if (proof.outcome === "exit-unproven") {
                return { ok: false, refusal: { reason: "exit-unproven", runtimeId: proof.runtimeId } };
            }
            return null; // `terminated` / `already-exited` → proven exit
        } catch (error) {
            // An ownership transition CANNOT commit from a safety state: the
            // manager REJECTS. The structured refusal is the transition's
            // result — the error is not rethrown and the Workspace snapshot
            // is left untouched.
            return { ok: false, refusal: { reason: "teardown-rejected", detail: error instanceof Error ? error.message : String(error) } };
        }
    }

    /** The commit-time reduce: revalidated against the CURRENT snapshot,
     * the CURRENT descriptor is the emission's contract, and the target's
     * presentation emission + the Preview-target move commit in the SAME
     * synchronous application. A missing target or an illegal
     * descriptor/emission pair is a structured refusal that leaves the
     * snapshot UNCHANGED (same identity, no notification). */
    private commitTarget(
        state: WorkspaceAuthoringState,
        targetDocumentId: DocumentSession["sessionId"],
    ): {
        refused: Extract<PreviewTransitionRefusal, { readonly reason: "target-not-open" | "target-emission-unavailable" }> | null;
        next: WorkspaceAuthoringState;
        targetChanged: boolean;
    } {
        const target = openDocumentIn(state.session, targetDocumentId);
        if (target === undefined) {
            return { refused: { reason: "target-not-open", targetDocumentId }, next: state, targetChanged: false };
        }
        const descriptor = state.profileDescriptor;
        if (descriptor === null) {
            return {
                refused: {
                    reason: "target-emission-unavailable",
                    detail: "the Workspace has no current Surface Profile Descriptor, so the target emission cannot be resolved",
                },
                next: state,
                targetChanged: false,
            };
        }
        const compatibility = checkProfileDescriptorCompatibility(target.history.present, descriptor);
        if (!compatibility.ok) {
            return {
                refused: { reason: "target-emission-unavailable", detail: firstDiagnostic(compatibility.diagnostics) },
                next: state,
                targetChanged: false,
            };
        }
        const emission = emitHlsl(target.history.present, descriptor);
        if (!emission.ok) {
            return {
                refused: { reason: "target-emission-unavailable", detail: firstDiagnostic(emission.diagnostics) },
                next: state,
                targetChanged: false,
            };
        }
        const targetChanged = state.session.preview.targetDocumentId !== targetDocumentId;
        // One transaction: the target's presentation emission AND the
        // Preview-target move commit together (the same-target fast path
        // may refresh the emission without moving the axis).
        const documents = state.session.documents.map((document) =>
            document.sessionId === targetDocumentId
                ? { ...document, presentation: { ...document.presentation, emission } }
                : document,
        );
        const committed = commitWorkspacePreviewTarget({ ...state.session, documents }, targetDocumentId);
        if (!committed.accepted) {
            return { refused: { reason: "target-not-open", targetDocumentId }, next: state, targetChanged: false };
        }
        return { refused: null, next: { ...state, session: committed.workspace }, targetChanged };
    }

    private release(identity: PreviewTransitionIdentity): void {
        if (this.inFlight?.sequence === identity.sequence) {
            this.inFlight = null;
        }
    }
}