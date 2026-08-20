# GGLab Surface Contract Freeze — `gglab.surface` v1

> Status: decision record — frozen (stage B1)
> Nature: explicit freeze decision for the initial `gglab.surface` profile contract, following Gate 0 (v0.2 §5.2 / §40). This is a decision record and evidence trail, not a new architecture specification, and not an implicit amendment to `GGLab_Shader_Graph_Editor_Architecture.md` v0.2.
> Normative machine-readable contract: `graphics-gadget-lab` main repo → `Shaders/Profiles/GGLab.Surface/1/descriptor.json` (`descriptorVersion: 1`, `profileVersion: 1`).
> Relationship rule: the descriptor JSON is the authoritative machine-readable contract; this document is the rationale/evidence record. Where this document and the descriptor disagree semantically, that is a validation/review failure — do not silently select one side or synthesize a third reading.

---

## 1. Scope of this freeze

Gate 0 proved the seam; this record decides which parts of the proven seam become the frozen authoring/profile contract, and it publishes the authoritative concrete `gglab.surface` descriptor instance in the main repo.

What this freeze does **not** do:

- does not implement `shader-graph-core`, an emitter, or any node library;
- does not modify the shader-editor repo;
- does not build a second generic Surface Profile Descriptor framework/schema (the descriptor below is one concrete instance of the v0.2 §15 contract);
- does not make `MaterialData` / `MaterialGPU` a ShaderGraph ABI;
- does not start Material Program / runtime parameter integration (v0.2 §39 / Slice 5);
- does not extend the `gglab-shaderc` CLI/process protocol.

The three artifacts remain strictly separate:

```text
observed Gate 0 implementation shape   (evidence, in main repo code)
frozen gglab.surface authoring contract  (this decision + descriptor semantics)
serialized descriptor instance           (descriptor.json, normative machine-readable data)
```

---

## 2. Freeze evidence (Gate 0)

The following main-repo items are the evidence inputs for this freeze. Gate 0 proved the seam; this record decides what is frozen.

| Evidence | File (main repo) | What it proves |
|---|---|---|
| Profile-shaped hand-authored seam | `Shaders/Common/SurfaceEvaluation.hlsli` | `SurfaceData { BaseColor: float3, Emissive: float3, Metallic: float, Roughness: float, Opacity: float }` resolved from the runtime-driven `MaterialData` plus `uv0`/`uv1`; comment fixes the sampling stance (reuse of the existing texture+sampler binding; sampler authoring deferred) and the pass-owned boundaries (normal perturbation, BRDF clamps, alpha policy) |
| Real consumer of the seam | `Shaders/Passes/PassForwardPBR.hlsl` (`PSMain`) | existing Forward PBR lighting consumes surface quantities; `Opacity` is resolved through pass-owned `ResolveMaterialAlpha` (alpha mode/cutoff/discard stay pass-side) |
| Compile-contract evidence | `Shaders/Tests/SurfaceContractCompile.hlsl` | the profile shape compiles standalone as a pixel-stage entry; the comment explicitly states the `MaterialData` layout is "intentionally not declared as the permanent ShaderGraph binding shape" |
| Production-DXC contract check | `Tests/GGLabRuntime/RenderingContractSelfTests.cpp` | production DXC compiles the `gglab.surface` surface-evaluation seam contract (check text: "profile shape and the runtime MaterialData input") |
| Surface Probe Lab (A/B fixtures) | `Sources/Application/Application/Lab/Sessions/SurfaceProbeLabSession.{h,cpp}`, Lab id `gglab.lab.surface_probe` | named fixtures `surface_probe.base_color_factor` (A dark gray (0.10, 0.10, 0.10) / B orange (0.90, 0.28, 0.10)) and `surface_probe.base_color_texture` (A `BaseColorWhite` 1×1 solid white / B `MissingTextureChecker` 64×64 checker) driven through the normal runtime material update path; mechanical CPU-side fixture checks |
| Current binding/sampling representation | `Shaders/Common/MaterialUtils.hlsli`, `Shaders/Common/MaterialSampling.hlsli` | `SelectUV(binding, uv0, uv1)`; `SampleTextureBinding(TextureSamplerBindingData, uv)`; per-binding `TexCoordIndex` |
| Normative baseline | `GGLab_Shader_Graph_Editor_Architecture.md` v0.2 | §5 (Gate 0 rules), §12 (candidate profile), §15 (descriptor contract), §16 (sampling semantics), §21 (process contract), §28 (testing), §30 (error handling), §34 (invariants), §35 (deferred), §36 (rejected), §40 (engineering order) |

