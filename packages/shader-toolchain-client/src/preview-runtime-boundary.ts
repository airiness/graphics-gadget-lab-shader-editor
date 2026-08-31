/**
 * Host boundary for the attached GGLab Preview Runtime process. This is not a
 * shader-tool operation: it launches/stops the main application's stable
 * Shader Graph Preview Lab after the Editor has produced an initial
 * publication. Paths and argv remain host-owned.
 */
import type { CandidateObservation, ToolCandidate } from "./host-boundary.js";

export interface PreviewRuntimeId {
    readonly sequence: number;
}

export interface PreviewRuntimeExit {
    readonly runtimeId: PreviewRuntimeId;
    readonly kind: "exited" | "stopped" | "wait-failed";
    readonly exitCode: number | null;
}

export type PreviewRuntimeLaunchResult =
    | {
          readonly kind: "launched";
          readonly runtimeId: PreviewRuntimeId;
          readonly runtimeIdentity: string;
          readonly exited: Promise<PreviewRuntimeExit>;
      }
    | { readonly kind: "session-already-running"; readonly runtimeId: PreviewRuntimeId }
    | {
          readonly kind: "candidate-invalidated";
          readonly candidate: ToolCandidate;
          readonly observation: CandidateObservation;
          readonly observedIdentity: string | null;
      }
    | { readonly kind: "runtime-unavailable"; readonly observation: "missing" | "unreadable" }
    | { readonly kind: "launch-failed" };

export interface PreviewRuntimeStopOutcome {
    readonly runtimeId: PreviewRuntimeId;
    readonly stopRequested: boolean;
    readonly alreadySettled: boolean;
}

export interface PreviewRuntimeBoundary {
    launchAttachedPreview(
        candidate: ToolCandidate,
        sessionId: string,
    ): Promise<PreviewRuntimeLaunchResult>;
    stopAttachedPreview(runtimeId: PreviewRuntimeId): Promise<PreviewRuntimeStopOutcome>;
}
