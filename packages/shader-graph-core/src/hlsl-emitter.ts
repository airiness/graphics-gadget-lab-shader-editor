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
 * Scope and contract-driven texture sampling (recorded so they cannot be
 * read as accidental):
 * - The full numeric surface is emitted: float constants, scalar/vector
 *   graph parameters, math nodes, UV0, and the SurfaceOutput assembly.
 * - Texture sampling is governed entirely by the descriptor's sampling
 *   contract. A descriptorVersion 1 file serializes no generated texture
 *   signature, so `Texture2DParameter`/`SampleTexture2D` are refused with
 *   a structured UNSUPPORTED_NODE_EMISSION diagnostic and the spelling is
 *   never invented. A descriptorVersion 2 file freezes the generated
 *   signature (one uint2 (texture binding index, sampler binding index)
 *   parameter per texture parameter, each slot's role naming what it
 *   carries) and the sample expression (the compiler-provided bindless
 *   heap builtins, the heap element types, NonUniformResourceIndex, and
 *   Sample over a float2 coordinate, yielding float4); emission lowers both
 *   kinds per that serialized contract and emits the sampling helper once,
 *   derived from the descriptor's fields — including which slot index each
 *   heap reads — rather than re-spelled or re-invented here. Compatibility
 *   with a profile line is judged on capability, never on version numbers:
 *   a profile line whose semantics require the texture-signature contract
 *   is refused against a descriptor that does not serialize it.
 * - Port-aware type resolution is not done here: the core's
 *   `resolveGraphTypes` service (graph-type-resolution.ts) is the single
 *   type authority, and emission only *consumes* its resolved
 *   (node, port) → type results. It owns the concrete input constraints —
 *   including the required outputs fed to the output node — so emission
 *   carries no type check of its own. It resolves per output port (which
 *   is why SampleTexture2D's RGBA/RGB/R/G/B/A ports resolve even though
 *   the v1 contract still refuses lowering them), it enforces the
 *   conservative result rules standalone (a node it does not implement
 *   semantically carries no resolved types rather than being guessed to
 *   behave like a supported version), and it can be scoped: emission
 *   resolves the live slice while whole-document resolution serves the
 *   authoring surface — one implementation, two domains.
 * - The value model is per node (one value statement per lowered node).
 *   Any live node whose definition declares more than one output port is
 *   refused with an explicit UNSUPPORTED_NODE_EMISSION diagnostic rather
 *   than silently lowered through the single-value path — except the
 *   texture sampler under a descriptorVersion 2 contract: one shared
 *   physical float4 statement per SampleTexture2D feeds RGBA/RGB/R/G/B/A
 *   through channel access at every consuming input, and that channel
 *   decomposition is core node semantics (the descriptor never defines
 *   channel outputs).
 * - Graph parameter types are authored, not inferred: every parameter entry
 *   declares a concrete `valueType` (core value vocabulary, enforced at
 *   parse time). The (class, valueType) pairing is checked by the shared
 *   `checkProfileConformance` service (profile-conformance.ts) against the
 *   descriptor's `parameterClasses` — the same authority the GUI and CLI
 *   consume, so "the profile does not permit this pair" is never
 *   something emission alone can report, and the GUI never has to fake a
 *   compile to hear it. A class the descriptor defers or does not define
 *   is a structured UNSUPPORTED_PARAMETER_CLASS error, and a valueType the
 *   profile's class does not permit is a structured
 *   UNSUPPORTED_PARAMETER_TYPE error; neither is ever substituted or
 *   re-derived from how the parameter is used. Emission consumes the
 *   verdicts and adds the contract decision: resource classes (texture
 *   bindings) contribute no signature line under descriptorVersion 1 (the
 *   generated resource spelling is unfrozen there), and one generated
 *   signature parameter per the frozen `generatedTextureSignature` under
 *   descriptorVersion 2.
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
import { checkProfileConformance } from "./profile-conformance.js";
import { validateShaderGraph } from "./validation.js";

/** What a generated-source range stands for (architecture §24 "semantic role"). */
export type ShaderGraphSourceMapRole =
    | "include"
    | "requiredOutputField"
    | "generatedFunctionDeclaration"
    | "graphParameterDeclaration"
    | "graphVisibleInputDeclaration"
    | "textureSampleHelperDeclaration"
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

/**
 * The core-generated name of the texture sampling helper (emitted once when
 * the live graph samples a texture). It shares the `gglab_` signature
 * namespace, so a parameter id that sanitizes to the same base collides
 * into `..._2` through the ordinary claim rule (the base is pre-reserved).
 */
const TEXTURE_SAMPLE_HELPER_IDENTIFIER = "sampleTexture2D";
const TEXTURE_SAMPLE_HELPER_NAME = `gglab_${TEXTURE_SAMPLE_HELPER_IDENTIFIER}`;

