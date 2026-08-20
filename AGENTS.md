# AGENTS.md

## Purpose

This file defines durable operating constraints for work in the GGLab Shader
Editor repository (`graphics-gadget-lab-shader-editor`). Keep it focused on
rules that should remain true across implementation phases.

Do not use this file as a project-status or roadmap tracker. Before
implementing or reviewing work, inspect the current repository, branch, recent
commits and task context rather than inferring the current phase from
AGENTS.md.

Detailed architecture, historical decisions, implementation plans and
phase-specific gates belong in the design documents listed under
"Design authority".

## Project model

This repository is the authoring tool repository of the GGLab workspace. It is
a pnpm TypeScript monorepo:

- `apps/editor/` (`@gglab/editor`) — editor application shell and composition
  root.
- `packages/shader-graph-core/` (`@gglab/shader-graph-core`) — headless
  ShaderGraph semantics: graph document model, type rules, validation, DAG
  compilation, deterministic HLSL generation, and source maps.
- `packages/editor-ui/` (`@gglab/editor-ui`) — presentation components for the
  editor.
- `tests/` — cross-package and end-to-end tests.
- `docs/` — repository-local documentation.

Web technology owns the authoring experience. TypeScript owns ordinary
ShaderGraph semantics. The C++ Shader Toolchain (`gglab-shaderc` /
`ShaderToolchainCore`, living in the main GGLab repository) owns Shader
production. `ShaderArtifact` remains the Runtime boundary. GGLab Runtime
remains the native rendering truth.

## Cross-repository topology

The GGLab workspace consists of three repositories:

- Main GGLab repository — C++ renderer, Shader Toolchain, authored
  `.shadergraph` documents, and the frozen surface profile descriptors.
- GGLab docs repository — normative architecture documents.
- This repository — editor tool implementation only.

Rules:

- Work performed from this repository treats the sibling main and docs
  repositories as read-only references. Do not modify them from this
  repository's tasks.
- Authored `.shadergraph` documents and related material/test assets live with
  the consuming product/content authority — initially the main repository —
  not in this tool repository.
- Design documents live in the docs repository. Reference them; do not copy
  their content into this repository.
- Shader production (compilation, target policy, artifact production) is owned
  by the main repository. This repository consumes its results through
  versioned process/artifact/profile boundaries, never through source-level
  C++ integration.

## Design authority

For architecture-sensitive work, read the relevant design documents before
making changes. The repository state remains authoritative for what is
currently implemented; the documents are authoritative for what is decided.

Use these documents as task-specific references:

- Authoring architecture (normative baseline):
  - `GGLab_Shader_Graph_Editor_Architecture.md`
- Frozen surface profile contract:
  - `GGLab_Surface_Contract_Freeze_v1.md` (freeze decision record and evidence
    rationale)
  - Surface Profile Descriptor instance: main repository
    `Shaders/Profiles/GGLab.Surface/1/descriptor.json` (authoritative
    machine-readable contract)
- Pipeline and toolchain authority (as needed):
  - `GGLab_Shader_System_Architecture.md` (pipeline: `.shadergraph` →
    generated HLSL → `gglab-shaderc` → `ShaderArtifact`)
  - `GGLab_Shader_Toochain_Extraction.md` (preserve the current filename
    spelling; toolchain process/result contracts)
- Terminology:
  - `GGLab_Project_Terminology.md`

Read the architecture document before the freeze record, and the freeze record
before the descriptor. The architecture document defines the long-term target;
the freeze record defines the frozen decisions and their rationale; the
descriptor defines the authoritative machine values.

If the freeze record and the descriptor disagree semantically, that is a
review failure. Do not silently select one side or synthesize a third reading;
report the disagreement.

If a task depends on a design document that is missing or unavailable, report
that limitation instead of reconstructing an authoritative design from
memory.

## Architecture boundaries

These boundaries are durable. A task may never override them locally:

- This repository must not introduce a second shader compiler, a second backend
  policy, a second material ABI, or a second renderer.
- Native compilation goes through `gglab-shaderc` only. The editor never
  reconstructs DXC invocation, target, or backend argument policy.
- WebGL/WebGPU canvas output (thumbnails, UI tests, experiments) is never
  GGLab Shader-correctness evidence. The authoritative preview is a GGLab
  Preview Lab in the main repository.
- React Flow is a presentation/interaction adapter. It is not the persisted
  graph model and not a semantic authority.
- Editor/session state stores are session/UI state. They are not a persisted
  graph-semantics authority.