---

## 3. Frozen decisions

Each decision below is reflected in the descriptor under the named field. `descriptor.json` is the normative statement.

### A. Generated-function contract

Options considered:

1. Freeze the exact Gate 0 signature `EvaluateSurface(MaterialData, float2, float2)` as the authoring contract — **rejected**: it would make the C++/HLSL runtime struct `MaterialData` a permanent ShaderGraph ABI, which Gate 0 explicitly declined (`SurfaceContractCompile.hlsl` comment) and the v0.2 §39/Slice-5 boundary forbids.
2. Freeze a logical generated-function boundary — **adopted**.

Decision (descriptor: `generatedFunction`):

- The profile's generated HLSL defines a **pixel-stage** function named **`EvaluateSurface`** (name kept for conformance identity and Gate 0 traceability; only the parameter shape is contractual, not the Gate 0 `MaterialData` parameter).
- It returns an object named **`SurfaceData`** whose fields are exactly the `requiredOutputs` entries, in descriptor list order.
- Parameters, in frozen order: first the graph-declared surface parameters (each constrained to a `parameterClasses` entry with a class-legal value type), then the `graphVisibleInputs` in descriptor order. In profileVersion 1 the final parameter is therefore always `float2 uv0`.
- **Runtime adapter**: mapping concrete material state (factors, per-resource texture+sampler, parameter values) into the generated function's logical inputs is a main-repo runtime obligation (the material-binding/Material Program layer, v0.2 §39 / Slice 5). The descriptor deliberately contains **no `MaterialData`/`MaterialGPU` field mirroring** — it freezes the logical profile contract, not a runtime struct ABI.

### B. Required outputs

Decision (descriptor: `requiredOutputs`, `outputFieldOrdering`):

| Field | Type | Required | Frozen semantic boundary |
|---|---|---|---|
| `BaseColor` | `float3` | yes | linear-RGB albedo contribution (pre-lighting) |
| `Emissive` | `float3` | yes | linear-RGB emissive contribution (pre-lighting) |
| `Metallic` | `float` | yes | metallic factor; BRDF interpretation is pass-owned |
| `Roughness` | `float` | yes | perceived roughness factor; BRDF clamping is pass-owned (evidence: `ClampPerceptualRoughnessForBRDF` in pass) |
| `Opacity` | `float` | yes | raw surface alpha before alpha-mode resolution; alpha mode/cutoff/discard are pass-owned (evidence: `ResolveMaterialAlpha` in pass) |

All five are required in profileVersion 1 (no optional outputs in v1). The descriptor list order is the canonical emitted field order of `SurfaceData`; identity is by name, order is normative for deterministic emission. This matches the v0.2 §12.1 candidate set, which Gate 0 confirmed; the set is frozen by decision, not merely copied from the current struct. Normal/tangent-space outputs remain deferred (see §5).

### C. Graph-visible inputs (UV0 / UV1 decision)

Decision (descriptor: `graphVisibleInputs`):

- **v1 graph-visible input: `uv0` (`float2`) only.**
- **UV1 decided: NOT graph-visible in profileVersion 1.**

Rationale:

