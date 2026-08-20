# Repository documentation

This repository owns the design documents of the GGLab shader editor.
Documents here are authored and revised in this repository; this location is
the normative home for the shader editor's architecture and contract records.

## Normative documents (this repository)

- `GGLab_Shader_Graph_Editor_Architecture.md` — authoring architecture
  baseline for the shader graph editor: ownership split, graph document model,
  type system, deterministic HLSL generation, descriptor contract,
  diagnostics, preview boundary, and invariants.
- `GGLab_Surface_Contract_Freeze_v1.md` — freeze decision record for the
  `gglab.surface` v1 profile contract, with the Gate 0 evidence trail.

The normative machine-readable contract for the frozen profile is the Surface
Profile Descriptor in the main GGLab repository:
`Shaders/Profiles/GGLab.Surface/1/descriptor.json`.

Both documents originated in the GGLab docs repository and were transferred
into this repository when the shader editor began owning its own
documentation.

## Documents owned by other repositories (referenced, not copied)

GGLab docs repository:

- `GGLab_Shader_System_Architecture.md` — shader pipeline authority
  (`.shadergraph` → generated HLSL → `gglab-shaderc` → `ShaderArtifact`)
- `GGLab_Shader_Toochain_Extraction.md` — Shader Toolchain extraction and
  contracts (preserve the filename spelling)
- `GGLab_Project_Terminology.md` — project-wide codename terminology
- `GGLab_Agent_Bootstrap_Protocol.md` — workspace agent bootstrap, handoff,
  review, and checkpoint protocol
- main-project C++ architecture documents (renderer, RHI, build, and project
  boundaries) owned by the main GGLab project
