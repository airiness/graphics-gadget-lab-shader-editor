/**
 * Application-level ErrorBoundary — the second line of defense.
 *
 * The first line is "no session operation may throw" (the auto-layout
 * crash was fixed exactly there: a defective graph must be layable, not
 * a layout-engine detonation). This boundary is the honest fallback for
 * the bug class that is not known yet: anything left uncaught in the
 * render tree, without a boundary, unmounts the ENTIRE app (a blank
 * window). Sitting OUTSIDE every stateful component of <App/>, a crash
 * can never take down this surface itself.
 *
 * What the user sees (English, structured, one action): the window stays
 * open; the topmost card (the close-prompt's chrome language, one rank
 * above it) states the honest consequence — the in-memory session
 * (document, history, unsaved edits) is gone with the broken render
 * tree — and offers the one recovery action: reload the window. The
 * error's first line is shown verbatim in a mono slot, undecorated, for
 * the diagnostic.
 */
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button } from "@gglab/editor-ui";

interface AppErrorBoundaryState {
    readonly error: Error | null;
}

/** The recovery action: reset the webview to the shell + disk state. */
function reloadWindow(): void {
    window.location.reload();
}

export class AppErrorBoundary extends Component<{ readonly children: ReactNode }, AppErrorBoundaryState> {
    state: AppErrorBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
        return { error };
    }

    override componentDidCatch(error: Error, info: ErrorInfo): void {
        // The full trace stays in the console for the developer; the card
        // carries only the first line.
        console.error("AppErrorBoundary caught a rendering error:", error, info);
    }

    override render(): ReactNode {
        const { error } = this.state;
        if (error === null) {
            return this.props.children;
        }
        const firstLine = error.message.split("\n")[0] ?? "";
        return (
            <div className="gglab-error-veil" role="alertdialog" aria-label="The editor hit a rendering error">
                <section className="gglab-error-card">
                    <h2 className="gglab-error-title">The editor hit a rendering error</h2>
                    <p className="gglab-error-text">
                        The window stayed open, but the in-memory session (document, history, and unsaved edits) was lost with the broken render tree.
                        Reopening a saved file restores it from disk.
                    </p>
                    {firstLine.length > 0 ? <code className="gglab-error-line">{firstLine}</code> : null}
                    <Button
                        variant="secondary"
                        onClick={reloadWindow}
                        aria-label="Reload the window to restore the shell"
                        title="Reload the window to restore the shell"
                    >
                        Reload the window
                    </Button>
                </section>
            </div>
        );
    }
}
