/**
 * The client's declaration of the published handshake contracts it
 * supports — the single authority for the supported range.
 *
 * Declared EMPTY today: no published handshake contract is in the client's
 * supported set yet. With an empty declaration, a tool whose
 * process-contract axis is any version stays discovered-but-unproven and
 * may not enter the compile path: a visible state of the world, not a gap.
 * When the toolchain extends or publishes a contract through its own
 * review, this declaration gains that range and the strict readers stay
 * the consumption side — consumption of a published contract, never a
 * definition of one.
 */

const NO_SUPPORTED_CONTRACTS: null = null;

/** The process-contract versions the client declares it supports.
 *  `null` is the explicit "declares none" state — never an empty range
 *  that might read as "supports version 0". */
export const clientSupportedContractRange: null = NO_SUPPORTED_CONTRACTS;
