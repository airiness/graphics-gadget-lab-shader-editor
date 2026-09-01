/**
 * The client's declaration of the published handbook contracts it
 * supports — the single authority for the supported range, and for the
 * compile-policy value it supports.
 *
 * Process contract v2 is the published form the client consumes (docs
 * authority: GGLab_Shader_Toochain_Extraction.md §22.1, v2 published
 * 2026-08 by main-repo commit 993b2c2): the v1 field set plus the
 * `compilePolicyRevision` required success-only field, under axis 2.
 * The client's strict reader for that published form is complete and
 * tested — so the client declares exactly that axis: 2 through 2.
 *
 * The declaration policy (docs §22.1.4, Owner decision P4): declare
 * ONLY the currently published axis, exactly. This client does NOT
 * declare 1..2: the contract defines no legacy mapping for a v1
 * document's absent `compilePolicyRevision`, and no consumer may
 * invent one. Consuming a published contract, never defining one —
 * when a real old-tool compatibility need appears, the contract
 * authority publishes the mapping first, and this declaration gains it.
 *
 * A process-contract axis OUTSIDE this declaration is explicitly
 * unsupported — never silently accepted, never silently reinterpreted —
 * and the state ladder shows exactly that: unproven when the client
 * declares no range at all, incompatible when the client declares a
 * range and the observed axis lies outside it.
 *
 * The COMPILE-POLICY axis is the toolchain's own lowering /
 * argument-generation policy version (docs §22.1.1, R5): it is a
 * consumer-must-participate compatibility fact (verdict + BuildIntent
 * identity), independent of the tool version, the process-contract
 * axis, and the producer identity. The client declares the one value
 * it supports — the current published value 1 — as a 1..1 range.
 */

/** An inclusive range of supported contract-axis versions. Both bounds
 *  are the axis value itself (a safe integer version, independent of
 *  the tool version). */
export interface SupportedContractRange {
    readonly minimum: number;
    readonly maximum: number;
}

/** The process-contract versions the client declares it supports: the
 *  published machine process contract v2 (document format + status
 *  vocabulary + exit-code mapping + channel rules + the required
 *  `compilePolicyRevision` success-only field). `null` — the explicit
 *  "declares none" state — remains a legal judgment input for tests and
 *  for the pre-publication world; the declaration itself is never empty.
 */
export const clientSupportedContractRange: SupportedContractRange = {
    minimum: 2,
    maximum: 2,
} as const;

/** The compile-policy revisions the client supports: exactly the
 *  currently published value 1 (docs §22.1.3: current normative value
 *  1). A value outside this range is an explicit compatibility
 *  mismatch — never silently accepted, never reinterpreted. This
 *  declaration exists because the contract (R5) makes the field a
 *  consumer-verdict fact; the value set remains the toolchain's own
 *  axis, consumed here, not defined here. */
export const clientSupportedCompilePolicyRange: SupportedContractRange = {
    minimum: 1,
    maximum: 1,
} as const;
