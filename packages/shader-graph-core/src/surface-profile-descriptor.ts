/**
 * Strict reader for the Surface Profile Descriptor.
 *
 * The descriptor is a serialized data document owned by the main GGLab
 * repository (the canonical v1 instance is
 * `Shaders/Profiles/GGLab.Surface/1/descriptor.json`; the canonical v2
 * instance, which serializes the profileVersion 2 texture-signature
 * contract, is `Shaders/Profiles/GGLab.Surface/2/descriptor.json`). The
 * core consumes it as parsed JSON only — never as a C++ ABI, header import,
 * or native linkage. This module reads exactly descriptorVersion 1 and 2:
 * each version projects its own field vocabulary and rejects everything it
 * does not support explicitly.
 *
 * Strictness rules for the descriptor:
 * - `descriptorVersion` outside {@link SUPPORTED_DESCRIPTOR_VERSION_RANGE} is
 *   rejected before any other field is interpreted. A reader must never
 *   reinterpret descriptors it does not support.
 * - Every field of the file's own descriptorVersion is required and
 *   type-checked, and unknown fields at any level are an explicit failure
 *   — including a field of a newer version on an older-version file, which
 *   must be rejected rather than half-consumed. The descriptor is a
 *   cross-boundary contract; a half-understood contract is a broken
 *   contract.
 * - The version axes stay independent (serialization vs profile semantics),
 *   but their combination is checked: descriptorVersion 2 is the
 *   serialization of the profileVersion 2 texture-signature contract, so a
 *   file mixing descriptorVersion 2 with profileVersion 1 (or the reverse)
 *   is a self-contradictory contract and is rejected explicitly.
 */
import type { ParseResult, ShaderGraphDiagnostic } from "./diagnostics.js";
import { DiagnosticCode } from "./diagnostics.js";
import { isJsonRecord, jsonKind } from "./json-value.js";
import type { JsonRecord, JsonValue } from "./json-value.js";
import { errorAt, rejectUnknownFields, requireBoolean, requireInteger, requireLiteral, requireString, requireStringArray, takeArray, takeField, takeObject } from "./parse-helpers.js";

export interface DescriptorVersionRange {
    readonly minimum: number;
    readonly maximum: number;
}

/** The range of `descriptorVersion` values this reader supports. */
export const SUPPORTED_DESCRIPTOR_VERSION_RANGE: DescriptorVersionRange = {
    minimum: 1,
    maximum: 2,
};

export interface SurfaceProfileDescriptor {
    readonly descriptorVersion: number;
    readonly profileId: string;
    readonly profileVersion: number;
    readonly language: "hlsl";
    readonly generatedFunction: GeneratedFunctionContract;
    readonly graphVisibleInputs: readonly GraphVisibleInput[];
    readonly requiredOutputs: readonly RequiredSurfaceOutput[];
    readonly outputFieldOrdering: "descriptorListOrder";
    readonly parameterClasses: readonly ProfileParameterClass[];
    readonly resourceClasses: readonly ProfileResourceClass[];
    readonly samplingContract: SamplingContract | SamplingContractTexture;
    readonly requiredIncludes: readonly string[];
    readonly processContract: ProcessContract;
    readonly deferred: DeferredFeatures;
}

export interface GeneratedFunctionContract {
    readonly name: string;
    readonly stage: "pixel";
    readonly returnValue: {
        readonly objectName: string;
        readonly fieldsSource: "requiredOutputs";
    };
    readonly parameterContract: {
        readonly ordering: "graphParametersThenGraphVisibleInputs";
        readonly graphParameters: {
            readonly source: "graphDocument";
            readonly classConstraint: "parameterClasses";
        };
        readonly graphVisibleInputs: {
            readonly source: "graphVisibleInputs";
        };
    };
}

export interface GraphVisibleInput {
    readonly id: string;
    readonly type: string;
    readonly semantic: string;
}

