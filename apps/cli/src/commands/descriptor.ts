/**
 * `descriptor <descriptor-json>`
 *
 * Inspects one Surface Profile Descriptor instance: parses it with the
 * core's strict reader and reports the machine values that matter to an
 * agent or CI caller — the version axes (independent), the profile line,
 * whether the generated texture-signature contract is serialized, the
 * sampling contract posture, the deferred sets, and the tool identity the
 * instance requires. No graph document is involved: this is contract
 * discovery, not compatibility — compatibility is always judged for a
 * document (see `validate` / `emit` via the shared verdict).
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { parseSurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import type { ParsedArgs } from "../args.js";
import { CliCode, buildEnvelope, cliDiagnosticAt } from "../envelope.js";
import { readTextFile } from "../io.js";

export function runDescriptor(args: ParsedArgs) {
    const diagnostics: ShaderGraphDiagnostic[] = [...args.diagnostics];
    const instancePath = args.positionals[0];
    if (instancePath === undefined) {
        diagnostics.push(cliDiagnosticAt("$.descriptor", CliCode.MissingArgument, `A descriptor instance file path is required; use "--help" for usage.`));
        return buildEnvelope("descriptor", diagnostics, null);
    }
    if (diagnostics.length > 0) {
        return buildEnvelope("descriptor", diagnostics, null);
    }

    const read = readTextFile(instancePath, "$.descriptor");
    if (read.text === undefined || read.diagnostic !== undefined) {
        diagnostics.push(read.diagnostic as ShaderGraphDiagnostic);
        return buildEnvelope("descriptor", diagnostics, null);
    }
    const parsed = parseSurfaceProfileDescriptor(read.text);
    if (!parsed.ok || parsed.value === null) {
        diagnostics.push(...parsed.diagnostics);
        return buildEnvelope("descriptor", diagnostics, null);
    }
    const instance = parsed.value;
    const payload = {
        descriptor: instancePath,
        descriptorVersion: instance.descriptorVersion,
        profileId: instance.profileId,
        profileVersion: instance.profileVersion,
        language: instance.language,
        textureSignatureSerialized:
            "generatedTextureSignature" in instance.samplingContract && "generatedSampleForm" in instance.samplingContract,
        sampling: {
            policy: instance.samplingContract.policy,
            appliesToResourceClass: instance.samplingContract.appliesToResourceClass,
            samplerAuthoring: instance.samplingContract.samplerAuthoring,
            samplerResolution: {
                owner: instance.samplingContract.samplerResolution.owner,
                cardinality: instance.samplingContract.samplerResolution.cardinality,
            },
            authorableFilterModes: [...instance.samplingContract.authorableFilterModes],
            authorableAddressModes: [...instance.samplingContract.authorableAddressModes],
            comparisonSamplerAuthoring: instance.samplingContract.comparisonSamplerAuthoring,
        },
        deferred: {
            parameterClasses: [...instance.deferred.parameterClasses],
            surfaceOutputs: [...instance.deferred.surfaceOutputs],
        },
        tool: {
            identity: instance.processContract.tool.identity,
            minimumVersion: instance.processContract.tool.minimumVersion,
            versionComparison: instance.processContract.tool.versionComparison,
        },
    };
    return buildEnvelope("descriptor", diagnostics, payload);
}
