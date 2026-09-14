import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@gglab/editor-ui";
import { createEnvironmentWorkflow, type EnvironmentWorkflow } from "./environment-workflow.js";
import type { PreviewCoordinator } from "./preview-coordinator.js";
import type { EnvironmentImportEvent } from "@gglab/shader-toolchain-client";

interface Props {
    coordinator: PreviewCoordinator;
    onWorkflowReady?: (workflow: EnvironmentWorkflow | null) => void;
    capture: () => () => boolean;
    begin: () => (event: EnvironmentImportEvent) => void;
    activeRoot: string | null;
}
export function EnvironmentPanel(props: Props) {
    const latest = useRef(props); latest.current = props;
    const [workflow, setWorkflow] = useState<EnvironmentWorkflow | null>(null);
    const [error, setError] = useState("");
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        if (!("__TAURI_INTERNALS__" in globalThis)) return;
        let disposed = false, owned: EnvironmentWorkflow | null = null;
        void import("@tauri-apps/api/core").then(({ invoke, Channel }) => {
            if (disposed) return;
            owned = createEnvironmentWorkflow(invoke, receive => { const channel = new Channel<unknown>(); channel.onmessage = receive; return channel; }, {
                coordinator: () => latest.current.coordinator,
                capture: () => latest.current.capture(), begin: () => latest.current.begin(),
            });
            setWorkflow(owned);
            latest.current.onWorkflowReady?.(owned);
        }).catch(e => { if (!disposed) setError(String(e)); });
        return () => { disposed = true; latest.current.onWorkflowReady?.(null); void owned?.cancel(); };
    }, []);
    return <>
        <Button variant="ghost" onClick={() => { dialog.current?.showModal(); void workflow?.refresh(); }}>GGLab Environment…</Button>
        <dialog ref={dialog} className="gglab-environment-dialog" onCancel={event => { if (workflow?.getSnapshot().busy) event.preventDefault(); }}>
            <h2>GGLab Environment</h2>
            <p>{props.activeRoot ? `Selected: ${props.activeRoot}` : "No Environment selected."}</p>
            <p>Import and Use pause Preview for final-location checks. Failed attempts retain existing registrations and writable state.</p>
            {workflow ? <EnvironmentControls workflow={workflow} close={() => dialog.current?.close()} /> : <>
                <p>{error || "Environment import requires the desktop app."}</p>
                <Button onClick={() => dialog.current?.close()}>Close</Button>
            </>}
        </dialog>
    </>;
}
export function EnvironmentControls({ workflow, close }: { workflow: EnvironmentWorkflow; close: () => void }) {
    const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot, workflow.getSnapshot);
    return <>
        <p role="status" aria-live="polite">{state.message}</p>
        <fieldset disabled={state.busy}>
            <legend>Import</legend>
            <Button onClick={() => void workflow.importBundled()}>Use bundled Environment</Button>
            <Button onClick={() => void workflow.discover()}>Import from Repository…</Button>
            <Button onClick={() => void workflow.importPublished()}>Import published Environment and state…</Button>
            {state.candidates.map(candidate => <div key={candidate.deployment} className="gglab-environment-row">
                <span>{candidate.deployment}</span>
                <Button onClick={() => void workflow.publish(candidate)}>Publish and use</Button>
            </div>)}
            {state.canRetry && <div className="gglab-environment-row">
                <Button onClick={() => void workflow.retry()}>Retry retained import</Button>
                <Button onClick={() => void workflow.retry(true)}>Retry with original publisher…</Button>
            </div>}
        </fieldset>
        <fieldset disabled={state.busy}>
            <legend>Registered Environments</legend>
            <Button onClick={() => void workflow.refresh()}>Refresh</Button>
            {state.registry?.records.map(({ record }) => <div key={record.environmentId} className="gglab-environment-row">
                <span>{record.environmentRoot}<br />State: {record.stateRoot}<br />Saved registration; fresh verification required.</span>
                <Button onClick={() => void workflow.useRegistered(record)}>Verify and use</Button>
            </div>)}
            {state.registry?.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic.code}: {diagnostic.message}</p>)}
            {!!state.registry?.pending.length && <p>Pending registration files are retained. Retry the original import to reconcile them.</p>}
        </fieldset>
        <details>
            <summary>Recover publication or state operations ({state.operations.length})</summary>
            <p>Completed operation targets are rechecked. Incomplete targets require their original publisher. Nothing is deleted.</p>
            {state.operations.map(intent => <div key={intent.operationId} className="gglab-environment-row">
                <span>{intent.operation}: {intent.targetRoot}</span>
                <Button disabled={state.busy} onClick={() => void workflow.resume(intent)}>Recheck and resume</Button>
            </div>)}
        </details>
        <div className="gglab-environment-row">
            {state.busy && <Button onClick={() => void workflow.cancel()}>Cancel operation</Button>}
            <Button disabled={state.busy} onClick={close}>Close</Button>
        </div>
    </>;
}
