/**
 * Initial node definitions for the `gglab.surface` profile (architecture
 * §12).
 *
 * Node definitions are pure, queryable data — not behavior, and not a
 * UI-side registry. They are the core's own node-semantics record: the GUI
 * node palette, the CLI's future `describe` surface, validation, and the
 * emitter all read these definitions; nothing re-derives node behavior
 * elsewhere.
 *
 * The set is the exact §12.3 family:
 *
 *     constants   Float, Float2, Float3, Float4
 *     parameters  ScalarParameter, VectorParameter
 *     math        Add, Subtract, Multiply, Divide, Lerp, Saturate, OneMinus,
 *                 Min, Max, Dot, Normalize
 *     input       UV0
 *     texture     Texture2DParameter, SampleTexture2D
 *     output      SurfaceOutput
 *
 * `SampleTexture2D` channel outputs (RGBA/RGB/R/G/B/A) are ShaderGraph node
 * semantics owned here, not descriptor fields. General ComponentMask/Split/
 * AppendVector/Swizzle nodes and normal/tangent-space authoring remain
 * deferred per §12.
 */
import type { NodeTypeCatalog, NodeTypeSupport } from "./graph-document.js";
import { NUMERIC_TYPES } from "./graph-types.js";
import type { GraphType } from "./graph-types.js";

export type NodeCategory = "constant" | "parameter" | "math" | "input" | "texture" | "output";

export interface NodePortDefinition {
    readonly id: string;
    /** Human-facing display label. */
    readonly name: string;
    /** Allowed types; a single-element array is a fixed type. */
    readonly types: readonly GraphType[];
    readonly required: boolean;
    readonly description?: string;
}

export interface NodePropertyDefinition {
    readonly name: string;
    readonly type: GraphType;
    readonly required: boolean;
    readonly description?: string;
}

export interface NodeDefinition {
    /** Node type name used by documents (for example "Multiply"). */
    readonly type: string;
    readonly category: NodeCategory;
    readonly displayName: string;
    readonly description: string;
    readonly versionRange: NodeTypeSupport;
    readonly inputs: readonly NodePortDefinition[];
    readonly outputs: readonly NodePortDefinition[];
    readonly properties: readonly NodePropertyDefinition[];
}

const NUMERIC: readonly GraphType[] = NUMERIC_TYPES;
const VECTORS: readonly GraphType[] = ["float2", "float3", "float4"];

// Every definition in the initial set supports exactly node version 1.
const V1_VERSION_RANGE: NodeTypeSupport = { minimumVersion: 1, maximumVersion: 1 };

function port(id: string, types: readonly GraphType[], required: boolean, description?: string): NodePortDefinition {
    return { id, name: id, types, required, ...(description !== undefined ? { description } : {}) };
}

function property(name: string, type: GraphType, required: boolean, description?: string): NodePropertyDefinition {
    return { name, type, required, ...(description !== undefined ? { description } : {}) };
}

function definition(
    type: string,
    category: NodeCategory,
    description: string,
    inputs: readonly NodePortDefinition[],
    outputs: readonly NodePortDefinition[],
    properties: readonly NodePropertyDefinition[],
): NodeDefinition {
    return {
        type,
        category,
        displayName: type,
        description,
        versionRange: V1_VERSION_RANGE,
        inputs,
        outputs,
        properties,
    };
}

