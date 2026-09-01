/** Strict reader for the dedicated, zero-side-effect `describe-preview`
 *  handshake. Process-contract support is judged before Preview-contract
 *  support; neither unsupported axis is reinterpreted as malformed payload. */
import type { ToolDiagnostic } from "./contract-facts.js";
import type { SupportedContractRange } from "./contract-range-declaration.js";
import { clientSupportedContractRange } from "./contract-range-declaration.js";
import { judgeContractSupport, type ContractSupportVerdict } from "./contract-range.js";
import { clientSupportedPreviewBuildContractRange } from "./preview-contract-range-declaration.js";
import {
    isBoolean,
    isIntegralNumber,
    isLowerDigestHex,
    isPlainObject,
    isString,
    readDiagnosticArray,
} from "./strict-json.js";

export type PreviewHandshakeFailureStatus =
    | "usage-error"
    | "compiler-unavailable"
    | "internal-error";

export interface SupportedPreviewInputContract {
    readonly id: string;
    readonly profileId: string;
    readonly profileVersion: number;
}

export interface PreviewHandshakeSuccessDocument {
    readonly command: "describe-preview";
    readonly success: true;
    readonly status: "ok";
    readonly exitCode: number;
    readonly processContractVersion: number;
    readonly previewBuildContractVersion: number;
    readonly compilePolicyRevision: number;
    readonly toolIdentity: string;
    readonly toolVersion: string;
    readonly producerKind: string;
    readonly producerIdentity: string;
    readonly supportedTargets: readonly string[];
    readonly previewProgramDescriptorVersion: number;
    readonly previewProgramDescriptorIdentity: string;
    readonly supportedPreviewInputContracts: readonly SupportedPreviewInputContract[];
    readonly previewPublicationSchemaVersion: number;
    readonly previewActivePublicationSchemaVersion: number;
    readonly previewObservationSchemaVersion: number;
    readonly diagnostics: readonly ToolDiagnostic[];
}

export interface PreviewHandshakeFailureDocument {
    readonly command: "describe-preview";
    readonly success: false;
    readonly status: PreviewHandshakeFailureStatus;
    readonly exitCode: number;
    readonly processContractVersion: number;
    readonly previewBuildContractVersion: number;
    readonly diagnostics: readonly ToolDiagnostic[];
}

export type PreviewHandshakeDocument =
    | PreviewHandshakeSuccessDocument
    | PreviewHandshakeFailureDocument;

export type PreviewHandshakeReadReason =
    | "not-json"
    | "not-a-single-line-json-document"
    | "not-an-object"
    | "command-not-describe-preview"
    | "missing-field"
    | "field-type-mismatch"
    | "status-outside-vocabulary"
    | "diagnostics-malformed"
    | "forbidden-field";

export interface PreviewHandshakeRejection {
    readonly reason: PreviewHandshakeReadReason;
    readonly detail: string;
}

export type PreviewHandshakeReadOutcome =
    | { readonly status: "read"; readonly document: PreviewHandshakeDocument }
    | { readonly status: "unsupported-process-contract"; readonly contract: ContractSupportVerdict }
    | { readonly status: "unsupported-preview-contract"; readonly contract: ContractSupportVerdict }
    | { readonly status: "rejected"; readonly rejection: PreviewHandshakeRejection };

const FAILURE_STATUSES: readonly PreviewHandshakeFailureStatus[] = [
    "usage-error",
    "compiler-unavailable",
    "internal-error",
];

const SUCCESS_ONLY_FIELDS = [
    "compilePolicyRevision",
    "toolIdentity",
    "toolVersion",
    "producerKind",
    "producerIdentity",
    "supportedTargets",
    "previewProgramDescriptorVersion",
    "previewProgramDescriptorIdentity",
    "supportedPreviewInputContracts",
    "previewPublicationSchemaVersion",
    "previewActivePublicationSchemaVersion",
    "previewObservationSchemaVersion",
] as const;

function rejection(reason: PreviewHandshakeReadReason, detail: string): PreviewHandshakeReadOutcome {
    return { status: "rejected", rejection: { reason, detail } };
}

function missingField(
    fields: readonly string[],
    raw: Record<string, unknown>,
): PreviewHandshakeReadOutcome | null {
    for (const field of fields) {
        if (!(field in raw)) {
            return rejection("missing-field", `the document is missing the required field "${field}"`);
        }
    }
    return null;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return isIntegralNumber(value) && value > 0;
}

