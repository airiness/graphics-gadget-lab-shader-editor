import type { PreviewBuildExecutionFailureStatus } from "../../src/preview-result-envelope.js";

export const PREVIEW_DESCRIPTOR_IDENTITY = "a7".repeat(32);
export const PREVIEW_PUBLICATION_ID = "b1".repeat(32);
export const PREVIEW_SHADER_ARTIFACT_ID = "c2".repeat(32);
export const PREVIEW_BASE_REGISTRY_ID = "d3".repeat(32);
export const PREVIEW_REGISTRY_ID = "e4".repeat(32);

export const DESCRIBE_PREVIEW_SUCCESS = JSON.stringify({
    command: "describe-preview",
    success: true,
    status: "ok",
    exitCode: 0,
    processContractVersion: 2,
    previewBuildContractVersion: 1,
    compilePolicyRevision: 1,
    toolIdentity: "gglab-shaderc",
    toolVersion: "1.3.0",
    producerKind: "dxc",
    producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
    supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
    previewProgramDescriptorVersion: 1,
    previewProgramDescriptorIdentity: PREVIEW_DESCRIPTOR_IDENTITY,
    supportedPreviewInputContracts: [
        {
            id: "gglab.preview-input.surface.numeric",
            profileId: "gglab.surface",
            profileVersion: 1,
        },
        {
            id: "gglab.preview-input.surface.texture2d",
            profileId: "gglab.surface",
            profileVersion: 2,
        },
    ],
    previewPublicationSchemaVersion: 1,
    previewActivePublicationSchemaVersion: 1,
    previewObservationSchemaVersion: 1,
    diagnostics: [],
});

export const DESCRIBE_PREVIEW_USAGE_ERROR = JSON.stringify({
    command: "describe-preview",
    success: false,
    status: "usage-error",
    exitCode: 2,
    processContractVersion: 2,
    previewBuildContractVersion: 1,
    diagnostics: [{ message: "describe-preview accepts no arguments" }],
});

export const BUILD_PREVIEW_SUCCESS = JSON.stringify({
    command: "build-preview",
    success: true,
    status: "ok",
    exitCode: 0,
    attemptSequence: 7,
    diagnostics: [],
    publicationId: PREVIEW_PUBLICATION_ID,
    shaderArtifactId: PREVIEW_SHADER_ARTIFACT_ID,
    baseRegistryId: PREVIEW_BASE_REGISTRY_ID,
    previewRegistryId: PREVIEW_REGISTRY_ID,
});

export const BUILD_PREVIEW_USAGE_ERROR = JSON.stringify({
    command: "build-preview",
    success: false,
    status: "usage-error",
    exitCode: 2,
    diagnostics: [{ message: "build-preview requires an option" }],
});

export const PREVIEW_BUILD_FAILURE_VOCABULARY: ReadonlyArray<{
    readonly status: PreviewBuildExecutionFailureStatus;
    readonly exitCode: number;
}> = [
    { status: "invalid-request", exitCode: 3 },
    { status: "source-unavailable", exitCode: 3 },
    { status: "source-identity-mismatch", exitCode: 3 },
    { status: "writer-unavailable", exitCode: 5 },
    { status: "base-registry-unavailable", exitCode: 5 },
    { status: "compiler-unavailable", exitCode: 4 },
    { status: "compile-failed", exitCode: 4 },
    { status: "artifact-publication-failed", exitCode: 5 },
    { status: "registry-build-failed", exitCode: 5 },
    { status: "registry-publication-failed", exitCode: 5 },
    { status: "preview-publication-build-failed", exitCode: 5 },
    { status: "preview-publication-invalid", exitCode: 5 },
    { status: "preview-publication-io-failed", exitCode: 5 },
    { status: "stale-attempt", exitCode: 3 },
    { status: "active-publication-failed", exitCode: 5 },
    { status: "internal-error", exitCode: 5 },
];

export function previewBuildFailureDocument(
    status: string,
    exitCode: number,
    attemptSequence: number = 7,
): string {
    return JSON.stringify({
        command: "build-preview",
        success: false,
        status,
        exitCode,
        attemptSequence,
        diagnostics: [{ message: `${status} diagnostic` }],
    });
}
