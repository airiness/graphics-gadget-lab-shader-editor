/**
 * File access for the CLI: reads are structured (FILE_NOT_FOUND /
 * FILE_UNREADABLE as diagnostics), never exceptions, so an agent or CI
 * caller sees one envelope shape end to end.
 */
import { readFileSync, statSync } from "node:fs";
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { CliCode, cliDiagnosticAt } from "./envelope.js";

export interface FileRead {
    readonly text: string | undefined;
    readonly diagnostic: ShaderGraphDiagnostic | undefined;
}

export function readTextFile(filePath: string, dataPath: string): FileRead {
    let isFile: boolean;
    try {
        isFile = statSync(filePath).isFile();
    } catch {
        isFile = false;
    }
    if (!isFile) {
        return {
            text: undefined,
            diagnostic: cliDiagnosticAt(dataPath, CliCode.FileNotFound, `File not found: "${filePath}".`),
        };
    }
    try {
        return { text: readFileSync(filePath, "utf8"), diagnostic: undefined };
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        return {
            text: undefined,
            diagnostic: cliDiagnosticAt(dataPath, CliCode.FileUnreadable, `File could not be read: "${filePath}" (${message}).`),
        };
    }
}
