/** Strict reader for preview-build contract v1 result envelopes. */
import type { ToolDiagnostic } from "./contract-facts.js";
import {
    isBoolean,
    isIntegralNumber,
    isLowerDigestHex,
    isPlainObject,
    readDiagnosticArray,
} from "./strict-json.js";

export type PreviewBuildExecutionFailureStatus =
    | "invalid-request"
    | "source-unavailable"
    | "source-identity-mismatch"
    | "writer-unavailable"
    | "base-registry-unavailable"
    | "compiler-unavailable"
    | "compile-failed"
    | "artifact-publication-failed"
    | "registry-build-failed"
    | "registry-publication-failed"
    | "preview-publication-build-failed"
    | "preview-publication-invalid"
    | "preview-publication-io-failed"
    | "stale-attempt"
    | "active-publication-failed"
    | "internal-error";

export type PreviewBuildFailureStatus = "usage-error" | PreviewBuildExecutionFailureStatus;

export interface PreviewBuildSuccessDocument {
    readonly command: "build-preview";
    readonly success: true;
    readonly status: "ok";
    readonly exitCode: number;
    readonly attemptSequence: number;
    readonly publicationId: string;
    readonly shaderArtifactId: string;
    readonly baseRegistryId: string;
    readonly previewRegistryId: string;
    readonly diagnostics: readonly ToolDiagnostic[];
}

export interface PreviewBuildUsageFailureDocument {
    readonly command: "build-preview";
    readonly success: false;
    readonly status: "usage-error";
    readonly exitCode: number;
    /** Command-line rejection can occur before the sequence is parsed. */
    readonly attemptSequence?: number | undefined;
    readonly diagnostics: readonly ToolDiagnostic[];
}

export interface PreviewBuildExecutionFailureDocument {
    readonly command: "build-preview";
    readonly success: false;
    readonly status: PreviewBuildExecutionFailureStatus;
    readonly exitCode: number;
    /** May be zero only when option-value parsing failed before a valid
     *  request could be formed; admitted requests always use positive values. */
    readonly attemptSequence: number;
    readonly diagnostics: readonly ToolDiagnostic[];
}

export type PreviewBuildDocument =
    | PreviewBuildSuccessDocument
    | PreviewBuildUsageFailureDocument
    | PreviewBuildExecutionFailureDocument;

export type PreviewBuildReadReason =
    | "not-json"
    | "not-a-single-line-json-document"
    | "not-an-object"
    | "command-not-build-preview"
    | "missing-field"
    | "field-type-mismatch"
    | "status-outside-vocabulary"
    | "diagnostics-malformed"
    | "forbidden-field";

export interface PreviewBuildRejection {
    readonly reason: PreviewBuildReadReason;
    readonly detail: string;
}

export type PreviewBuildReadOutcome =
    | { readonly status: "read"; readonly document: PreviewBuildDocument }
    | { readonly status: "rejected"; readonly rejection: PreviewBuildRejection };

const EXECUTION_FAILURE_STATUSES: readonly PreviewBuildExecutionFailureStatus[] = [
    "invalid-request",
    "source-unavailable",
    "source-identity-mismatch",
    "writer-unavailable",
    "base-registry-unavailable",
    "compiler-unavailable",
    "compile-failed",
    "artifact-publication-failed",
    "registry-build-failed",
    "registry-publication-failed",
    "preview-publication-build-failed",
    "preview-publication-invalid",
    "preview-publication-io-failed",
    "stale-attempt",
    "active-publication-failed",
    "internal-error",
];

const SUCCESS_ONLY_FIELDS = [
    "publicationId",
    "shaderArtifactId",
    "baseRegistryId",
    "previewRegistryId",
] as const;

function rejection(reason: PreviewBuildReadReason, detail: string): PreviewBuildReadOutcome {
    return { status: "rejected", rejection: { reason, detail } };
}

function missingField(
    fields: readonly string[],
    raw: Record<string, unknown>,
): PreviewBuildReadOutcome | null {
    for (const field of fields) {
        if (!(field in raw)) {
            return rejection("missing-field", `the document is missing the required field "${field}"`);
        }
    }
    return null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return isIntegralNumber(value) && value >= 0;
}

