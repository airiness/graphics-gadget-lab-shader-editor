# Repository documentation

This repository owns the design documents of the GGLab shader editor.
Documents here are authored and revised in this repository; this location is
the normative home for the shader editor's architecture.

## Normative documents (this repository)

- `GGLab_Shader_Graph_Editor_Architecture.md` — authoring architecture
  baseline for the shader graph editor: ownership split across the GUI and
  CLI frontends, graph document model, type system, deterministic HLSL
  generation, descriptor contract, diagnostics, preview boundary, and
  invariants.

- `GGLab_Shader_Toolchain_Integration_Design.md` — construction-level
  design for the toolchain integration stage: discovery and the strict
  readiness gate, the toolchain-client package boundary, the narrow
  `ShaderToolService`, generated-source staging, revisioned build state,
  the Build Inspector model, and the fake-process test model.

- `GGLab_Shader_Graph_Preview_Milestone_B_Closure.md` — final Editor-side
  qualification record for the dual-backend DX12/Vulkan attached Preview
  product path. Cross-project Preview architecture and final qualification
  authority remain in the GGLab docs repository.

- `GGLab_Shader_Graph_Preview_Ownership_Coordination.md` — Preview ownership
  architecture decision and Slice 1 implementation plan: the four ownership
  authorities (WorkspaceSession, build flow, `AttachedPreviewRuntimeManager`,
  `PreviewCoordinator`), the Runtime state machine with `exit-unproven` as a
  first-class state, the stable `TerminationProof` tri-value contract, the
  coordinator-owned retarget/close transitions, and the Slice 2 host-native
  `terminateAndJoin` boundary.

This document originated in the GGLab docs repository and was transferred
into this repository when the shader editor began owning its own
documentation.

The normative machine-readable contract for the frozen `gglab.surface`
profile is the Surface Profile Descriptor in the main GGLab repository:
`Shaders/Profiles/GGLab.Surface/1/descriptor.json`. The freeze decision
record for that profile is owned by the GGLab docs repository (listed
below), not this one.

## Integration readiness records

- `environment-producer-mutations.md` — guarded publish/init-state execution,
  durable operation intents and read-only finalization reconciliation.

- [Tauri Environment storage](environment-tauri-storage.md) records the approved
  v1 integration scope, native filesystem observation, registry and recovery
  adapters, and the remaining production integration gates.

- [Environment clean replay](environment-clean-replay.md) records the exact
  committed Main/Editor pair, fresh builds, Windows 8.3 and native qualification,
  and successful GitHub CI after the review fixes.

- [Review follow-up](review-followup.md) records stable diagnostic identities,
  lazy cross-repo qualification, and the Main-owned 8.3 staging fix.

- [Correctness and evidence review closure](review-closure.md) records the pinned
  producer baseline, regression results and unresolved Windows short-alias gate.

- [Guarded Environment discovery](environment-tauri-host.md) documents the
  read-only Tauri bootstrap/publisher boundary and remaining approval gate.

- [Environment registry persistence and recovery](environment-registry.md)
  defines the Editor-owned location record, atomic host storage, unverified
  restart behavior, and the still-disabled production import boundary.

- [Environment import readiness and publisher handoff](environment-import-readiness.md)
  records the inspected producer prerequisite, requested publication contract
  deliverables, and Editor acceptance criteria. It does not define an
  approved Environment manifest or claim that import is implemented.

- [Environment import transaction](environment-import-transaction.md) connects actual
  final proof to guarded registry registration and documents recovery boundaries.

- [Managed Environment state paths](environment-managed-state.md) documents compact
  state allocation, legacy intent recovery and the Windows host path limit.

- [Workspace Environment activation](environment-workspace-activation.md) documents
  the coordinator-owned selection transaction and remaining native host binding.

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