- v0.2 §12.2 names **UV0** as the initial authoring input; UV1 was never a v1 graph-input candidate in the normative baseline.
- `EvaluateSurface(matData, uv0, uv1)` is runtime implementation evidence for the hand-authored seam, not an authoring contract. The per-`TexCoordIndex` UV selection (`SelectUV`) and the model-import UV assignment (`ModelImporter`) are runtime/material-binding semantics; they do not imply graph-level authority over UV1.
- Freezing UV1 would enlarge the v1 authoring surface without a proven Gate 0 need; keeping it out is the narrow, evidence-consistent choice.

This is an explicit v1 decision, not a TBD: Shader Editor B2 must **not** add `uv1` as a graph-visible input against profileVersion 1. Adding a second texture-coordinate graph input is a profileVersion 2 semantic change owned by the GGLab profile owner (with editor proposal).

### D. Parameter classes

Decision (descriptor: `parameterClasses`, `deferred.parameterClasses`):

| Class | Allowed value types in v1 |
|---|---|
| `ScalarParameter` | `float` |
| `VectorParameter` | `float2`, `float3`, `float4` |
| `Texture2DParameter` | resource class `Texture2D` |

Explicitly deferred (descriptor: `deferred.parameterClasses`):

- `BoolParameter` (`bool`) — deferred until a real node requires it (v0.2 §11 / §35).
- `SamplerParameter` (first-class `Sampler` values/edges) — not a first-class v1 graph value (v0.2 §11 / §16 / §35).

Deferral decisions are owned by the GGLab profile owner, proposed through the shader-editor repo's conformance/tests when a real need arises. The descriptor contains no generic node/type registry — only these classes and their value-type constraints.

### E. Resource classes

Decision (descriptor: `resourceClasses`):

- v1 resource class: **`Texture2D`**, sampled value type `float4`.

This is the profile resource contract only. It does not describe RenderGraph resources, RHI descriptor heaps, `MaterialGPU` layout, or any backend binding implementation (v0.2 §6 / §16 placement).

### F. Sampling contract

v0.2 §16 gave three options; Gate 0 proved one:

1. **reuse existing logical texture+sampler binding semantics — adopted** (evidence: `SurfaceEvaluation.hlsli` comment; `SampleTextureBinding` path exercised by `gate0_probe.base_color_texture`);
2. profile-owned default sampler policy — not adopted (Gate 0 did not prove a profile-owned policy);
3. another narrow representation — not needed.

Decision (descriptor: `samplingContract`), all structured/machine-readable:

- `policy: reuseRuntimeTextureSamplerBinding` for resource class `Texture2D`;
- **fixed now**: each **logical `Texture2D` binding** carries **one resolved sampler state** (`cardinality: oneSamplerPerTexture2DBinding`), resolved at draw time by the **material binding layer** (`owner: materialBindingLayer`) — the same texture+sampler binding-pair representation the current runtime path uses; the same physical texture resource may appear in multiple logical bindings with different sampler resolutions, which this contract does not forbid;
- **deferred**: first-class sampler values/edges, authorable filter modes (`authorableFilterModes: []`), authorable address modes (`authorableAddressModes: []`), comparison-sampler authoring — exactly the v0.2 §35 deferral list;
- **owner of the deferred decisions**: GGLab Shader Toolchain / runtime domain per the v0.2 §6 responsibility matrix ("GGLab surface/profile ABI — GGLab Runtime/Shader Toolchain domain"), with proposals from the shader-editor repo.

The descriptor's `samplingContract` is structured data, not natural-language protocol text; prose rationale lives only in this record and in v0.2 §16.

### G. Required includes / shared HLSL dependencies

Decision (descriptor: `requiredIncludes: []`):

