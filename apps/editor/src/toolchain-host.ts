/**
 * The PRODUCT host boundary over the Tauri service (design authority:
 * section 9) — the desktop implementation of the declared
 * `HostToolBoundary` contract that the client package owns.
 *
 * The two implementations are independent and never import each other:
 * this one runs the service's six allowlisted tool commands and the
 * separate compiler-free observation read; the reference
 * fake (client package) runs the scripted world. Both deliver the same
 * declared settlement surface, so the client's readers, state machine,
 * and build-line rules are written once against the CONTRACT, not
 * against either implementation.
 *
 * Wire discipline, explicitly (the client's adapter obligation, applied
 * here — materialization, never a cast):
 *
 * - OUT: a `NativeCompileRequest`'s `source` is a `Uint8Array`; the wire
 *   carries a plain byte array, so it goes out as one (the service's
 *   DTO deserializes it as its own byte vector);
 * - IN: the service's `BoundaryOutput` byte fields arrive as plain byte
 *   arrays (serde's JSON number-array form for a byte vector); they are
 *   MATERIALIZED as `Uint8Array` field by field — an `as`
 *   BoundaryResult would hand a plain array where the client's readers
 *   contract a typed array, and the typed-array shape is the client's
 *   entire byte vocabulary.
 *
 * The module never assembles a shell string and never interprets output
 * content.
 */
import type {
    BoundaryOutput,
    BoundaryResult,
    CancelOutcome,
    CompileAttemptHandle,
    DiscoverOutcome,
    DiscoverRequest,
    HostToolBoundary,
    NativeCompileRequest,
    NativePreviewBuildRequest,
    PreviewObservationBoundary,
    PreviewObservationHostReadResult,
    ToolCandidate,
} from "@gglab/shader-toolchain-client";
import { isDesktopHost } from "./host-io.js";

/** A plain byte array on the wire (serde's JSON form of a byte vector). */
type ByteArray = readonly number[];

/** The wire shape of the service's boundary output (its DTO, one-for-
 *  one — camelCase keys, byte arrays, the i32 exit code). */
interface WireBoundaryOutput {
    readonly stdout: ByteArray;
    readonly stderr: ByteArray;
    readonly exitCode: number;
    readonly timedOut: boolean;
    readonly canceled: boolean;
}

/** The wire shape of the service's settlement value (its DTO's three
 *  arms, tag `kind`). */
type WireBoundaryResult =
    | { readonly kind: "spawned"; readonly output: WireBoundaryOutput }
    | {
          readonly kind: "candidate-invalidated";
          readonly candidate: ToolCandidate;
          readonly observation: "changed" | "missing" | "unreadable";
          readonly observedIdentity: string | null;
      }
    | { readonly kind: "launch-failed"; readonly candidate: ToolCandidate };

type WirePreviewObservationHostReadResult =
    | { readonly kind: "read"; readonly bytes: ByteArray }
    | { readonly kind: "not-found" }
    | { readonly kind: "too-large" }
    | { readonly kind: "read-failed" }
    | {
          readonly kind: "candidate-invalidated";
          readonly candidate: ToolCandidate;
          readonly observation: "changed" | "missing" | "unreadable";
          readonly observedIdentity: string | null;
      };

function materializeOutput(output: WireBoundaryOutput): BoundaryOutput {
    return {
        stdout: new Uint8Array(output.stdout),
        stderr: new Uint8Array(output.stderr),
        exitCode: output.exitCode,
        timedOut: output.timedOut,
        canceled: output.canceled,
    };
}

/** Materializes the settlement's byte fields into the client's typed
 *  vocabulary (the other fields keep their wire values — they are the
 *  same plain shapes on both sides). */
function materializeResult(wire: WireBoundaryResult): BoundaryResult {
    switch (wire.kind) {
        case "spawned":
            return { kind: "spawned", output: materializeOutput(wire.output) };
        case "candidate-invalidated":
            return {
                kind: "candidate-invalidated",
                candidate: wire.candidate,
                observation: wire.observation,
                observedIdentity: wire.observedIdentity,
            };
        case "launch-failed":
            return { kind: "launch-failed", candidate: wire.candidate };
    }
}

function materializePreviewObservationResult(
    wire: WirePreviewObservationHostReadResult,
): PreviewObservationHostReadResult {
    if (wire.kind === "read") {
        return { kind: "read", bytes: new Uint8Array(wire.bytes) };
    }
    return wire;
}

/** The discovery request as the service's DTO expects (the same plain
 *  values the client declared — no wire vocabulary of its own). */
function discoverRequestWire(request: DiscoverRequest): Record<string, unknown> {
    return {
        explicitConfig: request.explicitConfig,
        siblingBuildOutput: request.siblingBuildOutput,
        bundled: request.bundled,
    };
}

/** The compile request as the service's DTO expects — the byte array is
 *  the wire form, everything else is the domain value itself. */
