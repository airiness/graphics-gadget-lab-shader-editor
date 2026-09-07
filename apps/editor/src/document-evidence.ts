import { serializeShaderGraphDocument, type HlslEmission, type ShaderGraphDocument, type ShaderGraphSourceMap } from "@gglab/shader-graph-core";
import type { DocumentSessionId } from "./workspace-session.js";

/** Editor-owned provenance captured before asynchronous build admission.
 * Source equality alone never identifies an open document. */
export interface DocumentEvidenceOrigin {
    readonly documentSessionId: DocumentSessionId;
    readonly documentRevision: string;
    readonly sourceMap: ShaderGraphSourceMap;
}

export function captureDocumentEvidence(
    documentSessionId: DocumentSessionId | undefined,
    document: ShaderGraphDocument,
    emission: HlslEmission | null,
): DocumentEvidenceOrigin | null {
    if (documentSessionId === undefined || emission?.ok !== true || emission.sourceMap === null) {
        return null;
    }
    return {
        documentSessionId,
        documentRevision: serializeShaderGraphDocument(document),
        sourceMap: emission.sourceMap,
    };
}