type PreviewInputContractsRead =
    | { readonly ok: true; readonly contracts: readonly SupportedPreviewInputContract[] }
    | { readonly ok: false; readonly detail: string };

function readPreviewInputContracts(raw: unknown): PreviewInputContractsRead {
    if (!Array.isArray(raw)) {
        return { ok: false, detail: "supportedPreviewInputContracts must be an array" };
    }
    const contracts: SupportedPreviewInputContract[] = [];
    const seenIds = new Set<string>();
    for (let index = 0; index < raw.length; index += 1) {
        const entry = raw[index];
        if (!isPlainObject(entry)) {
            return { ok: false, detail: `supportedPreviewInputContracts[${index}] is not an object` };
        }
        for (const field of ["id", "profileId", "profileVersion"] as const) {
            if (!(field in entry)) {
                return {
                    ok: false,
                    detail: `supportedPreviewInputContracts[${index}] is missing "${field}"`,
                };
            }
        }
        if (!isString(entry.id) || entry.id.length === 0) {
            return { ok: false, detail: `supportedPreviewInputContracts[${index}].id is not a non-empty string` };
        }
        if (!isString(entry.profileId) || entry.profileId.length === 0) {
            return { ok: false, detail: `supportedPreviewInputContracts[${index}].profileId is not a non-empty string` };
        }
        if (!isPositiveSafeInteger(entry.profileVersion)) {
            return { ok: false, detail: `supportedPreviewInputContracts[${index}].profileVersion is not a positive integer` };
        }
        if (seenIds.has(entry.id)) {
            return { ok: false, detail: `supportedPreviewInputContracts contains duplicate id "${entry.id}"` };
        }
        seenIds.add(entry.id);
        contracts.push({
            id: entry.id,
            profileId: entry.profileId,
            profileVersion: entry.profileVersion,
        });
    }
    return { ok: true, contracts };
}