export interface RequiredSurfaceOutput {
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly semantic: string;
}

export interface ProfileParameterClass {
    readonly class: string;
    readonly valueType?: string;
    readonly valueTypes?: readonly string[];
}

export interface ProfileResourceClass {
    readonly class: string;
    readonly sampledType: string;
}

export interface SamplingContract {
    readonly policy: "reuseRuntimeTextureSamplerBinding";
    readonly appliesToResourceClass: string;
    readonly samplerAuthoring: "deferred";
    readonly samplerResolution: {
        readonly owner: "materialBindingLayer";
        readonly cardinality: "oneSamplerPerTexture2DBinding";
    };
    readonly authorableFilterModes: readonly string[];
    readonly authorableAddressModes: readonly string[];
    readonly comparisonSamplerAuthoring: "deferred";
}

/**
 * The profileVersion 2 addition: how a `Texture2DParameter` appears in the
 * generated signature. One `uint2` parameter per texture parameter whose
 * components are (texture binding index, sampler binding index), in that
 * order — the same pair representation the runtime binding layer uses.
 */
export interface GeneratedTextureSignature {
    readonly cardinality: "oneParameterPerTexture2DParameter";
    readonly parameterType: "uint2";
    readonly componentOrder: readonly TextureSignatureComponent[];
}

/** One component of the generated texture parameter pair. */
export interface TextureSignatureComponent {
    readonly position: 0 | 1;
    readonly meaning: string;
}

/**
 * The profileVersion 2 addition: the exact generated sampling expression —
 * the compiler-provided bindless heap builtins, the NonUniformResourceIndex
 * wrapping, and the Sample operation over a float2 coordinate yielding the
 * resource class' float4 type.
 */
export interface GeneratedSampleForm {
    readonly resourceHeapBuiltin: "ResourceDescriptorHeap";
    readonly resourceElementType: "Texture2D<float4>";
    readonly samplerHeapBuiltin: "SamplerDescriptorHeap";
    readonly indexScope: "NonUniformResourceIndex";
    readonly operation: "Sample";
    readonly coordinateType: "float2";
    readonly resultType: "float4";
}

/** `SamplingContract` plus the profileVersion 2 texture-signature fields. */
export interface SamplingContractTexture extends SamplingContract {
    readonly generatedTextureSignature: GeneratedTextureSignature;
    readonly generatedSampleForm: GeneratedSampleForm;
}

export interface ProcessContract {
    readonly tool: {
        readonly identity: string;
        readonly minimumVersion: string;
        readonly versionComparison: "semver";
    };
}

export interface DeferredFeatures {
    readonly parameterClasses: readonly string[];
    readonly surfaceOutputs: readonly string[];
}

const TOP_LEVEL_FIELDS: readonly string[] = [
    "descriptorVersion",
    "profileId",
    "profileVersion",
    "language",
    "generatedFunction",
    "graphVisibleInputs",
    "requiredOutputs",
    "outputFieldOrdering",
    "parameterClasses",
    "resourceClasses",
    "samplingContract",
    "requiredIncludes",
    "processContract",
    "deferred",
];

/**
 * Parses a Surface Profile Descriptor from JSON text supplied by the caller.
 * The core does no file IO: loading the descriptor bytes is the caller's
 * job.
 */
