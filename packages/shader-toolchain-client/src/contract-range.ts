/**
 * The client's own range discipline over the process-contract version
 * axis — the axis the handshake (describe) document versioning rides.
 *
 * The client DECLARES the published contract versions it supports. A
 * contract outside that range is explicitly unsupported — never silently
 * accepted, never silently reinterpreted. Until the client supports a
 * published handshake contract its supported set is empty, and that is why
 * today every real tool stays discovered-but-unproven: a visible,
 * explainable state of the world, not a missing feature to paper over.
 */
import { clientSupportedContractRange } from "./contract-range-declaration.js";

/**
 * An inclusive range of supported process-contract versions. Both bounds
 * are the contract axis value itself (a safe integer version, independent
 * of the tool version).
 */
export interface SupportedContractRange {
    readonly minimum: number;
    readonly maximum: number;
}

export type ContractSupportVerdict =
    | {
        readonly supported: true;
        readonly observedVersion: number;
        readonly range: SupportedContractRange;
      }
    | {
        readonly supported: false;
        readonly reason: "no-supported-contract-declared";
        readonly observedVersion: number;
      }
    | {
        readonly supported: false;
        readonly reason: "observed-version-outside-range";
        readonly observedVersion: number;
        readonly range: SupportedContractRange;
      };

/**
 * Judges an observed process-contract version against a declared supported
 * range. The range defaults to the client's own declaration (today: empty,
 * so every observation is explicitly unsupported) and may be supplied
 * explicitly — the tests exercise the future non-empty path against the
 * declared range shape, and the product path always runs on the
 * declaration.
 *
 * This axis is independent of the tool version: the same tool can be
 * version-compatible while its contract axis is outside the client's
 * supported range, and that is a separate, visible verdict.
 */
export function judgeContractSupport(
    observedVersion: number,
    range: SupportedContractRange | null = clientSupportedContractRange,
): ContractSupportVerdict {
    if (range === null) {
        return { supported: false, reason: "no-supported-contract-declared", observedVersion };
    }
    if (observedVersion >= range.minimum && observedVersion <= range.maximum) {
        return { supported: true, observedVersion, range };
    }
    return {
        supported: false,
        reason: "observed-version-outside-range",
        observedVersion,
        range,
    };
}
