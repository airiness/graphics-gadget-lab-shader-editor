/**
 * The strict reader for the published handshake (describe) document —
 * the single-line JSON document the machine process contract places on
 * stdout, with stderr left empty.
 *
 * Discipline (toolchain integration design, section 7): the reader holds
 * the document shapes strictly — the exact field set of each document
 * kind, the exact field types, a status vocabulary drawn from the
 * published contract — and never partially accepts, invents, or silently
 * reinterprets unfamiliar data. Unknown or missing fields reject
 * explicitly.
 *
 * Reading is NOT consuming: this reader proves the document's shape.
 * Whether the observed process-contract version is in the client's
 * declared supported range is the separate axis decision in
 * contract-range, and whether the facts meet the requirement is the
 * verdicts'. Today, with the declared range empty, a well-read describe
 * document still leaves the tool discovered-but-unproven — both layers
 * visible, neither papered over.
 */
import type { ToolDiagnostic } from "./contract-facts.js";
import {
    firstUnknownField,
    isBoolean,
    isIntegralNumber,
    isPlainObject,
    isString,
    readDiagnosticArray,
} from "./strict-json.js";

/** The failure status vocabulary of the published handshake contract. */
export type HandshakeFailureStatus = "usage-error" | "compiler-unavailable" | "internal-error";

export interface HandshakeSuccessDocument {
    readonly command: "describe";
    readonly success: true;
    readonly status: "ok";
    readonly exitCode: number;
    /** The process-contract version axis — carried here, and only here. */
    readonly processContractVersion: number;
    readonly toolIdentity: string;
    readonly toolVersion: string;
    readonly producerKind: string;
    readonly producerIdentity: string;
    readonly supportedTargets: readonly string[];
    /** Carried verbatim; empty on the published success shape. */
    readonly diagnostics: readonly ToolDiagnostic[];
}

export interface HandshakeFailureDocument {
    readonly command: "describe";
    readonly success: false;
    readonly status: HandshakeFailureStatus;
    readonly exitCode: number;
    /** The process-contract version axis stays present on failure
     *  documents too — it is the axis of the contract itself. */
    readonly processContractVersion: number;
    /** Non-empty, carried verbatim, and the entire failure payload. */
    readonly diagnostics: readonly ToolDiagnostic[];
}

export type HandshakeDocument = HandshakeSuccessDocument | HandshakeFailureDocument;

export type HandshakeReadReason =
    | "not-json"
    | "not-a-single-line-json-document"
    | "not-an-object"
    | "command-not-describe"
    | "missing-field"
    | "unexpected-field"
    | "field-type-mismatch"
    | "status-outside-vocabulary"
    | "diagnostics-malformed";

/** An explicit, structured reading refusal — never a partial document. */
export interface HandshakeRejection {
    readonly reason: HandshakeReadReason;
    readonly detail: string;
}

export type HandshakeReadOutcome =
    | { readonly status: "read"; readonly document: HandshakeDocument }
    | { readonly status: "rejected"; readonly rejection: HandshakeRejection };

const SUCCESS_FIELDS = [
    "command",
    "success",
    "status",
    "exitCode",
    "processContractVersion",
    "toolIdentity",
    "toolVersion",
    "producerKind",
    "producerIdentity",
    "supportedTargets",
    "diagnostics",
] as const;

const FAILURE_FIELDS = [
    "command",
    "success",
    "status",
    "exitCode",
    "processContractVersion",
    "diagnostics",
] as const;

const FAILURE_STATUSES: readonly HandshakeFailureStatus[] = [
    "usage-error",
    "compiler-unavailable",
    "internal-error",
];

function rejection(reason: HandshakeReadReason, detail: string): HandshakeReadOutcome {
    return { status: "rejected", rejection: { reason, detail } };
}

function missingField(fields: readonly string[], raw: Record<string, unknown>): HandshakeReadOutcome | null {
    for (const field of fields) {
        if (!(field in raw)) {
            return rejection("missing-field", `the document is missing the required field "${field}"`);
        }
    }
    return null;
}

