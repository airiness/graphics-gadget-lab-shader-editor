/**
 * The NativeCompileRequest value and the build-intent / build-id axis —
 * three identity concepts, not one (design authority: the toolchain
 * integration design, sections 8 and 11):
 *
 * - GeneratedSourceIdentity — the SHA-256 of the exact emitted bytes:
 *   the core's durable CONTENT identity (carried here, owned there);
 * - BuildIntent — the semantic identity of the compile request:
 *   sourceIdentity + target + stage/entry + the descriptor-contract
 *   inputs (defines/includes) + the relevant proven tool facts
 *   (identity, version, process-contract axis, producer identity) —
 *   everything that actually affects what the tool compiles;
 * - BuildId — the identity of ONE concrete asynchronous attempt
 *   (session-local, ordered); who came later, when two attempts share
 *   an intent.
 *
 * Same source bytes under a different target (or stage, or proven tool
 * facts) is a DIFFERENT intent; two attempts within one intent are
 * ordered by BuildId. This creates no new persisted identity: both are
 * session-local structured data.
 *
 * The request is a VALUE — same semantic compile request, same request
 * value — and no argv exists anywhere on this side of the boundary:
 * argument arrays are the host serialization's business.
 */
import type { ToolFacts } from "./contract-facts.js";
import { isDigestHex } from "./strict-json.js";

export interface CompileDefine {
    readonly name: string;
    readonly value: string;
}

/**
 * The domain-shaped compile request, composed at the editor's
 * composition point from facts with exactly one source each (design
 * section 8): target from the explicit build configuration, stage/entry
 * from the descriptor's generated-function facts, defines/includes from
 * the descriptor contract (empty for the frozen v2 profile — the slots
 * exist), source from the staged emission (bytes + the core's identity).
 */
export interface NativeCompileRequest {
    readonly source: Uint8Array;
    readonly sourceIdentity: string;
    readonly target: string;
    readonly stage: string;
    readonly entry: string;
    readonly defines: readonly CompileDefine[];
    readonly includes: readonly string[];
}

export type RequestWellFormed =
    | { readonly ok: true }
    | { readonly ok: false; readonly reason: string; readonly detail: string };

function sortedByName(defines: readonly CompileDefine[]): boolean {
    for (let index = 1; index < defines.length; index += 1) {
        const previous = defines[index - 1];
        const current = defines[index];
        if (previous === undefined || current === undefined) {
            return false;
        }
        if (previous.name >= current.name) {
            return false;
        }
    }
    return true;
}

/**
 * Shape discipline for the allowlisted request: well-formedness is
 * checked explicitly, and every refusal names its side. This is the
 * client's reading of the request value the editor composed — no policy,
 * no argv, no prose.
 */
export function isWellFormedRequest(request: NativeCompileRequest): RequestWellFormed {
    if (!(request.source instanceof Uint8Array)) {
        return { ok: false, reason: "source", detail: "the source must be the exact emitted bytes" };
    }
    if (!isDigestHex(request.sourceIdentity)) {
        return {
            ok: false,
            reason: "sourceIdentity",
            detail: "the source identity must be a 64-character hex digest of the exact bytes",
        };
    }
    for (const field of ["target", "stage", "entry"] as const) {
        if (typeof request[field] !== "string" || request[field].length === 0) {
            return { ok: false, reason: field, detail: `the ${field} must be a non-empty wire name` };
        }
    }
    if (request.defines.length > 0) {
        for (const define of request.defines) {
            if (typeof define.name !== "string" || define.name.length === 0 || typeof define.value !== "string") {
                return { ok: false, reason: "defines", detail: "a define carries a non-empty name and a string value" };
            }
        }
        if (!sortedByName(request.defines)) {
            return { ok: false, reason: "defines", detail: "defines must be sorted by name with no duplicates" };
        }
    }
    for (const include of request.includes) {
        if (typeof include !== "string" || include.length === 0) {
            return { ok: false, reason: "includes", detail: "an include must be a non-empty string" };
        }
    }
    return { ok: true };
}

/**
 * The value-level identity of a request: canonical (sorted defines and
 * includes, stable fields, no argument array). Two requests with the
 * same canonical form and the same bytes are the same request value.
 */
export interface CanonicalCompileForm {
    readonly sourceIdentity: string;
    readonly target: string;
    readonly stage: string;
    readonly entry: string;
    readonly defines: readonly CompileDefine[];
    readonly includes: readonly string[];
}

