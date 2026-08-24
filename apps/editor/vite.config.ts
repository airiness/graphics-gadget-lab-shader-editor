import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * Dev/build server for the editor shell. Vite compiles the TypeScript/JSX
 * surface (esbuild under the hood); the React automatic runtime is used so
 * component files carry no React import of their own.
 *
 * Tailwind v4 (CSS-first) provides the utilities the editor-ui kit
 * (button / badge / input / collapsible / separator) and the chrome use;
 * the kit's semantic tokens are themed from this app's design tokens in
 * app.css (`@theme inline`), so the visual facts live in one place.
 */
export default defineConfig({
    plugins: [tailwindcss()],
    esbuild: {
        jsx: "automatic",
    },
    server: {
        port: 5173,
        strictPort: true,
        // The Tauri desktop host lives in src-tauri (Rust/cargo). Keep the
        // Vite dev watcher away from it: cargo owns those files, and
        // watching them in parallel (especially the cargo build tree under
        // src-tauri/target) causes file-watch contention under `tauri dev`.
        // (chokidar v4 option name is `ignored`, not `ignore`.)
        watch: {
            ignored: ["**/src-tauri/**", "**/target/**"],
        },
    },
});
