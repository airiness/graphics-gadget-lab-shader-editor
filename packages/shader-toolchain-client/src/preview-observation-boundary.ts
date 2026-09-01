/**
 * Compiler-free host read boundary for one Runtime Preview observation.
 * This is deliberately separate from HostToolBoundary's six tool operations:
 * no process is spawned and no tool protocol is interpreted. The host derives
 * the candidate deployment's canonical artifact root, performs one bounded
 * read, and returns bytes or a closed structured host outcome.
 */
import type { CandidateObservation, ToolCandidate } from "./host-boundary.js";

export type PreviewObservationHostReadResult =
    | { readonly kind: "read"; readonly bytes: Uint8Array }
    | { readonly kind: "not-found" }
    | { readonly kind: "too-large" }
    | { readonly kind: "read-failed" }
    | {
          readonly kind: "candidate-invalidated";
          readonly candidate: ToolCandidate;
          readonly observation: CandidateObservation;
          readonly observedIdentity: string | null;
      };

export interface PreviewObservationBoundary {
    readPreviewObservation(
        candidate: ToolCandidate,
        sessionId: string,
    ): Promise<PreviewObservationHostReadResult>;
}

