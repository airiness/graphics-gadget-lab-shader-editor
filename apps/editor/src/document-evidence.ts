import { DocumentEvidenceOrigin } from "./document-session.js";
export { DocumentEvidenceOrigin, isDocumentEvidenceOrigin } from "./document-session.js";
/** Capture all provenance coordinates atomically from one document owner. */
export const captureDocumentEvidence = DocumentEvidenceOrigin.capture;
