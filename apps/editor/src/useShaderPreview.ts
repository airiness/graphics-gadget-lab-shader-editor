/** React composition for the attached Shader Graph Preview session. Pure
 * protocol/order rules remain in PreviewBuildFlow; this hook owns only desktop
 * boundary construction, actions, render ticks, and the bounded poll timer. */
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
    type AttachedPreviewRuntimeState,
    type PreviewBuildGate,
    type PreviewCompositionInput,
    type PreviewObservationRefresh,
} from "./preview-build-flow.js";
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
    readonly runtime: AttachedPreviewRuntimeState;
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
    readonly notes: readonly { readonly level: "ok" | "info" | "refusal"; readonly text: string }[];
}

export function useShaderPreview(input: UseShaderPreviewInput): ShaderPreviewSurface {
    const [, bump] = useState(0);
    const [flow, setFlow] = useState<PreviewBuildFlow | null>(null);
    const [buildInFlight, setBuildInFlight] = useState(false);
    const [launchInFlight, setLaunchInFlight] = useState(false);
    const [notes, setNotes] = useState<ShaderPreviewSurface["notes"]>([]);
    const flowRef = useRef<PreviewBuildFlow | null>(null);

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
                runtime,
            );
            flowRef.current = preview;
            setFlow(preview);
        })().catch((error: unknown) => {
            if (!canceled) {
                note("refusal", `Preview host initialization failed: ${describeError(error)}`);
            }
        });
        return () => {
            canceled = true;
            const current = flowRef.current;
            flowRef.current = null;
            setFlow(null);
            if (current !== null) {
                void current.stopAttachedPreview();
            }
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
        if (flow === null) {
            note("refusal", "Attached Preview launch is unavailable: no desktop Preview host.");
            return;
        }
        setLaunchInFlight(true);
        try {
            const launch = await flow.launchAttachedPreview();
            if (!launch.launched) {
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
    }, [flow, note]);

    const buildPreview = useCallback(async (): Promise<void> => {
        if (flow === null) {
            note("refusal", "Preview build is unavailable: no desktop Preview host.");
            return;
        }
        setBuildInFlight(true);
        try {
            const launch = await flow.buildPreview(composition);
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
            const runtime = flow.runtimeState;
            if (runtime.kind !== "running" && runtime.kind !== "stopping") {
                await launchPreview();
            }
        } catch (error) {
            note("refusal", `Preview build failed: ${describeError(error)}`);
        } finally {
            setBuildInFlight(false);
            bump((value) => value + 1);
        }
    }, [flow, composition, launchPreview, note]);

    const stopPreview = useCallback(async (): Promise<void> => {
        if (flow === null) {
            return;
        }
        try {
            const outcome = await flow.stopAttachedPreview();
            if (outcome !== null) {
                note(
                    outcome.stopRequested ? "info" : "refusal",
                    outcome.stopRequested
                        ? `Stop requested for attached Runtime #${outcome.runtimeId.sequence}.`
                        : `Attached Runtime #${outcome.runtimeId.sequence} had already settled.`,
                );
            }
        } catch (error) {
            note("refusal", `Stopping attached Preview failed: ${describeError(error)}`);
        }
        bump((value) => value + 1);
    }, [flow, note]);

    const runtimeKind = flow?.runtimeState.kind ?? "idle";
    useEffect(() => {
        if (flow === null || runtimeKind !== "running") {
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
    }, [flow, runtimeKind, note]);

    return {
        flow,
        sessionId: flow?.session.sessionId ?? null,
        gate: flow?.buildGate(composition) ?? null,
        runtime: flow?.runtimeState ?? { kind: "idle" },
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
        notes,
    };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
