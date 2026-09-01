/**
 * The reader for the published compile result envelope — an
 * already-published, stable toolchain contract (machine-readable, tested
 * in the toolchain repository).
 *
 * The envelope is independent of the describe process-contract axis: it
 * carries no `processContractVersion` of its own, so no axis gate runs —
 * the contract's own tolerance rules apply directly: required fields and
 * types are strict, the status vocabulary is closed, the
 * known-but-forbidden fields (a failure document carrying the
 * success-only result evidence) reject, and fields outside the contract's
 * shape are IGNORED — the wire contract owns its tolerance policy, this
 * client does not pre-declare it.
 *
 * Consuming this envelope is client work: read it, check its status
 * vocabulary, extract the build and artifact facts. The reader trusts
 * the document's own fields (status, exitCode, identities) and does not
 * re-derive the contract's own mappings (for example status to exit
 * code) — that consistency is the toolchain's obligation, proven by the
 * toolchain's own self-tests.
 *
 * The three publication fields (artifactId, runtimeArtifactBinaryPath,
 * runtimeArtifactManifestPath) form one published group on the wire (the
 * contract's own rule): the reader requires them exactly together and
 * models them as the nested `publication` value.
 */
import type { ToolDiagnostic } from "./contract-facts.js";
import {
    isBoolean,
    isDigestHex,
    isIntegralNumber,
    isPlainObject,
    isString,
    readDiagnosticArray,
} from "./strict-json.js";

/** The failure status vocabulary of the published result contract. */
export type CompileFailureStatus =
    | "invalid-request"
    | "source-not-found"
    | "compiler-unavailable"
    | "compile-failed"
    | "artifact-io-failure"
    | "source-changed";

/** The binary formats the toolchain publishes. */
export type CompileBinaryFormat = "spirv" | "dxil";

export interface CompilePublication {
    readonly artifactId: string;
    readonly runtimeArtifactBinaryPath: string;
    readonly runtimeArtifactManifestPath: string;
}

export interface CompileSuccessDocument {
    readonly command: "compile";
    readonly success: true;
    readonly status: "ok";
    readonly exitCode: number;
    /** The recipe identity the toolchain committed (its evidence). */
    readonly recipeId: string;
    /** The build key the toolchain committed (its evidence). */
    readonly buildKey: string;
    /** The content identity of the committed binary (its evidence). */
    readonly binaryHash: string;
    readonly binaryFormat: CompileBinaryFormat;
    /** The target wire name the compilation targeted (result evidence). */
    readonly target: string;
    readonly binaryPath: string;
    readonly cacheRecordPath: string;
    readonly fromCache: boolean;
    /** Carried verbatim; empty on the published success shape. */
    readonly diagnostics: readonly ToolDiagnostic[];
    /** The publication group: present exactly together, or absent. */
    readonly publication?: CompilePublication | undefined;
}

export interface CompileFailureDocument {
    readonly command: "compile";
    readonly success: false;
    readonly status: CompileFailureStatus;
    readonly exitCode: number;
    /** Non-empty, carried verbatim: structured diagnostics are the
     *  failure payload, never prose. */
    readonly diagnostics: readonly ToolDiagnostic[];
}

export type CompileDocument = CompileSuccessDocument | CompileFailureDocument;

export type CompileReadReason =
    | "not-json"
    | "not-a-single-line-json-document"
    | "not-an-object"
    | "command-not-compile"
    | "missing-field"
    | "field-type-mismatch"
    | "status-outside-vocabulary"
    | "publication-group-incomplete"
    | "diagnostics-malformed"
    | "forbidden-field";

/** An explicit, structured reading refusal — never a partial document. */
export interface CompileRejection {
    readonly reason: CompileReadReason;
    readonly detail: string;
}

export type CompileReadOutcome =
    | { readonly status: "read"; readonly document: CompileDocument }
    | { readonly status: "rejected"; readonly rejection: CompileRejection };