/**
 * Channel decomposition of the SampleTexture2D float4 sample. This is
 * ShaderGraphCore node semantics (which HLSL component access each channel
 * port stands for); the descriptor never defines channel outputs.
 */
const SAMPLE_CHANNEL_ACCESS: Readonly<Record<string, string>> = {
    RGBA: "",
    RGB: ".rgb",
    R: ".r",
    G: ".g",
    B: ".b",
    A: ".a",
};

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
function buildSymbols(ids: readonly string[], prefix: string, reservedBases: readonly string[] = []): Map<string, string> {
    const uniqueSorted = [...new Set(ids)].sort();
    const claimCount = new Map<string, number>();
    for (const reserved of new Set(reservedBases)) {
        claimCount.set(reserved, (claimCount.get(reserved) ?? 0) + 1);
    }
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
    const canonicalParameters = [...new Set(document.parameters.map((parameter) => parameter.id))].sort().flatMap((id) => {
        const parameter = document.parameters.find((entry) => entry.id === id);
        return parameter === undefined ? [] : [parameter];
    });

    // Profile conformance: the (class, valueType) pairing authority shared
    // with the GUI/CLI. Emission consumes the verdicts; it does not
    // re-derive them.
    const conformance = checkProfileConformance(document, descriptor);
    if (conformance.diagnostics.length > 0) {
        diagnostics.push(...conformance.diagnostics);
        return fail(diagnostics);
    }
    const conformanceById = new Map(conformance.parameters.map((entry) => [entry.parameterId, entry]));

    // The generated texture-signature contract, when this descriptor
    // serializes one (descriptorVersion 2). descriptorVersion 1 files
    // express no generated spelling, so emission keeps the frozen v1
    // refusal instead of inventing a spelling; the fields consumed here are
    // descriptor-owned literals (validated by the reader), not re-spelled
    // contract text.
    const textureContract =
        "generatedTextureSignature" in descriptor.samplingContract
            ? { signature: descriptor.samplingContract.generatedTextureSignature, form: descriptor.samplingContract.generatedSampleForm }
            : undefined;

    // Profile contract compatibility is a capability question, not a
    // version-number comparison: the gglab.surface v2 line includes the
    // texture-sampling semantics, so its descriptor must serialize the
    // generated texture-signature contract (the descriptorVersion 2
    // addition). A descriptor that cannot express it is incompatible with
    // that profile line whatever its serialization number is — and a
    // future serialization that still expresses it keeps working. The
    // version axes stay independent (AGENTS.md).
    if (document.profile === "gglab.surface" && document.profileVersion >= 2 && textureContract === undefined) {
        diagnostics.push(
            errorAt(
                "$",
                DiagnosticCode.ProfileMismatch,
                `Profile "gglab.surface" version ${document.profileVersion} requires the generated texture-signature contract, which this descriptor does not serialize.`,
            ),
        );
        return fail(diagnostics);
    }

    // Port-aware type resolution: the core's single type authority — it
    // owns the concrete input constraints, including the output node's
    // required outputs, so emission no longer carries its own half of the
    // type check. Emission resolves only the *live* slice: dead authoring
    // content (trial nodes, disconnected experiments) may carry type
    // failures without blocking compilation; whole-document resolution
    // remains the authority's job for authoring consumers.
    const resolved = resolveGraphTypes(document, { nodeIds: new Set(topology.executionOrder) });
    if (resolved.diagnostics.length > 0) {
        diagnostics.push(...resolved.diagnostics);
        return fail(diagnostics);
    }

    // Symbol namespaces: the contract parameter space (graph parameters and
    // graph-visible inputs share one namespace) and node values.
    const signatureSymbols = buildSymbols(
        [...document.parameters.map((parameter) => parameter.id), ...descriptor.graphVisibleInputs.map((input) => input.id)],
        "gglab_",
        [TEXTURE_SAMPLE_HELPER_NAME],
    );
    const valueSymbols = buildSymbols(liveIds, "v_");

    // Input resolution: the single connection feeding (node, port), and the
    // value expression it carries. The expression is the source node's value
    // symbol plus, for multi-output sources, the channel access of the
    // consumed port (SampleTexture2D's one float4 sample decomposes per
    // channel — core node semantics; the descriptor never defines channel
    // outputs).
    const inputAccess = (node: GraphNode, portId: string): { readonly expression: string; readonly nodeId: string | undefined; readonly nodePortId: string | undefined } => {
        const connection = connections.find((candidate) => candidate.to.nodeId === node.id && candidate.to.portId === portId);
        if (connection === undefined) {
            return { expression: "?", nodeId: undefined, nodePortId: undefined };
        }
        const base = valueSymbols.get(connection.from.nodeId) ?? "?";
        const source = nodeById.get(connection.from.nodeId);
        const channel = source?.type === "SampleTexture2D" ? (SAMPLE_CHANNEL_ACCESS[connection.from.portId] ?? "") : "";
        return { expression: `${base}${channel}`, nodeId: connection.from.nodeId, nodePortId: connection.from.portId };
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
                const aInput = inputAccess(node, "a");
                const bInput = inputAccess(node, "b");
                const tInput = inputAccess(node, "t");
                const vInput = inputAccess(node, "value");
                let expression: string;
                switch (node.type) {
                    case "Add":
                        expression = `${aInput.expression} + ${bInput.expression}`;
                        break;
                    case "Subtract":
                        expression = `${aInput.expression} - ${bInput.expression}`;
                        break;
                    case "Multiply":
                        expression = `${aInput.expression} * ${bInput.expression}`;
                        break;
                    case "Divide":
                        expression = `${aInput.expression} / ${bInput.expression}`;
                        break;
                    case "Min":
                        expression = `min(${aInput.expression}, ${bInput.expression})`;
                        break;
                    case "Max":
                        expression = `max(${aInput.expression}, ${bInput.expression})`;
                        break;
                    case "Lerp":
                        expression = `lerp(${aInput.expression}, ${bInput.expression}, ${tInput.expression})`;
                        break;
                    case "Saturate":
                        expression = `saturate(${vInput.expression})`;
                        break;
                    case "OneMinus":
                        expression = `1.0 - ${vInput.expression}`;
                        break;
                    case "Dot":
                        expression = `dot(${aInput.expression}, ${bInput.expression})`;
                        break;
                    case "Normalize":
                        expression = `normalize(${vInput.expression})`;
                        break;
                    default:
                        expression = "?";
                        break;
                }
                return `${outType} ${temp} = ${expression};`;
            }
            case "Texture2DParameter": {
                // descriptorVersion 2 lowers the texture parameter with the
                // frozen generated signature (the uint2 binding pair); the
                // gate below the statement loop already refused this kind on
                // descriptorVersion 1 descriptors.
                const contract = textureContract;
                const referenceId = node.properties["parameterId"];
                const signatureSymbol = typeof referenceId === "string" ? (signatureSymbols.get(referenceId) ?? undefined) : undefined;
                if (contract === undefined || signatureSymbol === undefined) {
                    diagnostics.push(
                        errorAt(path, DiagnosticCode.UnresolvedParameterReference, `Node "${node.id}" (${node.type}) cannot be lowered: its graph parameter has no resolved signature symbol.`),
                    );
                    return undefined;
                }
                return `${contract.signature.parameterType} ${temp} = ${signatureSymbol};`;
            }
            case "SampleTexture2D": {
                // descriptorVersion 2: one shared float4 statement via the
                // generated sampling helper; channel ports decompose at the
                // consuming inputs (SAMPLE_CHANNEL_ACCESS).
                const contract = textureContract;
                const textureInput = inputAccess(node, "texture");
                const uvInput = inputAccess(node, "uv");
                if (contract === undefined || textureInput.nodeId === undefined || uvInput.nodeId === undefined) {
                    diagnostics.push(
                        errorAt(path, DiagnosticCode.TypeMismatch, `Node "${node.id}" (${node.type}) requires a resolved texture binding (Texture2D) and a float2 coordinate; one or both could not be resolved.`),
                    );
                    return undefined;
                }
                return `${contract.form.resultType} ${temp} = ${TEXTURE_SAMPLE_HELPER_NAME}(${textureInput.expression}, ${uvInput.expression});`;
            }
            default:
                return undefined; // impossible here: diagnosed before lowering
        }
    };

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
        // Texture sampling is contract-driven: descriptorVersion 1 files
        // serialize no generated texture signature, so these node kinds are
        // refused (structured; the spelling is a cross-repository contract
        // decision, never invented). descriptorVersion 2 files freeze the
        // signature and sample form, and the kinds lower per that contract.
        if ((node.type === "Texture2DParameter" || node.type === "SampleTexture2D") && textureContract === undefined) {
            diagnostics.push(
                errorAt(
                    nodePath(nodeId),
                    DiagnosticCode.UnsupportedNodeEmission,
                    `Node "${nodeId}" (${node.type}) requires the texture-sampling signature spelling, which this descriptor does not serialize (the profile's sampling contract defers the generated spelling).`,
                ),
            );
            continue;
        }
        // The value model is per node; the texture sampler's six channel
        // ports are the sanctioned multi-output case (one shared float4
        // statement, decomposed per channel at the consumers). Any OTHER
        // multi-output node needs the per-(nodeId, portId) model and is
        // refused explicitly.
        if (definition.outputs.length > 1 && node.type !== "SampleTexture2D") {
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
        // The texture sampler's physical value is its RGBA (float4) port;
        // channel ports decompose from it at the consuming inputs.
        statements.push({ text, nodeId, portId: node.type === "SampleTexture2D" ? "RGBA" : "value" });
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
            // The concrete type of this edge is the type authority's ruling
            // (it checked the required-output input ports before lowering);
            // emission only emits. An undefined type here means a
            // structural or resolution gate has already failed the graph.
            if (resolved.typeAt(connection.from.nodeId, connection.from.portId) === undefined) {
                continue;
            }
            const source = nodeById.get(connection.from.nodeId);
            const base = valueSymbols.get(connection.from.nodeId);
            if (base === undefined || source === undefined) {
                continue;
            }
            // Channel decomposition at the consumer (the sampler's one float4
            // statement feeds each channel port through its component
            // access).
            const channel = source.type === "SampleTexture2D" ? (SAMPLE_CHANNEL_ACCESS[connection.from.portId] ?? "") : "";
            assignments.push({
                text: `    surface.${requiredOutput.name} = ${base}${channel};`,
                nodeId: connection.from.nodeId,
                portId: connection.from.portId,
                name: requiredOutput.name,
            });
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
        // The verdict comes from the shared conformance service; the
        // contract decides what a resource class contributes: no line under
        // descriptorVersion 1 (the generated resource spelling is unfrozen
        // there and the node refuses to lower), or the frozen generated
        // signature under descriptorVersion 2.
        const verdict = conformanceById.get(parameter.id);
        if (verdict === undefined) {
            continue;
        }
        const parameterType = verdict.resourceClass ? textureContract?.signature.parameterType : verdict.valueType;
        if (parameterType === undefined) {
            continue;
        }
        signatureEntries.push({ text: `    ${parameterType} ${signatureSymbols.get(parameter.id) ?? "?"}`, range: { role: "graphParameterDeclaration", parameterId: parameter.id } });
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
    // The generated sampling helper: emitted exactly once when the live
    // graph samples a texture, spelled entirely from the descriptor's
    // generatedSampleForm and generatedTextureSignature — the descriptor is
    // the single contract statement, and emission never re-invents a
    // spelling. Each heap index uses the slot declared for its role: the
    // component role is the contract authority for what a slot carries, and
    // its slot position decides the generated component accessor (no
    // invisible x/y convention in emission).
    const textureSampled = statements.some((statement) => nodeById.get(statement.nodeId)?.type === "SampleTexture2D");
    const helperLines: EmittedLine[] = [];
    if (textureSampled && textureContract !== undefined) {
        const { signature, form } = textureContract;
        const componentAccessors = [".x", ".y", ".z", ".w"];
        const accessorForRole = (role: string): string | undefined => {
            const component = signature.componentOrder.find((candidate) => candidate.role === role);
            return component === undefined ? undefined : componentAccessors[component.position];
        };
        const textureIndexAccessor = accessorForRole("textureBindingIndex");
        const samplerIndexAccessor = accessorForRole("samplerBindingIndex");
        // The reader guarantees a descriptorVersion 2 signature carries
        // both roles over both slots; this guard keeps the guard
        // structural in case a future shape changes that guarantee.
        if (textureIndexAccessor !== undefined && samplerIndexAccessor !== undefined) {
            helperLines.push(
                { text: "" },
                {
                    text: `${form.resultType} ${TEXTURE_SAMPLE_HELPER_NAME}(${signature.parameterType} textureSamplerBinding, ${form.coordinateType} uv0)`,
                    range: { role: "textureSampleHelperDeclaration", name: TEXTURE_SAMPLE_HELPER_NAME },
                },
                { text: "{" },
                { text: `    ${form.resourceElementType} texture = ${form.resourceHeapBuiltin}[${form.indexScope}(textureSamplerBinding${textureIndexAccessor})];` },
                { text: `    ${form.samplerElementType} sampler = ${form.samplerHeapBuiltin}[${form.indexScope}(textureSamplerBinding${samplerIndexAccessor})];` },
                { text: `    return texture.${form.operation}(sampler, uv0);` },
                { text: "}" },
            );
        }
    }
    const lines: EmittedLine[] = [
        { text: "// Generated by GGLab ShaderGraphCore. Do not edit; regenerate from the source .shadergraph document." },
        ...descriptor.requiredIncludes.map((include) => ({ text: `#include "${include}"`, range: { role: "include" as const, name: include } })),
        { text: "" },
        { text: `struct ${objectName}` },
        { text: "{" },
        ...descriptor.requiredOutputs.map((output) => ({ text: `    ${output.type} ${output.name};`, range: { role: "requiredOutputField" as const, name: output.name } })),
        { text: "};" },
        ...helperLines,
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
