import type { EnvironmentImportEvent } from "@gglab/shader-toolchain-client";
import type { EditorOutput } from "./editor-output.js";
import { EMPTY_EVIDENCE_CORRELATION, type ProblemSnapshotEntry } from "./panel-vocabulary.js";

/** Session evidence only: clearing Output never changes the latest settled Environment problem. */
export class EnvironmentEvidence {
    private attempt = 0;
    private entries: readonly ProblemSnapshotEntry[] = [];
    private listeners = new Set<() => void>();
    constructor(private readonly output: EditorOutput) {}
    getSnapshot = (): readonly ProblemSnapshotEntry[] => this.entries;
    subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
    begin = (): ((event: EnvironmentImportEvent) => void) => {
        const attempt = ++this.attempt;
        return event => {
            const diagnostic = event.diagnostic;
            this.output.append("environment", diagnostic ? "refusal" : "info", `Environment ${event.phase}: ${event.environmentRoot}${diagnostic ? ": " + diagnostic.message : ""}`, EMPTY_EVIDENCE_CORRELATION, diagnostic ? [diagnostic] : []);
            if (event.phase !== "settled" || attempt !== this.attempt) return;
            this.entries = diagnostic ? [{
                identity: JSON.stringify(["environment", attempt, event.environmentRoot, diagnostic.code, diagnostic.dataPath]),
                severity: diagnostic.severity, code: diagnostic.code, text: diagnostic.message,
                location: { kind: "environment", root: event.environmentRoot, dataPath: diagnostic.dataPath },
                correlation: EMPTY_EVIDENCE_CORRELATION,
            }] : [];
            for (const listener of this.listeners) listener();
        };
    };
}
