/**
 * Application entry: mount the composition root into the shell, inside
 * the application-level ErrorBoundary (the second line of defense — a
 * crash must surface as the recovery card, never as a blank window).
 */
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { AppErrorBoundary } from "./app-error-boundary.js";

const rootElement = document.getElementById("gglab-root");
if (rootElement === null) {
    throw new Error('The editor shell is missing its mount element ("gglab-root").');
}
createRoot(rootElement).render(
    <AppErrorBoundary>
        <App />
    </AppErrorBoundary>,
);
