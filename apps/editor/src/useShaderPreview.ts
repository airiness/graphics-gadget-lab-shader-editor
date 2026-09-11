/** React composition for the attached Shader Graph Preview session. Pure
 * protocol/order rules remain in PreviewBuildController; the Runtime
 * lifetime authority lives in AttachedPreviewRuntimeManager; this hook
 * owns only desktop boundary construction, action wiring, render ticks,
 * and the bounded poll timer. */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
    PreviewAttemptOutcome,
    PreviewRuntimeProjection,
} from "@gglab/shader-toolchain-client";
import type {
    HlslEmission,
    ShaderGraphDocument,
    SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";
import type { NativeBuildFlow } from "./native-build-flow.js";
import { checkProfileDescriptorCompatibility } from "@gglab/shader-graph-core";
import {
    PreviewBuildController,
    type PreviewBuildGate,
    type PreviewCompositionInput,
    type PreviewObservationRefresh,
} from "./preview-build-controller.js";
import {
    AttachedPreviewRuntimeManager,
    type AttachedRuntimeState,
} from "./preview-runtime-manager.js";
import { PreviewCoordinator } from "./preview-coordinator.js";
import {
    WorkspaceStore,
    type WorkspaceAuthoringState,
} from "./workspace-store.js";
import { previewProgramDescriptorIdentity, createPreviewSessionId } from "./preview-program-contract.js";
import {
    createTauriPreviewObservationBoundary,
    createTauriPreviewRuntimeBoundary,
    createTauriToolBoundary,
    toolBoundaryAvailable,
} from "./toolchain-host.js";
const OBSERVATION_POLL_INTERVAL_MS = 250;

export interface UseShaderPreviewInput {
    readonly environment?: import("./use-environment-authoring.js").WorkspaceEnvironmentBinding | null;
    readonly documentOwner?: import("./document-session.js").DocumentSession;
    readonly document: ShaderGraphDocument;
    readonly descriptor: SurfaceProfileDescriptor | null;
    readonly descriptorCompatible: boolean;
    readonly emission: HlslEmission | null;
    readonly configuredTarget: string;
    readonly nativeFlow: NativeBuildFlow | null;
    /** The Workspace commit authority the Preview ownership transitions
     *  commit to (the same instance the app renders from). */
    readonly workspaceStore: WorkspaceStore<WorkspaceAuthoringState>;
}

export interface ShaderPreviewSurface {
    readonly flow: PreviewBuildController | null;
    /** Ownership-transition + gate authority over the Runtime manager and
     * the build flow. Always present for a mounted editor: with no desktop
     * host it executes pure Workspace transitions (proven no Runtime) and
     * structural build refusals; with a host it carries the strict-teardown
     * discipline. A strict `terminateAndJoin` is reachable only through its
     * transition methods — never as a raw exposed action. */
    readonly coordinator: PreviewCoordinator;
    readonly sessionId: string | null;
    readonly gate: PreviewBuildGate | null;
    readonly runtime: AttachedRuntimeState;
    readonly projection: PreviewRuntimeProjection | null;
    readonly lastObservationRefresh: PreviewObservationRefresh | null;
    readonly handshakeInFlight: boolean;
    readonly buildInFlight: boolean;
    readonly launchInFlight: boolean;
    readonly initialPublicationAvailable: boolean;
    readonly previewHandshake: () => Promise<void>;
    readonly buildPreview: () => Promise<void>;
    readonly startPreview: (documentId: import("./workspace-session.js").DocumentSessionId) => Promise<void>;
    readonly launchPreview: () => Promise<void>;
    readonly stopPreview: () => Promise<void>;
    readonly notes: readonly { readonly level: "ok" | "info" | "refusal"; readonly text: string }[];
}

export function useShaderPreview(input: UseShaderPreviewInput): ShaderPreviewSurface {
    const [, bump] = useState(0);
    const [flow, setFlow] = useState<PreviewBuildController | null>(null);
    const [buildInFlight, setBuildInFlight] = useState(false);
    const [launchInFlight, setLaunchInFlight] = useState(false);
    const [notes, setNotes] = useState<ShaderPreviewSurface["notes"]>([]);
    const flowRef = useRef<PreviewBuildController | null>(null);
    const managerRef = useRef<AttachedPreviewRuntimeManager | null>(null);
    const boundNative = useRef<NativeBuildFlow | null>(null);
    const inputRef = useRef(input);
    inputRef.current = input;
    // One coordinator per mount, independent of whether the desktop host
    // arrives. It reads the LIVE host bindings through the accessors below,
    // so ownership transitions (retarget / close-the-target) are ALWAYS
    // available: with no host they are pure Workspace commits (proven no
    // Runtime), and with a host they carry the strict-teardown discipline.
    // The strict single-flight slot therefore never gets re-created.
    const [coordinator] = useState(
        () =>
            new PreviewCoordinator(
                () => managerRef.current,
                () => flowRef.current,
                input.workspaceStore,
                () => inputRef.current.environment === undefined ? boundNative.current === inputRef.current.nativeFlow && inputRef.current.workspaceStore.getSnapshot().session.activeEnvironment === null : inputRef.current.environment?.current() === true && managerRef.current === inputRef.current.environment.manager,
                document => {
                    try { return inputRef.current.environment?.resolveProfile(document) ?? null; } catch { return null; }
                },
            ),
    );

    const note = useCallback((level: "ok" | "info" | "refusal", text: string) => {
        setNotes((previous) => [...previous.slice(-23), { level, text }]);
    }, []);

    useEffect(() => {
        let canceled = false;
        if (input.environment !== undefined) {
            const owner = input.environment;
            flowRef.current = owner?.preview ?? null;
            if (owner) managerRef.current = owner.manager;
            setFlow(owner?.preview ?? null);
            return;
        }
        if (input.nativeFlow === null || !toolBoundaryAvailable(globalThis)) {
            return;
        }
        const nativeFlow = input.nativeFlow;
        void (async () => {
            const [tool, observation, runtime] = await Promise.all([
                createTauriToolBoundary(),
                createTauriPreviewObservationBoundary(),
                createTauriPreviewRuntimeBoundary(),
            ]);
            if (canceled) {
                return;
            }
            const sessionId = createPreviewSessionId();
            const manager = new AttachedPreviewRuntimeManager(runtime, sessionId);
            const preview = new PreviewBuildController(
                tool,
                {
                    current: () => nativeFlow.tool,
                    candidateInvalidated: (result) => {
                        nativeFlow.candidateInvalidated(result);
                        bump((value) => value + 1);
                    },
                },
                sessionId,
                observation,
                manager,
            );
            boundNative.current = nativeFlow;
            managerRef.current = manager;
            flowRef.current = preview;
            setFlow(preview);
        })().catch((error: unknown) => {
            if (!canceled) {
                note("refusal", `Preview host initialization failed: ${describeError(error)}`);
            }
        });
        return () => {
            canceled = true;
            const currentManager = managerRef.current;
            const currentFlow = flowRef.current;
            managerRef.current = null;
            flowRef.current = null;
            setFlow(null);
            if (currentManager !== null) {
                // Strict teardown, fire-and-forget. A plain `stop()` is a
                // NO-OP while `launching` (nothing attached yet) and would
                // orphan a Runtime whose launch settles after unmount;
                // `terminateAndJoin()` first joins the pending launch lane
                // and then completes the teardown. It must never block the
                // unmount.
                void currentManager.terminateAndJoin().catch(() => undefined);
            }
            void currentFlow;
        };
    }, [input.nativeFlow, input.environment, note]);

    const composition: PreviewCompositionInput = {
        ...(input.documentOwner === undefined ? {} : { documentOwner: input.documentOwner }),
        document: input.document,
        descriptor: input.descriptor,
        descriptorCompatible: input.descriptorCompatible,
        emission: input.emission,
        configuredTarget: input.configuredTarget,
        previewProgramDescriptorIdentity,
    };

    const previewHandshake = useCallback(async (): Promise<void> => {
        if (!coordinator.hostAdmitted) {
            note("refusal", "Preview handshake requires a host bound to the current Workspace Environment.");
            return;
        }
        if (flow === null) {
            note("refusal", "Preview handshake is unavailable: no desktop Preview host.");
            return;
        }
        try {
            const pending = flow.previewHandshake(composition);
            bump((value) => value + 1);
            const record = await pending;
            if (flowRef.current !== flow || !coordinator.hostAdmitted) return;
            if (record.kind === "settled" && record.eligibility.status === "eligible" && !record.stale) {
                note("ok", "Preview compatibility proven for the current candidate and input contract.");
            } else {
                note("refusal", `Preview handshake did not admit the current composition (${record.kind}).`);
            }
        } catch (error) {
            note("refusal", `Preview handshake failed: ${describeError(error)}`);
        }
        bump((value) => value + 1);
    }, [flow, composition, note, coordinator]);

    const launchPreview = useCallback(async (): Promise<void> => {
        if (!coordinator.hostAdmitted) {
            note("refusal", "Attached Preview launch requires a host bound to the current Workspace Environment.");
            return;
        }
        const current = flowRef.current;
        const manager = managerRef.current;
        if (current === null || manager === null) {
            note("refusal", "Attached Preview launch is unavailable: no desktop Preview host.");
            return;
        }
        setLaunchInFlight(true);
        try {
            const candidate = current.launchCandidate();
            if (candidate === null) {
                note("refusal", "Attached Preview was not launched (initial-publication-unavailable).");
                return;
            }
            const launch = await manager.launch(candidate);
            if (!launch.launched) {
                if (launch.reason === "host-refused" && launch.result.kind === "candidate-invalidated") {
                    current.reportCandidateInvalidation(launch.result);
                }
                note("refusal", `Attached Preview was not launched (${launch.reason}).`);
                return;
            }
            note("ok", `Attached Preview launched (Runtime #${launch.runtimeId.sequence}).`);
            void launch.exited.finally(() => bump((value) => value + 1));
        } catch (error) {
            note("refusal", `Attached Preview launch failed: ${describeError(error)}`);
        } finally {
            setLaunchInFlight(false);
            bump((value) => value + 1);
        }
    }, [note, coordinator]);

    const buildPreviewFor = useCallback(async (requested: PreviewCompositionInput): Promise<void> => {
        const current = flowRef.current;
        const manager = managerRef.current;
        if (current === null || manager === null) {
            note("refusal", "Preview build is unavailable: no desktop Preview host.");
            return;
        }
        setBuildInFlight(true);
        try {
            const launch = await coordinator.buildPreview(requested);
            if (!launch.issued) {
                note("refusal", `Preview build was not issued (${launch.reason}).`);
                return;
            }
            bump((value) => value + 1);
            const outcome: PreviewAttemptOutcome = await launch.outcome;
            if (flowRef.current !== current || !coordinator.hostAdmitted) return;
            // The settlement itself is the owner Preview session's record —
            // the Preview panel view renders it as its structured,
            // correlated row. No flattened note copy of the same attempt
            // (that was a second, uncorrelated display of owner truth).
            if (outcome.kind !== "published") {
                return;
            }
            // Success-first UX: a build publication with no (usable)
            // attached Runtime auto-launches one. `running` / `terminating`
            // / `launching` suppress it; `exit-unproven` is refused by
            // launch admission; `runtime-ownership-conflict` and
            // `launch-outcome-unproven` suppress it (the host KNOWS / MAY
            // HAVE a Runtime — a second one is forbidden); `idle` (and the
            // retry lane) admit it.
            const runtime = manager.state;
            if (
                runtime.kind !== "running" &&
                runtime.kind !== "terminating" &&
                runtime.kind !== "launching" &&
                runtime.kind !== "runtime-ownership-conflict" &&
                runtime.kind !== "launch-outcome-unproven"
            ) {
                await launchPreview();
            }
        } catch (error) {
            note("refusal", `Preview build failed: ${describeError(error)}`);
        } finally {
            setBuildInFlight(false);
            bump((value) => value + 1);
        }
    }, [coordinator, launchPreview, note]);

    const buildPreview = useCallback(() => buildPreviewFor(composition), [buildPreviewFor, composition]);
    const starting = useRef(false);
    const startPreview = useCallback(async (documentId: import("./workspace-session.js").DocumentSessionId): Promise<void> => {
        if (starting.current) return;
        starting.current = true;
        try {
            const currentInput = inputRef.current;
            const state = currentInput.workspaceStore.getSnapshot();
            const owner = state.session.documents.find(document => document.sessionId === documentId);
            const currentFlow = flowRef.current;
            if (!owner || state.session.preview.targetDocumentId !== documentId || !currentFlow || !coordinator.hostAdmitted) {
                note("refusal", "Preview requires a selected target and a ready host for the current Environment.");
                return;
            }
            // Retarget committed synchronously; React may still expose the previous target's props.
            const descriptor = state.session.activeEnvironment === null ? state.profileDescriptor : currentInput.environment?.resolveProfile(owner.history.present) ?? null;
            const requested: PreviewCompositionInput = { documentOwner: owner, document: owner.history.present, descriptor, descriptorCompatible: descriptor !== null && checkProfileDescriptorCompatibility(owner.history.present, descriptor).ok, emission: owner.presentation.emission, configuredTarget: currentInput.configuredTarget, previewProgramDescriptorIdentity };
            note("info", "Proving Preview compatibility for the selected graph…");
            const record = await currentFlow.previewHandshake(requested);
            bump(value => value + 1);
            if (flowRef.current !== currentFlow || !coordinator.hostAdmitted) return;
            const latest = inputRef.current.workspaceStore.getSnapshot().session;
            if (latest.preview.targetDocumentId !== documentId || latest.activeEnvironment !== state.session.activeEnvironment || latest.workspaceRoot?.canonicalWorkspaceUri !== state.session.workspaceRoot?.canonicalWorkspaceUri || latest.documents.find(document => document.sessionId === documentId)?.history.present !== owner.history.present || inputRef.current.configuredTarget !== requested.configuredTarget) {
                note("refusal", "Preview target, document or Environment changed during compatibility checks. Retry the current graph.");
                return;
            }
            if (record.kind !== "settled" || record.stale || record.eligibility.status !== "eligible") {
                note("refusal", `Preview compatibility refused: ${JSON.stringify(record)}. Check native tool readiness and the Preview target contract.`);
                return;
            }
            note("info", "Building Preview; Runtime will start only after successful publication…");
            await buildPreviewFor(requested);
        } catch (error) {
            note("refusal", `Preview failed: ${describeError(error)}`);
        } finally { starting.current = false; bump(value => value + 1); }
    }, [buildPreviewFor, coordinator, note]);

    const stopPreview = useCallback(async (): Promise<void> => {
        const manager = managerRef.current;
        if (manager === null) {
            return;
        }
        try {
            const outcome = await manager.stop();
            if (outcome.outcome === "stop-requested") {
                note("info", `Stop requested for attached Runtime #${outcome.runtimeId.sequence}.`);
            } else if (outcome.outcome === "join-in-progress") {
                note(
                    "info",
                    `Stop already in progress for attached Runtime #${outcome.runtimeId.sequence}; joined the same teardown (no second host request).`,
                );
            } else if (outcome.outcome === "unproven-rejoin") {
                note(
                    "refusal",
                    `Attached Runtime #${outcome.runtimeId.sequence} could not be proven exited; re-reported the stored unproven fact (no host call was made).`,
                );
            } else {
                note("info", "No attached Preview Runtime to stop.");
            }
        } catch (error) {
            note("refusal", `Stopping attached Preview failed: ${describeError(error)}`);
        }
        bump((value) => value + 1);
    }, [note]);

    // A strict `terminateAndJoin()` is intentionally NOT exposed here: it is
    // the PreviewCoordinator's transition tool (its last await, guarded by
    // the single-flight slot and commit-time revalidation), not a bypass.
    // The plain user "Stop" button uses `stopPreview` above.

    const managerState = managerRef.current;
    const runtimeKind = flow === null || managerState === null ? "idle" : managerState.state.kind;
    useEffect(() => {
        if (!coordinator.hostAdmitted || flow === null || managerState === null || runtimeKind !== "running") {
            return;
        }
        let disposed = false;
        const refresh = (): void => {
            void flow
                .refreshObservation()
                .catch((error: unknown) => {
                    if (!disposed) {
                        note("refusal", `Preview observation read failed: ${describeError(error)}`);
                    }
                })
                .finally(() => {
                    if (!disposed) {
                        bump((value) => value + 1);
                    }
                });
        };
        refresh();
        const timer = globalThis.setInterval(refresh, OBSERVATION_POLL_INTERVAL_MS);
        return () => {
            disposed = true;
            globalThis.clearInterval(timer);
        };
    }, [flow, managerState, runtimeKind, note, coordinator, input.environment]);

    return {
        flow,
        coordinator,
        sessionId: flow?.session.sessionId ?? null,
        // gate / projection are host operations: present (as structural
        // refusals) only while a desktop host (and thus a build line) exists;
        // `null` is the honest "no host" fact, matching the disabled toolbar.
        gate: flow !== null ? coordinator.gate(composition) : null,
        runtime: flow !== null && managerState !== null ? managerState.state : { kind: "idle" },
        projection: flow !== null ? coordinator.runtimeProjection(composition) : null,
        lastObservationRefresh: coordinator.hostAdmitted ? flow?.lastObservationRefresh ?? null : null,
        handshakeInFlight: flow?.previewHandshakeInFlight ?? false,
        buildInFlight: flow?.buildInFlight ?? buildInFlight,
        launchInFlight: managerState?.state.kind === "launching" || (flow === null && launchInFlight),
        initialPublicationAvailable: coordinator.hostAdmitted && (flow?.initialPublicationAvailable ?? false),
        previewHandshake,
        buildPreview,
        startPreview,
        launchPreview,
        stopPreview,
        notes,
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
