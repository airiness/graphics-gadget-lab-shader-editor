/**
 * The initial graph type system (architecture §11).
 *
 * The first value domain is intentionally small. `bool` is deferred until a
 * real semantic node requires it, and `Sampler` is not a first-class v1
 * graph value. Matrices, arbitrary structs, arrays, generics, and
 * user-defined types do not exist before a concrete node requires them.
 *
 * This vocabulary is core-owned data: frontends query it; they never
 * redeclare a type list of theirown.
 */

export const GRAPH_TYPES = ["float", "float2", "float3", "float4", "Texture2D"] as const;

export type GraphType = (typeof GRAPH_TYPES)[number];

/** Numeric family (§11.1); math nodes state constraints over Numeric. */
export const NUMERIC_TYPES = ["float", "float2", "float3", "float4"] as const;

export type NumericType = (typeof NUMERIC_TYPES)[number];

/**
 * Types deliberately outside the v1 value domain (§11, and the descriptor's
 * deferred set). Referencing a deferred type is an explicit diagnostic,
 * never a silent default.
 */
export const DEFERRED_GRAPH_TYPES = ["bool", "Sampler"] as const;

export type DeferredGraphType = (typeof DEFERRED_GRAPH_TYPES)[number];

export function isGraphType(value: string): value is GraphType {
    return (GRAPH_TYPES as readonly string[]).includes(value);
}

export function isNumericType(value: string): value is NumericType {
    return (NUMERIC_TYPES as readonly string[]).includes(value);
}

/**
 * Conservative implicit conversion (§11.2): only identity is implicit;
 * vector-to-vector is explicitly not implicit (float2 → float3,
 * float4 → float3, ...).
 *
 * Operation result typing (for example `float × float3 → float3`) is a
 * per-operation rule owned by the type-checking stage, not a general
 * conversion, and is not represented here.
 */
export function isImplicitlyConvertible(source: GraphType, target: GraphType): boolean {
    return source === target;
}
