# Graphics Gadget Lab — Shader Editor

Authoring tool repository for the GGLab node-based shader graph editor.

This repository owns the editor application and the headless shader graph
semantics package. It is the third repository of the GGLab workspace: the
main GGLab repository owns the C++ renderer, the shader toolchain
(`gglab-shaderc` / `ShaderToolchainCore`), authored `.shadergraph` documents,
and the frozen surface profile descriptors; the docs repository owns the
normative architecture documents. This repository never introduces a second
shader compiler, a second backend policy, a second material ABI, or a second
renderer.

## Workspace layout

- `apps/editor/` — editor application shell and composition root
- `packages/shader-graph-core/` — headless shader graph semantics (graph
  document model, type rules, validation, DAG compilation, deterministic
  HLSL generation and source maps)
- `packages/editor-ui/` — presentation components for the editor
- `tests/` — cross-package and end-to-end tests
- `docs/` — repository-local documentation

## Commands

Run from the repository root:

- `pnpm install` — install workspace dependencies
- `pnpm typecheck` — TypeScript check for all workspace packages
- `pnpm test` — run the workspace unit tests
- `pnpm lint` — lint the whole repository