- **No normative required include is frozen in v1.**
- Distinction made explicit: the **logical profile dependency** of the generated surface HLSL — sampling a `Texture2D` resource through a runtime-supplied texture+sampler binding — is already captured structurally by `samplingContract`, so it is not additionally frozen as file paths.
- The current implementation includes (`Common/SurfaceEvaluation.hlsli` including `Common/MaterialUtils.hlsli` → `Common/MaterialSampling.hlsli` → `Common/BindlessResources.hlsli` / `Common/BufferLayout.hlsli`) are the hand-authored Gate 0 integration location in the main repo. They are **runtime implementation includes, not the generated-HLSL contract**. Freezing path names would couple the profile contract to a repo layout and would re-open on any refactor.
- The concrete runtime-side adapter for generated programs (how their resources/parameters attach to the material state) is a runtime-owned milestone (v0.2 §39 / Slice 5), not a descriptor field.

### H. Process contract (`gglab-shaderc`)

Observed current state (verified in code, main repo):

- Tool identity: `gglab-shaderc`; `toolVersion = "1.0.0"` (`Sources/Tools/ShaderCompiler/ShaderCompilerCommandLine.h`); `--version` is **human-readable only** today.
- Targets: `gglab-dx12`, `gglab-vulkan13` (`targets` command, human-readable).
- Machine-readable compile result contract (D6, toolchain extraction doc §22/§38.3): `compile --result-format json` emits a single JSON envelope on stdout (stderr empty in JSON mode), success fields `command, success, status, exitCode, recipeId, buildKey, binaryHash, binaryFormat, target, binaryPath, cacheRecordPath, fromCache, diagnostics`; failure statuses `usage-error, invalid-request, source-not-found, compiler-unavailable, compile-failed, artifact-io-failure, source-changed`; exit codes `0/2/3/4/5/6`; `binaryFormat` ∈ {`dxil`, `spirv`}. Verified against `Sources/Tools/ShaderCompiler/Main.cpp` and `Tests/GGLabRuntime/ShaderCompilerCliContractSelfTests.cpp`.
- Gap: the v0.2 §21 full handshake (machine-readable `processContractVersion`, `toolVersion`, producer identity, targets, capabilities, artifact schema) does **not** exist yet — `--version`/`targets` are human-facing (toolchain D6 explicitly deferred machine-readable version: "如需 machine-readable version 另行设计").

Decision:

- The current machine-readable **compile result contract plus the concrete tool version/target facts are sufficient for the descriptor freeze**: the required compatibility information exists as concrete, tool-owned facts. The descriptor declares only the **narrow tool identity/version requirement** (descriptor: `processContract.tool`): identity `gglab-shaderc`, `minimumVersion: "1.0.0"` with `versionComparison: "semver"` (a concrete bound — no floating `"latest"`). It deliberately does **not** mirror the tool's own schema: supported targets/capabilities are declared by the tool through future machine-readable discovery and judged at readiness (v0.2 §20/§21, Slice 2), and the compile-result schema (status/exit-code/binary-format vocabulary, result fields) is owned by the `gglab-shaderc` process contract (D6). `gglab.surface` is backend-neutral: target support is a toolchain discovery question, not a profile-level requirement, so the profile does not require all known backends simultaneously and does not copy the CLI status/exit/field vocabulary (which would couple profile/descriptor versions to unrelated CLI evolution).
- **Reported gap (not implemented here)**: a machine-readable tool discovery output (e.g. `--version --json` or a `discovery` command) exposing `processContractVersion`, `toolVersion`, producer/compiler identity, supported targets, capabilities, and artifact schema compatibility.
  - Why it is not a freeze blocker: the descriptor only needs concrete compatibility requirements, which the current contract facts provide.
  - Where it blocks: v0.2 §20/§21 editor tool-discovery/readiness (Slice 2) must not parse human `--version` prose as the durable contract.
  - Smallest proposed follow-up (owner to approve; **not started**): extend `gglab-shaderc` with a machine-readable discovery command/version flag emitting the §21 fields as one JSON document; likely files: `Sources/Tools/ShaderCompiler/{Main.cpp, ShaderCompilerCommandLine.{h,cpp}}`, `Tests/GGLabRuntime/ShaderCompilerCliContractSelfTests.cpp`, and docs §22 sync.
  - Owner: GGLab Shader Toolchain (main repo).

