/**
 * The client's declaration of the published handshake contracts it
 * supports — the single authority for the supported range.
 *
 * The gglab-shaderc machine process contract v1 is published by the main
 * GGLab repository and the client's strict reader for that published form
 * is complete and tested — so the client declares exactly that axis: v1
 * through v1.
 *
 * A process-contract axis OUTSIDE this declaration (today: axis 2 or
 * later) is explicitly unsupported — never silently accepted, never
 * silently reinterpreted — and the state ladder shows exactly that:
 * unproven when the client declares no range at all, incompatible when
 * the client declares a range and the observed axis lies outside it.
 *
 * When the toolchain publishes or extends the contract through its own
 * review, this declaration gains the published range — consumption of a
 * published contract, never a definition of one.
 */

/** An inclusive range of supported process-contract versions. Both bounds
 *  are the contract axis value itself (a safe integer version, independent
 *  of the tool version). */
export interface SupportedContractRange {
    readonly minimum: number;
    readonly maximum: number;
}

/** The process-contract versions the client declares it supports: the
 *  published machine process contract v1 (document format + status
 *  vocabulary + exit-code mapping + channel rules). `null` — the explicit
 *  "declares none" state — remains a legal judgment input for tests and
 *  for the pre-publication world; the declaration itself is never empty. */
export const clientSupportedContractRange: SupportedContractRange = {
    minimum: 1,
    maximum: 1,
} as const;