- There is exactly one ordinary node/port/type authority:
  `packages/shader-graph-core`. The UI, tests, and tooling ask its semantic
  services. No parallel node registries, including UI-side registries.
- `packages/shader-graph-core` must remain headless: no React, no React Flow,
  no Zustand, no Tauri, no DOM/Web API, no native addon, no C++/FFI
  dependency.
- ShaderGraph emits HLSL, not DXIL/SPIR-V. Generated HLSL is HLSL; its authoring
  origin is not privileged. Production correctness of compiled HLSL is owned by
  `gglab-shaderc`; ordinary graph semantic correctness is owned by
  `shader-graph-core` itself.
- The editor never mirrors or depends on Runtime struct shapes such as
  `MaterialData` / `MaterialGPU`. Mapping concrete runtime material state into
  generated-function inputs is a main-repository obligation.

### Surface Profile Descriptor

- The descriptor is consumed as a **serialized data document** (parsed JSON).
  It is never a C++ ABI, header import, or native linkage into
  `shader-graph-core`.
- The descriptor owns only cross-boundary profile facts: the generated-function
  contract, required outputs, graph-visible inputs, parameter/resource
  classes, the sampling contract, and narrow tool identity/version
  requirements. It does not own node behavior, DAG rules, type inference, node
  registries, SampleTexture2D channel outputs, graph optimization, or
  presentation.
- Emission targets the descriptor's logical contract, not the current runtime
  implementation shape.
- Readers declare the `descriptorVersion` range they support and reject
  out-of-range or unknown versions explicitly. Unknown/newer data must fail or
  degrade explicitly; never silently reinterpret it.
- Graph/profile selection must never implicitly upgrade a graph to another
  `profileId` / `profileVersion`. Selection chooses the highest supported
  `descriptorVersion` only within the graph's requested profile line.
- Referencing a class or feature in the descriptor's deferred set is an
  explicit diagnostic, never a silent default substitution.
- Version axes are domain-owned and independent: `schemaVersion` (graph
  document format), `profileVersion` (profile semantics),
  `descriptorVersion` (descriptor serialization). Do not introduce a generic
  cross-cutting global version.

### Diagnostics

Two distinct diagnostic layers, both structured (never an unstructured
`string[]`):

- Graph-native diagnostics come from `shader-graph-core` (cycles, type
  mismatch, missing input/output, unknown node/version, unknown profile
  feature, invalid connection). Their location authority is graph-local
  node/port identity.
- Toolchain diagnostics come from native shader compilation (HLSL
  syntax/type errors, include errors, compiler unavailable, artifact IO,
  target-policy failure). Their location authority is generated-source
  identity/location, mapped back to node/port through the ShaderGraph source
  map.

## Deterministic emission invariants

- Given the same semantic graph, frozen profile contract, and graph compiler
  version, the generated HLSL and source map are deterministic.
- Canvas placement, collapsed state, comments/groups, viewport, and incidental
  serialization order never change generated HLSL.
- Renaming only a human-facing display label never changes generated symbols.
- Generated parameter symbols derive from stable semantic identity under a
  deterministic, ASCII-safe, collision-free rule.
- The durable generated-source identity is the SHA-256 of the exact generated
  HLSL bytes. Do not create a second persisted identity scheme
  (no CRC/FNV/StringId substitutions).
- Save → load → compile preserves the semantic graph, the HLSL, and the source
  identity.

## Build state and readiness

- Native compilation is asynchronous and revisioned. Each result is bound to
  the graph/source revision that produced it. A stale result never becomes
  current and never overwrites newer state.
- Positive native-build readiness requires a compatible toolchain AND a
  compatible required Surface Profile Descriptor. Executable existence alone
  is not readiness.
- Do not parse human-readable tool prose (`--version` text) as the durable
  contract. Compatibility is judged through machine-readable contracts.
- A failed build or artifact load is an explicit state (stale/last-good plus
  diagnostics), never a silent fallback. Where a safe last-good artifact
  exists, a failed newer build/load must not blank or erase it.

## Workspace and tooling rules

- pnpm workspaces is the only package management. `pnpm-lock.yaml` is
  committed. The package manager version is pinned in the root `package.json`
  (`packageManager`) and must not be re-resolved to floating "latest"
  versions.
- Root scripts are the unified entry points: `pnpm install`, `pnpm typecheck`,
  `pnpm test`, `pnpm lint`.
- `tsconfig.base.json` is the strictness baseline. Do not weaken strictness
  flags for a package without an explicit, recorded task decision.