const FAILURE_STATUSES: readonly CompileFailureStatus[] = [
    "invalid-request",
    "source-not-found",
    "compiler-unavailable",
    "compile-failed",
    "artifact-io-failure",
    "source-changed",
];

const BINARY_FORMATS: readonly CompileBinaryFormat[] = ["spirv", "dxil"];

/** The success-only result evidence a failure document must NOT carry —
 *  known fields the contract assigns to the success kind only. */
const SUCCESS_ONLY_FIELDS = [
    "recipeId",
    "buildKey",
    "binaryHash",
    "binaryFormat",
    "target",
    "binaryPath",
    "cacheRecordPath",
    "fromCache",
    "artifactId",
    "runtimeArtifactBinaryPath",
    "runtimeArtifactManifestPath",
] as const;

function rejection(reason: CompileReadReason, detail: string): CompileReadOutcome {
    return { status: "rejected", rejection: { reason, detail } };
}

function missingField(fields: readonly string[], raw: Record<string, unknown>): CompileReadOutcome | null {
    for (const field of fields) {
        if (!(field in raw)) {
            return rejection("missing-field", `the document is missing the required field "${field}"`);
        }
    }
    return null;
}

/**
 * Reads one published result envelope from the tool's stdout text (the
 * same channel discipline: one single-line JSON document on stdout,
 * stderr empty).
 */
