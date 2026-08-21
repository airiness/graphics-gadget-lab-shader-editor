/**
 * Deterministic HLSL emission (architecture §14) — the pipeline's final
 * structural stage: validation → topology → parameter conformance →
 * port-aware type resolution → lower the live subgraph → assembly against
 * the descriptor's logical contract.
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
 * - Port-aware type resolution is not done here: the core's
 *   `resolveGraphTypes` service (graph-type-resolution.ts) is the single
 *   type authority, and emission only *consumes* its resolved
 *   (node, port) → type results. It resolves per output port — which is
 *   why SampleTexture2D's RGBA/RGB/R/G/B/A ports resolve even though the
 *   v1 contract still refuses lowering them.
 * - The value model is per node (one value statement per lowered node).
 *   Any live node whose definition declares more than one output port is
 *   refused with an explicit UNSUPPORTED_NODE_EMISSION diagnostic rather than
 *   silently lowered through the single-value path; multi-output lowering
 *   (one shared physical statement feeding several ports, for example
 *   SampleTexture2D's single sample feeding RGBA/RGB/R/G/B/A) arrives with
 *   the texture-sampling contract, after the descriptor freeze.
 * - Graph parameter types are authored, not inferred: every parameter entry
 *   declares a concrete `valueType` (core value vocabulary, enforced at
 *   parse time). Emission checks that (class, valueType) pairing against the
 *   descriptor's `parameterClasses` — profile conformance, not dataflow
 *   guessing. A class the descriptor defers or does not define is a
 *   structured UNSUPPORTED_PARAMETER_CLASS error, and a valueType the
 *   profile's class does not permit is a structured
 *   UNSUPPORTED_PARAMETER_TYPE error; neither is ever substituted or
 *   re-derived from how the parameter is used.
 * - Binary math operations follow the documented conservative result rule
 *   (§11.2), applied by the type resolution service: identical vectors
 *   keep the type, a scalar widens to the vector operand, and distinct
 *   vector sizes are a TYPE_MISMATCH.
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
import { getNodeDefinition } from "./node-definitions.js";
import type { SurfaceProfileDescriptor } from "./surface-profile-descriptor.js";
import { sha256Hex, utf8Encode } from "./sha256.js";
import { resolveGraphTopology } from "./topology.js";
import { resolveGraphTypes } from "./graph-type-resolution.js";
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
    const rootId = topology.outputRootIds[0] as string;

    // Canonical parameter order: stable-id sorted. The persisted
    // parameters[] array order is incidental serialization, so emission
    // (signature lines, diagnostics) must not follow it.
    const parameterIndexById = new Map<string, number>(document.parameters.map((parameter, index) => [parameter.id, index]));
    const canonicalParameters = [...new Set(document.parameters.map((parameter) => parameter.id))].sort().flatMap((id) => {
        const parameter = document.parameters.find((entry) => entry.id === id);
        return parameter === undefined ? [] : [parameter];
    });

    // Graph parameter signature types: the authored concrete type on the
    // parameter entry (vocabulary enforced at parse time), conformance-checked
    // against the descriptor's `parameterClasses`. The pairing check is
    // profile conformance; no type is ever derived from usage.
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
            // Resource class (for example Texture2D): conformance still
            // applies — the authored type must be the class's declared
            // resource type — but v1 contributes no signature line, because
            // the generated spelling for a texture+sampler binding is not
            // frozen; its nodes are refused explicitly during lowering.
            if (classEntry.valueType !== parameter.valueType) {
                diagnostics.push(
                    errorAt(
                        `$.parameters[${index}]`,
                        DiagnosticCode.UnsupportedParameterType,
                        `Graph parameter "${parameter.id}" declares valueType "${parameter.valueType}", but class "${parameter.class}" in this profile is typed "${classEntry.valueType}".`,
                    ),
                );
            }
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
            continue;
        }
        parameterTypeById.set(parameter.id, parameter.valueType);
    }

    if (diagnostics.length > 0) {
        return fail(diagnostics);
    }

    // Port-aware type resolution: the core's single type authority. Emission
    // only consumes the resolved (node, port) → type results; it does not
    // re-derive them.
    const resolved = resolveGraphTypes(document);
    if (resolved.diagnostics.length > 0) {
        diagnostics.push(...resolved.diagnostics);
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
                // Consumed from the resolved type (the authored value type),
                // not re-derived here.
                const type = resolved.typeAt(node.id, "value");
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
                const outType = resolved.typeAt(node.id, "value");
                if (outType === undefined) {
                    diagnostics.push(
                        errorAt(nodePath(node.id), DiagnosticCode.TypeMismatch, `Node "${node.id}" (${node.type}): the output type could not be resolved`),
                    );
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
            // Port-level: the exact output port the connection names, per
            // the shared type authority (not the node's single-value type).
            const sourceType = resolved.typeAt(connection.from.nodeId, connection.from.portId);
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
