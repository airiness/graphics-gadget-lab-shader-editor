import { EnvironmentContractError, environmentDiagnostic, projectEnvironmentRegistrySnapshot, ENVIRONMENT_IMPORT_AVAILABILITY } from "@gglab/shader-toolchain-client";
import { parseSurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { inspectEnvironmentProducer, readEnvironmentRoleText, verifyEnvironmentDirectory } from "../environment-host.js";
import { NodeEnvironmentRegistryStorage } from "../environment-registry-storage.js";
import type { ParsedArgs } from "../command-grammar.js";
import { buildEnvelope, type CliEnvelope } from "../envelope.js";

export function runEnvironment(command: "environment-verify" | "environment-discover" | "environment-registry", args: ParsedArgs): CliEnvelope {
    if (args.diagnostics.length) return buildEnvelope(command, args.diagnostics, null);
    try {
        const root = args.positionals[0]!;
        if (command === "environment-registry") {
            const snapshot = projectEnvironmentRegistrySnapshot(new NodeEnvironmentRegistryStorage(root).scanSync());
            return buildEnvelope(command, snapshot.diagnostics, { ...snapshot, importAvailability: ENVIRONMENT_IMPORT_AVAILABILITY });
        }
        if (command === "environment-discover") {
            // Undefined search roots are resolved from the producer bootstrap by the host.
            return buildEnvelope(command, [], discoverEnvironmentDeployments(root));
        }
        const closure = verifyEnvironmentDirectory(root);
        const profiles = [];
        if (args.flags.has("profiles")) {
            for (const [role, version] of [["surfaceProfile1", 1], ["surfaceProfile2", 2]] as const) {
                const parsed = parseSurfaceProfileDescriptor(readEnvironmentRoleText(closure, role));
                if (!parsed.ok || parsed.value === null) return buildEnvelope(command, parsed.diagnostics.map(d => ({ ...d, dataPath: `${closure.manifest.roles[role]}:${d.dataPath}` })), null);
                const descriptor = parsed.value;
                if (descriptor.profileId !== "gglab.surface" || descriptor.profileVersion !== version) throw new EnvironmentContractError("profile-mismatch", "Descriptor does not match its Environment role", closure.manifest.roles[role]);
                profiles.push({ role, profileId: descriptor.profileId, profileVersion: descriptor.profileVersion, descriptorVersion: descriptor.descriptorVersion });
            }
        }
        return buildEnvelope(command, [], { ...closure, profiles, nativeReadiness: "unproven", importAvailability: ENVIRONMENT_IMPORT_AVAILABILITY });
    } catch (error) { return buildEnvelope(command, [environmentDiagnostic(error)], null); }
}
function discoverEnvironmentDeployments(repositoryRoot: string) {
    const result = inspectEnvironmentProducer(repositoryRoot);
    if (!result.response.success) throw new EnvironmentContractError(result.response.error.code, result.response.error.message);
    return { publisherSha256: result.publisherSha256, ...result.response.result, nativeReadiness: "unproven", importAvailability: ENVIRONMENT_IMPORT_AVAILABILITY };
}
