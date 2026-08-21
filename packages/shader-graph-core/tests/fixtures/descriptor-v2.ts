/**
 * Synthetic v2 descriptor fixture mirroring the canonical main-repo
 * instance field for field (`Shaders/Profiles/GGLab.Surface/2/descriptor.json`
 * of the main repository — same vocabulary, same values). It is the v1
 * vocabulary plus the profileVersion 2 texture-signature additions
 * (`generatedTextureSignature` and `generatedSampleForm` on the sampling
 * contract). Embedded in this repository rather than mirrored from the
 * main repository so the fixture stays deterministic and self-contained.
 */
export const canonicalV2Fixture: Record<string, unknown> = {
    descriptorVersion: 2,
    profileId: "gglab.surface",
    profileVersion: 2,
    language: "hlsl",
    generatedFunction: {
        name: "EvaluateSurface",
        stage: "pixel",
        returnValue: {
            objectName: "SurfaceData",
            fieldsSource: "requiredOutputs",
        },
        parameterContract: {
            ordering: "graphParametersThenGraphVisibleInputs",
            graphParameters: {
                source: "graphDocument",
                classConstraint: "parameterClasses",
            },
            graphVisibleInputs: {
                source: "graphVisibleInputs",
            },
        },
    },
    graphVisibleInputs: [
        {
            id: "uv0",
            type: "float2",
            semantic: "primary texture coordinate supplied by the rendering pass",
        },
    ],
    requiredOutputs: [
        { name: "BaseColor", type: "float3", required: true, semantic: "linear-RGB albedo contribution (pre-lighting)" },
        { name: "Emissive", type: "float3", required: true, semantic: "linear-RGB emissive contribution (pre-lighting)" },
        { name: "Metallic", type: "float", required: true, semantic: "metallic factor; BRDF interpretation is pass-owned" },
        { name: "Roughness", type: "float", required: true, semantic: "perceived roughness factor; BRDF clamping is pass-owned" },
        { name: "Opacity", type: "float", required: true, semantic: "raw surface alpha before alpha-mode resolution; alpha mode, cutoff, and discard are pass-owned" },
    ],
    outputFieldOrdering: "descriptorListOrder",
    parameterClasses: [
        { class: "ScalarParameter", valueTypes: ["float"] },
        { class: "VectorParameter", valueTypes: ["float2", "float3", "float4"] },
        { class: "Texture2DParameter", valueType: "Texture2D" },
    ],
    resourceClasses: [{ class: "Texture2D", sampledType: "float4" }],
    samplingContract: {
        policy: "reuseRuntimeTextureSamplerBinding",
        appliesToResourceClass: "Texture2D",
        samplerAuthoring: "deferred",
        samplerResolution: {
            owner: "materialBindingLayer",
            cardinality: "oneSamplerPerTexture2DBinding",
        },
        authorableFilterModes: [],
        authorableAddressModes: [],
        comparisonSamplerAuthoring: "deferred",
        generatedTextureSignature: {
            cardinality: "oneParameterPerTexture2DParameter",
            parameterType: "uint2",
            componentOrder: [
                { position: 0, meaning: "texture binding index into the shared texture resource heap" },
                { position: 1, meaning: "sampler binding index into the shared sampler heap" },
            ],
        },
        generatedSampleForm: {
            resourceHeapBuiltin: "ResourceDescriptorHeap",
            resourceElementType: "Texture2D<float4>",
            samplerHeapBuiltin: "SamplerDescriptorHeap",
            indexScope: "NonUniformResourceIndex",
            operation: "Sample",
            coordinateType: "float2",
            resultType: "float4",
        },
    },
    requiredIncludes: [],
    processContract: {
        tool: {
            identity: "gglab-shaderc",
            minimumVersion: "1.0.0",
            versionComparison: "semver",
        },
    },
    deferred: {
        parameterClasses: ["BoolParameter", "SamplerParameter"],
        surfaceOutputs: ["normalTangentSpaceAuthoring"],
    },
};