export function canonicalFormOf(request: NativeCompileRequest): CanonicalCompileForm {
    const wellFormed = isWellFormedRequest(request);
    if (wellFormed.ok !== true) {
        throw new Error(`the request is not well-formed: ${wellFormed.reason} — ${wellFormed.detail}`);
    }
    return {
        sourceIdentity: request.sourceIdentity,
        target: request.target,
        stage: request.stage,
        entry: request.entry,
        defines: request.defines.map((define) => ({ name: define.name, value: define.value })),
        includes: [...request.includes],
    };
}

/** Same semantic compile request → same request value. */
export function requestsEqual(a: NativeCompileRequest, b: NativeCompileRequest): boolean {
    let formA: CanonicalCompileForm;
    let formB: CanonicalCompileForm;
    try {
        formA = canonicalFormOf(a);
        formB = canonicalFormOf(b);
    } catch {
        return false;
    }
    if (
        formA.sourceIdentity !== formB.sourceIdentity ||
        formA.target !== formB.target ||
        formA.stage !== formB.stage ||
        formA.entry !== formB.entry
    ) {
        return false;
    }
    if (formA.defines.length !== formB.defines.length) {
        return false;
    }
    for (let index = 0; index < formA.defines.length; index += 1) {
        const left = formA.defines[index];
        const right = formB.defines[index];
        if (left === undefined || right === undefined || left.name !== right.name || left.value !== right.value) {
            return false;
        }
    }
    if (formA.includes.length !== formB.includes.length) {
        return false;
    }
    for (let index = 0; index < formA.includes.length; index += 1) {
        if (formA.includes[index] !== formB.includes[index]) {
            return false;
        }
    }
    return bytesEqual(a.source, b.source);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) {
            return false;
        }
    }
    return true;
}

/** The proven tool facts relevant to what the tool compiles (design
 *  section 8): everything the verdicts established under a contract the
 *  client supports. */
export interface ProvenToolFacts {
    readonly identity: string;
    readonly version: string;
    readonly processContractVersion: number;
    readonly producerIdentity: string;
}

export function provenToolFactsOf(facts: ToolFacts): ProvenToolFacts {
    return {
        identity: facts.toolIdentity,
        version: facts.toolVersion,
        processContractVersion: facts.processContractVersion,
        producerIdentity: facts.producerIdentity,
    };
}

/**
 * The semantic identity of the compile request. A result can be
 * `current` only for the CURRENT BuildIntent — intent match, not merely
 * the source bytes: the same bytes under a different target, stage, or
 * different proven tool facts is a DIFFERENT intent.
 */
export interface BuildIntent {
    readonly sourceIdentity: string;
    readonly target: string;
    readonly stage: string;
    readonly entry: string;
    readonly defines: readonly CompileDefine[];
    readonly includes: readonly string[];
    readonly tool: ProvenToolFacts;
}

/** Precondition: the request is well-formed (the gate admitted it). */
export function buildIntentOf(request: NativeCompileRequest, facts: ToolFacts): BuildIntent {
    return {
        ...canonicalFormOf(request),
        tool: provenToolFactsOf(facts),
    };
}

/** Intents are compared structurally — a changed proven producer
 *  identity under the same tool version is a DIFFERENT intent. */
export function buildIntentsEqual(a: BuildIntent, b: BuildIntent): boolean {
    if (
        a.sourceIdentity !== b.sourceIdentity ||
        a.target !== b.target ||
        a.stage !== b.stage ||
        a.entry !== b.entry ||
        a.defines.length !== b.defines.length
    ) {
        return false;
    }
    for (let index = 0; index < a.defines.length; index += 1) {
        const left = a.defines[index];
        const right = b.defines[index];
        if (left === undefined || right === undefined || left.name !== right.name || left.value !== right.value) {
            return false;
        }
    }
    if (a.includes.length !== b.includes.length) {
        return false;
    }
    for (let index = 0; index < a.includes.length; index += 1) {
        if (a.includes[index] !== b.includes[index]) {
            return false;
        }
    }
    const toolA = a.tool;
    const toolB = b.tool;
    return (
        toolA.identity === toolB.identity &&
        toolA.version === toolB.version &&
        toolA.processContractVersion === toolB.processContractVersion &&
        toolA.producerIdentity === toolB.producerIdentity
    );
}

/** The identity of ONE concrete asynchronous attempt: session-local and
 *  ordered — the ordering axis when two attempts share an intent. */
export interface BuildId {
    readonly sequence: number;
}

/** Issues the next session-local BuildId after the current line. */
export function nextBuildId(line: ReadonlyArray<{ readonly buildId: BuildId }>): BuildId {
    let highest = 0;
    for (const record of line) {
        if (record.buildId.sequence > highest) {
            highest = record.buildId.sequence;
        }
    }
    return { sequence: highest + 1 };
}