function compileRequestWire(request: NativeCompileRequest): Record<string, unknown> {
    return {
        source: Array.from(request.source),
        sourceIdentity: request.sourceIdentity,
        target: request.target,
        stage: request.stage,
        entry: request.entry,
        defines: request.defines.map((define) => ({ name: define.name, value: define.value })),
        includes: [...request.includes],
    };
}

/** The dedicated Preview request's wire materialization. It remains an
 *  intent/identity value: all paths, adapters, PSMain, and publication policy
 *  stay inside the native boundary/toolchain. */
function previewBuildRequestWire(request: NativePreviewBuildRequest): Record<string, unknown> {
    return {
        sessionId: request.sessionId,
        targetProfile: request.targetProfile,
        profileId: request.profileId,
        profileVersion: request.profileVersion,
        previewInputContractId: request.previewInputContractId,
        previewProgramDescriptorIdentity: request.previewProgramDescriptorIdentity,
        generatedSourceIdentity: request.generatedSourceIdentity,
        generatedSourceBytes: Array.from(request.generatedSourceBytes),
        attemptSequence: request.attemptSequence,
    };
}

/**
 * Builds the product boundary on top of the official Tauri invoke API.
 * The imports are made lazily (code-split out of the web build, exactly
 * like the file-channel desktop slice): this function is only reached
 * on a desktop host.
 */
export async function createTauriToolBoundary(): Promise<HostToolBoundary> {
    const { invoke, Channel } = await import("@tauri-apps/api/core");

    return {
        async discover(request: DiscoverRequest): Promise<DiscoverOutcome> {
            const outcome = (await invoke("shader-tool-discover", { request: discoverRequestWire(request) })) as DiscoverOutcome;
            return { candidate: outcome.candidate, failures: [...(outcome.failures ?? [])] };
        },

        async handshake(candidate: ToolCandidate): Promise<BoundaryResult> {
            const wire = (await invoke("shader-tool-handshake", { candidate })) as WireBoundaryResult;
            return materializeResult(wire);
        },

        async previewHandshake(candidate: ToolCandidate): Promise<BoundaryResult> {
            const wire = (await invoke("shader-tool-preview-handshake", { candidate })) as WireBoundaryResult;
            return materializeResult(wire);
        },

        async compile(candidate: ToolCandidate, request: NativeCompileRequest): Promise<CompileAttemptHandle> {
            // The service resolves the admission immediately with the
            // attempt's identity and delivers the settlement on a
            // command channel; ONE channel instance serves the invoke
            // call and the promise, materialized into the client's
            // typed-array vocabulary when it fires.
            let resolveSettlement: (settlement: BoundaryResult) => void = () => undefined;
            const result = new Promise<BoundaryResult>((resolve) => {
                resolveSettlement = resolve;
            });
            const channel = new Channel<WireBoundaryResult>((message: WireBoundaryResult) =>
                resolveSettlement(materializeResult(message)),
            );
            const id = (await invoke("shader-tool-compile", {
                candidate,
                request: compileRequestWire(request),
                channel,
            })) as { sequence: number };
            return { buildId: { sequence: id.sequence }, result };
        },

        async buildPreview(candidate: ToolCandidate, request: NativePreviewBuildRequest) {
            let resolveSettlement: (settlement: BoundaryResult) => void = () => undefined;
            const result = new Promise<BoundaryResult>((resolve) => {
                resolveSettlement = resolve;
            });
            const channel = new Channel<WireBoundaryResult>((message: WireBoundaryResult) =>
                resolveSettlement(materializeResult(message)),
            );
            const id = (await invoke("shader-tool-build-preview", {
                candidate,
                request: previewBuildRequestWire(request),
                channel,
            })) as { sequence: number };
            return { buildId: { sequence: id.sequence }, result };
        },

        async cancel(buildId: { readonly sequence: number }): Promise<CancelOutcome> {
            const outcome = (await invoke("shader-tool-cancel", { buildId })) as { canceled: boolean; alreadySettled: boolean };
            return { buildId, canceled: outcome.canceled, alreadySettled: outcome.alreadySettled };
        },
    };
}

/** Builds the separate compiler-free observation boundary. Keeping this out
 *  of HostToolBoundary preserves the six-operation tool contract: this call
 *  only reads a host-derived Runtime record for one candidate/session. */
export async function createTauriPreviewObservationBoundary(): Promise<PreviewObservationBoundary> {
    const { invoke } = await import("@tauri-apps/api/core");
    return {
        async readPreviewObservation(candidate: ToolCandidate, sessionId: string) {
            const wire = (await invoke("shader-preview-read-observation", {
                candidate,
                sessionId,
            })) as WirePreviewObservationHostReadResult;
            return materializePreviewObservationResult(wire);
        },
    };
}

/** Web shells are not desktop hosts — the absence of a service is the
 *  capability report's structured fact (`HostUnavailable`), not an
 *  exception. */
export function toolBoundaryAvailable(host: unknown): boolean {
    return isDesktopHost(host);
}
