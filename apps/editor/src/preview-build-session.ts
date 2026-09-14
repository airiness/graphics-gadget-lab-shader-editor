/**
 * Editor-owned storage for one attached Preview session. The client package
 * supplies the pure attempt-line rules; this module remembers the line and
 * the next monotonic AttemptSequence for the lifetime of one SessionId.
 */
import {
    emptyPreviewBuildLine,
    isPreviewSessionId,
    issuePreviewAttempt,
    reportPreviewBuildLine,
    settlePreviewAttempt,
    type BuildId,
    type PreviewAttemptOutcome,
    type PreviewBuildIntent,
    type PreviewBuildLine,
    type PreviewBuildLineReport,
    type ToolCandidate,
} from "@gglab/shader-toolchain-client";
import { isDocumentEvidenceOrigin, type DocumentEvidenceOrigin } from "./document-evidence.js";

export interface PreviewBuildSession {
    readonly origins?: ReadonlyMap<BuildId["sequence"], DocumentEvidenceOrigin>;
    readonly sessionId: string;
    readonly line: PreviewBuildLine;
    readonly nextAttemptSequence: number;
}

export function createPreviewBuildSession(sessionId: string): PreviewBuildSession {
    if (!isPreviewSessionId(sessionId)) {
        throw new Error("a Preview session id must be exactly 32 lowercase hexadecimal characters");
    }
    return { sessionId, line: emptyPreviewBuildLine(), nextAttemptSequence: 1 };
}

export function previewSessionIssue(
    session: PreviewBuildSession,
    attemptSequence: number,
    buildId: BuildId,
    candidate: ToolCandidate,
    intent: PreviewBuildIntent,
    origin: DocumentEvidenceOrigin | null = null,
): PreviewBuildSession {
    if (attemptSequence !== session.nextAttemptSequence) {
        throw new Error(
            `Preview attempt sequence ${attemptSequence} is not the next sequence ${session.nextAttemptSequence}`,
        );
    }
    if (origin !== null && !isDocumentEvidenceOrigin(origin)) throw new Error("Invalid document evidence origin");
    if (origin !== null && origin.sourceMap.generatedSourceIdentity !== intent.generatedSourceIdentity) {
        throw new Error("Preview origin must name the admitted generated source");
    }
    const origins = new Map(session.origins);
    if (origin !== null) origins.set(buildId.sequence, origin);
    return {
        origins,
        sessionId: session.sessionId,
        line: issuePreviewAttempt(session.line, { attemptSequence, buildId, candidate, intent }),
        nextAttemptSequence: attemptSequence + 1,
    };
}

export function previewSessionSettle(
    session: PreviewBuildSession,
    attemptSequence: number,
    outcome: PreviewAttemptOutcome,
): PreviewBuildSession {
    return {
        ...session,
        line: settlePreviewAttempt(session.line, attemptSequence, outcome),
    };
}

export function previewSessionReport(session: PreviewBuildSession): PreviewBuildLineReport {
    return reportPreviewBuildLine(session.line);
}
