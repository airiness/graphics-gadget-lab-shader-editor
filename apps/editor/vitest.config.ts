import { defineConfig } from "vitest/config";

/** GUI slice tests run in a DOM environment (React rendering). */
export default defineConfig({
    esbuild: {
        jsx: "automatic",
    },
    test: {
        environment: "jsdom",
    },
});