export function parseSurfaceProfileDescriptor(
    rawJson: string,
    supportedRange: DescriptorVersionRange = SUPPORTED_DESCRIPTOR_VERSION_RANGE,
): ParseResult<SurfaceProfileDescriptor> {
    let root: unknown;
    try {
        root = JSON.parse(rawJson);
    } catch {
        return { ok: false, value: null, diagnostics: [errorAt("$", DiagnosticCode.InvalidJson, "Input is not valid JSON.")] };
    }

    if (!isJsonRecord(root)) {
        return { ok: false, value: null, diagnostics: [errorAt("$", DiagnosticCode.UnexpectedType, `The descriptor root must be a JSON object, got ${jsonKind(root)}.`)] };
    }

    if (takeField(root, "descriptorVersion") === undefined) {
        return { ok: false, value: null, diagnostics: [errorAt("$.descriptorVersion", DiagnosticCode.MissingRequiredField, `Required field "descriptorVersion" is missing.`)] };
    }
    const version = root["descriptorVersion"] as JsonValue;
    if (typeof version !== "number" || !Number.isInteger(version)) {
        return { ok: false, value: null, diagnostics: [errorAt("$.descriptorVersion", DiagnosticCode.UnexpectedType, `Expected an integer descriptor version, got ${jsonKind(version)}.`)] };
    }
    if (version < supportedRange.minimum || version > supportedRange.maximum) {
        return {
            ok: false,
            value: null,
            diagnostics: [
                errorAt(
                    "$.descriptorVersion",
                    DiagnosticCode.UnsupportedDescriptorVersion,
                    `Descriptor version ${version} is outside the supported range ${supportedRange.minimum}..${supportedRange.maximum}; this reader must not reinterpret descriptors it does not support.`,
                ),
            ],
        };
    }

    const diagnostics: ShaderGraphDiagnostic[] = [];
    rejectUnknownFields(root, TOP_LEVEL_FIELDS, "$", diagnostics);

    const profileId = requireString(root, "profileId", "$", diagnostics);
    const profileVersion = requireInteger(root, "profileVersion", "$", diagnostics);
    const language = requireLanguage(root, diagnostics);
    const generatedFunction = parseGeneratedFunction(takeObject(root, "generatedFunction", "$", diagnostics), "$.generatedFunction", diagnostics);
    const graphVisibleInputs = parseGraphVisibleInputs(takeArray(root, "graphVisibleInputs", "$", diagnostics), "$.graphVisibleInputs", diagnostics);
    const requiredOutputs = parseRequiredOutputs(takeArray(root, "requiredOutputs", "$", diagnostics), "$.requiredOutputs", diagnostics);
    const outputFieldOrdering = requireLiteral(root, "outputFieldOrdering", "$", "descriptorListOrder", diagnostics);
    const parameterClasses = parseParameterClasses(takeArray(root, "parameterClasses", "$", diagnostics), "$.parameterClasses", diagnostics);
    const resourceClasses = parseResourceClasses(takeArray(root, "resourceClasses", "$", diagnostics), "$.resourceClasses", diagnostics);
    const samplingContract = parseSamplingContract(takeObject(root, "samplingContract", "$", diagnostics), "$.samplingContract", diagnostics, version);
    const requiredIncludes = requireStringArray(root, "requiredIncludes", "$", diagnostics);
    const processContract = parseProcessContract(takeObject(root, "processContract", "$", diagnostics), "$.processContract", diagnostics);
    const deferred = parseDeferred(takeObject(root, "deferred", "$", diagnostics), "$.deferred", diagnostics);

    // `hasErrors` is authoritative: every diagnostic this reader emits is an
    // error when it should not be there. The remaining checks exist so the
    // assembly below type-checks.
    const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
    if (
        hasErrors ||
        profileId === undefined ||
        profileVersion === undefined ||
        language === undefined ||
        generatedFunction === undefined ||
        graphVisibleInputs === undefined ||
        requiredOutputs === undefined ||
        outputFieldOrdering === undefined ||
        parameterClasses === undefined ||
        resourceClasses === undefined ||
        samplingContract === undefined ||
        requiredIncludes === undefined ||
        processContract === undefined ||
        deferred === undefined
    ) {
        return { ok: false, value: null, diagnostics };
    }

    // The version axes stay independent, but their combination is checked:
    // descriptorVersion 2 is the serialization of the profileVersion 2
    // texture-signature contract. A file mixing the two is a
    // self-contradictory contract, rejected explicitly (never reinterpreted).
    if (version === 2 && profileVersion !== 2) {
        diagnostics.push(
            errorAt(
                "$.profileVersion",
                DiagnosticCode.ProfileMismatch,
                `descriptorVersion 2 serializes the profileVersion 2 texture-signature contract; this file declares profileVersion ${profileVersion}.`,
            ),
        );
    }
    if (version === 1 && profileVersion !== 1) {
        diagnostics.push(
            errorAt(
                "$.descriptorVersion",
                DiagnosticCode.ProfileMismatch,
                `profileVersion ${profileVersion} includes the generated texture-signature contract, which the descriptorVersion 1 serialization cannot express.`,
            ),
        );
    }
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return { ok: false, value: null, diagnostics };
    }

    return {
        ok: true,
        value: {
            descriptorVersion: version,
            profileId,
            profileVersion,
            language,
            generatedFunction,
            graphVisibleInputs,
            requiredOutputs,
            outputFieldOrdering,
            parameterClasses,
            resourceClasses,
            samplingContract,
            requiredIncludes,
            processContract,
            deferred,
        },
        diagnostics,
    };
}

