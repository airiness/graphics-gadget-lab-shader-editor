# Toolchain probe: graph-generated surface functions as native HLSL

## Background (2026-08)

The editor's first live `Compile` (generated function staged as the source,
`--stage pixel --entry EvaluateSurface`) was rejected by DXC with:

```text
hlsl.hlsl:19:1: error: Semantic must be defined for all outputs of an
entry function or patch constant function
SurfaceData EvaluateSurface( ^
```

Investigation resolved this as a **contract-level misuse, not an emission
bug**: the `generatedFunction` block of the profile descriptor is a
**function** contract, while the compile CLI's `--stage/--entry` are a
**program** contract (canonical self-tests compile the profile contract
file with `m_Entry = L"PSMain"`; the production Forward PBR pass takes
`EvaluateSurface` through `Common/SurfaceEvaluation.hlsli` and its entry is
`PSMain : SV_Target`). A bare generated function is not a valid pixel entry
on its own; the semantics are pass-owned. `gglab-shaderc` has no
surface-program mode (no profile knowledge in its sources) — it compiles
what the CLI tells it to.

So the generated function's native-correctness must be proven by composing
it into a **full program** the contract way, exactly like the canonical
contract tests do — which is what this probe does.

## Files and provenance

Both generated files were emitted from the committed, clean
`shader-graph-core` state at editor commit
`6d4307dcccd12bc355a1d79683f5489b6f0c78ae`. The editor worktree carried
unrelated UI changes, but `packages/shader-graph-core/` had no local diff.

| File | Origin |
| --- | --- |
| `generated-surface-function.hlsl` | **Byte-exact ShaderGraphCore output** for `hlsl-emitter.test.ts::baseDocument()` (`profileVersion 1`: parameters `p.metal`/`p.tint`, all five required outputs). Do not edit. |
| `surface-probe-compile.hlsl` | Main-repository-shaped, hand-authored `PSMain : SV_Target` harness for the v1 function. |
| `generated-surface-function-v2.hlsl` | **Byte-exact ShaderGraphCore output** for `hlsl-emitter.test.ts::textureDocument()` (`profileVersion 2`: the `uint2` texture/sampler pair and bindless `Sample` form). Do not edit. |
| `surface-v2-probe-compile.hlsl` | Main-repository-shaped, hand-authored `PSMain : SV_Target` harness for the v2 function. |

## Generated-source identities

| Profile version | Generated file | SHA-256 / `generatedSourceIdentity` | Bytes |
| --- | --- | --- | ---: |
| 1 | `generated-surface-function.hlsl` | `b702b5a5483d97342cdbe5c4bd5aa36d3d16c9f8d42d1b10ca03128ae56db5d3` | 689 |
| 2 | `generated-surface-function-v2.hlsl` | `82c16e3d6540739178e76d44632166fec3d7fd1898c360e07e8304c4899cb604` | 1084 |

## How to run (main repository's toolchain binary)

Use the canonical contract invocation (`GGLab_Shader_Toochain_Extraction.md`
§21), with the probe directory as both source root and explicit include root.
Use writable cache and artifact roots; these are derived output and are not
probe evidence:

```powershell
$Tool = "<main-repo>\Build\Output\x64\Debug\gglab-shaderc.exe"
$Probe = "<editor-repo>\tests\toolchain-probe"
$Cache = "<main-repo>\Build\SurfaceGeneratedProbe\Cache"
$Artifacts = "<main-repo>\Build\SurfaceGeneratedProbe\Artifacts"

& $Tool compile --source-root $Probe --include $Probe `
  --source surface-probe-compile.hlsl --stage pixel --entry PSMain `
  --target gglab-dx12 --cache-root $Cache --artifact-root $Artifacts `
  --result-format json
