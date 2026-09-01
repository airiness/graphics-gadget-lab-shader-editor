/**
 * The two frozen Preview input contracts approved for the first GGLab
 * Preview Program. This is editor composition logic over core-owned graph and
 * descriptor facts: it selects a named Preview contract only after exact
 * stable-id/class/value-type/order and graph-visible-input matching.
 */
import type {
    GraphParameter,
    ShaderGraphDocument,
    SurfaceProfileDescriptor,
} from "@gglab/shader-graph-core";

interface FrozenGraphParameter {
    readonly id: string;
    readonly class: string;
    readonly valueType: string;
}

interface FrozenPreviewInputContract {
    readonly id: string;
    readonly profileId: "gglab.surface";
    readonly profileVersion: 1 | 2;
    readonly parameters: readonly FrozenGraphParameter[];
    readonly textureBindingPairRequired: boolean;
}

const FROZEN_PREVIEW_INPUT_CONTRACTS: readonly FrozenPreviewInputContract[] = [
    {
        id: "gglab.preview-input.surface.numeric",
        profileId: "gglab.surface",
        profileVersion: 1,
        parameters: [
            { id: "p.metal", class: "ScalarParameter", valueType: "float" },
            { id: "p.tint", class: "VectorParameter", valueType: "float3" },
        ],
        textureBindingPairRequired: false,
    },
    {
        id: "gglab.preview-input.surface.texture2d",
        profileId: "gglab.surface",
        profileVersion: 2,
        parameters: [
            { id: "p.rough", class: "ScalarParameter", valueType: "float" },
            { id: "p.tex", class: "Texture2DParameter", valueType: "Texture2D" },
        ],
        textureBindingPairRequired: true,
    },
];

export interface PreviewInputContractSelection {
    readonly id: string;
    readonly profileId: string;
    readonly profileVersion: number;
}

export type PreviewInputContractMismatch =
    | { readonly reason: "unsupported-profile-line"; readonly profileId: string; readonly profileVersion: number }
    | { readonly reason: "descriptor-profile-mismatch" }
    | {
          readonly reason: "generated-function-mismatch";
          readonly field: "name" | "stage" | "returnValue.objectName";
          readonly expected: string;
          readonly observed: string;
      }
    | { readonly reason: "graph-parameter-count-mismatch"; readonly expected: number; readonly observed: number }
    | {
          readonly reason: "graph-parameter-mismatch";
          readonly index: number;
          readonly expected: FrozenGraphParameter;
          readonly observed: FrozenGraphParameter;
      }
    | { readonly reason: "graph-visible-input-mismatch" }
    | { readonly reason: "texture-binding-pair-mismatch" };

export type PreviewInputContractMatch =
    | { readonly matched: true; readonly contract: PreviewInputContractSelection }
    | { readonly matched: false; readonly mismatch: PreviewInputContractMismatch };

function parameterFact(parameter: GraphParameter): FrozenGraphParameter {
    return { id: parameter.id, class: parameter.class, valueType: parameter.valueType };
}

function parametersEqual(left: FrozenGraphParameter, right: FrozenGraphParameter): boolean {
    return left.id === right.id && left.class === right.class && left.valueType === right.valueType;
}

function graphVisibleInputMatches(descriptor: SurfaceProfileDescriptor): boolean {
    return (
        descriptor.graphVisibleInputs.length === 1 &&
        descriptor.graphVisibleInputs[0]?.id === "uv0" &&
        descriptor.graphVisibleInputs[0].type === "float2"
    );
}

function generatedFunctionMismatch(
    descriptor: SurfaceProfileDescriptor,
): Extract<PreviewInputContractMismatch, { readonly reason: "generated-function-mismatch" }> | null {
    if (descriptor.generatedFunction.name !== "EvaluateSurface") {
        return {
            reason: "generated-function-mismatch",
            field: "name",
            expected: "EvaluateSurface",
            observed: descriptor.generatedFunction.name,
        };
    }
    if (descriptor.generatedFunction.stage !== "pixel") {
        return {
            reason: "generated-function-mismatch",
            field: "stage",
            expected: "pixel",
            observed: descriptor.generatedFunction.stage,
        };
    }
    if (descriptor.generatedFunction.returnValue.objectName !== "SurfaceData") {
        return {
            reason: "generated-function-mismatch",
            field: "returnValue.objectName",
            expected: "SurfaceData",
            observed: descriptor.generatedFunction.returnValue.objectName,
        };
    }
    return null;
}

function textureBindingPairMatches(descriptor: SurfaceProfileDescriptor): boolean {
    if (!("generatedTextureSignature" in descriptor.samplingContract)) {
        return false;
    }
    const signature = descriptor.samplingContract.generatedTextureSignature;
    return (
        signature.cardinality === "oneParameterPerTexture2DParameter" &&
        signature.parameterType === "uint2" &&
        signature.componentOrder.length === 2 &&
        signature.componentOrder[0]?.position === 0 &&
        signature.componentOrder[0].role === "textureBindingIndex" &&
        signature.componentOrder[1]?.position === 1 &&
        signature.componentOrder[1].role === "samplerBindingIndex"
    );
}

/** Selects one fixed contract. Persisted parameter array order is not an
 *  authority: the profile's deterministic order is stable-id order, so both
 *  sides are compared in that canonical order. */
export function selectPreviewInputContract(
    document: ShaderGraphDocument,
    descriptor: SurfaceProfileDescriptor,
): PreviewInputContractMatch {
    const contract = FROZEN_PREVIEW_INPUT_CONTRACTS.find(
        (candidate) =>
            candidate.profileId === document.profile &&
            candidate.profileVersion === document.profileVersion,
    );
    if (contract === undefined) {
        return {
            matched: false,
            mismatch: {
                reason: "unsupported-profile-line",
                profileId: document.profile,
                profileVersion: document.profileVersion,
            },
        };
    }
    if (
        descriptor.profileId !== document.profile ||
        descriptor.profileVersion !== document.profileVersion
    ) {
        return { matched: false, mismatch: { reason: "descriptor-profile-mismatch" } };
    }
    const generatedFunction = generatedFunctionMismatch(descriptor);
    if (generatedFunction !== null) {
        return { matched: false, mismatch: generatedFunction };
    }

    const observed = document.parameters.map(parameterFact).sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    if (observed.length !== contract.parameters.length) {
        return {
            matched: false,
            mismatch: {
                reason: "graph-parameter-count-mismatch",
                expected: contract.parameters.length,
                observed: observed.length,
            },
        };
    }
    for (let index = 0; index < contract.parameters.length; index += 1) {
        const expected = contract.parameters[index];
        const actual = observed[index];
        if (expected !== undefined && actual !== undefined && !parametersEqual(expected, actual)) {
            return {
                matched: false,
                mismatch: { reason: "graph-parameter-mismatch", index, expected, observed: actual },
            };
        }
    }
    if (!graphVisibleInputMatches(descriptor)) {
        return { matched: false, mismatch: { reason: "graph-visible-input-mismatch" } };
    }
    if (contract.textureBindingPairRequired && !textureBindingPairMatches(descriptor)) {
        return { matched: false, mismatch: { reason: "texture-binding-pair-mismatch" } };
    }
    if (!contract.textureBindingPairRequired && "generatedTextureSignature" in descriptor.samplingContract) {
        return { matched: false, mismatch: { reason: "texture-binding-pair-mismatch" } };
    }
    return {
        matched: true,
        contract: {
            id: contract.id,
            profileId: contract.profileId,
            profileVersion: contract.profileVersion,
        },
    };
}