function requireLanguage(root: JsonRecord, diagnostics: ShaderGraphDiagnostic[]): "hlsl" | undefined {
    const value = requireString(root, "language", "$", diagnostics);
    if (value === undefined) {
        return undefined;
    }
    if (value !== "hlsl") {
        diagnostics.push(errorAt("$.language", DiagnosticCode.UnsupportedLanguage, `Expected language "hlsl", got "${value}".`));
        return undefined;
    }
    return "hlsl";
}

function parseGeneratedFunction(raw: JsonRecord | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): GeneratedFunctionContract | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const name = requireString(raw, "name", path, diagnostics);
    const stage = requireLiteral(raw, "stage", path, "pixel", diagnostics);

    const returnValueRaw = takeObject(raw, "returnValue", path, diagnostics);
    const objectName = returnValueRaw === undefined ? undefined : requireString(returnValueRaw, "objectName", `${path}.returnValue`, diagnostics);
    const fieldsSource = returnValueRaw === undefined ? undefined : requireLiteral(returnValueRaw, "fieldsSource", `${path}.returnValue`, "requiredOutputs", diagnostics);
    if (returnValueRaw !== undefined) {
        rejectUnknownFields(returnValueRaw, ["objectName", "fieldsSource"], `${path}.returnValue`, diagnostics);
    }

    const parameterContractRaw = takeObject(raw, "parameterContract", path, diagnostics);
    let ordering: "graphParametersThenGraphVisibleInputs" | undefined;
    let graphParameters: { readonly source: "graphDocument"; readonly classConstraint: "parameterClasses" } | undefined;
    let graphVisibleInputs: { readonly source: "graphVisibleInputs" } | undefined;
    if (parameterContractRaw !== undefined) {
        const orderingPath = `${path}.parameterContract`;
        ordering = requireLiteral(parameterContractRaw, "ordering", orderingPath, "graphParametersThenGraphVisibleInputs", diagnostics);
        const graphParametersRaw = takeObject(parameterContractRaw, "graphParameters", orderingPath, diagnostics);
        if (graphParametersRaw !== undefined) {
            const source = requireLiteral(graphParametersRaw, "source", `${orderingPath}.graphParameters`, "graphDocument", diagnostics);
            const classConstraint = requireLiteral(graphParametersRaw, "classConstraint", `${orderingPath}.graphParameters`, "parameterClasses", diagnostics);
            rejectUnknownFields(graphParametersRaw, ["source", "classConstraint"], `${orderingPath}.graphParameters`, diagnostics);
            if (source !== undefined && classConstraint !== undefined) {
                graphParameters = { source, classConstraint };
            }
        }
        const graphVisibleInputsRaw = takeObject(parameterContractRaw, "graphVisibleInputs", orderingPath, diagnostics);
        if (graphVisibleInputsRaw !== undefined) {
            const source = requireLiteral(graphVisibleInputsRaw, "source", `${orderingPath}.graphVisibleInputs`, "graphVisibleInputs", diagnostics);
            rejectUnknownFields(graphVisibleInputsRaw, ["source"], `${orderingPath}.graphVisibleInputs`, diagnostics);
            if (source !== undefined) {
                graphVisibleInputs = { source };
            }
        }
        rejectUnknownFields(parameterContractRaw, ["ordering", "graphParameters", "graphVisibleInputs"], orderingPath, diagnostics);
    }

    rejectUnknownFields(raw, ["name", "stage", "returnValue", "parameterContract"], path, diagnostics);

    if (name === undefined || stage === undefined || objectName === undefined || fieldsSource === undefined || ordering === undefined || graphParameters === undefined || graphVisibleInputs === undefined) {
        return undefined;
    }
    return {
        name,
        stage,
        returnValue: { objectName, fieldsSource },
        parameterContract: {
            ordering,
            graphParameters,
            graphVisibleInputs,
        },
    };
}

