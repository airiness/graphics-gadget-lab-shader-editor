# Graphics Gadget Lab — Shader Editor

This project is frozen and no longer maintained. Download the self-contained
Windows x64 archive from [the final release](https://github.com/airiness/graphics-gadget-lab-shader-editor/releases/tag/v0.1.0-final).
See [portable release instructions and verification](docs/final-release.md).

Authoring tool repository for the GGLab node-based shader graph editor.

This repository owns two authoring frontends — the GUI editor and a
machine/automation CLI — over a single headless shader graph semantics
package; both frontends share `packages/shader-graph-core` as the only
semantic authority. It is the third repository of the GGLab workspace: the
main GGLab repository owns the C++ renderer, the shader toolchain
(`gglab-shaderc` / `ShaderToolchainCore`), authored `.shadergraph` documents,
and the frozen surface profile descriptors; the docs repository owns the
main-project architecture documents. This repository never introduces a second
shader compiler, a second backend policy, a second material ABI, or a second
renderer.

## Workspace layout

- `apps/editor/` — GUI authoring frontend: editor application shell and
  composition root
- `apps/cli/` — CLI authoring frontend for AI agents, CI, automation, and
  batch editing
- `packages/shader-graph-core/` — headless shader graph semantics (graph
  document model, type rules, validation, DAG compilation, deterministic
  HLSL generation and source maps); single semantic authority for both
  frontends
- `packages/editor-ui/` — presentation components for the GUI editor
- `tests/` — cross-package and end-to-end tests
- `docs/` — repository documentation, including this repository's normative
  design documents

## Commands

Run from the repository root:

- `pnpm install` — install workspace dependencies
- `pnpm typecheck` — TypeScript check for all workspace packages
- `pnpm test` — run the workspace unit tests
- `pnpm lint` — lint the whole repository
