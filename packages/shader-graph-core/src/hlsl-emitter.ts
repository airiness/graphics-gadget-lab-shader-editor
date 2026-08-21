/**
 * Deterministic HLSL emission (architecture §14) — the pipeline's final
 * structural stage: validation → topology → lower the live subgraph →
 * assembly against the descriptor's logical contract.
 *
 * `emitHlsl` is a pure function over two caller-supplied data inputs: a
 * parsed `ShaderGraphDocument` and a parsed `SurfaceProfileDescriptor`.
 * Emission targets the descriptor's logical contract — generated function
 * name/stage, the return object built from `requiredOutputs` in descriptor
 * list order, and the `graphParameters then graphVisibleInputs` parameter
 * ordering — never any runtime struct shape such as `MaterialData`.
 *
 * V1 scope and deferred contract points (recorded so they cannot be read
 * as accidental):
 * - The full numeric surface is emitted: float constants, scalar/vector
 *   graph parameters, math nodes, UV0, and the SurfaceOutput assembly.
 * - Texture sampling is refused with a structured UNSUPPORTED_NODE_EMISSION
 *   diagnostic for `Texture2DParameter`/`SampleTexture2D`. The frozen v1
 *   contract captures the sampling policy structurally
 *   (reuseRuntimeTextureSamplerBinding; one sampler per Texture2D binding,
 *   resolved by the material binding layer; sampler authoring deferred) but
 *   does not specify the generated-code spelling of the sampler input. That
 *   spelling is a cross-repository contract decision, not an implementation
 *   detail, and is not invented here.
 * - The value model is per node (one value symbol per lowered node). Any
 *   live node whose definition declares more than one output port is
 *   refused with an explicit UNSUPPORTED_NODE_EMISSION diagnostic rather than
 *   silently lowered through the single-value path; multi-output nodes
 *   (for example SampleTexture2D's RGBA/RGB/R/G/B/A) require the
 *   per-(nodeId, portId) value model that the core type-model refactor
 *   introduces before texture emission.
 * - Vector graph parameter types are fixed by single-typed usage only
 *   (INTERIM): conservative v1 typing does not perform dataflow inference,
 *   and an under-constrained parameter is a structured
 *   AMBIGUOUS_PARAMETER_TYPE error, never a silent type choice. This
 *   inference is an interim mechanism until the document declares a
 *   concrete value type on the graph parameter; it must be replaced, not
 *   extended.
 * - Binary math operations follow the documented conservative result rule
 *   (§11.2): identical vectors keep the type, a scalar widens to the vector
 *   operand, and distinct vector sizes are a TYPE_MISMATCH.
 * - Nodes whose version is outside their definition's supported range are
 *   refused for emission (error) even though structural validation reports
 *   them only as warnings: validation stays forward-compatible for
 *   documents, emission must never silently reinterpret semantics it does
 *   not implement.
 *
 * Source map (architecture §24, `ShaderGraphSourceMap`): `ranges[]` carry
 * generated line/column ranges (1-based lines, 1-based columns, end
 * column exclusive) plus the semantic role and the graph/profile
 * identities the range stands for; `generatedSourceIdentity` is the SHA-256
 * of the exact bytes (computed here by the core's dependency-free sha256
 * implementation, keeping the core headless and runtime-dependency-free).
 * Lines without a navigable identity (header comment, braces, the local
 * surface object, the return) carry no range.
 *
 * Determinism (AGENTS.md invariants): identical semantic input yields
 * byte-identical HLSL and source map; symbols derive from stable semantic
 * ids (never display labels), sanitized to ASCII identifiers and made
 * collision-free by a deterministic per-namespace rule; graph parameters
 * appear in canonical stable-id order; editor/presentation state never
 * reaches the output. On success, non-error diagnostics from structural
 * validation (warnings for unknown nodes/versions outside the live path)
 * are carried through to the emission result.
 */
