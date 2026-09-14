import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "**/node_modules/",
            "**/dist/",
            "**/target/",
            "**/src-tauri/gen/",
            "coverage/",
            ".review-evidence/",
            "pnpm-lock.yaml"
        ]
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser
            }
        }
    },
    {
        // plain-JS entry shims (CLI bin) run on Node
        files: ["**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    }
);
