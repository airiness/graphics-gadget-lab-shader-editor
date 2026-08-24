/**
 * Shared command plumbing: document loading, descriptor input options
 * (--descriptor file | --descriptors-dir discovery), and the
 * command-specific diagnostic assembly. Every failure stays a structured
 * diagnostic inside the envelope — a command never throws into the process
 * boundary.
 */
import type { ShaderGraphDiagnostic, SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import {
    checkProfileDescriptorCompatibility,
    checkProfileConformance,
    parseShaderGraphDocument,
    type ShaderGraphDocument,
} from "@gglab/shader-graph-core";
import type { ParsedArgs } from "./command-grammar.js";
import { CliCode, cliDiagnosticAt } from "./envelope.js";
import { resolveDescriptorFromDirectory, resolveDescriptorInstance, type DescriptorResolution } from "./resolve-descriptor.js";
import { readTextFile } from "./io.js";

/** A successfully loaded graph document. */
export interface LoadedDocument {
    readonly document: ShaderGraphDocument;
}

export function loadDocument(filePath: string): { loaded: LoadedDocument | undefined; diagnostics: readonly ShaderGraphDiagnostic[] } {
    const read = readTextFile(filePath, "$.document");
    if (read.text === undefined || read.diagnostic !== undefined) {
        return { loaded: undefined, diagnostics: [read.diagnostic as ShaderGraphDiagnostic] };
    }
    const parsed = parseShaderGraphDocument(read.text);
    if (!parsed.ok || parsed.value === null) {
        return { loaded: undefined, diagnostics: parsed.diagnostics };
    }
    return { loaded: { document: parsed.value }, diagnostics: [] };
}

export interface DescriptorInput {
    readonly descriptor: SurfaceProfileDescriptor;
    readonly instancePath: string;
    readonly considered: DescriptorResolution["considered"];
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
}

/**
 * The machine-readable view of how the descriptor was resolved: which
 * instance served the request, and every candidate that was considered —
 * including ones the reader did not support (e.g. a newer
 * descriptorVersion), which stays explicit instead of silently ignored.
 */
export function descriptorResolutionView(input: DescriptorInput) {
    return {
        selected: input.instancePath,
        considered: input.considered.map((candidate) => ({
            instancePath: candidate.instancePath,
            supported: candidate.descriptor !== undefined,
            failure: candidate.diagnostics.length > 0 ? (candidate.diagnostics[0]?.code ?? undefined) : undefined,
        })),
    };
}

/**
 * Resolves the descriptor for a command from its options. Exactly one of
 * --descriptor / --descriptors-dir is valid; `required` controls whether
 * the absence is a failure (emit) or a documented no-descriptor mode
 * (validate).
 */
export function resolveDescriptorInput(
    args: ParsedArgs,
    document: ShaderGraphDocument,
    required: boolean,
): { resolved: DescriptorInput | undefined; diagnostics: readonly ShaderGraphDiagnostic[] } {
    const hasFile = args.options.has("descriptor");
    const hasDir = args.options.has("descriptors-dir");
    if (hasFile && hasDir) {
        return {
            resolved: undefined,
            diagnostics: [
                cliDiagnosticAt(
                    "$.descriptor",
                    CliCode.InvalidArgument,
                    `Use exactly one of "--descriptor <file>" or "--descriptors-dir <dir>"; both were supplied.`,
                ),
            ],
        };
    }
    if (hasFile) {
        const file = resolveDescriptorInstance(args.options.get("descriptor") as string);
        return { resolved: file.descriptor === undefined ? undefined : asDescriptorInput(file), diagnostics: file.diagnostics };
    }
    if (hasDir) {
        const value = args.options.get("descriptors-dir");
        const resolution = resolveDescriptorFromDirectory(value as string, document.profile, document.profileVersion);
        return {
            resolved: resolution.descriptor === undefined ? undefined : asDescriptorInput(resolution),
            diagnostics: resolution.diagnostics,
        };
    }
    if (required) {
        return {
            resolved: undefined,
            diagnostics: [
                cliDiagnosticAt(
                    "$.descriptor",
                    CliCode.MissingOption,
                    `Emission requires a descriptor instance; supply exactly one of "--descriptor <file>" or "--descriptors-dir <dir>".`,
                ),
            ],
        };
    }
    return { resolved: undefined, diagnostics: [] };
}

function asDescriptorInput(resolution: DescriptorResolution): DescriptorInput {
    return {
        descriptor: resolution.descriptor as SurfaceProfileDescriptor,
        instancePath: resolution.instancePath as string,
        considered: resolution.considered,
        diagnostics: [],
    };
}

/**
 * Runs the shared descriptor pairing checks (compatibility verdict, then
 * class/type conformance) and appends their structured diagnostics.
 * Returns false as soon as either verdict fails, so neither authority is
 * consumed twice (for example by the emitter re-running its own conformance
 * check on an already-failed pairing).
 */
export function checkDescriptorPairing(
    document: ShaderGraphDocument,
    descriptor: SurfaceProfileDescriptor,
    diagnostics: ShaderGraphDiagnostic[],
): boolean {
    const compatibility = checkProfileDescriptorCompatibility(document, descriptor);
    diagnostics.push(...compatibility.diagnostics);
    if (!compatibility.ok) {
        return false;
    }
    const conformance = checkProfileConformance(document, descriptor);
    diagnostics.push(...conformance.diagnostics);
    return conformance.ok;
}
