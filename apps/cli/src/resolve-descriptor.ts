/**
 * Descriptor instance resolution for the CLI — a thin, structured
 * serialization of two core/AGENTS rules:
 *
 * - descriptors are consumed as serialized data documents through the
 *   core's strict reader (parseSurfaceProfileDescriptor); an
 *   out-of-range or unknown descriptorVersion is an explicit
 *   UnsupportedDescriptorVersion, never a silent reinterpretation;
 * - profile/descriptor selection never crosses a profile line: within the
 *   graph's requested (profileId, profileVersion) line, the highest
 *   supported descriptorVersion wins.
 *
 * Discovery walks `<baseDir>/<profileIdDir>/<profileVersionDir>/descriptor.json`
 * — the main-repository layout — parses every candidate with the strict
 * reader, and keeps the candidates that declare the requested line. The
 * parsed (not the path-matched) line is what is compared, so a
 * mislabeled directory can never smuggle a foreign line in. An instance
 * whose descriptorVersion is outside the reader's supported range is
 * recorded, then reported in the resolution diagnostics (explicit
 * degradation) and never selected.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ShaderGraphDiagnostic, SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { parseSurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { CliCode, cliDiagnosticAt } from "./envelope.js";
import { readTextFile } from "./io.js";

/** One discovered candidate instance and what the reader said about it. */
export interface DescriptorCandidate {
    readonly instancePath: string;
    /** Present when the core reader understood the serialization. */
    readonly descriptor: SurfaceProfileDescriptor | undefined;
    /** Reader diagnostics (empty when the descriptor parsed). */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
}

export interface DescriptorResolution {
    readonly descriptor: SurfaceProfileDescriptor | undefined;
    readonly instancePath: string | undefined;
    /** Every candidate that was discovered and parsed, in stable path order. */
    readonly considered: readonly DescriptorCandidate[];
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
}

/** Resolves a single descriptor file and parses it with the core reader. */
export function resolveDescriptorInstance(filePath: string): DescriptorResolution {
    const read = readTextFile(filePath, "$.descriptor");
    if (read.text === undefined || read.diagnostic !== undefined) {
        return {
            descriptor: undefined,
            instancePath: undefined,
            considered: [],
            diagnostics: [read.diagnostic as ShaderGraphDiagnostic],
        };
    }
    const parsed = parseSurfaceProfileDescriptor(read.text);
    const descriptor = parsed.ok && parsed.value !== null ? parsed.value : undefined;
    const candidate: DescriptorCandidate = {
        instancePath: filePath,
        descriptor,
        diagnostics: parsed.diagnostics,
    };
    if (descriptor !== undefined) {
        return { descriptor, instancePath: filePath, considered: [candidate], diagnostics: [] };
    }
    return { descriptor: undefined, instancePath: undefined, considered: [candidate], diagnostics: [...parsed.diagnostics] };
}

/**
 * Discovers descriptor instances under a base directory and selects the
 * one that serves the requested profile line — the highest supported
 * descriptorVersion within (profileId, profileVersion) and only that line.
 */
export function resolveDescriptorFromDirectory(
    baseDirectory: string,
    profileId: string,
    profileVersion: number,
): DescriptorResolution {
    const isDirectory = (() => {
        try {
            return statSync(baseDirectory).isDirectory();
        } catch {
            return false;
        }
    })();
    if (!isDirectory) {
        return {
            descriptor: undefined,
            instancePath: undefined,
            considered: [],
            diagnostics: [
                cliDiagnosticAt("$.descriptorsDir", CliCode.FileNotFound, `"--descriptors-dir" must name an existing directory; found: "${baseDirectory}".`),
            ],
        };
    }

    const candidates: DescriptorCandidate[] = [];
    let profileDirectories: string[];
    try {
        profileDirectories = readdirSync(baseDirectory, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch {
        return {
            descriptor: undefined,
            instancePath: undefined,
            considered: [],
            diagnostics: [cliDiagnosticAt("$.descriptorsDir", CliCode.FileNotFound, `Directory not found: "${baseDirectory}".`)],
        };
    }
    for (const profileDirectory of profileDirectories) {
        const lineRoot = join(baseDirectory, profileDirectory);
        let lineDirectories: string[];
        try {
            lineDirectories = readdirSync(lineRoot, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
                .map((entry) => entry.name)
                .sort();
        } catch {
            continue; // not a profile line directory; skip
        }
        for (const lineDirectory of lineDirectories) {
            const instancePath = join(lineRoot, lineDirectory, "descriptor.json");
            const isFile = (() => {
                try {
                    return statSync(instancePath).isFile();
                } catch {
                    return false;
                }
            })();
            if (!isFile) {
                continue;
            }
            const file = resolveDescriptorInstance(instancePath);
            candidates.push({ instancePath, descriptor: file.descriptor, diagnostics: file.diagnostics });
        }
    }

    const matching = candidates.filter(
        (candidate) =>
            candidate.descriptor !== undefined &&
            candidate.descriptor.profileId === profileId &&
            candidate.descriptor.profileVersion === profileVersion,
    );
    if (matching.length === 0) {
        return {
            descriptor: undefined,
            instancePath: undefined,
            considered: candidates,
            diagnostics: [
                cliDiagnosticAt(
                    "$.descriptorsDir",
                    CliCode.DescriptorNotResolved,
                    `No supported descriptor instance for profile "${profileId}" version ${profileVersion} was found under "${baseDirectory}" (considered ${candidates.length} candidate file(s)).`,
                ),
            ],
        };
    }
    // Selection: the highest supported descriptorVersion within the requested
    // line (ties cannot occur for one instance per layout path; the sort is
    // stable either way).
    matching.sort((a, b) => {
        const versionDelta = (a.descriptor as SurfaceProfileDescriptor).descriptorVersion - (b.descriptor as SurfaceProfileDescriptor).descriptorVersion;
        return versionDelta !== 0 ? versionDelta : a.instancePath.localeCompare(b.instancePath);
    });
    const selected = matching[matching.length - 1];
    if (selected === undefined || selected.descriptor === undefined) {
        throw new Error("internal invariant: a matching candidate must provide a parsed descriptor");
    }
    return { descriptor: selected.descriptor, instancePath: selected.instancePath, considered: candidates, diagnostics: [] };
}