No new CLI protocol, capability-negotiation framework, or generic version-handshake system is introduced by this freeze.

---

## 4. Version model

Two independent axes, both already present as descriptor fields.

### `descriptorVersion` (serialization/schema axis)

- Meaning: version of the **Surface Profile Descriptor serialization format**.
- Bump rule: any change to the descriptor document format — adding, removing, renaming, or re-structurizing fields, or changing how a field is read — requires a new `descriptorVersion`.
- Reader behavior: a reader MUST reject a `descriptorVersion` outside the range it explicitly supports, with an explicit diagnostic (v0.2 §9.4: unknown/newer data fails or degrades explicitly — never silently reinterpret). Within one supported `descriptorVersion`, unknown fields are not expected and are not silently ignored.
- Backward-compatible evolution: only via a new `descriptorVersion`; readers declare the versions they support (v0.2 §20/§21.1 selection rules apply).

### `profileVersion` (semantic axis)

- Meaning: version of the **`gglab.surface` semantic contract** (what the descriptor values say, not how they are serialized).
- Bump rule: any of the following changes the frozen semantics and requires a new `profileVersion`:
  - adding / removing / changing a required output (name, type, requiredness, semantic);
  - changing the graph-visible input set (e.g. a future `uv1`);
  - changing sampling semantics (policy, sampler resolution owner/cardinality, authorable modes);
  - changing parameter/resource classes (add/remove a class, change its class-legal value types);
  - changing the generated-function contract (name, stage, return object, parameter order rule);
  - changing the `deferred` set in a way that alters what is legal (e.g. promoting a deferred class to allowed).
- Breaking vs compatible: a published `profileVersion` is a **frozen point**; any semantic mutation publishes a new `profileVersion`. There is no "compatible semantic drift" within a version. Multiple `profileVersion` instances are retained (one directory per version: `Shaders/Profiles/GGLab.Surface/<profileVersion>/descriptor.json`) so consumers keep their requested profile line.
- Graph declaration: a `.shadergraph` document declares `profileId` + `profileVersion` (v0.2 §9.1); the editor selects within the requested profile line at the highest supported `descriptorVersion` (v0.2 §20/§21.1) and never implicitly upgrades a graph to another profile/profileVersion (v0.2 §34 invariant 16).
- Prohibition: no floating compatibility bound (`"latest"` or equivalent) anywhere in the descriptor; only concrete versions, concrete bounds, or structured rules that the existing process contract defines.

---

## 5. Deferred decisions (v1 status, explicit)

| Deferred item | Status in profileVersion 1 | Owner of the future decision |
|---|---|---|
| `BoolParameter` (`bool` graph value) | deferred (v0.2 §11 / §35); descriptor `deferred.parameterClasses` | GGLab profile owner + shader-editor proposal |
| `SamplerParameter` (sampler values/edges) | deferred (v0.2 §16 / §35); descriptor `deferred.parameterClasses` | GGLab profile owner + toolchain |
| Sampler filter/address/comparison authoring | deferred (v0.2 §35); descriptor `samplingContract.*` fields | GGLab toolchain/runtime domain (v0.2 §6) |
| Normal/tangent-space surface outputs | deferred (v0.2 §12.1); descriptor `deferred.surfaceOutputs` | GGLab profile owner |
| `uv1` as graph-visible input | **decided out of v1** (not merely TBD — see §3.C) | GGLab profile owner (profileVersion 2 decision) |
| Material Program / runtime parameter+resource integration | out of scope (v0.2 §39 / Slice 5); runtime-owned adapter obligation | GGLab main repo |
| Custom HLSL escape hatch | deferred (v0.2 §35 / §36); must stay inside the active profile contract if ever introduced | GGLab profile owner |
| Machine-readable tool discovery handshake (v0.2 §21 fields) | deferred — smallest follow-up reported in §3.H, **not approved, not implemented** | GGLab Shader Toolchain |

