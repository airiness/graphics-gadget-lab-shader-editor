/**
 * Client declarations for the independently versioned Preview surfaces.
 * These values consume the contracts published by GraphicsGadgetLab; they
 * do not define or extend those contracts.
 */
import type { SupportedContractRange } from "./contract-range-declaration.js";

export const clientSupportedPreviewBuildContractRange: SupportedContractRange = {
    minimum: 1,
    maximum: 1,
} as const;

export const clientSupportedPreviewProgramDescriptorRange: SupportedContractRange = {
    minimum: 1,
    maximum: 1,
} as const;

export const clientSupportedPreviewPublicationSchemaRange: SupportedContractRange = {
    minimum: 1,
    maximum: 1,
} as const;

export const clientSupportedPreviewActivePublicationSchemaRange: SupportedContractRange = {
    minimum: 1,
    maximum: 1,
} as const;

export const clientSupportedPreviewObservationSchemaRange: SupportedContractRange = {
    minimum: 1,
    maximum: 1,
} as const;
