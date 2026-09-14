import { createHash } from "node:crypto";
import { ENVIRONMENT_ROLES, ENVIRONMENT_STATE_ROLES, environmentIdentity, readEnvironmentManifest, type EnvironmentManifest } from "../packages/shader-toolchain-client/src/index.js";

/** Local unit-test data only: never a producer conformance or native qualification vector. */
export const syntheticMemberText = "synthetic fixture; not executable\n";
export function syntheticEnvironmentManifest(): EnvironmentManifest {
    const directories = new Set(["shaderSources", "baseArtifacts", "assets", "vulkanLayers"]);
    const paths = Object.entries(ENVIRONMENT_ROLES).map(([role, path]) => directories.has(role) ? path + "/unit.txt" : path);
    paths.push("payload/dxcompiler.dll", "payload/dxil.dll", "payload/VulkanLayers/VkLayer_khronos_validation.dll", "payload/VulkanLayers/VkLayer_khronos_validation.json", ...["gglab-dx12", "gglab-vulkan13"].map(target => `payload/BaseArtifacts/active/${target}/program-registry.ggsh.active`));
    const hash = (value: string): string => createHash("sha256").update(value, "ascii").digest("hex");
    const manifest: EnvironmentManifest = {
        manifestVersion: 1, kind: "gglab.authoring-environment", environmentId: "",
        producer: { publisherVersion: "1.0.0", publisherSha256: "1".repeat(64), sourceRevision: "0".repeat(40), sourceDirty: true, deployment: "Build/Unit" },
        roles: ENVIRONMENT_ROLES, writableState: { root: "external", roles: ENVIRONMENT_STATE_ROLES },
        members: paths.sort().map(path => ({ path, size: Buffer.byteLength(syntheticMemberText), sha256: hash(syntheticMemberText) })),
    };
    const complete = { ...manifest, environmentId: environmentIdentity(manifest, hash) };
    return readEnvironmentManifest(JSON.stringify(complete), hash);
}