function parseGraphVisibleInputs(raw: readonly JsonValue[] | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): readonly GraphVisibleInput[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const result: GraphVisibleInput[] = [];
    let failed = false;
    raw.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (!isJsonRecord(item)) {
            diagnostics.push(errorAt(itemPath, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(item)}.`));
            failed = true;
            return;
        }
        const id = requireString(item, "id", itemPath, diagnostics);
        const type = requireString(item, "type", itemPath, diagnostics);
        const semantic = requireString(item, "semantic", itemPath, diagnostics);
        rejectUnknownFields(item, ["id", "type", "semantic"], itemPath, diagnostics);
        if (id === undefined || type === undefined || semantic === undefined) {
            failed = true;
            return;
        }
        result.push({ id, type, semantic });
    });
    return failed ? undefined : result;
}

function parseRequiredOutputs(raw: readonly JsonValue[] | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): readonly RequiredSurfaceOutput[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const result: RequiredSurfaceOutput[] = [];
    let failed = false;
    raw.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (!isJsonRecord(item)) {
            diagnostics.push(errorAt(itemPath, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(item)}.`));
            failed = true;
            return;
        }
        const name = requireString(item, "name", itemPath, diagnostics);
        const type = requireString(item, "type", itemPath, diagnostics);
        const required = requireBoolean(item, "required", itemPath, diagnostics);
        const semantic = requireString(item, "semantic", itemPath, diagnostics);
        rejectUnknownFields(item, ["name", "type", "required", "semantic"], itemPath, diagnostics);
        if (name === undefined || type === undefined || required === undefined || semantic === undefined) {
            failed = true;
            return;
        }
        result.push({ name, type, required, semantic });
    });
    return failed ? undefined : result;
}

