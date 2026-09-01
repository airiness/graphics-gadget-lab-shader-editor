/**
 * The reader for the published handshake (describe) document — the
 * single-line JSON document the machine process contract places on
 * stdout, with stderr left empty.
 *
 * Reading is a two-phase negotiation, following the contract's own
 * tolerance rules (required fields, types, and closed status vocabulary
 * are strict; fields outside a document's shape are IGNORED — the wire
 * contract owns its tolerance policy, this client does not pre-declare
 * it):
 *
 * - Phase A — the minimal envelope every document kind carries:
 *   `command "describe"`, `success`, `exitCode`, and the
 *   `processContractVersion` axis (its type is envelope-level).
 * - The support gate — the observed axis is judged against the client's
 *   declared supported range BEFORE any payload is interpreted. An
 *   unsupported axis is a valid machine document whose contract the
 *   client does not consume: an explicit "unsupported-contract" result,
 *   never a malformed-document refusal.
 * - Phase B — the payload of the one supported contract (v2, the
 *   published form this client consumes): the required fields, their
 *   types, the closed status vocabulary, and the known-but-forbidden
 *   fields (a failure document carrying the success-only business
 *   facts) are strict; fields outside the v2 shape are ignored. The
 *   `compilePolicyRevision` field (v2+, required on success, integer)
 *   is read here and carried verbatim into the proven facts — the
 *   verdicts judge it, and the BuildIntent identity includes it.
 *
 * Whether the proven facts meet the requirement is the verdicts'; both
 * layers stay visible, neither papered over.
 */
import type { ToolDiagnostic } from "./contract-facts.js";
import type { SupportedContractRange } from "./contract-range-declaration.js";
import { clientSupportedContractRange } from "./contract-range-declaration.js";
import {
    judgeContractSupport,
    type ContractSupportVerdict,
} from "./contract-range.js";
import {
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
    /** The compile-policy revision axis (v2+, required on the success
     *  document): the toolchain's lowering / argument-generation policy
     *  version. Carried verbatim into the proven facts — a
     *  consumer-must-participate compatibility fact, never informational. */
    readonly compilePolicyRevision: number;
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
    /** The axis stays present on failure documents too: it is the axis
     *  of the contract itself. */
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
    | "field-type-mismatch"
    | "status-outside-vocabulary"
    | "diagnostics-malformed"
    | "forbidden-field";

/** An explicit, structured reading refusal — never a partial document. */
export interface HandshakeRejection {
    readonly reason: HandshakeReadReason;
    readonly detail: string;
}

/**
 * The three reading outcomes:
 * - `read` — envelope accepted, the axis is in the declared range, and
 *   the v1 payload checks out;
 * - `unsupported-contract` — a VALID document whose axis the client does
 *   not consume: the observed axis and its explicit judgment, carried
 *   verbatim for the state machine;
 * - `rejected` — the document does not check out at the envelope or
 *   payload level, with the side named.
 */
export type HandshakeReadOutcome =
    | { readonly status: "read"; readonly document: HandshakeDocument }
    | {
        readonly status: "unsupported-contract";
        readonly contract: ContractSupportVerdict;
      }
    | { readonly status: "rejected"; readonly rejection: HandshakeRejection };

const FAILURE_STATUSES: readonly HandshakeFailureStatus[] = [
    "usage-error",
    "compiler-unavailable",
    "internal-error",
];

/** The success-only business facts a failure document must NOT carry —
 *  known fields the contract assigns to the success kind only. */
const SUCCESS_ONLY_FIELDS = [
    "toolIdentity",
    "toolVersion",
    "compilePolicyRevision",
    "producerKind",
    "producerIdentity",
    "supportedTargets",
] as const;

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
 * Reads one published handshake document from the tool's stdout text. The
 * channel discipline (exactly one single-line JSON document on stdout) is
 * enforced on the text before parsing. The support gate runs on the
 * client's declared range by default; the null-declaration world is
 * reachable by passing `null` explicitly.
 */
export function readHandshakeDocument(
    text: string,
    range: SupportedContractRange | null = clientSupportedContractRange,
): HandshakeReadOutcome {
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

    // Phase A — the minimal envelope, every document kind.
    if (raw.command !== "describe") {
        return rejection(
            "command-not-describe",
            `the document carries command ${JSON.stringify(raw.command)}; a handshake document carries "describe"`,
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
    if (!("processContractVersion" in raw)) {
        return rejection(
            "missing-field",
            'the document is missing the required field "processContractVersion"',
        );
    }
    if (!isIntegralNumber(raw.processContractVersion)) {
        return rejection(
            "field-type-mismatch",
            `the processContractVersion field must be an integer, found ${JSON.stringify(raw.processContractVersion)}`,
        );
    }

    // The support gate: before any payload interpretation.
    const contract = judgeContractSupport(raw.processContractVersion, range);
    if (contract.supported !== true) {
        return { status: "unsupported-contract", contract };
    }

    // Phase B — the supported contract's payload (v2).
    if (raw.success === true) {
        const missing = missingField(
            [
                "status",
                "toolIdentity",
                "toolVersion",
                "compilePolicyRevision",
                "producerKind",
                "producerIdentity",
                "supportedTargets",
                "diagnostics",
            ],
            raw,
        );
        if (missing !== null) {
            return missing;
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
        if (!isIntegralNumber(raw.compilePolicyRevision)) {
            return rejection(
                "field-type-mismatch",
                `the compilePolicyRevision field must be an integer, found ${JSON.stringify(raw.compilePolicyRevision)}`,
            );
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
                exitCode: raw.exitCode as number,
                processContractVersion: raw.processContractVersion as number,
                compilePolicyRevision: raw.compilePolicyRevision as number,
                toolIdentity: raw.toolIdentity as string,
                toolVersion: raw.toolVersion as string,
                producerKind: raw.producerKind as string,
                producerIdentity: raw.producerIdentity as string,
                supportedTargets: raw.supportedTargets as readonly string[],
                diagnostics: diagnostics.diagnostics,
            },
        };
    }

    const missing = missingField(["status", "diagnostics"], raw);
    if (missing !== null) {
        return missing;
    }
    // Known-but-forbidden: the success-only business facts must be ABSENT
    // on a failure document (the contract assigns them to the success
    // kind). This is a contract rule, not a tolerance pre-declaration.
    for (const field of SUCCESS_ONLY_FIELDS) {
        if (field in raw) {
            return rejection(
                "forbidden-field",
                `a failure handshake document must not carry the success-only field "${field}"`,
            );
        }
    }
    if (typeof raw.status !== "string" || !FAILURE_STATUSES.includes(raw.status as HandshakeFailureStatus)) {
        return rejection(
            "status-outside-vocabulary",
            `a failure handshake document carries one of ${FAILURE_STATUSES.map((status) => `"${status}"`).join(", ")}, found ${JSON.stringify(raw.status)}`,
        );
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
            exitCode: raw.exitCode as number,
            processContractVersion: raw.processContractVersion as number,
            diagnostics: diagnostics.diagnostics,
        },
    };
}
