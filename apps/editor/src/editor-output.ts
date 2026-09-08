import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { EMPTY_EVIDENCE_CORRELATION, type OutputEvent, type EvidenceCorrelation } from "./panel-vocabulary.js";

export interface EditorOutputEvent extends OutputEvent {
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    readonly category: "authoring" | "workspace" | "discovery" | "document" | "environment";
    readonly level: "ok" | "info" | "refusal";
}

/** Session-local presentation history. Clear never calls a domain owner and
 * sequence numbers never repeat, including after clearing the view. */
export class EditorOutput {
    private entries: readonly EditorOutputEvent[] = [];
    private sequence = 0;
    private listeners = new Set<() => void>();

    getSnapshot = (): readonly EditorOutputEvent[] => this.entries;
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    append = (
        category: EditorOutputEvent["category"],
        level: EditorOutputEvent["level"],
        text: string,
        correlation: EvidenceCorrelation = EMPTY_EVIDENCE_CORRELATION,
        diagnostics: readonly ShaderGraphDiagnostic[] = [],
    ): void => {
        this.entries = [...this.entries, { sequence: ++this.sequence, category, level, text, correlation, diagnostics }];
        this.publish();
    };
    clear = (): void => {
        this.entries = [];
        this.publish();
    };
    private publish(): void {
        for (const listener of this.listeners) listener();
    }
}
