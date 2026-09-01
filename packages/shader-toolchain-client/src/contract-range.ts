/**
 * The client's own range discipline over the process-contract version
 * axis — the axis the handshake (describe) document versioning rides.
 *
 * The client DECLARES the published contract versions it supports (exactly
 * one place: the declaration module). An observed axis outside the
 * declared range is explicitly unsupported — never silently accepted,
 * never silently reinterpreted. The axis is independent of the tool
 * version: the same tool can be version-compatible while its contract
 * axis is outside the client's declared range, and that is a separate,
 * visible verdict.
 */
import {
    clientSupportedContractRange,
    type SupportedContractRange,
} from "./contract-range-declaration.js";

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
 * range. The range defaults to the client's own declaration and may be
 * supplied explicitly — the tests exercise the null-declaration world and
 * declared ranges on both inclusive bounds; the product path always runs
 * on the declaration.
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
