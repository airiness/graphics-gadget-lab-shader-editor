# GGLab Shader Graph Preview Milestone B Closure

> Status: Closed / dual-backend qualified 2026-09-01
>
> Authority relationship: Final Shader Editor-side qualification record for the live Preview Milestone B product path. The cross-project Preview contract remains owned by the GGLab docs repository's `GGLab_Shader_Graph_Preview_Program_And_Lab_Design.md` and final closure record.

Shader Graph Preview Milestone B is complete.

```text
DX12 attached Preview    qualified
Vulkan attached Preview  qualified
```

The accepted source coordinate was:

| Repository | Qualified revision |
|---|---|
| Main GGLab | `ad40b36f` |
| Shader Editor | `eb96689` |

These revisions identify the source state; exact executable observation remains
required at every process boundary. The owner-observed transient candidate,
session, attempt, publication, and Runtime observation values are not recreated
when their literal values were not retained in the repository record.

The Vulkan qualification used the real Shader Editor -> `gglab-shaderc build-preview` -> immutable Preview publication -> attached GraphicsGadgetLab Runtime path.

Owner-observed Runtime evidence included:

```text
Mode                         Attached Shader Editor publication
Eligibility                  Current
Profile                      gglab.surface v2
Preview Input Contract       gglab.preview-input.surface.texture2d
ProgramRef                   gglab.shader.shader-graph-preview::pixel.surface-v2
Entry                        PSMain
Backend                      Vulkan
Target                       gglab-vulkan13 / SPIR-V
Runtime activation error     None
Runtime rejection code       None
```

The candidate-publication, loaded-publication, and last-good-publication identities matched. Runtime diagnostics reported PASS for attached publication mapping, the Preview parameter block, deterministic primitive fixtures, current-generation Preview-pass execution, and Texture2D v2 production bindless binding.

The Editor-side tool proof simultaneously exposed both supported targets:

```text
gglab-dx12
gglab-vulkan13
```

`GGLab_Shader_Graph_Editor_Architecture.md` and
`GGLab_Shader_Toolchain_Integration_Design.md` now record the same dual-backend
closure directly. This evidence record does not override contradictory active
architecture text.

The closed architecture remains unchanged:

- generated `EvaluateSurface` is a function ABI, not a complete native entry;
- main GGLab owns Preview adapters, `PSMain`, native target policy, Artifact publication, Registry composition, and Runtime execution;
- Editor Preview requests carry intent/identity, not compiler/backend policy;
- Runtime remains artifact-only;
- attached startup is successful-publication-first;
- last-good and stale/current truth remain explicit;
- Preview artifacts remain backend-specific;
- Material Program and arbitrary parameter/resource binding remain separate future work.
