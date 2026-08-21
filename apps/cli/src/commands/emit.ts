/**
 * `emit <document> (--descriptor file | --descriptors-dir dir)`
 *
 * The core's deterministic emission service, serialized end to end: the
 * document is parsed, a descriptor instance is resolved (explicit file or
 * discovery over the main-repository layout — highest supported
 * descriptorVersion within the document's requested profile line, never
 * across lines), the shared compatibility verdict is applied, and
 * `emitHlsl` produces the generated HLSL bytes, source map, and SHA-256
 * identity. The command owns nothing semantic: the payload is the core's
 * result and the bytes are exactly the core's bytes ("the generated HLSL
 * bytes" — identity rule, AGENTS.md).
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { emitHlsl } from "@gglab/shader-graph-core";
import type { ParsedArgs } from "../args.js";
import { CliCode, buildEnvelope, cliDiagnosticAt } from "../envelope.js";
import { checkDescriptorPairing, loadDocument, resolveDescriptorInput, type DescriptorInput } from "../shared.js";

export function runEmit(args: ParsedArgs) {
    const diagnostics: ShaderGraphDiagnostic[] = [...args.diagnostics];
    const documentPath = args.positionals[0];
    if (documentPath === undefined) {
        diagnostics.push(cliDiagnosticAt("$.document", CliCode.MissingArgument, `A document file path is required; use "--help" for usage.`));
        return buildEnvelope("emit", diagnostics, null);
    }
    if (diagnostics.length > 0) {
        return buildEnvelope("emit", diagnostics, null);
    }

    const loaded = loadDocument(documentPath);
    if (loaded.loaded === undefined) {
        diagnostics.push(...loaded.diagnostics);
        return buildEnvelope("emit", diagnostics, null);
    }
    const { document } = loaded.loaded;

    const descriptorInput = resolveDescriptorInput(args, document, true);
    if (descriptorInput.resolved === undefined) {
        diagnostics.push(...descriptorInput.diagnostics);
        return buildEnvelope("emit", diagnostics, null);
    }
    const input: DescriptorInput = descriptorInput.resolved;

    const pairingDiagnostics: ShaderGraphDiagnostic[] = [];
    const compatible = checkDescriptorPairing(document, input.descriptor, pairingDiagnostics);
    diagnostics.push(...pairingDiagnostics);
    if (!compatible) {
        return buildEnvelope("emit", diagnostics, null);
    }

    const emission = emitHlsl(document, input.descriptor);
    if (!emission.ok) {
        diagnostics.push(...emission.diagnostics);
        return buildEnvelope("emit", diagnostics, null);
    }
    if (emission.source === "" || emission.sourceMap === null) {
        return buildEnvelope("emit", diagnostics, null);
    }
    const sourceMap = emission.sourceMap;
    const payload = {
        document: documentPath,
        descriptor: input.instancePath,
        descriptorVersion: input.descriptor.descriptorVersion,
        profile: document.profile,
        profileVersion: document.profileVersion,
        nodes: document.nodes.length,
        parameters: document.parameters.length,
        connections: document.connections.length,
        source: emission.source,
        generatedSourceIdentity: sourceMap.generatedSourceIdentity,
        sourceMap: sourceMap.ranges,
    };
    return buildEnvelope("emit", [...diagnostics, ...emission.diagnostics], payload);
}
