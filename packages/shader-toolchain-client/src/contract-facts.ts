/**
 * The plain value vocabulary the client owns over the toolchain's
 * machine contract: the tool requirement it is judged against, the facts
 * a handshake must establish, and the structured diagnostics a result
 * carries.
 *
 * These are plain values, not wire documents: the strict readers
 * (handshake-document, result-envelope) produce and consume them, the
 * verdicts judge them, and the editor composition maps descriptor- and
 * tool-side facts into them. The client contains no argv type anywhere —
 * argument arrays exist only inside the host boundary the service
 * implements — and it never imports @gglab/shader-graph-core types: the
 * editor is the single composition point where their worlds may meet.
 */

/**
 * The tool requirement as the client receives it. The editor composition
 * maps the profile descriptor's process contract (identity, minimum
 * version, comparison rule) into this plain shape; the client never
 * understands the descriptor's own type surface.
 */
export interface ToolRequirement {
    /** The tool identity the profile requires — required by the descriptor,
     *  never picked by the client. */
    readonly identity: string;
    /** The minimum tool version, judged under the declared comparison rule. */
    readonly minimumVersion: string;
    /** The comparison rule name the requirement declares; "semver" is the
     *  only rule the client implements, and any other name is an explicit
     *  refusal, never a guess. */
    readonly versionComparison: string;
}

/** Two requirements are the same when their judgment inputs agree
 *  structurally: the requirement is a value, and identity, minimum
 *  version, and comparison rule are all of it. A re-statement with the
 *  same value changed nothing; a requirement that differs is a NEW
 *  judgment input (the verdicts taken under the old one are void). */
export function requirementsEqual(a: ToolRequirement, b: ToolRequirement): boolean {
    return a.identity === b.identity && a.minimumVersion === b.minimumVersion && a.versionComparison === b.versionComparison;
}

/**
 * A structured toolchain diagnostic carried verbatim from the published
 * envelope. It is a distinct layer from graph-native diagnostics: the
 * client preserves the tool's own message and location facts and never
 * rewrites, mines, or merges them.
 */
export interface ToolDiagnostic {
    readonly message: string;
    /** The tool's own location fact (generated-source identity) when the
     *  tool reports one. */
    readonly sourceIdentity?: string;
}

/**
 * The verdict facts a handshake must establish (the required facts of
 * the published contract, held as plain values):
 *
 * - the tool's identity,
 * - the tool's version,
 * - the process-contract version axis,
 * - the compile-policy revision axis (v2+, required on the success
 *   document — a consumer-must-participate compatibility fact: it
 *   enters the verdict AND the BuildIntent identity),
 * - the producer/compiler identity,
 * - the tool's published supported targets (a tool FACT — whether a
 *   CONFIGURED target is among them is judged by the editor composition,
 *   which is where the configuration lives).
 *
 * The artifact contract axis is not part of the verdict facts: it enters
 * only when the editor genuinely consumes a versioned artifact contract.
 * `binaryPath`, `binaryHash`, and `cacheRecordPath` are result evidence
 * carried by the compile envelope, not handshake requirements.
 */
export interface ToolFacts {
    readonly toolIdentity: string;
    readonly toolVersion: string;
    readonly processContractVersion: number;
    readonly compilePolicyRevision: number;
    readonly producerKind: string;
    readonly producerIdentity: string;
    readonly supportedTargets: readonly string[];
}