export const NODE_DEFINITIONS: readonly NodeDefinition[] = [
    // Constants
    definition("Float", "constant", "Constant float value.", [], [port("value", ["float"], true, "Constant value.")], [property("value", "float", true, "Constant float value.")]),
    definition("Float2", "constant", "Constant float2 value.", [], [port("value", ["float2"], true, "Constant value.")], [property("value", "float2", true, "Constant float2 value.")]),
    definition("Float3", "constant", "Constant float3 value.", [], [port("value", ["float3"], true, "Constant value.")], [property("value", "float3", true, "Constant float3 value.")]),
    definition("Float4", "constant", "Constant float4 value.", [], [port("value", ["float4"], true, "Constant value.")], [property("value", "float4", true, "Constant float4 value.")]),

    // Parameters
    definition(
        "ScalarParameter",
        "parameter",
        "Scalar float graph parameter, declared in the document's parameter list.",
        [],
        [port("value", ["float"], true, "Parameter value.")],
        [],
    ),
    definition(
        "VectorParameter",
        "parameter",
        "Vector (float2/float3/float4) graph parameter, declared in the document's parameter list.",
        [],
        [port("value", VECTORS, true, "Parameter value.")],
        [],
    ),

    // Math
    definition("Add", "math", "Element-wise addition: a + b.", [port("a", NUMERIC, true), port("b", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition("Subtract", "math", "Element-wise subtraction: a - b.", [port("a", NUMERIC, true), port("b", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition("Multiply", "math", "Element-wise multiplication.", [port("a", NUMERIC, true), port("b", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition("Divide", "math", "Element-wise division: a / b.", [port("a", NUMERIC, true), port("b", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition(
        "Lerp",
        "math",
        "Linear interpolation from a to b by t.",
        [port("a", NUMERIC, true), port("b", NUMERIC, true), port("t", ["float"], true, "Interpolation factor.")],
        [port("value", NUMERIC, true)],
        [],
    ),
    definition("Saturate", "math", "Clamps each component to [0, 1].", [port("value", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition("OneMinus", "math", "1 minus each component.", [port("value", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition("Min", "math", "Component-wise minimum of a and b.", [port("a", NUMERIC, true), port("b", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition("Max", "math", "Component-wise maximum of a and b.", [port("a", NUMERIC, true), port("b", NUMERIC, true)], [port("value", NUMERIC, true)], []),
    definition(
        "Dot",
        "math",
        "Dot product; inputs must share the same vector size.",
        [port("a", VECTORS, true), port("b", VECTORS, true)],
        [port("value", ["float"], true, "Dot product result.")],
        [],
    ),
    definition("Normalize", "math", "Unit vector.", [port("value", VECTORS, true)], [port("value", VECTORS, true)], []),

    // Input
    definition(
        "UV0",
        "input",
        "Primary texture coordinate supplied by the rendering pass.",
        [],
        [port("value", ["float2"], true, "Texture coordinate.")],
        [],
    ),

    // Texture
    definition(
        "Texture2DParameter",
        "texture",
        "2D texture resource parameter, declared in the document's parameter list.",
        [],
        [port("value", ["Texture2D"], true, "Texture resource.")],
        [],
    ),
    definition(
        "SampleTexture2D",
        "texture",
        "Samples a 2D texture and exposes typed channel outputs.",
        [port("texture", ["Texture2D"], true, "Texture to sample."), port("uv", ["float2"], true, "Sample coordinate.")],
        [
            port("RGBA", ["float4"], true, "All four channels."),
            port("RGB", ["float3"], true, "Color channels."),
            port("R", ["float"], true, "Red channel."),
            port("G", ["float"], true, "Green channel."),
            port("B", ["float"], true, "Blue channel."),
            port("A", ["float"], true, "Alpha channel."),
        ],
        [],
    ),

    // Output
    definition(
        "SurfaceOutput",
        "output",
        "Surface output; maps one-to-one onto the profile's required outputs.",
        [
            port("BaseColor", ["float3"], true, "Linear-RGB albedo contribution."),
            port("Emissive", ["float3"], true, "Linear-RGB emissive contribution."),
            port("Metallic", ["float"], true, "Metallic factor."),
            port("Roughness", ["float"], true, "Roughness factor."),
            port("Opacity", ["float"], true, "Raw surface alpha."),
        ],
        [],
        [],
    ),
];

const DEFINITION_BY_TYPE = new Map<string, NodeDefinition>();
for (const nodeDefinition of NODE_DEFINITIONS) {
    DEFINITION_BY_TYPE.set(nodeDefinition.type, nodeDefinition);
}

/** Looks up a node definition by document node type name. */
export function getNodeDefinition(type: string): NodeDefinition | undefined {
    return DEFINITION_BY_TYPE.get(type);
}

/**
 * The core's built-in node type catalog: every defined node type mapped to
 * its supported version range. Consumed as the default catalog by
 * `parseShaderGraphDocument` and by any consumer asking which node types
 * this core understands.
 */
export function supportedNodeTypeCatalog(): NodeTypeCatalog {
    const catalog: { [type: string]: NodeTypeSupport } = {};
    for (const nodeDefinition of NODE_DEFINITIONS) {
        catalog[nodeDefinition.type] = nodeDefinition.versionRange;
    }
    return catalog;
}
