/**
 * Profile conformance for declared graph parameters — the single authority
 * for the (class, valueType) pairing of a `ShaderGraphDocument` against a
 * `SurfaceProfileDescriptor`'s `parameterClasses`.
 *
 * `checkProfileConformance` is a pure function over two caller-supplied data
 * inputs. It does not emit and does not need emission context, so the GUI
 * (immediate feedback when a user picks a parameter class/type pair), the
 * CLI, and the emitter all ask this one service and get the same structured
 * diagnostics — the GUI in particular must never have to "fake a compile"
 * to learn that a pair is not permitted by the profile.
 *
 * Layering (kept deliberately narrow):
 *
 * - The parse layer owns the structure and the *vocabulary*:
 *   `valueType` is required and must be a core graph value type.
 * - Structural validation owns node-level concerns (for example the
 *   parameter node's class matching its referenced entry's class).
 * - This service owns the *pairing* of each declared (class, valueType)
 *   against the descriptor: a class the descriptor defers or does not define
 *   is UNSUPPORTED_PARAMETER_CLASS; a valueType the profile's class does not
 *   permit is UNSUPPORTED_PARAMETER_TYPE. Nothing is substituted, inferred
 *   from usage, or re-derived per consumer.
 * - Resource classes (a descriptor entry with a single `valueType`, for
 *   example Texture2D) report `resourceClass: true`: the pairing is checked
 *   exactly like any other, but the caller decides what the contract does
 *   with the resource (v1 defers the generated sampler spelling, so the
 *   emitter contributes no signature line and refuses the node's lowering).
 *
 * Entries are in canonical (stable-id sorted) order, so diagnostic and
 * entry order never follows incidental `parameters[]` serialization order.
 * Data paths keep the graph's authoritative `$.parameters[i]` indexing.
 */
import type { ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import type { GraphParameter, ShaderGraphDocument } from "./graph-document.js";
import type { GraphType } from "./graph-types.js";
import { errorAt } from "./parse-helpers.js";
import type { SurfaceProfileDescriptor } from "./surface-profile-descriptor.js";

/** One declared parameter's conformance verdict (canonical order). */
export interface ProfileConformanceEntry {
    /** Stable parameter identity (the document id). */
    readonly parameterId: string;
    /** The declared class name (a descriptor-defined name when conformant). */
    readonly className: string;
    /** The authored concrete value type (vocabulary enforced at parse). */
    readonly valueType: GraphType;
    /** False when the class gate or the pairing gate failed (diagnosed). */
    readonly conformant: boolean;
    /**
     * True when the descriptor declares this class as a resource class
     * (single `valueType`): the pairing is checked as usual, but consumers
     * such as emission decide per contract what the resource contributes
     * (v1 defers the generated resource spelling).
     */
    readonly resourceClass: boolean;
}

export interface ProfileConformance {
    /** True when every declared parameter conforms to the profile. */
    readonly ok: boolean;
    /** Structured pairing failures, in canonical order. */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    /** One verdict per declared parameter, in canonical order. */
    readonly parameters: readonly ProfileConformanceEntry[];
}

export function checkProfileConformance(document: ShaderGraphDocument, descriptor: SurfaceProfileDescriptor): ProfileConformance {
    // Canonical order: stable-id sorted (the persisted array order is
    // incidental serialization). Duplicates are impossible after parse.
    const canonicalParameters: GraphParameter[] = [...new Set(document.parameters.map((parameter) => parameter.id))]
        .sort()
        .flatMap((id) => {
            const parameter = document.parameters.find((entry) => entry.id === id);
            return parameter === undefined ? [] : [parameter];
        });
    const parameterIndexById = new Map<string, number>(document.parameters.map((parameter, index) => [parameter.id, index]));

    const diagnostics: ShaderGraphDiagnostic[] = [];
    const parameters: ProfileConformanceEntry[] = [];

    for (const parameter of canonicalParameters) {
        const index = parameterIndexById.get(parameter.id) ?? 0;
        const classEntry = descriptor.parameterClasses.find((entry) => entry.class === parameter.class);
        const deferred = descriptor.deferred.parameterClasses.includes(parameter.class);
        if (classEntry === undefined) {
            diagnostics.push(
                errorAt(
                    `$.parameters[${index}]`,
                    DiagnosticCode.UnsupportedParameterClass,
                    `Graph parameter "${parameter.id}" uses class "${parameter.class}"${deferred ? " that is in the descriptor's deferred set" : " that the descriptor does not define"}; the profile cannot type it.`,
                ),
            );
            parameters.push({ parameterId: parameter.id, className: parameter.class, valueType: parameter.valueType, conformant: false, resourceClass: false });
            continue;
        }
        if (classEntry.valueType !== undefined) {
            // Resource class (for example Texture2D): conformance still
            // applies — the authored type must be the class's declared
            // resource type. What the contract does with the resource (v1:
            // no signature line, node lowering refused) is the consumer's
            // decision; this verdict only reports the pairing.
            if (classEntry.valueType !== parameter.valueType) {
                diagnostics.push(
                    errorAt(
                        `$.parameters[${index}]`,
                        DiagnosticCode.UnsupportedParameterType,
                        `Graph parameter "${parameter.id}" declares valueType "${parameter.valueType}", but class "${parameter.class}" in this profile is typed "${classEntry.valueType}".`,
                    ),
                );
            }
            parameters.push({
                parameterId: parameter.id,
                className: parameter.class,
                valueType: parameter.valueType,
                conformant: classEntry.valueType === parameter.valueType,
                resourceClass: true,
            });
            continue;
        }
        const allowed = classEntry.valueTypes ?? [];
        if (!allowed.includes(parameter.valueType)) {
            diagnostics.push(
                errorAt(
                    `$.parameters[${index}]`,
                    DiagnosticCode.UnsupportedParameterType,
                    `Graph parameter "${parameter.id}" declares valueType "${parameter.valueType}", but class "${parameter.class}" in this profile permits only ${allowed.map((type) => `"${type}"`).join(", ")}.`,
                ),
            );
            parameters.push({ parameterId: parameter.id, className: parameter.class, valueType: parameter.valueType, conformant: false, resourceClass: false });
            continue;
        }
        parameters.push({ parameterId: parameter.id, className: parameter.class, valueType: parameter.valueType, conformant: true, resourceClass: false });
    }

    return { ok: diagnostics.length === 0, diagnostics, parameters };
}