- The root ESLint flat config is the lint policy.
- Install dependencies needed by the current task, not in anticipation of
  future work.
- Each workspace package has one responsibility. Dependencies follow the
  ownership direction (`apps/editor` → `@gglab/editor-ui` /
  `@gglab/shader-graph-core`), never the reverse.
- Do not commit generated build products, caches, IDE state, or local package
  store directories. `.gitignore` is the boundary; extend it before handoff
  when a new artifact class appears.
- Do not modify machine-level environments (global installs, system paths,
  shared caches) without the owner's consent. If tooling is missing, report
  the actual environment and the smallest proposed solution, and wait.

## Source rules

Repository-visible content is English: code, comments, READMEs, package
metadata, identifiers, file names, test names, logs, commit messages, and
PR/issue text.

Naming follows ordinary TypeScript ecosystem conventions (do not invent a
special all-PascalCase identifier rule):

- Types, classes, interfaces, enums: `PascalCase`
- Functions, methods, variables: `camelCase`
- Directories and files: `kebab-case`

Do not encode implementation-phase or planning labels such as `S1`, `P0`,
`A0`, slice numbers, or commit numbers into durable identifiers, file names or
code comments. Describe the lasting semantic meaning instead. Version numbers
that are part of a contract (for example `schemaVersion`, `profileVersion`,
`descriptorVersion`) are durable semantics, not phase labels. Historical
design documents and commit messages may retain phase labels.

Preserve the naming and organization used by neighboring code. Avoid unrelated
formatting churn.

## Asset and fixture licensing

Do not add or retain third-party models, textures, HDRIs, or other assets
(including test fixtures) when their source or redistribution rights are
unclear.

For third-party assets:

- preserve upstream license and attribution requirements;
- record source, rights holder, license, and required attribution in the
  nearest applicable `THIRD_PARTY_NOTICES.md`;
- keep notices synchronized when assets are added, removed, renamed, converted
  or replaced.

Large binary assets require a concrete runtime, test, or validation purpose.
Prefer small, deterministic, generated fixtures (solid-color or procedural
textures) for graph and compilation tests.

## Build and verification

Verification runs from the repository root:

    pnpm install     # fresh/repeatable installation
    pnpm typecheck   # TypeScript check for all workspace packages
    pnpm test        # workspace unit tests
    pnpm lint        # lint the whole repository

- Do not report a change as verified unless the relevant commands actually
  completed successfully. If verification is blocked by tooling, environment,
  GPU, driver, or hardware availability, state exactly what was and was not
  tested.
- Run the owning package's tests for a focused change. When a change crosses
  workspace package boundaries, run all affected packages and consider the
  corresponding main-repository verification.
- Native shader correctness (DXC compilation, target policy, artifact
  contracts, Runtime-side evidence) is owned by the main repository's build
  and self-test suites. Do not duplicate or re-implement that evidence in this
  repository's tests.
- Treat "the graph compiles to HLSL" and "the generated HLSL compiles natively"
  as separate verification steps.

## Change discipline

- Before changing ownership, versioning, or persisted contracts, inspect the
  complete relevant path (schema → validation → emission → descriptor
  contract) rather than patching only the immediate symptom.
- Prefer focused changes over unrelated subsystem-wide refactors.
- Preserve existing user changes in the working tree. Do not discard,
  overwrite, reformat, or rewrite unrelated modifications.
- Do not silently weaken validation, diagnostics, error handling, or test
  coverage to make a failure disappear.
- When fixing a non-obvious correctness bug, record the violated invariant in
  code or tests where that improves future maintainability.
- Do not stage, commit, amend, reset, rebase, force-push, or otherwise modify
  Git history unless the project owner explicitly requests it.

Before handoff:

- review the diff for unrelated modifications;
- confirm the diff contains no phase labels, non-English repository-visible
  content, or generated artifacts;
- run `pnpm typecheck`, `pnpm test`, and `pnpm lint`;
- report known limitations and untested paths.

## Language and handoff

Repository-visible content is English (see "Source rules"). Communication with
the project owner may use Chinese with English technical terms where helpful.

After implementing a change, provide a proposed English Conventional Commit
message using an imperative `type(scope): summary` subject unless the owner
asks for another format.

Put each complete proposed commit message in its own plain fenced code block
so it can be copied directly. Keep verification results and review commentary
outside the commit-message block.

If independently reviewable changes are intentionally split, provide one
proposed message per slice and identify the corresponding scope outside the
code blocks.
