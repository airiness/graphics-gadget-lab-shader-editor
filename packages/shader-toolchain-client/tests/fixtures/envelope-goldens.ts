/**
 * Golden wire documents for the two published machine contracts the
 * client reads: the handshake (describe) document and the compile result
 * envelope.
 *
 * These follow the toolchain's own machine-readable contract — the
 * single-line stdout documents the process contract defines and the
 * toolchain's self-test suite proves — and they are the only wire shapes
 * these reader tests assert against. The real tool is never a test
 * fixture and never a test dependency; no test here touches a
 * human-facing output surface.
 *
 * Where a field carries a concrete value (for example
 * `producerIdentity`), the golden holds a representative valid fixture:
 * that field is a runtime-observed identity, not a fixed constant of
 * the contract. A real-tool smoke against the actual `gglab-shaderc`
 * describe output still proves the real document reads.
 *
 * The supportedTargets wire name "gglab-vulkan13" is the single-table
 * authority from the toolchain repository; the shorter spelling seen in
 * some discussion threads was a typo and must not appear in a golden.
 */
import type { CompileFailureStatus } from "../../src/result-envelope.js";

export const DESCRIBE_SUCCESS =
    '{"command":"describe","success":true,"status":"ok","exitCode":0,"processContractVersion":1,"toolIdentity":"gglab-shaderc","toolVersion":"1.1.0","producerKind":"dxc","producerIdentity":"Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)","supportedTargets":["gglab-dx12","gglab-vulkan13"],"diagnostics":[]}';

export const DESCRIBE_USAGE_ERROR =
    '{"command":"describe","success":false,"status":"usage-error","exitCode":2,"processContractVersion":1,"diagnostics":[{"message":"describe accepts no arguments"}]}';

export const DESCRIBE_COMPILER_UNAVAILABLE =
    '{"command":"describe","success":false,"status":"compiler-unavailable","exitCode":4,"processContractVersion":1,"diagnostics":[{"message":"DXC producer runtime could not be resolved"}]}';

export const DESCRIBE_INTERNAL_ERROR =
    '{"command":"describe","success":false,"status":"internal-error","exitCode":7,"processContractVersion":1,"diagnostics":[{"message":"describe internal failure"}]}';

const RECIPE_ID = "3f".repeat(32);
const BUILD_KEY = "5e".repeat(32);
const BINARY_HASH = "9c".repeat(32);
const ARTIFACT_ID = "d1".repeat(32);

export const COMPILE_SUCCESS =
    `{"command":"compile","success":true,"status":"ok","exitCode":0,"recipeId":"${RECIPE_ID}","buildKey":"${BUILD_KEY}","binaryHash":"${BINARY_HASH}","binaryFormat":"dxil","target":"gglab-dx12","binaryPath":"C:/gglab/build/cache/${BINARY_HASH}.dxil","cacheRecordPath":"C:/gglab/build/cache/${BINARY_HASH}.dxil.json","fromCache":false,"diagnostics":[]}`;

export const COMPILE_SUCCESS_PUBLISHED =
    `{"command":"compile","success":true,"status":"ok","exitCode":0,"recipeId":"${RECIPE_ID}","buildKey":"${BUILD_KEY}","binaryHash":"${BINARY_HASH}","binaryFormat":"spirv","target":"gglab-vulkan13","binaryPath":"C:/gglab/build/cache/${BINARY_HASH}.spv","cacheRecordPath":"C:/gglab/build/cache/${BINARY_HASH}.spv.json","fromCache":true,"artifactId":"${ARTIFACT_ID}","runtimeArtifactBinaryPath":"C:/gglart/artifacts/${ARTIFACT_ID}.spv","runtimeArtifactManifestPath":"C:/gglart/artifacts/${ARTIFACT_ID}.json","diagnostics":[]}`;

export const COMPILE_FAILURE_EXAMPLE =
    '{"command":"compile","success":false,"status":"compile-failed","exitCode":4,"diagnostics":[{"message":"HLSL compilation failed","sourceIdentity":"Shaders/Surface/1/emitted/surface-pixel.hlsl"}]}';

/**
 * The full published failure status vocabulary with the contract's own
 * exit-code membership, as the toolchain contract allocates it. The
 * client consumes the document fields and does not re-derive this
 * mapping; the table exists so the suite exercises every status.
 */
export const COMPILE_FAILURE_VOCABULARY: ReadonlyArray<{
    readonly status: CompileFailureStatus;
    readonly exitCode: number;
}> = [
    { status: "invalid-request", exitCode: 3 },
    { status: "source-not-found", exitCode: 3 },
    { status: "compiler-unavailable", exitCode: 4 },
    { status: "compile-failed", exitCode: 4 },
    { status: "artifact-io-failure", exitCode: 5 },
    { status: "source-changed", exitCode: 6 },
];

/** Builds a well-formed failure envelope for any published failure
 *  status — used to walk the whole vocabulary, not to relax shape. */
export function compileFailureDocument(status: string, exitCode: number, message: string): string {
    return JSON.stringify({
        command: "compile",
        success: false,
        status,
        exitCode,
        diagnostics: [{ message }],
    });
}