```

Repeat with `gglab-vulkan13`, then repeat both targets with
`surface-v2-probe-compile.hlsl`.

### Include-resolution note (learned the hard way, 2026-08-26)

- The toolchain stages the entry source under a fixed name (every error
  references `hlsl.hlsl`), so a QUOTE include (`#include
  "generated-surface-function.hlsl"`) resolves against the staging
  directory and fails with `file not found`.
- The working form is the canonical main-repo pattern: ANGLE-BRACKET
  include (`#include <generated-surface-function.hlsl>`) resolved against
  the toolchain's include search path, made explicit here with the
  repeatable `--include <path>` (CLI §21) pointing at this directory.

## Interpretation

- **success** (JSON document: `success:true`, and `binaryFormat` matches
  the requested target): the graph-generated surface function **is valid
  HLSL under its frozen gglab.surface profile version** when composed into
  a contract-conformant program. This closes AGENTS.md's second verification step
  ("the generated HLSL compiles natively") under the main repo's
  toolchain authority.
- **failure**: the returned diagnostics now name the actual
  function-level error (signature, types, or emission content) — no longer
  the entry/semantic mismatch that the mis-compiled-function invocation
  produced. Read them as evidence about the generated function.

## Qualification result

The original v1/DX12 investigation succeeded on 2026-08-26. On 2026-08-29,
the complete profile-version/target matrix was re-run with
`gglab-shaderc describe` reporting tool version `1.2.0`, process contract
version `2`, compile-policy revision `1`, producer identity
`1.9+5402.0d3ee6b5`, and both published targets.

| Profile version | Target | Format | Binary hash | Recipe ID | Build key | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `gglab-dx12` | `dxil` | `491bc48ae92b0e032ce79e645ee3636fb54e7d9ce07f28ca7e55d39de3b8e43e` | `42a318e6898c4689468b7be505831501fc41c503ec1bc7b9e54c2447ebc2f212` | `c55bfe33c64149645c92f70c68abfbc67e614a2aa1d587053d8ff2bb7a6ae5f0` | `status=ok`, `exitCode=0`, `fromCache=false`, diagnostics empty |
| 1 | `gglab-vulkan13` | `spirv` | `c45e3f3b7016118724f32b63a93bf4ced7f8fa5e06105bdb4d183ce38626bff4` | `bee0bfe1b8a5db920024f97f76719c27c2ff9dae9c295f4edd2e3b94b9b2c8a6` | `57b10d2783ea50ff34e0a61c8f24496d0b67eca1f4281e1a5b2244316841bd21` | `status=ok`, `exitCode=0`, `fromCache=false`, diagnostics empty |
| 2 | `gglab-dx12` | `dxil` | `75a423172be2e5e14d13894cf6d9f914bc090cef36c9ea518c372b90086bd19e` | `d2d45f4edc733ce5423360f3e8b881c7a0dcc3ffc9a4c21a98281123a2d1e9e8` | `baefe4ce99eccc6a7a5ce41476bdd4d82e3bf371e2a38b61dcdaf42f39835769` | `status=ok`, `exitCode=0`, `fromCache=false`, diagnostics empty |
| 2 | `gglab-vulkan13` | `spirv` | `c3b5afc8d1ab70e3aea195dff47b2e47333c98bfde8f56e73ab7e081c49dfaeb` | `1b30c856991bf352a6b3af16082fa213e20ac641afdde19e3e0df22faa317a8c` | `63338d2072b89dc8e8d772635fa0e598cbd637a949f3e15069df184cbff086ab` | `status=ok`, `exitCode=0`, `fromCache=false`, diagnostics empty |

Conclusion: both pinned generated functions are valid native HLSL on both
published targets when composed into contract-conformant programs. This
does NOT close the product-artifact question: pass-owned entry semantics,
material binding, and Runtime consumption remain the main repository's
composition obligation.

## Non-product scope

These files are one-off verification fixtures for the surface-program
composition investigation. They are not product content and not a new contract. The
durable gate for "editor output satisfies the gglab.surface line" is
option B — a profile-contract self-test in the main repo that compiles the
graph-generated function inside the contract program — and the product
question (what the editor's Compile produces as an artifact) is the
deferred contract decision (option C).
