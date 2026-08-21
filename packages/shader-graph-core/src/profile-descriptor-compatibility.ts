/**
 * Profile × Descriptor capability compatibility — the single shared
 * authority for "does this descriptor serve the document's frozen profile
 * line in a form whose capabilities are exactly what that line admits?".
 *
 * Layering (recorded for review):
 *
 * - The descriptor parser (`parseSurfaceProfileDescriptor`) answers only
 *   "can this reader understand this descriptorVersion's serialization?".
 *   It parses each supported serialization shape strictly — unknown fields,
 *   unsupported literals, wrong shapes fail — and it does NOT couple the
 *   descriptorVersion and profileVersion numbers: understanding a
 *   serialization is not the same as admitting it for a profile line.
 * - This service answers compatibility, on capability, not on version
 *   numbers: the profile line's frozen semantic requirements
 *   (SUPPORTED_PROFILES) say which descriptor capabilities the line
 *   requires and which it forbids. A line that requires the generated
 *   texture-signature contract (gglab.surface v2) is incompatible with a
 *   descriptor that does not serialize it; a line that does not admit the
 *   contract (gglab.surface v1, whose texture emission is a structured
 *   refusal) is incompatible with a descriptor that does serialize it —
 *   the descriptor would change that line's frozen semantics. The version
 *   axes stay independent (AGENTS.md): a future serialization that still
 *   expresses (or stops expressing) the contract behaves exactly as its
 *   capabilities dictate, with no version-number comparison involved.
 * - Consumers (the emitter today; GUI/CLI when they select descriptors)
 *   consume this verdict; they do not re-derive capability semantics from
 *   version numbers, and the parser is not extended to make this
 *   compatibility call.
 */
import type { ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import type { ShaderGraphDocument } from "./graph-document.js";
import { errorAt } from "./parse-helpers.js";
import type { SurfaceProfileDescriptor } from "./surface-profile-descriptor.js";
import { SUPPORTED_PROFILES } from "./validation.js";

/** Compatibility verdict for one (document profile line, descriptor) pair. */
export interface ProfileDescriptorCompatibility {
    /** True when the descriptor is a compatible authority for the line. */
    readonly ok: boolean;
    /** Structured incompatibilities (line mismatch or capability violations). */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
}

/**
 * Judges whether `descriptor` is a compatible descriptor authority for the
 * document's requested `profile` / `profileVersion` line. Checks, in order:
 * the exact profile line (never an implicit upgrade), then the capability
 * admission of that line — required capabilities present, forbidden
 * capabilities absent — against the descriptor's serialized capabilities.
 */
export function checkProfileDescriptorCompatibility(
    document: ShaderGraphDocument,
    descriptor: SurfaceProfileDescriptor,
): ProfileDescriptorCompatibility {
    // 1. Exact line: the descriptor must serve the same profileId and
    //    profileVersion the document requests. A mismatch is a single
    //    structured judgment; no capability claim is layered on top.
    if (descriptor.profileId !== document.profile || descriptor.profileVersion !== document.profileVersion) {
        return {
            ok: false,
            diagnostics: [
                errorAt(
                    "$",
                    DiagnosticCode.ProfileMismatch,
                    `The document requests profile "${document.profile}" version ${document.profileVersion}; the supplied descriptor is for "${descriptor.profileId}" version ${descriptor.profileVersion}.`,
                ),
            ],
        };
    }

    // 2. Capability admission of the requested line (frozen semantics,
    //    carried by the core's profile knowledge — the version numbers do
    //    not participate).
    const requirements = SUPPORTED_PROFILES.find(
        (candidate) => candidate.profileId === document.profile && candidate.profileVersion === document.profileVersion,
    );
    if (requirements === undefined) {
        // The line is not one this core implements, so its frozen semantic
        // requirements cannot be judged (validation reports the line itself
        // as unsupported for the document).
        return {
            ok: false,
            diagnostics: [
                errorAt(
                    "$",
                    DiagnosticCode.UnknownProfileFeature,
                    `Profile "${document.profile}" version ${document.profileVersion} is not a profile line this core implements, so no descriptor compatibility can be judged for it.`,
                ),
            ],
        };
    }

    const diagnostics: ShaderGraphDiagnostic[] = [];
    const serializesTextureSignature = hasGeneratedTextureSignature(descriptor);
    if (requirements.textureSignature === "required" && !serializesTextureSignature) {
        diagnostics.push(
            errorAt(
                "$",
                DiagnosticCode.MissingProfileCapability,
                `Profile "${document.profile}" version ${document.profileVersion} requires the generated texture-signature contract, which this descriptor does not serialize.`,
            ),
        );
    }
    if (requirements.textureSignature === "forbidden" && serializesTextureSignature) {
        diagnostics.push(
            errorAt(
                "$",
                DiagnosticCode.ForbiddenProfileCapability,
                `Profile "${document.profile}" version ${document.profileVersion} does not admit the generated texture-signature contract, which this descriptor serializes; the descriptor would change that line's frozen semantics.`,
            ),
        );
    }
    return { ok: diagnostics.length === 0, diagnostics };
}

/**
 * Whether the descriptor serializes the generated texture-signature
 * contract (both fields of the serialization; the reader guarantees they
 * travel together on the descriptorVersion that adds them).
 */
function hasGeneratedTextureSignature(descriptor: SurfaceProfileDescriptor): boolean {
    return (
        "generatedTextureSignature" in descriptor.samplingContract && "generatedSampleForm" in descriptor.samplingContract
    );
}