import type { ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import type { GraphNode, ShaderGraphDocument } from "./graph-document.js";
import { errorAt } from "./parse-helpers.js";
import type { JsonValue } from "./json-value.js";
import { isGraphType } from "./graph-types.js";
import type { GraphType } from "./graph-types.js";
import { getNodeDefinition } from "./node-definitions.js";
import type { SurfaceProfileDescriptor } from "./surface-profile-descriptor.js";
import { sha256Hex, utf8Encode } from "./sha256.js";
import { resolveGraphTopology } from "./topology.js";
import { validateShaderGraph } from "./validation.js";

/** What a generated-source range stands for (architecture §24 "semantic role"). */
export type ShaderGraphSourceMapRole =
    | "include"
    | "requiredOutputField"
    | "generatedFunctionDeclaration"
    | "graphParameterDeclaration"
    | "graphVisibleInputDeclaration"
    | "nodeValueStatement"
    | "requiredOutputAssignment";

export interface ShaderGraphSourceMapRange {
    /** 1-based. */
    readonly startLine: number;
    /** 1-based column of the first character of the range. */
    readonly startColumn: number;
    /** 1-based; ranges span a single generated line. */
    readonly endLine: number;
    /** Exclusive column just past the last character of the range. */
    readonly endColumn: number;
    readonly role: ShaderGraphSourceMapRole;
    /** Graph-local node identity (roles that stand for a node). */
    readonly nodeId?: string;
    /** Graph-local output port the range is tied to, when meaningful. */
    readonly portId?: string;
    /** Graph parameter id (graphParameterDeclaration). */
    readonly parameterId?: string;
    /** Graph-visible input id (graphVisibleInputDeclaration). */
    readonly graphVisibleInputId?: string;
    /** Profile-member name the range stands for (field name, include path). */
    readonly name?: string;
}

/** Architecture §24: the frozen shape of the emitted source map. */
export interface ShaderGraphSourceMap {
    /** SHA-256 (lowercase hex) of the exact generated HLSL bytes. */
    readonly generatedSourceIdentity: string;
    readonly ranges: readonly ShaderGraphSourceMapRange[];
}

export interface HlslEmission {
    readonly ok: boolean;
    /**
     * Emission diagnostics: always the errors that blocked emission; on
     * success, the non-error diagnostics carried from structural
     * validation.
     */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    /** Exact generated HLSL text; empty unless `ok`. */
    readonly source: string;
    /** Present with the source; null on failed emission. */
    readonly sourceMap: ShaderGraphSourceMap | null;
}

function fail(diagnostics: readonly ShaderGraphDiagnostic[]): HlslEmission {
    return { ok: false, diagnostics, source: "", sourceMap: null };
}

function sanitizeIdentifier(id: string): string {
    let out = "";
    for (const ch of id) {
        out += /[A-Za-z0-9_]/.test(ch) ? ch : "_";
    }
    if (out.length === 0) {
        return "_";
    }
    if (/^[0-9]/.test(out)) {
        return `_${out}`;
    }
    return out;
}

/**
 * Collision-free symbol table for a set of stable ids (per namespace):
 * ids visit in sorted order, the first id to claim a base keeps it, and
 * later colliding ids take base_2, base_3, ... — deterministic for any
 * input multiset, independent of document order.
 */
function buildSymbols(ids: readonly string[], prefix: string): Map<string, string> {
    const uniqueSorted = [...new Set(ids)].sort();
    const claimCount = new Map<string, number>();
    const symbols = new Map<string, string>();
    for (const id of uniqueSorted) {
        const base = prefix + sanitizeIdentifier(id);
        const count = claimCount.get(base) ?? 0;
        claimCount.set(base, count + 1);
        symbols.set(id, count === 0 ? base : `${base}_${count + 1}`);
    }
    return symbols;
}

function formatNumber(value: number): string {
    if (Number.isInteger(value)) {
        // HLSL float literals need a decimal point; `1` would be an int.
        return value.toFixed(1);
    }
    return String(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function describeValue(value: JsonValue | undefined): string {
    return value === undefined ? "missing" : JSON.stringify(value);
}

export function emitHlsl(document: ShaderGraphDocument, descriptor: SurfaceProfileDescriptor): HlslEmission {
    const diagnostics: ShaderGraphDiagnostic[] = [];
    const nodes = document.nodes;
    const connections = document.connections;

    const nodeIndexById = new Map<string, number>(nodes.map((node, index) => [node.id, index]));
    const nodeById = new Map<string, GraphNode>(nodes.map((node) => [node.id, node]));
    const nodePath = (nodeId: string): string => {
        const index = nodeIndexById.get(nodeId);
        return index === undefined ? "$" : `$.nodes[${index}]`;
    };

    // The descriptor must describe the document's profile line.
    if (descriptor.profileId !== document.profile || descriptor.profileVersion !== document.profileVersion) {
        diagnostics.push(
            errorAt(
                "$",
                DiagnosticCode.ProfileMismatch,
                `The document requests profile "${document.profile}" version ${document.profileVersion}; the supplied descriptor is for "${descriptor.profileId}" version ${descriptor.profileVersion}.`,
            ),
        );
        return fail(diagnostics);
    }

    // Pipeline gates: structured validation, then the live-subgraph
    // topology; emission only proceeds on a clean acyclic live graph.
    const validation = validateShaderGraph(document);
    if (!validation.ok) {
        return fail(validation.diagnostics);
    }
    const topology = resolveGraphTopology(document);
    if (!topology.ok) {
        return fail(topology.diagnostics);
    }
    if (topology.outputRootIds.length !== 1) {
        diagnostics.push(
            errorAt(
                "$",
                DiagnosticCode.AmbiguousOutputRoot,
                topology.outputRootIds.length === 0
                    ? "The graph has no output node; there is nothing to emit."
                    : `The graph has ${topology.outputRootIds.length} output nodes; the profile contract defines a single return object.`,
            ),
        );
        return fail(diagnostics);
    }

    const liveIds = topology.executionOrder;
    const liveSet = new Set<string>(liveIds);
    const rootId = topology.outputRootIds[0] as string;

    // Canonical parameter order: stable-id sorted. The persisted
    // parameters[] array order is incidental serialization, so emission
    // (signature lines, diagnostics) must not follow it.
    const parameterIndexById = new Map<string, number>(document.parameters.map((parameter, index) => [parameter.id, index]));
    const canonicalParameters = [...new Set(document.parameters.map((parameter) => parameter.id))].sort().flatMap((id) => {
        const parameter = document.parameters.find((entry) => entry.id === id);
        return parameter === undefined ? [] : [parameter];
    });

    // Graph parameter signature types: fixed by a single-type class, inferred
    // from single-typed usage for multi-type classes, refused otherwise.
    const parameterTypeById = new Map<string, string>();
    for (const parameter of canonicalParameters) {
        const index = parameterIndexById.get(parameter.id) ?? 0;
        const classEntry = descriptor.parameterClasses.find((entry) => entry.class === parameter.class);
        if (classEntry === undefined) {
            const deferred = descriptor.deferred.parameterClasses.includes(parameter.class);
            diagnostics.push(
                errorAt(
                    `$.parameters[${index}]`,
                    DiagnosticCode.UnsupportedParameterClass,
                    `Graph parameter "${parameter.id}" uses class "${parameter.class}"${deferred ? " that is in the descriptor's deferred set" : " that the descriptor does not define"}; the emission cannot type it.`,
                ),
            );
            continue;
        }
        if (classEntry.valueType !== undefined) {
            // Resource parameter (Texture2D): the v1 signature spelling for a
            // texture+sampler binding is not frozen; its nodes are refused
            // explicitly during lowering.
            continue;
        }
        const allowed = classEntry.valueTypes ?? [];
        if (allowed.length === 1) {
            const single = allowed[0];
            if (single !== undefined) {
                parameterTypeById.set(parameter.id, single);
            }
            continue;
        }
        // Multi-type class: infer below.
    }

    for (const parameter of canonicalParameters) {
        const index = parameterIndexById.get(parameter.id) ?? 0;
        if (parameterTypeById.has(parameter.id)) {
            continue;
        }
        const classEntry = descriptor.parameterClasses.find((entry) => entry.class === parameter.class);
        if (classEntry === undefined || classEntry.valueType !== undefined) {
            continue; // resource or already diagnosed
        }
        const concrete = new Set<string>();
        let unconstrained = false;
        for (const node of nodes) {
            if (!liveSet.has(node.id)) {
                continue;
            }
            const definition = getNodeDefinition(node.type);
            const reference = definition?.referenceProperties.find((entry) => entry.name === "parameterId");
            if (definition === undefined || reference === undefined || node.properties["parameterId"] !== parameter.id) {
                continue;
            }
            for (const connection of connections) {
                if (connection.from.nodeId !== node.id) {
                    continue;
                }
                const targetNode = nodeById.get(connection.to.nodeId);
                const targetDefinition = targetNode === undefined ? undefined : getNodeDefinition(targetNode.type);
                const targetPort = targetDefinition?.inputs.find((port) => port.id === connection.to.portId);
                if (targetPort === undefined) {
                    continue;
                }
                if (targetPort.types.length === 1) {
                    const single = targetPort.types[0];
                    if (single !== undefined) {
                        concrete.add(single);
                    }
                } else {
                    unconstrained = true;
                }
            }
        }
        if (concrete.size !== 1 || unconstrained) {
            diagnostics.push(
                errorAt(
                    `$.parameters[${index}]`,
                    DiagnosticCode.AmbiguousParameterType,
                    `Graph parameter "${parameter.id}" (${parameter.class}) has no single concrete type from its usage; v1 conservative typing does not infer dataflow types, so the parameter must feed exactly one single-typed port and no other ports.`,
                ),
            );
            continue;
        }
        for (const type of concrete) {
            parameterTypeById.set(parameter.id, type);
        }
    }

    if (diagnostics.length > 0) {
        return fail(diagnostics);
    }

    // Symbol namespaces: the contract parameter space (graph parameters and
    // graph-visible inputs share one namespace) and node values.
    const signatureSymbols = buildSymbols([...document.parameters.map((parameter) => parameter.id), ...descriptor.graphVisibleInputs.map((input) => input.id)], "gglab_");
    const valueSymbols = buildSymbols(liveIds, "v_");

    // Input resolution: the single connection feeding (node, port).
    const inputSourceOf = (node: GraphNode, portId: string): GraphNode | undefined => {
        const connection = connections.find((candidate) => candidate.to.nodeId === node.id && candidate.to.portId === portId);
        return connection === undefined ? undefined : nodeById.get(connection.from.nodeId);
    };

    // Conservative per-node output typing (§11.2): base kinds, scalar
    // widening, distinct-vector-size rejection.
    const typeMemo = new Map<string, GraphType>();
    const typeFailed = new Set<string>();
    const typeDiagnosed = new Set<string>();
    const typeError = (node: GraphNode, message: string): void => {
        if (typeDiagnosed.has(node.id)) {
            return;
        }
        typeDiagnosed.add(node.id);
        diagnostics.push(errorAt(nodePath(node.id), DiagnosticCode.TypeMismatch, `Node "${node.id}" (${node.type}): ${message}`));
    };

    const parameterTypeOf = (node: GraphNode): string | undefined => {
        const referenceId = node.properties["parameterId"];
        return typeof referenceId === "string" ? parameterTypeById.get(referenceId) : undefined;
    };

    const combineBinary = (node: GraphNode, a: GraphType, b: GraphType): GraphType | undefined => {
        if (a === b) {
            return a;
        }
        if (a === "float") {
            return b;
        }
        if (b === "float") {
            return a;
        }
        typeError(node, `operands of distinct vector sizes (${a} and ${b}) are not implicitly convertible`);
        return undefined;
    };

    const baseOutputType = (node: GraphNode): GraphType | undefined => {
        switch (node.type) {
            case "Float":
                return "float";
            case "Float2":
                return "float2";
            case "Float3":
                return "float3";
            case "Float4":
                return "float4";
            case "UV0":
                return "float2";
            case "ScalarParameter":
            case "VectorParameter": {
                const type = parameterTypeOf(node);
                return type !== undefined && isGraphType(type) ? type : undefined;
            }
            case "Saturate":
            case "OneMinus": {
                const input = inputSourceOf(node, "value");
                return input === undefined ? undefined : resolveOutputType(input.id);
            }
            case "Normalize": {
                const input = inputSourceOf(node, "value");
                const type = input === undefined ? undefined : resolveOutputType(input.id);
                if (type === "float" ) {
                    typeError(node, "Normalize requires a vector input (float2/float3/float4), not a scalar float");
                    return undefined;
                }
                return type;
            }
            case "Add":
            case "Subtract":
            case "Multiply":
            case "Divide":
            case "Min":
            case "Max": {
                const aSource = inputSourceOf(node, "a");
                const bSource = inputSourceOf(node, "b");
                const a = aSource === undefined ? undefined : resolveOutputType(aSource.id);
                const b = bSource === undefined ? undefined : resolveOutputType(bSource.id);
                if (a === undefined || b === undefined) {
                    typeError(node, "an input's output type could not be resolved");
                    return undefined;
                }
                return combineBinary(node, a, b);
            }
            case "Lerp": {
                const tSource = inputSourceOf(node, "t");
                const t = tSource === undefined ? undefined : resolveOutputType(tSource.id);
                if (t !== "float") {
                    typeError(node, 'the "t" input must be a float');
                    return undefined;
                }
                const aSource = inputSourceOf(node, "a");
                const bSource = inputSourceOf(node, "b");
                const a = aSource === undefined ? undefined : resolveOutputType(aSource.id);
                const b = bSource === undefined ? undefined : resolveOutputType(bSource.id);
                if (a === undefined || b === undefined) {
                    typeError(node, "an input's output type could not be resolved");
                    return undefined;
                }
                return combineBinary(node, a, b);
            }
            case "Dot": {
                const aSource = inputSourceOf(node, "a");
                const bSource = inputSourceOf(node, "b");
                const a = aSource === undefined ? undefined : resolveOutputType(aSource.id);
                const b = bSource === undefined ? undefined : resolveOutputType(bSource.id);
                if (a === undefined || b === undefined || a !== b || a === "float") {
                    typeError(node, `Dot requires both inputs to be the same vector size (float2/float3/float4), got ${a ?? "unresolved"} and ${b ?? "unresolved"}`);
                    return undefined;
                }
                return "float";
            }
            default:
                return undefined; // roots, texture nodes, unknown kinds
        }
    };

    const resolveOutputType = (nodeId: string): GraphType | undefined => {
        const memoized = typeMemo.get(nodeId);
        if (memoized !== undefined) {
            return memoized;
        }
        if (typeFailed.has(nodeId)) {
            return undefined;
        }
        const node = nodeById.get(nodeId);
        if (node === undefined) {
            return undefined;
        }
        const type = baseOutputType(node);
        if (type === undefined) {
            typeFailed.add(nodeId);
        } else {
            typeMemo.set(nodeId, type);
        }
        return type;
    };

    const symbolOf = (nodeId: string | undefined): string => {
        if (nodeId === undefined) {
            return "?";
        }
        return valueSymbols.get(nodeId) ?? "?";
    };

    const lowerNode = (node: GraphNode): string | undefined => {
        const temp = valueSymbols.get(node.id);
        if (temp === undefined) {
            return undefined;
        }
        const path = nodePath(node.id);
        switch (node.type) {
            case "Float": {
                const value = node.properties["value"];
                if (!isFiniteNumber(value)) {
                    diagnostics.push(
                        errorAt(path, DiagnosticCode.InvalidNodeProperty, `Node "${node.id}" (Float) expects a finite numeric "value" property, got ${describeValue(node.properties["value"] as JsonValue | undefined)}.`),
                    );
                    return undefined;
                }
                return `float ${temp} = ${formatNumber(value)};`;
            }
            case "Float2":
            case "Float3":
            case "Float4": {
                const count = Number(node.type.slice(5));
                const value = node.properties["value"] as JsonValue | undefined;
                const valid = Array.isArray(value) && value.length === count && value.every((component) => isFiniteNumber(component));
                if (!valid) {
                    diagnostics.push(
                        errorAt(path, DiagnosticCode.InvalidNodeProperty, `Node "${node.id}" (${node.type}) expects "value" to be an array of ${count} finite numbers, got ${describeValue(value)}.`),
                    );
                    return undefined;
                }
                // The node type name ("Float3") is not the HLSL type name
                // ("float3"); derive the HLSL spelling.
                const hlsType = node.type.charAt(0).toLowerCase() + node.type.slice(1);
                const body = (value as JsonValue[]).map((component) => formatNumber(component as number)).join(", ");
                return `${hlsType} ${temp} = ${hlsType}(${body});`;
            }
            case "ScalarParameter":
            case "VectorParameter": {
                const type = parameterTypeOf(node);
                const referenceId = node.properties["parameterId"];
                const signatureSymbol = typeof referenceId === "string" ? (signatureSymbols.get(referenceId) ?? undefined) : undefined;
                if (type === undefined || signatureSymbol === undefined) {
                    diagnostics.push(
                        errorAt(path, DiagnosticCode.UnresolvedParameterReference, `Node "${node.id}" (${node.type}) cannot be lowered: its graph parameter has no resolved signature type.`),
                    );
                    return undefined;
                }
                return `${type} ${temp} = ${signatureSymbol};`;
            }
            case "UV0": {
                const uv0Symbol = signatureSymbols.get("uv0");
                if (uv0Symbol === undefined) {
                    diagnostics.push(
                        errorAt(path, DiagnosticCode.UnsupportedNodeEmission, `Node "${node.id}" (UV0) requires graph-visible input "uv0" from the descriptor.`),
                    );
                    return undefined;
                }
                return `float2 ${temp} = ${uv0Symbol};`;
            }
            case "Add":
            case "Subtract":
            case "Multiply":
            case "Divide":
            case "Min":
            case "Max":
            case "Lerp":
            case "Saturate":
            case "OneMinus":
            case "Dot":
            case "Normalize": {
                const outType = resolveOutputType(node.id);
                if (outType === undefined) {
                    if (!typeDiagnosed.has(node.id)) {
                        typeError(node, "the output type could not be resolved");
                    }
                    return undefined;
                }
                const aSource = inputSourceOf(node, "a");
                const bSource = inputSourceOf(node, "b");
                const tSource = inputSourceOf(node, "t");
                let expression: string;
                switch (node.type) {
                    case "Add":
                        expression = `${symbolOf(aSource?.id)} + ${symbolOf(bSource?.id)}`;
                        break;
                    case "Subtract":
                        expression = `${symbolOf(aSource?.id)} - ${symbolOf(bSource?.id)}`;
                        break;
                    case "Multiply":
                        expression = `${symbolOf(aSource?.id)} * ${symbolOf(bSource?.id)}`;
                        break;
                    case "Divide":
                        expression = `${symbolOf(aSource?.id)} / ${symbolOf(bSource?.id)}`;
                        break;
                    case "Min":
                        expression = `min(${symbolOf(aSource?.id)}, ${symbolOf(bSource?.id)})`;
                        break;
                    case "Max":
                        expression = `max(${symbolOf(aSource?.id)}, ${symbolOf(bSource?.id)})`;
                        break;
                    case "Lerp":
                        expression = `lerp(${symbolOf(aSource?.id)}, ${symbolOf(bSource?.id)}, ${symbolOf(tSource?.id)})`;
                        break;
                    case "Saturate":
                        expression = `saturate(${symbolOf(tSourceInput(node))})`;
                        break;
                    case "OneMinus":
                        expression = `1.0 - ${symbolOf(tSourceInput(node))}`;
                        break;
                    case "Dot":
                        expression = `dot(${symbolOf(aSource?.id)}, ${symbolOf(bSource?.id)})`;
                        break;
                    case "Normalize":
                        expression = `normalize(${symbolOf(tSourceInput(node))})`;
                        break;
                    default:
                        expression = "?";
                        break;
                }
                return `${outType} ${temp} = ${expression};`;
            }
            default:
                return undefined; // impossible here: diagnosed before lowering
        }
    };

    // Unary ops take their operand from "value" (declared here to keep the
    // switch above flat).
    function tSourceInput(node: GraphNode): string | undefined {
        const input = inputSourceOf(node, "value");
        return input?.id;
    }

    const statements: { readonly text: string; readonly nodeId: string; readonly portId: string }[] = [];
    for (const nodeId of liveIds) {
        if (nodeId === rootId) {
            continue;
        }
        const node = nodeById.get(nodeId);
        if (node === undefined) {
            continue;
        }
        const definition = getNodeDefinition(node.type);
        if (definition === undefined) {
            diagnostics.push(
                errorAt(nodePath(nodeId), DiagnosticCode.UnsupportedNodeEmission, `Node "${nodeId}" has type "${node.type}", which this core does not define and therefore cannot lower.`),
            );
            continue;
        }
        // Emission refuses node versions it does not implement, even though
        // structural validation reports them only as warnings.
        const versionRange = definition.versionRange;
        if (node.version < versionRange.minimumVersion || node.version > versionRange.maximumVersion) {
            diagnostics.push(
                errorAt(
                    nodePath(nodeId),
                    DiagnosticCode.UnknownNodeVersion,
                    `Node "${nodeId}" (${node.type}) has version ${node.version}, outside the supported range ${versionRange.minimumVersion}..${versionRange.maximumVersion}; emission cannot lower it.`,
                ),
            );
            continue;
        }
        // Texture sampling: the v1 contract gap (generation-side sampler
        // spelling) is the operative refusal reason for these node kinds.
        if (node.type === "Texture2DParameter" || node.type === "SampleTexture2D") {
            diagnostics.push(
                errorAt(
                    nodePath(nodeId),
                    DiagnosticCode.UnsupportedNodeEmission,
                    `Node "${nodeId}" (${node.type}) requires the texture-sampling signature spelling, which the frozen v1 contract does not specify (samplerAuthoring is deferred and sampler resolution is owned by the material binding layer).`,
                ),
            );
            continue;
        }
        // The value model is per node; any other multi-output node needs
        // the per-(nodeId, portId) model and is refused explicitly.
        if (definition.outputs.length > 1) {
            diagnostics.push(
                errorAt(
                    nodePath(nodeId),
                    DiagnosticCode.UnsupportedNodeEmission,
                    `Node "${nodeId}" (${node.type}) declares ${definition.outputs.length} output ports; this emitter's value model is per node (single output), so multi-output node emission is refused explicitly.`,
                ),
            );
            continue;
        }
        const text = lowerNode(node);
        if (text === undefined) {
            continue; // diagnosed
        }
        statements.push({ text, nodeId, portId: "value" });
    }

    // The single output root assembles the descriptor's required outputs in
    // descriptor list order.
    const root = nodeById.get(rootId);
    const assignments: { readonly text: string; readonly nodeId: string; readonly portId: string; readonly name: string }[] = [];
    if (root !== undefined) {
        for (const requiredOutput of descriptor.requiredOutputs) {
            const connection = connections.find((candidate) => candidate.to.nodeId === root.id && candidate.to.portId === requiredOutput.name);
            if (connection === undefined) {
                diagnostics.push(
                    errorAt(nodePath(rootId), DiagnosticCode.MissingRequiredInput, `Output node "${root.id}" has required input "${requiredOutput.name}" without a connection.`),
                );
                continue;
            }
            const sourceType = resolveOutputType(connection.from.nodeId);
            if (sourceType === undefined) {
                // Already diagnosed during lowering/type resolution.
                continue;
            }
            if (sourceType !== requiredOutput.type) {
                diagnostics.push(
                    errorAt(nodePath(rootId), DiagnosticCode.TypeMismatch, `Output "${requiredOutput.name}" expects ${requiredOutput.type}; the connected source produces ${sourceType ?? "an unresolvable type"}.`),
                );
                continue;
            }
            const sourceSymbol = valueSymbols.get(connection.from.nodeId);
            if (sourceSymbol === undefined) {
                continue;
            }
            assignments.push({ text: `    surface.${requiredOutput.name} = ${sourceSymbol};`, nodeId: connection.from.nodeId, portId: "value", name: requiredOutput.name });
        }
    }

    if (diagnostics.length > 0) {
        return fail(diagnostics);
    }

    // Assembly.
    const objectName = descriptor.generatedFunction.returnValue.objectName;
    const functionName = descriptor.generatedFunction.name;
    const signatureEntries: { readonly text: string; readonly range: Omit<ShaderGraphSourceMapRange, "startLine" | "startColumn" | "endLine" | "endColumn"> }[] = [];
    for (const parameter of canonicalParameters) {
        const type = parameterTypeById.get(parameter.id);
        if (type === undefined) {
            continue; // resource parameter (no v1 spelling)
        }
        signatureEntries.push({ text: `    ${type} ${signatureSymbols.get(parameter.id) ?? "?"}`, range: { role: "graphParameterDeclaration", parameterId: parameter.id } });
    }
    descriptor.graphVisibleInputs.forEach((input) => {
        signatureEntries.push({
            text: `    ${input.type} ${signatureSymbols.get(input.id) ?? "?"}`,
            range: { role: "graphVisibleInputDeclaration", graphVisibleInputId: input.id },
        });
    });
    // Trailing comma: every entry except the overall last.
    const total = signatureEntries.length;
    const signatureLines = signatureEntries.map((entry, index) => ({
        text: index === total - 1 ? entry.text : `${entry.text},`,
        range: entry.range,
    }));

    interface EmittedLine {
        readonly text: string;
        /** Present when the line stands for a navigable graph/profile identity. */
        readonly range?: Omit<ShaderGraphSourceMapRange, "startLine" | "startColumn" | "endLine" | "endColumn">;
    }
    const lines: EmittedLine[] = [
        { text: "// Generated by GGLab ShaderGraphCore. Do not edit; regenerate from the source .shadergraph document." },
        ...descriptor.requiredIncludes.map((include) => ({ text: `#include "${include}"`, range: { role: "include" as const, name: include } })),
        { text: "" },
        { text: `struct ${objectName}` },
        { text: "{" },
        ...descriptor.requiredOutputs.map((output) => ({ text: `    ${output.type} ${output.name};`, range: { role: "requiredOutputField" as const, name: output.name } })),
        { text: "};" },
        { text: "" },
        { text: `${objectName} ${functionName}(`, range: { role: "generatedFunctionDeclaration" } },
        ...signatureLines,
        { text: ")" },
        { text: "{" },
        { text: `    ${objectName} surface;` },
        ...statements.map((statement) => ({ text: `    ${statement.text}`, range: { role: "nodeValueStatement" as const, nodeId: statement.nodeId, portId: statement.portId } })),
        ...assignments.map((assignment) => ({ text: assignment.text, range: { role: "requiredOutputAssignment" as const, nodeId: assignment.nodeId, portId: assignment.portId, name: assignment.name } })),
        { text: "    return surface;" },
        { text: "}" },
    ];

    const source = lines.map((line) => line.text).join("\n") + "\n";

    // §24: line/column ranges, 1-based lines, 1-based columns, end column
    // exclusive; each range spans its single generated line.
    const ranges: ShaderGraphSourceMapRange[] = [];
    lines.forEach((line, index) => {
        if (line.range === undefined) {
            return;
        }
        ranges.push({
            startLine: index + 1,
            startColumn: 1,
            endLine: index + 1,
            endColumn: line.text.length + 1,
            ...line.range,
        });
    });
    const sourceMap: ShaderGraphSourceMap = {
        generatedSourceIdentity: sha256Hex(utf8Encode(source)),
        ranges,
    };

    // On success, carry the non-error structural-validation diagnostics
    // (for example unknown nodes/versions outside the live emission path).
    const carriedDiagnostics = validation.diagnostics.filter((diagnostic) => diagnostic.severity !== "error");

    return { ok: true, diagnostics: carriedDiagnostics, source, sourceMap };
}
