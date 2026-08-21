import { defineConfig } from "vite";

/**
 * Dev/build server for the editor shell. Vite compiles the TypeScript/JSX
 * surface (esbuild under the hood); the React automatic runtime is used so
 * component files carry no React import of their own. No plugin stack is
 * needed for this slice: plain .tsx + CSS imports.
 */
export default defineConfig({
    esbuild: {
        jsx: "automatic",
    },
    server: {
        port: 5173,
        strictPort: true,
    },
});