export function readPreviewBuildDocument(text: string): PreviewBuildReadOutcome {
    const document = text.trim();
    if (document.length === 0) {
        return rejection("not-json", "the document is empty; the Preview build produced no machine document");
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
    if (raw.command !== "build-preview") {
        return rejection(
            "command-not-build-preview",
            `the document carries command ${JSON.stringify(raw.command)}; a Preview result carries "build-preview"`,
        );
    }
    const envelopeMissing = missingField(["success", "exitCode"], raw);
    if (envelopeMissing !== null) {
        return envelopeMissing;
    }
    if (!isBoolean(raw.success)) {
        return rejection("field-type-mismatch", "the success field must be a boolean");
    }
    if (!isIntegralNumber(raw.exitCode)) {
        return rejection("field-type-mismatch", "the exitCode field must be an integer");
    }

    if (raw.success === true) {
        const missing = missingField(
            [
                "status",
                "attemptSequence",
                "publicationId",
                "shaderArtifactId",
                "baseRegistryId",
                "previewRegistryId",
                "diagnostics",
            ],
            raw,
        );
        if (missing !== null) {
            return missing;
        }
        if (raw.status !== "ok") {
            return rejection("status-outside-vocabulary", 'a successful Preview build carries status "ok"');
        }
        if (!isIntegralNumber(raw.attemptSequence) || raw.attemptSequence <= 0) {
            return rejection("field-type-mismatch", "a successful attemptSequence must be a positive safe integer");
        }
        for (const field of SUCCESS_ONLY_FIELDS) {
            if (!isLowerDigestHex(raw[field])) {
                return rejection(
                    "field-type-mismatch",
                    `the ${field} field must be a canonical lowercase SHA-256 digest`,
                );
            }
        }
        const diagnostics = readDiagnosticArray(raw.diagnostics);
        if (!diagnostics.ok) {
            return rejection("diagnostics-malformed", diagnostics.detail);
        }
        return {
            status: "read",
            document: {
                command: "build-preview",
                success: true,
                status: "ok",
                exitCode: raw.exitCode,
                attemptSequence: raw.attemptSequence,
                publicationId: raw.publicationId as string,
                shaderArtifactId: raw.shaderArtifactId as string,
                baseRegistryId: raw.baseRegistryId as string,
                previewRegistryId: raw.previewRegistryId as string,
                diagnostics: diagnostics.diagnostics,
            },
        };
    }

    const missing = missingField(["status", "diagnostics"], raw);
    if (missing !== null) {
        return missing;
    }
    for (const field of SUCCESS_ONLY_FIELDS) {
        if (field in raw) {
            return rejection(
                "forbidden-field",
                `a failed Preview build must not carry the success-only field "${field}"`,
            );
        }
    }
    const diagnostics = readDiagnosticArray(raw.diagnostics);
    if (!diagnostics.ok || diagnostics.diagnostics.length === 0) {
        return rejection(
            "diagnostics-malformed",
            diagnostics.ok ? "a failed Preview build carries at least one diagnostic" : diagnostics.detail,
        );
    }

    if (raw.status === "usage-error") {
        if ("attemptSequence" in raw && !isNonNegativeSafeInteger(raw.attemptSequence)) {
            return rejection("field-type-mismatch", "the optional attemptSequence must be a non-negative safe integer");
        }
        return {
            status: "read",
            document: {
                command: "build-preview",
                success: false,
                status: "usage-error",
                exitCode: raw.exitCode,
                attemptSequence: raw.attemptSequence as number | undefined,
                diagnostics: diagnostics.diagnostics,
            },
        };
    }

    if (
        typeof raw.status !== "string" ||
        !EXECUTION_FAILURE_STATUSES.includes(raw.status as PreviewBuildExecutionFailureStatus)
    ) {
        return rejection("status-outside-vocabulary", "the failed Preview build carries an unknown status");
    }
    if (!("attemptSequence" in raw)) {
        return rejection("missing-field", 'the document is missing the required field "attemptSequence"');
    }
    if (!isNonNegativeSafeInteger(raw.attemptSequence)) {
        return rejection("field-type-mismatch", "the attemptSequence must be a non-negative safe integer");
    }
    return {
        status: "read",
        document: {
            command: "build-preview",
            success: false,
            status: raw.status as PreviewBuildExecutionFailureStatus,
            exitCode: raw.exitCode,
            attemptSequence: raw.attemptSequence,
            diagnostics: diagnostics.diagnostics,
        },
    };
}
