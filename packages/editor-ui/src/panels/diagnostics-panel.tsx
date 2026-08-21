/**
 * Diagnostics panel — renders the core's structured diagnostics verbatim
 * (stable code, severity, message, document location). It adds no
 * classification of its own: the codes already carry the meaning, and the
 * two diagnostic layers (graph-native vs. toolchain) are shown under
 * separate titles by the composition root.
 */
import type { ShaderGraphDiagnostic } from "@gglab/shader-graph-core";

export interface DiagnosticsPanelProps {
    readonly title: string;
    /** Structured diagnostics (never an unstructured string list). */
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
    /** True when the related core verdict passed. */
    readonly ok: boolean;
    /** Shown when `ok` and there are no diagnostics. */
    readonly passedText: string;
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps) {
    return (
        <section className={`gglab-diagnostics gglab-diagnostics-${props.ok ? "ok" : "problems"}`}>
            <h2>{props.title}</h2>
            {props.ok && props.diagnostics.length === 0 ? <p className="gglab-diagnostics-passed">{props.passedText}</p> : null}
            {props.diagnostics.map((diagnostic, index) => (
                <dl className={`gglab-diagnostics-item gglab-diagnostics-severity-${diagnostic.severity}`} key={`${diagnostic.code}:${index}`}>
                    <dt>
                        <span className="gglab-diagnostics-code">{diagnostic.code}</span>{" "}
                        <span className="gglab-diagnostics-severity">{diagnostic.severity}</span>
                    </dt>
                    <dd className="gglab-diagnostics-message">{diagnostic.message}</dd>
                    {diagnostic.dataPath !== undefined && <dd className="gglab-diagnostics-path">{diagnostic.dataPath}</dd>}
                </dl>
            ))}
        </section>
    );
}