/**
 * Reads one published handshake document from the tool's stdout text.
 * The channel discipline (a single-line JSON document, stderr empty) is
 * enforced on the text before parsing.
 */
export function readHandshakeDocument(text: string): HandshakeReadOutcome {
    const document = text.trim();
    if (document.length === 0) {
        return rejection("not-json", "the document is empty; the handshake produced no machine document");
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
    if (raw.command !== "describe") {
        return rejection(
            "command-not-describe",
            `the document carries command ${JSON.stringify(raw.command)}; a handshake document carries "describe"`,
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
        const missing = missingField(SUCCESS_FIELDS, raw);
        if (missing !== null) {
            return missing;
        }
        const exitCode = raw.exitCode;
        if (!isIntegralNumber(exitCode)) {
            return rejection("field-type-mismatch", `the exitCode field must be an integer, found ${JSON.stringify(exitCode)}`);
        }
        const processContractVersion = raw.processContractVersion;
        if (!isIntegralNumber(processContractVersion)) {
            return rejection(
                "field-type-mismatch",
                `the processContractVersion field must be an integer, found ${JSON.stringify(processContractVersion)}`,
            );
        }
        if (raw.status !== "ok") {
            return rejection(
                "status-outside-vocabulary",
                `a success handshake document carries status "ok", found ${JSON.stringify(raw.status)}`,
            );
        }
        for (const field of ["toolIdentity", "toolVersion", "producerKind", "producerIdentity"] as const) {
            if (!isString(raw[field])) {
                return rejection("field-type-mismatch", `the ${field} field must be a string, found ${JSON.stringify(raw[field])}`);
            }
        }
        if (!Array.isArray(raw.supportedTargets) || raw.supportedTargets.some((entry) => !isString(entry))) {
            return rejection(
                "field-type-mismatch",
                "the supportedTargets field must be an array of wire-name strings",
            );
        }
        const diagnostics = readDiagnosticArray(raw.diagnostics);
        if (!diagnostics.ok) {
            return rejection("diagnostics-malformed", diagnostics.detail);
        }
        return {
            status: "read",
            document: {
                command: "describe",
                success: true,
                status: "ok",
                exitCode,
                processContractVersion,
                toolIdentity: raw.toolIdentity as string,
                toolVersion: raw.toolVersion as string,
                producerKind: raw.producerKind as string,
                producerIdentity: raw.producerIdentity as string,
                supportedTargets: raw.supportedTargets as readonly string[],
                diagnostics: diagnostics.diagnostics,
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
    const processContractVersion = raw.processContractVersion;
    if (!isIntegralNumber(processContractVersion)) {
        return rejection(
            "field-type-mismatch",
            `the processContractVersion field must be an integer, found ${JSON.stringify(processContractVersion)}`,
        );
    }
    if (typeof raw.status !== "string" || !FAILURE_STATUSES.includes(raw.status as HandshakeFailureStatus)) {
        return rejection(
            "status-outside-vocabulary",
            `a failure handshake document carries one of ${FAILURE_STATUSES.map((status) => `"${status}"`).join(", ")}, found ${JSON.stringify(raw.status)}`,
        );
    }
    // The published failure payload carries no business fields: the
    // success-only facts must be absent, not ignored.
    for (const businessField of ["toolIdentity", "toolVersion", "producerKind", "producerIdentity", "supportedTargets"] as const) {
        if (businessField in raw) {
            return rejection(
                "unexpected-field",
                `a failure handshake document must not carry the business field "${businessField}"`,
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
            "a failure handshake document carries at least one structured diagnostic",
        );
    }
    return {
        status: "read",
        document: {
            command: "describe",
            success: false,
            status: raw.status as HandshakeFailureStatus,
            exitCode,
            processContractVersion,
            diagnostics: diagnostics.diagnostics,
        },
    };
}
