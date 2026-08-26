/**
 * The process-level (channel) readers — the client's interpretation of
 * the machine process contract BELOW the document level.
 *
 * The host owns bounded execution and reports raw execution facts
 * (stdout bytes, stderr bytes, exit code, timeout, cancel). This module
 * owns what those facts MEAN under the contract, before any document is
 * trusted:
 *
 * - `canceled`  — an explicit terminal state; nothing is interpreted
 *   (neither a document nor a channel fact);
 * - `timed-out` — bounded execution terminated the attempt; the document
 *   surface is untrusted;
 * - `channel-violated` — a channel rule the process contract defines is
 *   broken: stderr is non-empty (the contract leaves it empty), the
 *   stdout bytes are not valid UTF-8, or the process exit code does not
 *   match the intact document's own exit code;
 * - `read` / `unsupported-contract` / `rejected` — the document-level
 *   reading, reached only when the channel is clean.
 *
 * This is the step that keeps the channel contract out of the editor:
 * the editor composes states from OUTCOMES (canceled / timed-out /
 * channel-violated / read / unsupported / rejected), never from raw
 * stream or exit-code checks of its own.
 */
import type { BoundaryOutput } from "./host-boundary.js";
import type { SupportedContractRange } from "./contract-range-declaration.js";
import { clientSupportedContractRange } from "./contract-range-declaration.js";
import type { ContractSupportVerdict } from "./contract-range.js";
import { readHandshakeDocument } from "./handshake-document.js";
import {
    readCompileDocument,
    type CompileDocument,
    type CompileRejection,
} from "./result-envelope.js";
import type {
    HandshakeDocument,
    HandshakeRejection,
} from "./handshake-document.js";
import { utf8Decode } from "./utf8.js";

/** A broken channel rule, with the side and the observed values
 *  structured — never prose only. */
export type ChannelViolation =
    | { readonly reason: "stderr-non-empty"; readonly byteLength: number }
    | { readonly reason: "stdout-not-valid-utf8"; readonly detail: string }
    | {
        readonly reason: "exit-code-mismatch";
        readonly documentExitCode: number;
        readonly processExitCode: number;
      };

/** The process-level outcome of a handshake call. `canceled` and
 *  `timed-out` are terminal and win over every interpretation; the
 *  document-level outcomes are reached only over a clean channel. */
export type HandshakeProcessOutcome =
    | { readonly kind: "canceled" }
    | { readonly kind: "timed-out" }
    | { readonly kind: "channel-violated"; readonly violation: ChannelViolation }
    | { readonly kind: "read"; readonly document: HandshakeDocument }
    | { readonly kind: "unsupported-contract"; readonly contract: ContractSupportVerdict }
    | { readonly kind: "rejected"; readonly rejection: HandshakeRejection };

/** The process-level outcome of a compile call (the result envelope has
 *  no axis of its own, so no axis-gate outcome appears here). */
export type CompileProcessOutcome =
    | { readonly kind: "canceled" }
    | { readonly kind: "timed-out" }
    | { readonly kind: "channel-violated"; readonly violation: ChannelViolation }
    | { readonly kind: "read"; readonly document: CompileDocument }
    | { readonly kind: "rejected"; readonly rejection: CompileRejection };

/**
 * Reads one handshake attempt's boundary output under the machine
 * process contract: terminal states first, then channel discipline
 * (stderr empty, stdout valid UTF-8), then the document-level reading,
 * then the exit-code consistency fact (the intact document's own exit
 * code must equal the process exit code the host observed). The support
 * gate runs on the client's declared range by default; the
 * null-declaration world is reachable by passing `null`.
 */
export function readHandshakeOutput(
    output: BoundaryOutput,
    range: SupportedContractRange | null = clientSupportedContractRange,
): HandshakeProcessOutcome {
    if (output.canceled) {
        return { kind: "canceled" };
    }
    if (output.timedOut) {
        return { kind: "timed-out" };
    }
    if (output.stderr.byteLength !== 0) {
        return {
            kind: "channel-violated",
            violation: { reason: "stderr-non-empty", byteLength: output.stderr.byteLength },
        };
    }
    const decoded = utf8Decode(output.stdout);
    if (decoded.ok !== true) {
        return {
            kind: "channel-violated",
            violation: { reason: "stdout-not-valid-utf8", detail: decoded.detail },
        };
    }

    const read = readHandshakeDocument(decoded.text, range);
    if (read.status === "read") {
        const document = read.document;
        if (document.exitCode !== output.exitCode) {
            return {
                kind: "channel-violated",
                violation: {
                    reason: "exit-code-mismatch",
                    documentExitCode: document.exitCode,
                    processExitCode: output.exitCode,
                },
            };
        }
        return { kind: "read", document };
    }
    if (read.status === "unsupported-contract") {
        return { kind: "unsupported-contract", contract: read.contract };
    }
    return { kind: "rejected", rejection: read.rejection };
}

/**
 * Reads one compile attempt's boundary output under the same process-
 * level contract. The result envelope has no process-contract axis of
 * its own, so there is no axis gate here — the channel discipline and
 * the document-level rules apply the same way.
 */
export function readCompileOutput(output: BoundaryOutput): CompileProcessOutcome {
    if (output.canceled) {
        return { kind: "canceled" };
    }
    if (output.timedOut) {
        return { kind: "timed-out" };
    }
    if (output.stderr.byteLength !== 0) {
        return {
            kind: "channel-violated",
            violation: { reason: "stderr-non-empty", byteLength: output.stderr.byteLength },
        };
    }
    const decoded = utf8Decode(output.stdout);
    if (decoded.ok !== true) {
        return {
            kind: "channel-violated",
            violation: { reason: "stdout-not-valid-utf8", detail: decoded.detail },
        };
    }

    const read = readCompileDocument(decoded.text);
    if (read.status === "read") {
        const document = read.document;
        if (document.exitCode !== output.exitCode) {
            return {
                kind: "channel-violated",
                violation: {
                    reason: "exit-code-mismatch",
                    documentExitCode: document.exitCode,
                    processExitCode: output.exitCode,
                },
            };
        }
        return { kind: "read", document };
    }
    return { kind: "rejected", rejection: read.rejection };
}
