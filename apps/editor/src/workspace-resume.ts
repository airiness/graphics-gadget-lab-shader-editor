import type { WorkspaceAuthoringState } from "./workspace-store.js";
import type { WorkspaceSession } from "./workspace-session.js";

export interface WorkspaceResume {
    readonly workspaceUri: string;
    readonly documentUris: readonly string[];
    readonly activeUri: string | null;
    readonly previewUri: string | null;
    readonly environmentId: string | null;
    readonly buildTarget: string;
}
export function readWorkspaceResume(value: unknown): WorkspaceResume {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected Workspace resume intent.");
    const r = value as Record<string, unknown>;
    const uris: unknown[] | null = Array.isArray(r.documentUris) ? r.documentUris : null;
    const fields = ["workspaceUri", "documentUris", "activeUri", "previewUri", "environmentId", "buildTarget"];
    const text = (v: unknown, limit: number): v is string => typeof v === "string" && v.length > 0 && v.length <= limit;
    if (Object.keys(r).length !== fields.length || Object.keys(r).some(key => !fields.includes(key)) ||
        !text(r.workspaceUri, 8192) || uris === null || uris.length > 32 || !uris.every(uri => text(uri, 8192)) ||
        new Set(uris).size !== uris.length ||
        ![r.activeUri, r.previewUri].every(uri => uri === null || (typeof uri === "string" && uris.includes(uri))) ||
        !(r.environmentId === null || text(r.environmentId, 128)) || !text(r.buildTarget, 128)) throw new Error("Invalid Workspace resume intent.");
    return { workspaceUri: r.workspaceUri, documentUris: uris as string[], activeUri: r.activeUri as string | null,
        previewUri: r.previewUri as string | null, environmentId: r.environmentId, buildTarget: r.buildTarget };
}
export function projectWorkspaceResume(session: WorkspaceSession, buildTarget: string): WorkspaceResume | null {
    if (session.workspaceRoot === null) return null;
    return { workspaceUri: session.workspaceRoot.canonicalWorkspaceUri,
        documentUris: session.documents.flatMap(doc => doc.canonicalUri === null ? [] : [doc.canonicalUri]),
        activeUri: session.documents.find(doc => doc.sessionId === session.activeDocumentId)?.canonicalUri ?? null,
        previewUri: session.documents.find(doc => doc.sessionId === session.preview.targetDocumentId)?.canonicalUri ?? null,
        environmentId: session.activeEnvironment?.environmentId ?? null, buildTarget };
}
/** Evidence recomputation is not an edit. Environment activation clears emissions
 * while retaining document owners, histories, file baselines and tab identities. */
export function sameResumeContext(before: WorkspaceAuthoringState, after: WorkspaceAuthoringState, allowEnvironmentChange = false): boolean {
    const a = before.session, b = after.session;
    return a.workspaceRoot === b.workspaceRoot && a.activeDocumentId === b.activeDocumentId &&
        a.preview.targetDocumentId === b.preview.targetDocumentId &&
        (allowEnvironmentChange || a.activeEnvironment === b.activeEnvironment) &&
        a.documents.length === b.documents.length && a.documents.every((doc, index) => {
            const next = b.documents[index]!;
            return doc.sessionId === next.sessionId && doc.history === next.history &&
                doc.canonicalUri === next.canonicalUri && doc.fileRevisionToken === next.fileRevisionToken &&
                doc.savedBaseline === next.savedBaseline && doc.provenance === next.provenance;
        });
}
export interface WorkspaceResumeHost {
    readWorkspaceResume(uri: string): Promise<WorkspaceResume | null>;
    saveWorkspaceResume(intent: WorkspaceResume): Promise<void>;
}

/** Loading establishes a baseline; it never writes empty startup tabs over saved intent. */
export function bindWorkspaceResume(host: WorkspaceResumeHost, initial: WorkspaceResume, loaded: (intent: WorkspaceResume | null) => void, report: (error: unknown) => void) {
    let current = initial, last = JSON.stringify(initial), ready = false, disposed = false, paused = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, writes = Promise.resolve();
    const flush = () => {
        if (!ready || paused) return;
        const value = current, ticket = generation;
        writes = writes.then(async () => {
            if (ticket !== generation || paused || JSON.stringify(value) === last) return;
            try { await host.saveWorkspaceResume(readWorkspaceResume(value)); last = JSON.stringify(value); }
            catch (error) { report(error); }
        });
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(flush, 200); };
    const loading = host.readWorkspaceResume(initial.workspaceUri).then(value => {
        if (disposed) return;
        ready = true; loaded(value);
        if (JSON.stringify(current) !== last) schedule();
    }).catch(error => { if (!disposed) report(error); });
    return {
        loading,
        observe(value: WorkspaceResume) { if (disposed || value.workspaceUri !== initial.workspaceUri) return; current = value; if (ready && !paused) schedule(); },
        pause() { paused = true; generation++; clearTimeout(timer); return writes; },
        resume(baseline: WorkspaceResume) { current = baseline; last = JSON.stringify(baseline); paused = false; if (!disposed) schedule(); },
        async dispose() { disposed = true; clearTimeout(timer); flush(); await writes; },
    };
}
