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
import { useEffect, useRef } from "react";
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

/** Picked file handed back by a host file-open injection (name for
 * diagnostics, text for the core reader). */
export interface PickedText {
    readonly name: string;
    readonly text: string;
}

export interface DescriptorPanelProps {
    readonly state: DescriptorPanelState;
    /** The authoring context supplies this instance; file loading is unavailable. */
    readonly readOnly?: boolean;
    readonly onStateChange: (state: DescriptorPanelState) => void;
    /**
     * Optional host file-open injection (desktop slice): resolve with
     * `{ name, text }`, or `null` for a user cancel. When absent, the
     * component falls back to the browser file input (web behavior is
     * unchanged). The panel stays headless — it only sees a generic
     * "pick a file, give me its text" function.
     */
    readonly openDescriptorFile?: () => Promise<PickedText | null>;
}

export function DescriptorPanel(props: DescriptorPanelProps) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const state = props.state;
    const latest = useRef(props);
    latest.current = props;
    const generation = useRef(0);
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; generation.current++; };
    }, [props.readOnly, props.openDescriptorFile]);
    async function readPickedFile(read: () => Promise<PickedText | null>, fileName: string): Promise<void> {
        if (latest.current.readOnly) return;
        const request = ++generation.current;
        const publish = (next: DescriptorPanelState) => {
            if (mounted.current && request === generation.current && !latest.current.readOnly) latest.current.onStateChange(next);
        };
        try {
            const picked = await read();
            if (picked !== null) publish(readDescriptorText(picked.name, picked.text));
        } catch (error) {
            publish({ kind: "rejected", fileName, diagnosticCode: "IO", diagnosticMessage: error instanceof Error ? error.message : String(error) });
        }
    }
    const onOpenClicked = async (): Promise<void> => {
        if (props.readOnly) return;
        const nativeOpen = props.openDescriptorFile;
        if (nativeOpen === undefined) {
            fileInputRef.current?.click();
            return;
        }
        await readPickedFile(nativeOpen, "host");
    };
    return (
        <section className="gglab-panel">
            <h2 className="gglab-panel-title">Profile descriptor</h2>
            <p className="gglab-panel-hint">
                The profile contract is consumed as a serialized data document (parsed by the core's strict reader), never a C++ ABI or header import.
            </p>
            {/* A clear ordinary action: neutral raised button, file icon,
                hover/pressed/focus states from the button design language.
                Desktop hosts inject a native open; the web build keeps
                the hidden file input fallback. */}
            <Button disabled={props.readOnly} variant="secondary" className="self-start" onClick={() => void onOpenClicked()}>
                <FileIcon />
                Open descriptor file…
            </Button>
            <input
                ref={fileInputRef}
                disabled={props.readOnly}
                type="file"
                accept="application/json,.json"
                className="gglab-visually-hidden"
                tabIndex={-1}
                aria-hidden
                onChange={async (event) => {
                    const input = event.currentTarget;
                    const file = input.files?.[0];
                    // Capture and reset before awaiting: React releases currentTarget,
                    // and selecting the same file again must remain a new read intent.
                    input.value = "";
                    if (file === undefined || props.readOnly) return;
                    await readPickedFile(async () => ({ name: file.name, text: await file.text() }), file.name);
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
