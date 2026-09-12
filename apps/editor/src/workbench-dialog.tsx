import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@gglab/editor-ui";

/** Modal configuration owns only visibility; browser dialog semantics contain
 * keyboard focus and return it to the invoking control on close. */
export function WorkbenchDialog(props: { title: string; onClose: () => void; children: ReactNode }) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const element = dialog.current;
        element?.showModal();
        return () => element?.close();
    }, []);
    return <dialog ref={dialog} className="gglab-workbench-dialog" aria-label={props.title} onCancel={props.onClose}>
        <div className="gglab-workbench-dialog-heading"><h2>{props.title}</h2>
            <Button variant="ghost" onClick={props.onClose} autoFocus>Close</Button>
        </div>
        {props.children}
    </dialog>;
}
