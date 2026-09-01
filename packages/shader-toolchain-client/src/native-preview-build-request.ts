/**
 * The Editor-owned value for one live Preview build attempt.
 *
 * It carries Preview intent and identities only. Adapter selection, PSMain,
 * compiler policy, staging paths, artifact paths, registry composition, and
 * argv serialization remain main/toolchain or host-boundary responsibilities.
 */
import { isIntegralNumber, isLowerDigestHex } from "./strict-json.js";

export interface NativePreviewBuildRequest {
    readonly sessionId: string;
    readonly targetProfile: string;
    readonly profileId: string;
    readonly profileVersion: number;
    readonly previewInputContractId: string;
    readonly previewProgramDescriptorIdentity: string;
    readonly generatedSourceIdentity: string;
    readonly generatedSourceBytes: Uint8Array;
    /** Monotonically increasing within one session. The TypeScript client
     *  intentionally owns the positive safe-integer subset of wire u64. */
    readonly attemptSequence: number;
}

export type PreviewRequestWellFormed =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: keyof NativePreviewBuildRequest; readonly detail: string };

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/** The Preview coordination namespace is exactly one canonical 128-bit
 *  lowercase hexadecimal value. Export the predicate so editor session
 *  storage does not grow a second copy of the wire rule. */
export function isPreviewSessionId(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return isIntegralNumber(value) && value > 0;
}

export function isWellFormedPreviewBuildRequest(
    request: NativePreviewBuildRequest,
): PreviewRequestWellFormed {
    if (!isPreviewSessionId(request.sessionId)) {
        return {
            ok: false,
            reason: "sessionId",
            detail: "the session identity must be exactly 32 lowercase hexadecimal characters",
        };
    }
    for (const field of ["targetProfile", "profileId", "previewInputContractId"] as const) {
        if (!isNonEmptyString(request[field])) {
            return { ok: false, reason: field, detail: `the ${field} must be a non-empty wire name` };
        }
    }
    if (!isPositiveSafeInteger(request.profileVersion)) {
        return {
            ok: false,
            reason: "profileVersion",
            detail: "the profile version must be a positive safe integer",
        };
    }
    if (!isLowerDigestHex(request.previewProgramDescriptorIdentity)) {
        return {
            ok: false,
            reason: "previewProgramDescriptorIdentity",
            detail: "the Preview Program Descriptor identity must be a canonical lowercase SHA-256 digest",
        };
    }
    if (!isLowerDigestHex(request.generatedSourceIdentity)) {
        return {
            ok: false,
            reason: "generatedSourceIdentity",
            detail: "the generated source identity must be a canonical lowercase SHA-256 digest",
        };
    }
    if (!(request.generatedSourceBytes instanceof Uint8Array)) {
        return {
            ok: false,
            reason: "generatedSourceBytes",
            detail: "the generated source must be the exact emitted bytes",
        };
    }
    if (!isPositiveSafeInteger(request.attemptSequence)) {
        return {
            ok: false,
            reason: "attemptSequence",
            detail: "the attempt sequence must be a positive safe integer",
        };
    }
    return { ok: true };
}

export interface CanonicalPreviewBuildForm {
    readonly sessionId: string;
    readonly targetProfile: string;
    readonly profileId: string;
    readonly profileVersion: number;
    readonly previewInputContractId: string;
    readonly previewProgramDescriptorIdentity: string;
    readonly generatedSourceIdentity: string;
    readonly attemptSequence: number;
}

export function canonicalPreviewBuildFormOf(
    request: NativePreviewBuildRequest,
): CanonicalPreviewBuildForm {
    const wellFormed = isWellFormedPreviewBuildRequest(request);
    if (wellFormed.ok !== true) {
        throw new Error(`the Preview request is not well-formed: ${wellFormed.reason} — ${wellFormed.detail}`);
    }
    return {
        sessionId: request.sessionId,
        targetProfile: request.targetProfile,
        profileId: request.profileId,
        profileVersion: request.profileVersion,
        previewInputContractId: request.previewInputContractId,
        previewProgramDescriptorIdentity: request.previewProgramDescriptorIdentity,
        generatedSourceIdentity: request.generatedSourceIdentity,
        attemptSequence: request.attemptSequence,
    };
}

export function previewBuildRequestsEqual(
    left: NativePreviewBuildRequest,
    right: NativePreviewBuildRequest,
): boolean {
    let leftForm: CanonicalPreviewBuildForm;
    let rightForm: CanonicalPreviewBuildForm;
    try {
        leftForm = canonicalPreviewBuildFormOf(left);
        rightForm = canonicalPreviewBuildFormOf(right);
    } catch {
        return false;
    }
    for (const field of Object.keys(leftForm) as ReadonlyArray<keyof CanonicalPreviewBuildForm>) {
        if (leftForm[field] !== rightForm[field]) {
            return false;
        }
    }
    return bytesEqual(left.generatedSourceBytes, right.generatedSourceBytes);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}
