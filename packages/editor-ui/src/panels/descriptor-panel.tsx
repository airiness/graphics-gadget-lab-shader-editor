/**
 * Descriptor instance panel — loads one Surface Profile Descriptor through
 * the core's strict reader. Compatibility and conformance are NOT judged
 * here: the composition root asks the core's shared services for those
 * verdicts (one authority per rule) and reports their diagnostics.
 *
 * `readDescriptorText` is the pure core of this component (and the unit
 * that tests exercise): text → parsed instance, or the reader's structured
 * rejection. The file input is hidden browser plumbing behind a styled
 * button (the desktop-tool surface never shows a raw native file picker
 * control).
 */
import { useRef } from "react";
import { parseSurfaceProfileDescriptor, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { FileIcon } from "../components/icons.js";
import { Button } from "../components/ui/button.js";

export type DescriptorPanelState =
    | { readonly kind: "empty" }
    | { readonly kind: "ready"; readonly descriptor: SurfaceProfileDescriptor }
    | { readonly kind: "rejected"; readonly fileName: string; readonly diagnosticCode: string; readonly diagnosticMessage: string };

/** Parse descriptor text with the core's strict reader (structured result only). */
export function readDescriptorText(fileName: string, text: string): DescriptorPanelState {
    const parsed = parseSurfaceProfileDescriptor(text);
    if (parsed.ok && parsed.value !== null) {
        return { kind: "ready", descriptor: parsed.value };
    }
    const first = parsed.diagnostics[0];
    return {
        kind: "rejected",
        fileName,
        diagnosticCode: first !== undefined ? first.code : "READER",
        diagnosticMessage: first !== undefined ? first.message : "The descriptor reader rejected this file.",
    };
}

/**
 * The machine fact the GUI surfaces about the instance: whether the
 * generated texture-signature contract is serialized (the same expression
 * the CLI's `descriptor` command reports — one expression, one authority).
 */
export function textureSignatureSerialized(descriptor: SurfaceProfileDescriptor): boolean {
    return "generatedTextureSignature" in descriptor.samplingContract && "generatedSampleForm" in descriptor.samplingContract;
}

export interface DescriptorPanelProps {
    readonly state: DescriptorPanelState;
    readonly onStateChange: (state: DescriptorPanelState) => void;
}

export function DescriptorPanel(props: DescriptorPanelProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const state = props.state;
    return (
        <section className="gglab-panel">
            <h2 className="gglab-panel-title">Profile descriptor</h2>
            <p className="gglab-panel-hint">
                The profile contract is consumed as a serialized data document (parsed by the core's strict reader), never a C++ ABI or header import.
            </p>
            {/* Primary action of the profile panel: solid affordance, icon,
                hover/pressed/focus states from the chrome kit. */}
            <Button variant="primary" className="self-start" onClick={() => fileInputRef.current?.click()}>
                <FileIcon />
                Open descriptor file…
            </Button>
            <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="gglab-visually-hidden"
                tabIndex={-1}
                aria-hidden
                onChange={async (event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file === undefined) {
                        return;
                    }
                    const text = await file.text();
                    props.onStateChange(readDescriptorText(file.name, text));
                    event.currentTarget.value = "";
                }}
            />
            {state.kind === "empty" && <p className="gglab-panel-status">No descriptor loaded — compatibility and conformance are not yet judged.</p>}
            {state.kind === "rejected" && (
                <p className="gglab-panel-status gglab-panel-status-warn">
                    <span className="gglab-panel-code">{state.diagnosticCode}</span> {state.diagnosticMessage}
                </p>
            )}
            {state.kind === "ready" && (
                <dl className="gglab-facts">
                    <div className="gglab-fact">
                        <dt>descriptorVersion</dt>
                        <dd>{String(state.descriptor.descriptorVersion)}</dd>
                    </div>
                    <div className="gglab-fact">
                        <dt>profile line</dt>
                        <dd>
                            {state.descriptor.profileId} · profileVersion {String(state.descriptor.profileVersion)}
                        </dd>
                    </div>
                    <div className="gglab-fact">
                        <dt>texture-signature</dt>
                        <dd>{textureSignatureSerialized(state.descriptor) ? "serialized" : "not serialized"}</dd>
                    </div>
                </dl>
            )}
        </section>
    );
}
