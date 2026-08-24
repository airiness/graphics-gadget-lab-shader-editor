/**
 * `validate <document> [--descriptor file | --descriptors-dir dir]`
 *
 * Runs the document through the core's authoring-domain checks in the
 * fixed order the core defines: structural validation, whole-document
 * port-level type resolution (the core's authoring rule — type errors are
 * graph-level), then — when a descriptor instance is supplied — the shared
 * profile × descriptor compatibility verdict and the (type, class)
 * conformance rules. Diagnostics keep their stable codes; `ok` is present
 * in the core's shape (warnings never fail the document). No graph
 * semantics are defined here: this command is the serialization of those
 * core services.
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { resolveGraphTypes, validateShaderGraph } from "@gglab/shader-graph-core";
import type { ParsedArgs } from "../command-grammar.js";
import { CliCode, buildEnvelope, cliDiagnosticAt } from "../envelope.js";
import { checkDescriptorPairing, descriptorResolutionView, loadDocument, resolveDescriptorInput } from "../shared.js";

export function runValidate(args: ParsedArgs) {
    const diagnostics: ShaderGraphDiagnostic[] = [...args.diagnostics];
    const documentPath = args.positionals[0];
    if (documentPath === undefined) {
        diagnostics.push(cliDiagnosticAt("$.document", CliCode.MissingArgument, `A document file path is required; use "--help" for usage.`));
        return buildEnvelope("validate", diagnostics, null);
    }
    if (diagnostics.length > 0) {
        return buildEnvelope("validate", diagnostics, null);
    }

    const loaded = loadDocument(documentPath);
    if (loaded.loaded === undefined) {
        diagnostics.push(...loaded.diagnostics);
        return buildEnvelope("validate", diagnostics, null);
    }
    const { document } = loaded.loaded;

    diagnostics.push(...validateShaderGraph(document).diagnostics);
    const typeResult = resolveGraphTypes(document);
    diagnostics.push(...typeResult.diagnostics);

    // Descriptor pairing (compatibility verdict + conformance) — only when
    // a descriptor instance was supplied; validate without one is the
    // pure document-domain check the core provides.
    const descriptorInput = resolveDescriptorInput(args, document, false);
    diagnostics.push(...descriptorInput.diagnostics);
    if (descriptorInput.diagnostics.length > 0) {
        return buildEnvelope("validate", diagnostics, null);
    }
    if (descriptorInput.resolved !== undefined) {
        const compatible = checkDescriptorPairing(document, descriptorInput.resolved.descriptor, diagnostics);
        if (!compatible) {
            return buildEnvelope("validate", diagnostics, null);
        }
    }

    const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
    const payload = {
        document: documentPath,
        descriptor: descriptorInput.resolved?.instancePath ?? null,
        descriptorResolution: descriptorInput.resolved === undefined ? null : descriptorResolutionView(descriptorInput.resolved),
        profile: document.profile,
        profileVersion: document.profileVersion,
        nodes: document.nodes.length,
        parameters: document.parameters.length,
        connections: document.connections.length,
        diagnostics: { error: errorCount, warning: warningCount },
    };
    return buildEnvelope("validate", diagnostics, payload);
}