export function readPreviewHandshakeDocument(
    text: string,
    processRange: SupportedContractRange | null = clientSupportedContractRange,
    previewRange: SupportedContractRange | null = clientSupportedPreviewBuildContractRange,
): PreviewHandshakeReadOutcome {
    const document = text.trim();
    if (document.length === 0) {
        return rejection("not-json", "the document is empty; the Preview handshake produced no machine document");
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
    if (raw.command !== "describe-preview") {
        return rejection(
            "command-not-describe-preview",
            `the document carries command ${JSON.stringify(raw.command)}; a Preview handshake carries "describe-preview"`,
        );
    }
    const envelopeMissing = missingField(["success", "exitCode", "processContractVersion"], raw);
    if (envelopeMissing !== null) {
        return envelopeMissing;
    }
    if (!isBoolean(raw.success)) {
        return rejection("field-type-mismatch", "the success field must be a boolean");
    }
    if (!isIntegralNumber(raw.exitCode)) {
        return rejection("field-type-mismatch", "the exitCode field must be an integer");
    }
    if (!isIntegralNumber(raw.processContractVersion)) {
        return rejection("field-type-mismatch", "the processContractVersion field must be an integer");
    }

    const processContract = judgeContractSupport(raw.processContractVersion, processRange);
    if (processContract.supported !== true) {
        return { status: "unsupported-process-contract", contract: processContract };
    }

    if (!("previewBuildContractVersion" in raw)) {
        return rejection("missing-field", 'the document is missing the required field "previewBuildContractVersion"');
    }
    if (!isIntegralNumber(raw.previewBuildContractVersion)) {
        return rejection("field-type-mismatch", "the previewBuildContractVersion field must be an integer");
    }
    const previewContract = judgeContractSupport(raw.previewBuildContractVersion, previewRange);
    if (previewContract.supported !== true) {
        return { status: "unsupported-preview-contract", contract: previewContract };
    }

    if (raw.success === true) {
        const missing = missingField(
            [
                "status",
                "compilePolicyRevision",
                "toolIdentity",
                "toolVersion",
                "producerKind",
                "producerIdentity",
                "supportedTargets",
                "previewProgramDescriptorVersion",
                "previewProgramDescriptorIdentity",
                "supportedPreviewInputContracts",
                "previewPublicationSchemaVersion",
                "previewActivePublicationSchemaVersion",
                "previewObservationSchemaVersion",
                "diagnostics",
            ],
            raw,
        );
        if (missing !== null) {
            return missing;
        }
        if (raw.status !== "ok") {
            return rejection("status-outside-vocabulary", 'a successful Preview handshake carries status "ok"');
        }
        for (const field of ["toolIdentity", "toolVersion", "producerKind", "producerIdentity"] as const) {
            if (!isString(raw[field])) {
                return rejection("field-type-mismatch", `the ${field} field must be a string`);
            }
        }
        if (!isPositiveSafeInteger(raw.compilePolicyRevision)) {
            return rejection("field-type-mismatch", "the compilePolicyRevision field must be a positive integer");
        }
        if (!Array.isArray(raw.supportedTargets) || raw.supportedTargets.some((entry) => !isString(entry))) {
            return rejection("field-type-mismatch", "the supportedTargets field must be an array of strings");
        }
        if (!isPositiveSafeInteger(raw.previewProgramDescriptorVersion)) {
            return rejection("field-type-mismatch", "the previewProgramDescriptorVersion field must be a positive integer");
        }
        if (!isLowerDigestHex(raw.previewProgramDescriptorIdentity)) {
            return rejection(
                "field-type-mismatch",
                "the previewProgramDescriptorIdentity field must be a canonical lowercase SHA-256 digest",
            );
        }
        const inputContracts = readPreviewInputContracts(raw.supportedPreviewInputContracts);
        if (!inputContracts.ok) {
            return rejection("field-type-mismatch", inputContracts.detail);
        }
        for (const field of [
            "previewPublicationSchemaVersion",
            "previewActivePublicationSchemaVersion",
            "previewObservationSchemaVersion",
        ] as const) {
            if (!isPositiveSafeInteger(raw[field])) {
                return rejection("field-type-mismatch", `the ${field} field must be a positive integer`);
            }
        }
        const diagnostics = readDiagnosticArray(raw.diagnostics);
        if (!diagnostics.ok) {
            return rejection("diagnostics-malformed", diagnostics.detail);
        }
        return {
            status: "read",
            document: {
                command: "describe-preview",
                success: true,
                status: "ok",
                exitCode: raw.exitCode,
                processContractVersion: raw.processContractVersion,
                previewBuildContractVersion: raw.previewBuildContractVersion,
                compilePolicyRevision: raw.compilePolicyRevision,
                toolIdentity: raw.toolIdentity as string,
                toolVersion: raw.toolVersion as string,
                producerKind: raw.producerKind as string,
                producerIdentity: raw.producerIdentity as string,
                supportedTargets: raw.supportedTargets as readonly string[],
                previewProgramDescriptorVersion: raw.previewProgramDescriptorVersion,
                previewProgramDescriptorIdentity: raw.previewProgramDescriptorIdentity,
                supportedPreviewInputContracts: inputContracts.contracts,
                previewPublicationSchemaVersion: raw.previewPublicationSchemaVersion as number,
                previewActivePublicationSchemaVersion: raw.previewActivePublicationSchemaVersion as number,
                previewObservationSchemaVersion: raw.previewObservationSchemaVersion as number,
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
                `a failed Preview handshake must not carry the success-only field "${field}"`,
            );
        }
    }
    if (typeof raw.status !== "string" || !FAILURE_STATUSES.includes(raw.status as PreviewHandshakeFailureStatus)) {
        return rejection("status-outside-vocabulary", "the failed Preview handshake carries an unknown status");
    }
    const diagnostics = readDiagnosticArray(raw.diagnostics);
    if (!diagnostics.ok || diagnostics.diagnostics.length === 0) {
        return rejection(
            "diagnostics-malformed",
            diagnostics.ok ? "a failed Preview handshake carries at least one diagnostic" : diagnostics.detail,
        );
    }
    return {
        status: "read",
        document: {
            command: "describe-preview",
            success: false,
            status: raw.status as PreviewHandshakeFailureStatus,
            exitCode: raw.exitCode,
            processContractVersion: raw.processContractVersion,
            previewBuildContractVersion: raw.previewBuildContractVersion,
            diagnostics: diagnostics.diagnostics,
        },
    };
}
