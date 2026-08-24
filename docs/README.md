# Repository documentation

This repository owns the design documents of the GGLab shader editor.
Documents here are authored and revised in this repository; this location is
the normative home for the shader editor's architecture.

## Normative document (this repository)

- `GGLab_Shader_Graph_Editor_Architecture.md` — authoring architecture
  baseline for the shader graph editor: ownership split across the GUI and
  CLI frontends, graph document model, type system, deterministic HLSL
  generation, descriptor contract, diagnostics, preview boundary, and
  invariants.

This document originated in the GGLab docs repository and was transferred
into this repository when the shader editor began owning its own
documentation.

The normative machine-readable contract for the frozen `gglab.surface`
profile is the Surface Profile Descriptor in the main GGLab repository:
`Shaders/Profiles/GGLab.Surface/1/descriptor.json`. The freeze decision
record for that profile is owned by the GGLab docs repository (listed
below), not this one.

## Documents owned by other repositories (referenced, not copied)

GGLab docs repository:

- `GGLab_Surface_Contract_Freeze_v1.md` — freeze decision record for the
  `gglab.surface` v1 profile contract, with the Gate 0 evidence trail
- `GGLab_Shader_System_Architecture.md` — shader pipeline authority
  (`.shadergraph` → generated HLSL → `gglab-shaderc` → `ShaderArtifact`)
- `GGLab_Shader_Toochain_Extraction.md` — Shader Toolchain extraction and
  contracts (preserve the filename spelling)
- `GGLab_Project_Terminology.md` — project-wide codename terminology
- `GGLab_Agent_Bootstrap_Protocol.md` — workspace agent bootstrap, handoff,
  review, and checkpoint protocol
- main-project C++ architecture documents (renderer, RHI, build, and project
  boundaries) owned by the main GGLab project
