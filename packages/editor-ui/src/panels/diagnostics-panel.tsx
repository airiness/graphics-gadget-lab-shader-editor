/**
 * Diagnostics panel — renders the core's structured diagnostics verbatim
 * (stable code, severity, message, location). It adds no classification of
 * its own: the codes already carry the meaning.
 *
 * Navigation: when `onSelect` is provided, each entry is clickable and the
 * composition root resolves the entry's `dataPath` anchor to a canvas
 * target (`diagnosticFocus`) — the panel only forwards the selection
 * intent; it never computes a target itself.
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";
import { Badge } from "../components/ui/badge.js";

export interface DiagnosticsPanelProps {
    readonly title: string;
    /** Structured diagnostics (never an unstructured string list). */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    /** True when the related core verdict passed. */
    readonly ok: boolean;
    /** Shown when `ok` and there are no diagnostics. */
    readonly passedText: string;
    /** Optional: make entries clickable (diagnostic → canvas navigation). */
    readonly onSelect?: (diagnostic: ShaderGraphDiagnostic) => void;
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
    const selectable: boolean = props.onSelect !== undefined;
    return (
        <section className={`gglab-diagnostics gglab-diagnostics-${props.ok ? "ok" : "problems"}`}>
            <div className="gglab-diagnostics-title">
                <h2>{props.title}</h2>
                <Badge variant={props.ok ? "ok" : "error"}>{props.ok ? "pass" : "problems"}</Badge>
            </div>
            {props.ok && props.diagnostics.length === 0 ? <p className="gglab-diagnostics-passed">{props.passedText}</p> : null}
            {props.diagnostics.map((diagnostic, index) => {
                const key = `${diagnostic.code}:${index}`;
                const inner = (
                    <>
                        <span className="gglab-diagnostics-head">
                            <span className="gglab-diagnostics-code">{diagnostic.code}</span>
                            <span className="gglab-diagnostics-severity">{diagnostic.severity}</span>
                            {diagnostic.dataPath !== "" && <span className="gglab-diagnostics-path">{diagnostic.dataPath}</span>}
                        </span>
                        <span className="gglab-diagnostics-message">{diagnostic.message}</span>
                    </>
                );
                if (selectable) {
                    return (
                        <button type="button" key={key} className={`gglab-diagnostics-item gglab-diagnostics-severity-${diagnostic.severity} gglab-diagnostics-selectable`} onClick={() => props.onSelect?.(diagnostic)}>
                            {inner}
                        </button>
                    );
                }
                return (
                    <div key={key} className={`gglab-diagnostics-item gglab-diagnostics-severity-${diagnostic.severity}`}>
                        {inner}
                    </div>
                );
            })}
        </section>
    );
}