export function readCompileDocument(text: string): CompileReadOutcome {
    const document = text.trim();
    if (document.length === 0) {
        return rejection("not-json", "the document is empty; the compile produced no machine document");
    }
    if (document.includes("\n") || document.includes("\r")) {
        return rejection(
            "not-a-single-line-json-document",
            "the machine process contract places exactly one single-line JSON document on stdout",
        );
    }

    let raw: unknown;
    try {
        raw = JSON.parse(document);
    } catch {
        return rejection("not-json", "the document is not valid JSON");
    }
    if (!isPlainObject(raw)) {
        return rejection("not-an-object", "the document root is not a JSON object");
    }

    // Phase A — the minimal envelope, every document kind.
    if (raw.command !== "compile") {
        return rejection(
            "command-not-compile",
            `the document carries command ${JSON.stringify(raw.command)}; a result envelope carries "compile"`,
        );
    }
    if (!("success" in raw)) {
        return rejection("missing-field", 'the document is missing the required field "success"');
    }
    if (!isBoolean(raw.success)) {
        return rejection("field-type-mismatch", `the success field must be a boolean, found ${JSON.stringify(raw.success)}`);
    }
    if (!("exitCode" in raw)) {
        return rejection("missing-field", 'the document is missing the required field "exitCode"');
    }
    if (!isIntegralNumber(raw.exitCode)) {
        return rejection("field-type-mismatch", `the exitCode field must be an integer, found ${JSON.stringify(raw.exitCode)}`);
    }

    // Phase B — the payload of the success or the failure kind.
    if (raw.success === true) {
        const missing = missingField(
            ["status", "recipeId", "buildKey", "binaryHash", "binaryFormat", "target", "binaryPath", "cacheRecordPath", "fromCache", "diagnostics"],
            raw,
        );
        if (missing !== null) {
            return missing;
        }
        if (raw.status !== "ok") {
            return rejection(
                "status-outside-vocabulary",
                `a success document carries status "ok", found ${JSON.stringify(raw.status)}`,
            );
        }
        for (const field of ["recipeId", "buildKey", "binaryHash"] as const) {
            if (!isDigestHex(raw[field])) {
                return rejection(
                    "field-type-mismatch",
                    `the ${field} field must be a 64-character hex digest, found ${JSON.stringify(raw[field])}`,
                );
            }
        }
        if (!isString(raw.binaryFormat) || !BINARY_FORMATS.includes(raw.binaryFormat as CompileBinaryFormat)) {
            return rejection(
                "field-type-mismatch",
                `the binaryFormat field must be one of ${BINARY_FORMATS.map((format) => `"${format}"`).join(", ")}, found ${JSON.stringify(raw.binaryFormat)}`,
            );
        }
        for (const field of ["target", "binaryPath", "cacheRecordPath"] as const) {
            if (!isString(raw[field])) {
                return rejection("field-type-mismatch", `the ${field} field must be a string, found ${JSON.stringify(raw[field])}`);
            }
        }
        if (!isBoolean(raw.fromCache)) {
            return rejection("field-type-mismatch", `the fromCache field must be a boolean, found ${JSON.stringify(raw.fromCache)}`);
        }
        const diagnostics = readDiagnosticArray(raw.diagnostics);
        if (!diagnostics.ok) {
            return rejection("diagnostics-malformed", diagnostics.detail);
        }

        // The publication group: one published group on the wire, exactly
        // together — partial presence is a contract violation and rejects.
        const publicationKeys = ["artifactId", "runtimeArtifactBinaryPath", "runtimeArtifactManifestPath"];
        const present = publicationKeys.filter((field) => field in raw);
        let publication: CompilePublication | undefined;
        if (present.length > 0) {
            if (present.length !== publicationKeys.length) {
                return rejection(
                    "publication-group-incomplete",
                    `the publication fields form one group; found ${JSON.stringify(present)} but all three or none are expected`,
                );
            }
            const artifactId = raw.artifactId;
            const runtimeArtifactBinaryPath = raw.runtimeArtifactBinaryPath;
            const runtimeArtifactManifestPath = raw.runtimeArtifactManifestPath;
            if (
                !isDigestHex(artifactId) ||
                !isString(runtimeArtifactBinaryPath) ||
                !isString(runtimeArtifactManifestPath)
            ) {
                return rejection("field-type-mismatch", "the publication group fields must be strings and a 64-character hex digest");
            }
            publication = {
                artifactId,
                runtimeArtifactBinaryPath,
                runtimeArtifactManifestPath,
            };
        }

        return {
            status: "read",
            document: {
                command: "compile",
                success: true,
                status: "ok",
                exitCode: raw.exitCode as number,
                recipeId: raw.recipeId as string,
                buildKey: raw.buildKey as string,
                binaryHash: raw.binaryHash as string,
                binaryFormat: raw.binaryFormat as CompileBinaryFormat,
                target: raw.target as string,
                binaryPath: raw.binaryPath as string,
                cacheRecordPath: raw.cacheRecordPath as string,
                fromCache: raw.fromCache as boolean,
                diagnostics: diagnostics.diagnostics,
                publication,
            },
        };
    }

    const missing = missingField(["status", "diagnostics"], raw);
    if (missing !== null) {
        return missing;
    }
    // Known-but-forbidden: the success-only result evidence must be ABSENT
    // on a failure document (the contract assigns it to the success
    // kind). This is a contract rule, not a tolerance pre-declaration.
    for (const field of SUCCESS_ONLY_FIELDS) {
        if (field in raw) {
            return rejection(
                "forbidden-field",
                `a failure document must not carry the success-only field "${field}"`,
            );
        }
    }
    if (typeof raw.status !== "string" || !FAILURE_STATUSES.includes(raw.status as CompileFailureStatus)) {
        return rejection(
            "status-outside-vocabulary",
            `a failure document carries one of ${FAILURE_STATUSES.map((status) => `"${status}"`).join(", ")}, found ${JSON.stringify(raw.status)}`,
        );
    }
    const diagnostics = readDiagnosticArray(raw.diagnostics);
    if (!diagnostics.ok) {
        return rejection("diagnostics-malformed", diagnostics.detail);
    }
    if (diagnostics.diagnostics.length === 0) {
        return rejection(
            "diagnostics-malformed",
            "a failure document carries at least one structured diagnostic",
        );
    }
    return {
        status: "read",
        document: {
            command: "compile",
            success: false,
            status: raw.status as CompileFailureStatus,
            exitCode: raw.exitCode as number,
            diagnostics: diagnostics.diagnostics,
        },
    };
}
