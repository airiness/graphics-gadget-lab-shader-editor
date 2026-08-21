/**
 * Application entry: mount the composition root into the shell.
 */
import { createRoot } from "react-dom/client";
import { App } from "./app.js";

const rootElement = document.getElementById("gglab-root");
if (rootElement === null) {
    throw new Error('The editor shell is missing its mount element ("gglab-root").');
}
createRoot(rootElement).render(<App />);
