/** React composition for the attached Shader Graph Preview session. Pure
 * protocol/order rules remain in PreviewBuildFlow; the Runtime lifetime
 * authority lives in AttachedPreviewRuntimeManager; this hook owns only
 * desktop boundary construction, action wiring, render ticks, and the
 * bounded poll timer. */
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
import {
    PreviewBuildFlow,
    type PreviewBuildGate,
    type PreviewCompositionInput,
    type PreviewObservationRefresh,
} from "./preview-build-flow.js";
import {
    AttachedPreviewRuntimeManager,
    type AttachedRuntimeState,
} from "./preview-runtime-manager.js";
import { previewProgramDescriptorIdentity, createPreviewSessionId } from "./preview-program-contract.js";
import {
    createTauriPreviewObservationBoundary,
    createTauriPreviewRuntimeBoundary,
    createTauriToolBoundary,
    toolBoundaryAvailable,
} from "./toolchain-host.js";
import { describePreviewAttemptOutcome } from "./preview-attempt-summary.js";

const OBSERVATION_POLL_INTERVAL_MS = 250;

export interface UseShaderPreviewInput {
    readonly document: ShaderGraphDocument;
    readonly descriptor: SurfaceProfileDescriptor | null;
    readonly descriptorCompatible: boolean;
    readonly emission: HlslEmission | null;
    readonly configuredTarget: string;
    readonly nativeFlow: NativeBuildFlow | null;
}

export interface ShaderPreviewSurface {
    readonly flow: PreviewBuildFlow | null;
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
    readonly launchPreview: () => Promise<void>;
    readonly stopPreview: () => Promise<void>;
    /** Strict teardown: resolves only after the attached Runtime's exit is
     * PROVEN (`terminated`). Rejects when the exit settles as
     * `exit-unproven` (the host could only best-effort kill/wait and cannot
     * prove exit) or the stop request fails — a caller must NOT retarget or
     * close the target after such a failure. `stopPreview` alone is for the
     * plain user "Stop" button, never for an ownership transition. */
    readonly stopPreviewAndWait: () => Promise<void>;
    readonly notes: readonly { readonly level: "ok" | "info" | "refusal"; readonly text: string }[];
}

export function useShaderPreview(input: UseShaderPreviewInput): ShaderPreviewSurface {
    const [, bump] = useState(0);
    const [flow, setFlow] = useState<PreviewBuildFlow | null>(null);
    const [buildInFlight, setBuildInFlight] = useState(false);
    const [launchInFlight, setLaunchInFlight] = useState(false);
    const [notes, setNotes] = useState<ShaderPreviewSurface["notes"]>([]);
    const flowRef = useRef<PreviewBuildFlow | null>(null);
    const managerRef = useRef<AttachedPreviewRuntimeManager | null>(null);

    const note = useCallback((level: "ok" | "info" | "refusal", text: string) => {
        setNotes((previous) => [...previous.slice(-23), { level, text }]);
    }, []);

    useEffect(() => {
        let canceled = false;
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
            const preview = new PreviewBuildFlow(
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
                // Best-effort stop request at unmount; the join must never
                // block teardown, and an unproven outcome never rejects it.
                void currentManager.stop().catch(() => undefined);
            }
            void currentFlow;
        };
    }, [input.nativeFlow, note]);

    const composition: PreviewCompositionInput = {
        document: input.document,
        descriptor: input.descriptor,
        descriptorCompatible: input.descriptorCompatible,
        emission: input.emission,
        configuredTarget: input.configuredTarget,
        previewProgramDescriptorIdentity,
    };

    const previewHandshake = useCallback(async (): Promise<void> => {
        if (flow === null) {
            note("refusal", "Preview handshake is unavailable: no desktop Preview host.");
            return;
        }
        try {
            const pending = flow.previewHandshake(composition);
            bump((value) => value + 1);
            const record = await pending;
            if (record.kind === "settled" && record.eligibility.status === "eligible" && !record.stale) {
                note("ok", "Preview compatibility proven for the current candidate and input contract.");
            } else {
                note("refusal", `Preview handshake did not admit the current composition (${record.kind}).`);
            }
        } catch (error) {
            note("refusal", `Preview handshake failed: ${describeError(error)}`);
        }
        bump((value) => value + 1);
    }, [flow, composition, note]);

    const launchPreview = useCallback(async (): Promise<void> => {
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
    }, [note]);

    const buildPreview = useCallback(async (): Promise<void> => {
        const current = flowRef.current;
        const manager = managerRef.current;
        if (current === null || manager === null) {
            note("refusal", "Preview build is unavailable: no desktop Preview host.");
            return;
        }
        setBuildInFlight(true);
        try {
            const launch = await current.buildPreview(composition);
            if (!launch.issued) {
                note("refusal", `Preview build was not issued (${launch.reason}).`);
                return;
            }
            bump((value) => value + 1);
            const outcome: PreviewAttemptOutcome = await launch.outcome;
            if (outcome.kind !== "published") {
                note("refusal", describePreviewAttemptOutcome(launch.attemptSequence, outcome));
                return;
            }
            note("ok", describePreviewAttemptOutcome(launch.attemptSequence, outcome));
            // Success-first UX: a build publication with no (usable)
            // attached Runtime auto-launches one. `running` / `terminating`
            // / `launching` suppress it; `exit-unproven` is refused by
            // launch admission; `idle` (and the retry lane) admit it.
            const runtime = manager.state;
            if (runtime.kind !== "running" && runtime.kind !== "terminating" && runtime.kind !== "launching") {
                await launchPreview();
            }
        } catch (error) {
            note("refusal", `Preview build failed: ${describeError(error)}`);
        } finally {
            setBuildInFlight(false);
            bump((value) => value + 1);
        }
    }, [composition, launchPreview, note]);

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

    // No try/catch here on purpose: an ownership transition (retarget /
    // close the target) needs to KNOW when the teardown did not complete,
    // so the caller refuses the commit instead of splitting ownership.
    const stopPreviewAndWait = useCallback(async (): Promise<void> => {
        const manager = managerRef.current;
        if (manager === null) {
            return;
        }
        const proof = await manager.terminateAndJoin();
        if (proof.outcome === "exit-unproven") {
            throw new Error(
                `Attached Preview Runtime #${proof.runtimeId.sequence} could not be proven exited (host wait-failed); the ownership transition was not committed.`,
            );
        }
        bump((value) => value + 1);
    }, [bump]);

    const managerState = managerRef.current;
    const runtimeKind = flow === null || managerState === null ? "idle" : managerState.state.kind;
    useEffect(() => {
        if (flow === null || managerState === null || runtimeKind !== "running") {
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
    }, [flow, managerState, runtimeKind, note]);

    return {
        flow,
        sessionId: flow?.session.sessionId ?? null,
        gate: flow?.buildGate(composition) ?? null,
        runtime: flow !== null && managerState !== null ? managerState.state : { kind: "idle" },
        projection: flow?.runtimeProjection(composition) ?? null,
        lastObservationRefresh: flow?.lastObservationRefresh ?? null,
        handshakeInFlight: flow?.previewHandshakeInFlight ?? false,
        buildInFlight,
        launchInFlight,
        initialPublicationAvailable: flow?.initialPublicationAvailable ?? false,
        previewHandshake,
        buildPreview,
        launchPreview,
        stopPreview,
        stopPreviewAndWait,
        notes,
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