function parseParameterClasses(raw: readonly JsonValue[] | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): readonly ProfileParameterClass[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const result: ProfileParameterClass[] = [];
    let failed = false;
    raw.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (!isJsonRecord(item)) {
            diagnostics.push(errorAt(itemPath, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(item)}.`));
            failed = true;
            return;
        }
        const cls = requireString(item, "class", itemPath, diagnostics);
        const valueType = takeField(item, "valueType");
        const valueTypes = takeField(item, "valueTypes");
        const valueTypeDeclared = valueType !== undefined;
        const valueTypesDeclared = valueTypes !== undefined;
        let valueTypeValid = !valueTypeDeclared;
        if (valueTypeDeclared) {
            valueTypeValid = typeof valueType === "string" && valueType.length > 0;
            if (!valueTypeValid) {
                diagnostics.push(errorAt(`${itemPath}.valueType`, DiagnosticCode.UnexpectedType, `Expected a non-empty string, got ${jsonKind(valueType)}.`));
            }
        }
        let valueTypesValid = !valueTypesDeclared;
        if (valueTypesDeclared) {
            valueTypesValid = Array.isArray(valueTypes) && (valueTypes as readonly unknown[]).every((entry) => typeof entry === "string");
            if (!valueTypesValid) {
                diagnostics.push(errorAt(`${itemPath}.valueTypes`, DiagnosticCode.UnexpectedType, `Expected an array of strings, got ${jsonKind(valueTypes)}.`));
            }
        }
        const declaresNeither = !valueTypeDeclared && !valueTypesDeclared;
        const declaresBoth = valueTypeDeclared && valueTypesDeclared;
        if (declaresNeither) {
            diagnostics.push(errorAt(itemPath, DiagnosticCode.MissingRequiredField, `A parameter class declares neither "valueType" nor "valueTypes"; exactly one is required.`));
        }
        if (declaresBoth) {
            diagnostics.push(errorAt(`${itemPath}.valueTypes`, DiagnosticCode.UnexpectedField, `A parameter class declares both "valueType" and "valueTypes"; exactly one is allowed.`));
        }
        rejectUnknownFields(item, ["class", "valueType", "valueTypes"], itemPath, diagnostics);
        if (cls === undefined || declaresNeither || declaresBoth || !valueTypeValid || !valueTypesValid) {
            failed = true;
            return;
        }
        result.push({
            class: cls,
            ...(valueTypeValid ? { valueType: valueType as string } : {}),
            ...(valueTypesValid ? { valueTypes: valueTypes as readonly string[] } : {}),
        });
    });
    return failed ? undefined : result;
}

function parseResourceClasses(raw: readonly JsonValue[] | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): readonly ProfileResourceClass[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const result: ProfileResourceClass[] = [];
    let failed = false;
    raw.forEach((item, index) => {
        const itemPath = `${path}[${index}]`;
        if (!isJsonRecord(item)) {
            diagnostics.push(errorAt(itemPath, DiagnosticCode.UnexpectedType, `Expected a JSON object, got ${jsonKind(item)}.`));
            failed = true;
            return;
        }
        const cls = requireString(item, "class", itemPath, diagnostics);
        const sampledType = requireString(item, "sampledType", itemPath, diagnostics);
        rejectUnknownFields(item, ["class", "sampledType"], itemPath, diagnostics);
        if (cls === undefined || sampledType === undefined) {
            failed = true;
            return;
        }
        result.push({ class: cls, sampledType });
    });
    return failed ? undefined : result;
}

function parseSamplingContract(raw: JsonRecord | undefined, path: string, diagnostics: ShaderGraphDiagnostic[], descriptorVersion: number): SamplingContract | SamplingContractTexture | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const baseFields = ["policy", "appliesToResourceClass", "samplerAuthoring", "samplerResolution", "authorableFilterModes", "authorableAddressModes", "comparisonSamplerAuthoring"];
    const isTextureVersion = descriptorVersion === 2;

    const policy = requireLiteral(raw, "policy", path, "reuseRuntimeTextureSamplerBinding", diagnostics);
    const appliesToResourceClass = requireString(raw, "appliesToResourceClass", path, diagnostics);
    const samplerAuthoring = requireLiteral(raw, "samplerAuthoring", path, "deferred", diagnostics);

    const samplerResolutionRaw = takeObject(raw, "samplerResolution", path, diagnostics);
    const resolutionPath = `${path}.samplerResolution`;
    const owner = samplerResolutionRaw === undefined ? undefined : requireLiteral(samplerResolutionRaw, "owner", resolutionPath, "materialBindingLayer", diagnostics);
    const cardinality = samplerResolutionRaw === undefined ? undefined : requireLiteral(samplerResolutionRaw, "cardinality", resolutionPath, "oneSamplerPerTexture2DBinding", diagnostics);
    if (samplerResolutionRaw !== undefined) {
        rejectUnknownFields(samplerResolutionRaw, ["owner", "cardinality"], resolutionPath, diagnostics);
    }

    const authorableFilterModes = requireStringArray(raw, "authorableFilterModes", path, diagnostics);
    const authorableAddressModes = requireStringArray(raw, "authorableAddressModes", path, diagnostics);
    const comparisonSamplerAuthoring = requireLiteral(raw, "comparisonSamplerAuthoring", path, "deferred", diagnostics);

    // descriptorVersion 2 adds the generated texture signature. The two
    // fields are REQUIRED at that serialization (a texture-signature contract
    // without its signature is a broken contract), and they do not exist on
    // descriptorVersion 1 files at all — a v1 file that carries them is an
    // unknown field, not a half-upgrade.
    let generatedTextureSignature: GeneratedTextureSignature | undefined;
    let generatedSampleForm: GeneratedSampleForm | undefined;
    if (isTextureVersion) {
        generatedTextureSignature = parseGeneratedTextureSignature(takeObject(raw, "generatedTextureSignature", path, diagnostics), `${path}.generatedTextureSignature`, diagnostics);
        generatedSampleForm = parseGeneratedSampleForm(takeObject(raw, "generatedSampleForm", path, diagnostics), `${path}.generatedSampleForm`, diagnostics);
    }
    rejectUnknownFields(raw, isTextureVersion ? [...baseFields, "generatedTextureSignature", "generatedSampleForm"] : baseFields, path, diagnostics);

    if (policy === undefined || appliesToResourceClass === undefined || samplerAuthoring === undefined || owner === undefined || cardinality === undefined || authorableFilterModes === undefined || authorableAddressModes === undefined || comparisonSamplerAuthoring === undefined) {
        return undefined;
    }
    const sampling: SamplingContract = {
        policy,
        appliesToResourceClass,
        samplerAuthoring,
        samplerResolution: { owner, cardinality },
        authorableFilterModes,
        authorableAddressModes,
        comparisonSamplerAuthoring,
    };
    if (!isTextureVersion) {
        return sampling;
    }
    if (generatedTextureSignature === undefined || generatedSampleForm === undefined) {
        return undefined;
    }
    return { ...sampling, generatedTextureSignature, generatedSampleForm };
}

function parseGeneratedTextureSignature(raw: JsonRecord | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): GeneratedTextureSignature | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const cardinality = requireLiteral(raw, "cardinality", path, "oneParameterPerTexture2DParameter", diagnostics);
    const parameterType = requireLiteral(raw, "parameterType", path, "uint2", diagnostics);
    const componentOrderRaw = takeArray(raw, "componentOrder", path, diagnostics);
    if (componentOrderRaw !== undefined && componentOrderRaw.length !== 2) {
        diagnostics.push(errorAt(`${path}.componentOrder`, DiagnosticCode.UnexpectedType, `Expected exactly 2 pair components, got ${componentOrderRaw.length}.`));
    }
    let componentOrder: readonly TextureSignatureComponent[] | undefined;
    if (componentOrderRaw !== undefined && componentOrderRaw.length === 2) {
        const first = parseTextureSignatureComponent(componentOrderRaw[0], `${path}.componentOrder[0]`, 0, diagnostics);
        const second = parseTextureSignatureComponent(componentOrderRaw[1], `${path}.componentOrder[1]`, 1, diagnostics);
        if (first !== undefined && second !== undefined) {
            componentOrder = [first, second];
        }
    }
    rejectUnknownFields(raw, ["cardinality", "parameterType", "componentOrder"], path, diagnostics);
    if (cardinality === undefined || parameterType === undefined || componentOrder === undefined) {
        return undefined;
    }
    return { cardinality, parameterType, componentOrder };
}

function parseTextureSignatureComponent(value: JsonValue | undefined, path: string, expectedPosition: 0 | 1, diagnostics: ShaderGraphDiagnostic[]): TextureSignatureComponent | undefined {
    if (!isJsonRecord(value)) {
        diagnostics.push(errorAt(path, DiagnosticCode.UnexpectedType, `Expected a component object, got ${jsonKind(value)}.`));
        return undefined;
    }
    const position = requireInteger(value, "position", path, diagnostics);
    const meaning = requireString(value, "meaning", path, diagnostics);
    if (position !== undefined && position !== expectedPosition) {
        diagnostics.push(errorAt(`${path}.position`, DiagnosticCode.UnexpectedType, `Expected component position ${expectedPosition}, got ${position}.`));
        return undefined;
    }
    rejectUnknownFields(value, ["position", "meaning"], path, diagnostics);
    if (position === undefined || meaning === undefined) {
        return undefined;
    }
    return { position: expectedPosition, meaning };
}

function parseGeneratedSampleForm(raw: JsonRecord | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): GeneratedSampleForm | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const resourceHeapBuiltin = requireLiteral(raw, "resourceHeapBuiltin", path, "ResourceDescriptorHeap", diagnostics);
    const resourceElementType = requireLiteral(raw, "resourceElementType", path, "Texture2D<float4>", diagnostics);
    const samplerHeapBuiltin = requireLiteral(raw, "samplerHeapBuiltin", path, "SamplerDescriptorHeap", diagnostics);
    const indexScope = requireLiteral(raw, "indexScope", path, "NonUniformResourceIndex", diagnostics);
    const operation = requireLiteral(raw, "operation", path, "Sample", diagnostics);
    const coordinateType = requireLiteral(raw, "coordinateType", path, "float2", diagnostics);
    const resultType = requireLiteral(raw, "resultType", path, "float4", diagnostics);
    rejectUnknownFields(
        raw,
        ["resourceHeapBuiltin", "resourceElementType", "samplerHeapBuiltin", "indexScope", "operation", "coordinateType", "resultType"],
        path,
        diagnostics,
    );
    if (resourceHeapBuiltin === undefined || resourceElementType === undefined || samplerHeapBuiltin === undefined || indexScope === undefined || operation === undefined || coordinateType === undefined || resultType === undefined) {
        return undefined;
    }
    return { resourceHeapBuiltin, resourceElementType, samplerHeapBuiltin, indexScope, operation, coordinateType, resultType };
}

function parseProcessContract(raw: JsonRecord | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): ProcessContract | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const toolRaw = takeObject(raw, "tool", path, diagnostics);
    const toolPath = `${path}.tool`;
    const identity = toolRaw === undefined ? undefined : requireString(toolRaw, "identity", toolPath, diagnostics);
    const minimumVersion = toolRaw === undefined ? undefined : requireString(toolRaw, "minimumVersion", toolPath, diagnostics);
    const versionComparison = toolRaw === undefined ? undefined : requireLiteral(toolRaw, "versionComparison", toolPath, "semver", diagnostics);
    if (toolRaw !== undefined) {
        rejectUnknownFields(toolRaw, ["identity", "minimumVersion", "versionComparison"], toolPath, diagnostics);
    }
    rejectUnknownFields(raw, ["tool"], path, diagnostics);
    if (identity === undefined || minimumVersion === undefined || versionComparison === undefined) {
        return undefined;
    }
    return { tool: { identity, minimumVersion, versionComparison } };
}

function parseDeferred(raw: JsonRecord | undefined, path: string, diagnostics: ShaderGraphDiagnostic[]): DeferredFeatures | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const parameterClasses = requireStringArray(raw, "parameterClasses", path, diagnostics);
    const surfaceOutputs = requireStringArray(raw, "surfaceOutputs", path, diagnostics);
    rejectUnknownFields(raw, ["parameterClasses", "surfaceOutputs"], path, diagnostics);
    if (parameterClasses === undefined || surfaceOutputs === undefined) {
        return undefined;
    }
    return { parameterClasses, surfaceOutputs };
}