---

## 6. Explicit non-captures (red-line compliance)

- No `shader-graph-core`, emitter, node registry, DAG/type/optimizer, or second generic compiler framework is introduced by this freeze or its descriptor.
- No node semantics, channel-output definitions (`SampleTexture2D` RGBA/RGB/...), graph type inference, React Flow, editor UI, or Shader Editor repository content appears in the descriptor (v0.2 §15 must-not list).
- `MaterialData` / `MaterialGPU` fields are **not** mirrored into the descriptor; the runtime struct stays a runtime binding detail.
- No RenderGraph / RHI / descriptor-heap / backend binding semantics in the resource or sampling contract.
- The shader-editor repo is read-only for this task and its contents are not modified.
- No commit/push/checkout/reset is performed as part of this freeze.

---

## 7. Traceability (decision → evidence → descriptor field)

| Frozen decision | Evidence basis | Descriptor field |
|---|---|---|
| generated function name/stage/return object/parameter order | §5.1 seam requirement; `SurfaceEvaluation.hlsli`; `SurfaceContractCompile.hlsl` (pixel entry, non-permanent-ABI comment) | `generatedFunction` |
| five required outputs, all required, canonical order | `SurfaceData` shape; `PassForwardPBR.hlsl` consumption; v0.2 §12.1 | `requiredOutputs`, `outputFieldOrdering` |
| `uv0` only graph-visible; UV1 out | v0.2 §12.2 (UV0 candidate); UV1 absence from §12.2; Gate 0 fixtures exercised on the base-color path | `graphVisibleInputs` |
| parameter classes + deferred bool/Sampler | v0.2 §11 / §12.3 / §35; Gate 0 scalar-factor + `Texture2D` fixtures | `parameterClasses`, `deferred.parameterClasses` |
| `Texture2D` resource class | v0.2 §16; `gate0_probe.base_color_texture` | `resourceClasses` |
| sampling policy + sampler deferrals | `SurfaceEvaluation.hlsli` comment; `MaterialSampling.hlsli`; v0.2 §16/§35 | `samplingContract` |
| no normative includes | v0.2 §15 (conditional); implementation-include distinction (§3.G) | `requiredIncludes` |
| narrow tool identity/version compatibility requirement | `ShaderCompilerCommandLine.h`, `Main.cpp`, CLI contract tests; toolchain doc §22/D6 | `processContract` |

---

## 8. Verification (B1)

- Descriptor JSON parse: **PASS** — `Shaders/Profiles/GGLab.Surface/1/descriptor.json` parsed by a strict JSON parser; key values confirmed round-trip (`descriptorVersion` 1, `profileId` `gglab.surface`, `profileVersion` 1, five `requiredOutputs`, `graphVisibleInputs` = `uv0`, three `parameterClasses`, `requiredIncludes` empty, `processContract` = tool identity/minimum-version anchor only).
- Main repo MSBuild (Debug / x64, full solution): **PASS** — build succeeded, 0 warnings, 0 errors (includes the descriptor `None` item added to `Application.vcxproj` by `Scripts/SyncShadersToVS.ps1` and the regenerated filters). Note: in the B1 sandboxed environment the `/m` parallel-node invocation is process-killed (reported failure with 0 errors — an environment limitation on MSBuild worker nodes); the sequential full-solution build is the authoritative green result.
- `GGLabRuntimeTests.exe --suite rendering-contracts`: **PASS** — `rendering-contracts self-tests passed (186 checks)`, exit code 0; includes the check "Production DXC compiles the `gglab.surface` surface evaluation seam contract".
- Shader-editor repo: unchanged (read-only for this task).
- Docs repo: no build required.
- No commit/push performed in any repository.
