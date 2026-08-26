/**
 * The strict reader for the published compile result envelope — an
 * already-published, stable toolchain contract (machine-readable, tested
 * in the toolchain repository), independent of the describe
 * process-contract axis: it carries no processContractVersion of its own.
 *
 * Consuming this envelope is client work: parse it strictly, check its
 * status vocabulary, extract the build and artifact facts. The reader
 * holds the exact field set of each document kind and rejects unknown,
 * missing, or mistyped data explicitly — never partially accepting, never
 * inventing a fact, never scraping prose.
 *
 * The reader is the shape authority on the TypeScript side: it trusts the
 * document's own fields (status, exitCode, identities) and does not
 * re-derive the contract's own mappings (for example status to exit
 * code) — that consistency is the toolchain's obligation, proven by the
 * toolchain's own self-tests.
 *
 * The three publication fields (artifactId, runtimeArtifactBinaryPath,
 * runtimeArtifactManifestPath) form one published group on the wire: the
 * reader requires them exactly together and models them as the nested
 * `publication` value.
 */
import type { ToolDiagnostic } from "./contract-facts.js";
import {
    firstUnknownField,
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
    | "unexpected-field"
    | "field-type-mismatch"
    | "status-outside-vocabulary"
    | "publication-group-incomplete"
    | "diagnostics-malformed";

/** An explicit, structured reading refusal — never a partial document. */
export interface CompileRejection {
    readonly reason: CompileReadReason;
    readonly detail: string;
}

export type CompileReadOutcome =
    | { readonly status: "read"; readonly document: CompileDocument }
    | { readonly status: "rejected"; readonly rejection: CompileRejection };

const SUCCESS_FIELDS = [
    "command",
    "success",
    "status",
    "exitCode",
    "recipeId",
    "buildKey",
    "binaryHash",
    "binaryFormat",
    "target",
    "binaryPath",
    "cacheRecordPath",
    "fromCache",
    "diagnostics",
    "artifactId",
    "runtimeArtifactBinaryPath",
    "runtimeArtifactManifestPath",
] as const;

const FAILURE_FIELDS = ["command", "success", "status", "exitCode", "diagnostics"] as const;

const FAILURE_STATUSES: readonly CompileFailureStatus[] = [
    "invalid-request",
    "source-not-found",
    "compiler-unavailable",
    "compile-failed",
    "artifact-io-failure",
    "source-changed",
];

const BINARY_FORMATS: readonly CompileBinaryFormat[] = ["spirv", "dxil"];

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
 * same channel discipline: one single-line JSON document, stderr empty).
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
    if (raw.command !== "compile") {
        return rejection(
            "command-not-compile",
            `the document carries command ${JSON.stringify(raw.command)}; a result envelope carries "compile"`,
        );
    }

    const unexpected = firstUnknownField(raw, SUCCESS_FIELDS);
    if (unexpected !== "") {
        return rejection("unexpected-field", `the document carries the unknown field "${unexpected}"`);
    }
    if (!isBoolean(raw.success)) {
        return rejection("field-type-mismatch", `the success field must be a boolean, found ${JSON.stringify(raw.success)}`);
    }

    if (raw.success === true) {
        const required = SUCCESS_FIELDS.filter((field) => !["artifactId", "runtimeArtifactBinaryPath", "runtimeArtifactManifestPath"].includes(field));
        const missing = missingField(required, raw);
        if (missing !== null) {
            return missing;
        }
        const exitCode = raw.exitCode;
        if (!isIntegralNumber(exitCode)) {
            return rejection("field-type-mismatch", `the exitCode field must be an integer, found ${JSON.stringify(exitCode)}`);
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

        // The publication group: exactly together on the wire, exactly
        // together in the read value — partial presence is a contract
        // violation and rejects.
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
                exitCode,
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

    const missing = missingField(FAILURE_FIELDS, raw);
    if (missing !== null) {
        return missing;
    }
    const exitCode = raw.exitCode;
    if (!isIntegralNumber(exitCode)) {
        return rejection("field-type-mismatch", `the exitCode field must be an integer, found ${JSON.stringify(exitCode)}`);
    }
    if (typeof raw.status !== "string" || !FAILURE_STATUSES.includes(raw.status as CompileFailureStatus)) {
        return rejection(
            "status-outside-vocabulary",
            `a failure document carries one of ${FAILURE_STATUSES.map((status) => `"${status}"`).join(", ")}, found ${JSON.stringify(raw.status)}`,
        );
    }
    // The published failure envelope carries no business fields: the
    // success-only evidence must be absent, not ignored.
    for (const businessField of ["recipeId", "buildKey", "binaryHash", "binaryFormat", "target", "binaryPath", "cacheRecordPath", "fromCache", "artifactId", "runtimeArtifactBinaryPath", "runtimeArtifactManifestPath"] as const) {
        if (businessField in raw) {
            return rejection(
                "unexpected-field",
                `a failure document must not carry the result field "${businessField}"`,
            );
        }
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
            exitCode,
            diagnostics: diagnostics.diagnostics,
        },
    };
}
