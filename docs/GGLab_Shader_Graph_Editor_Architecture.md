# GGLab Shader Graph Editor — Authoring Architecture

> Status: Proposed Architecture v0.4  
> Scope: Shader Graph authoring model, first-class authoring frontends (GUI and CLI), editor application architecture, graph-to-HLSL compilation, Shader Toolchain integration, diagnostics, preview, and the minimum GGLab Runtime integration seam  
> Authority relationship: Extends the authoring side of `GGLab_Shader_System_Architecture.md`; does not replace Shader Toolchain or Runtime architecture  
> Primary target: Windows desktop development workflow for Graphics Gadget Lab, plus a headless CLI surface for the same workflow  
> Revision note: v0.3 adds the first-class CLI authoring frontend (machine/automation authoring over the same headless core) as a normative product boundary. v0.2 folds the architecture-review amendment and subsequent review closure into this single normative proposal. v0.4 records the Slice 2 owner decisions: the strict native-build readiness gate (no bypass), the Toolchain Client as a sibling domain of ShaderGraphCore, the narrow Tauri ShaderToolService with Rust as bounded execution only, service-owned staging of generated sources, target as explicit build configuration, the CLI build deferral, and the external ownership of the toolchain handshake wire contract.

---

# 1. Purpose

GGLab already has a target Shader architecture in which ShaderGraph is an HLSL producer, `gglab-shaderc` is the Shader Toolchain frontend, `ShaderToolchainCore` owns compilation policy and artifact production, and Runtime consumes `ShaderArtifact` data.

The missing layer is a concrete authoring architecture for a node-based Shader Graph editor.

The goal is not merely to build a visually attractive node canvas. The design must establish durable boundaries between:

- graph authoring semantics;
- editor presentation and interaction;
- HLSL generation;
- native Shader compilation and artifact production;
- cross-repository profile/tool compatibility;
- diagnostics and observability;
- native Shader preview;
- the production GGLab Runtime.

The core rule is:

> **Web technology owns the GUI authoring experience. ShaderGraphCore owns ordinary ShaderGraph semantics. The CLI provides the headless machine/automation authoring frontend. The existing C++ Shader Toolchain owns Shader production. ShaderArtifact remains the Runtime boundary. GGLab Runtime remains the native rendering truth.**

This lets the editor evolve rapidly without creating a second Shader compiler, a second backend policy, a second material ABI, or a second renderer.

---

# 2. Existing architectural authority

This proposal starts from the existing Shader architecture rather than inventing a parallel system.

`GGLab_Shader_System_Architecture.md` defines:

```text
.shadergraph
     ↓
ShaderGraphCompiler
     ↓
Generated HLSL
     ↓
gglab-shaderc
     ↓
ShaderArtifact
```

`ShaderGraphCompiler` owns:

```text
Graph semantics
type checking
node semantics
graph optimization
HLSL generation
```

It does **not** own:

```text
DXC
SPIR-V lowering
DX12 target policy
Vulkan binding ABI
Shader artifact cache
```

The same architecture requires preview and production to consume the same artifact ABI whenever practical. In this v0.3 proposal, `ShaderPreview Runtime` is a role, not a requirement to build a second renderer executable.

`GGLab_Shader_Toochain_Extraction.md` additionally establishes two relevant constraints:

1. `gglab-shaderc` should expose a machine-readable process contract so tools do not scrape human console text.
2. GGLab should not build a large generic compiler framework merely in anticipation of future ShaderGraph work.

This document fills the authoring side above `gglab-shaderc` and defines the minimum seam into the real GGLab Runtime. It does not reopen Shader Toolchain ownership.

---

# 3. Goals

The editor should eventually provide:

- a polished desktop node-authoring experience;
- a durable `.shadergraph` format independent of React Flow;
- typed nodes and typed ports;
- deterministic graph validation and compilation;
- deterministic HLSL generation;
- graph diagnostics before native compilation;
- native compilation through `gglab-shaderc` only;
- structured artifact/build inspection;
- compiler diagnostics mapped back to ShaderGraph nodes;
- native preview through the same GGLab Runtime contracts used by production;
- a headless graph compiler usable from tests and future tooling;
- a first-class CLI authoring frontend for AI agents, CI, automation, and batch tooling over the same headless core;
- enough observability to trace graph → HLSL → native compile → artifact → preview/runtime.

The architecture should also be friendly to coding-agent-assisted development: UI, graph behavior, tests, and authoring features should be easy to evolve without exposing compiler or RHI internals to the editor.

## 3.1 Non-goals

The first architecture does **not** attempt to:

- replace `gglab-shaderc`;
- move DXC invocation into TypeScript or Rust;
- duplicate DX12/Vulkan target policy in the editor;
- generate WGSL/GLSL as a second production Shader path;
- make WebGL/WebGPU the Shader-correctness authority;
- introduce a generic multi-language Shader IR framework;
- serialize React Flow state as the `.shadergraph` contract;
- make Zustand state a persisted authoring contract;
- implement a complete Unreal-style Material system;
- implement every possible node;
- solve embedded native GPU preview first;
- redesign ShaderArtifact, Runtime ShaderManager, RenderGraph, or RHI as part of editor work;
- use ShaderGraph work to drive an immature backend toward parity.

---

# 4. Target system architecture

The following is the **authoritative overview diagram for this proposal**.

```text
┌───────────────────────────────────────────────┐
│             ShaderGraphEditor.exe             │
│                                               │
│ Tauri 2                                       │
│   │                                           │
│ React + TypeScript                            │
│   ├─ React Flow        Node Canvas            │
│   ├─ Zustand           Editor State           │
│   ├─ Tailwind/shadcn   UI                     │
│   └─ Monaco            HLSL / Diagnostics     │
│                                               │
│        ShaderGraphCore  ← pure TypeScript     │
│          │                                    │
│          ├─ Schema                            │
│          ├─ Type system                       │
│          ├─ Validation                        │
│          ├─ DAG compiler                      │
│          ├─ HLSL emitter                      │
│          └─ Source map                        │
└──────────────────┬────────────────────────────┘
                   │
             Generated HLSL
                   │
                   ▼
             gglab-shaderc.exe
                   │
                   ▼
          ShaderToolchainCore.lib
                   │
                   ▼
                  DXC
              ┌────┴────┐
              ▼         ▼
             DXIL     SPIR-V
              └────┬────┘
                   ▼
            ShaderArtifact
                   │
                   ▼
     GGLabRuntime / Renderer / RG / RHI
              ┌────┴──────────────┐
              ▼                   ▼
 Shader Graph Preview Lab   Production GGLab
```

The architecture is intentionally asymmetric:

- the editor is optimized for authoring and interaction;
- the native Shader Toolchain is optimized for reproducible Shader production;
- GGLab Runtime is optimized for artifact consumption and GPU execution;
- the first authoritative preview is a consumer of GGLab Runtime, not a parallel renderer.

No layer should reimplement the responsibility of the layer below it.

---

# 5. Gate 0 — Surface Integration Probe

The highest-risk unknown is not the React editor. It is whether a generated `gglab.surface` program can cross the real GGLab material/runtime seam cleanly.

Therefore implementation begins with **Gate 0**, before Slice 1 invests heavily in node vocabulary or preview UX.

Gate 0 is a **narrow GGLab-side contract probe**, not a Material-system rewrite.

## 5.1 What Gate 0 must prove

Gate 0 must prove both directions of the seam:

```text
externally driven material values/resources
        ↓
initial surface input/parameter seam
        ↓
hand-authored EvaluateSurface(...)
        ↓
initial surface output seam
        ↓
existing GGLab Forward PBR lighting
        ↓
RenderGraph / RHI
        ↓
observable GGLab Lab result
```

`EvaluateSurface(...)` above names the intended seam shape, not an already-existing GGLab function.

At the current GGLab implementation point, the candidate hook site is the material-evaluation region inside `Shaders/Passes/PassForwardPBR.hlsl::PSMain`: after `MaterialData` is loaded from `g_Materials[IN.MaterialIndex]` and before resolved base-color/metallic/roughness/normal-style surface quantities feed the existing lighting path. Existing helpers such as `SampleMaterialBaseColor(...)` and `SampleTextureBinding(...)` are part of the current material-evaluation route.

The Gate 0 implementation must re-confirm and record:

- the exact Forward PBR shader hook site used by the probe;
- the minimal shader/helper/source-file set modified to establish the seam;
- which existing material/runtime inputs are reused unchanged;
- which narrow wrapper/helper is newly introduced by the probe.

If a clean `EvaluateSurface(...)`-style boundary does not already exist, creating the smallest such boundary is a **Gate 0 result**, not a pre-existing contract assumed by this document.

A constant-only surface is **not** sufficient evidence.

At minimum, PASS requires:

- one hand-authored profile-shaped surface function/wrapper consumed by the real GGLab Forward PBR path;
- at least one externally driven scalar or vector material input whose changed value produces an observable surface change;
- at least one externally driven `Texture2D` input whose changed resource/content produces an observable surface change;
- the proposed surface output seam is consumed by existing GGLab lighting without a second renderer;
- compilation goes through the real GGLab Shader Toolchain path;
- no React/Zustand/editor-session state leaks into Runtime/RHI contracts;
- no backend-specific editor ABI is introduced;
- the observed input/output/resource seam is documented precisely enough to freeze a first surface contract.

Gate 0 uses named reproducible probe fixtures rather than ad-hoc manual values:

```text
gate0_probe.base_color_factor
    A → B through the normal Runtime/material update path
    expected: a known observable surface-color change

gate0_probe.base_color_texture
    Texture A → Texture B through the normal material resource-binding path
    expected: a known observable sampled/surface change
```
The probe evidence records the concrete A/B values or assets, the driving Runtime path, active backend/target, and resulting artifact/build identity. A stable image-regression framework is not a prerequisite for Gate 0, but the evidence must be deterministic enough for another engineer or agent to replay and distinguish A from B without relying on an undocumented eyeball-only procedure.

Gate 0 should preferentially reuse the existing `MaterialData`/material binding route rather than inventing a second temporary parameter system merely for the probe.

Gate 0 may use narrow temporary plumbing to prove the seam, but it does **not** authorize a general Material Program implementation, arbitrary parameter storage, arbitrary resource binding, or unrelated Runtime refactoring.

## 5.2 Go/no-go rule

Gate 0 passes only when runtime-driven data crosses the seam end-to-end.

If the probe reveals that the proposed `gglab.surface` shape is wrong, revise the profile before writing a large node library around it.

The required order is:

```text
Gate 0 evidence
     ↓
freeze initial GGLab surface contract
     ↓
project that contract into a machine-readable Surface Profile Descriptor
     ↓
make ShaderGraphCore emit/conform to that descriptor
```

Do **not** freeze a descriptor signature first and then force Gate 0 to validate the predetermined answer.

Because Gate 0 touches the main renderer/runtime repository, its implementation should be narrow and independently reviewed.

---

# 6. Responsibility matrix

| Concern | Owner | Must not own |
|---|---|---|
| Node canvas interaction | React Flow adapter/UI | Shader semantics |
| Editor session state | Zustand/editor layer | persisted graph authority |
| CLI command grammar / JSON transport / exit behavior | `apps/cli` CLI frontend | any ShaderGraph semantics |
| Headless/automation authoring | `apps/cli` over `ShaderGraphCore` | node/type rules, validation, DAG rules, HLSL lowering, profile interpretation |
| Graph schema | `ShaderGraphCore` | React Flow details |
| Node/port semantics | `ShaderGraphCore` | DXC/RHI policy |
| Type checking | `ShaderGraphCore` | backend target lowering |
| Graph validation | `ShaderGraphCore` | native compile validation |
| DAG compilation | `ShaderGraphCore` | Runtime/RHI state |
| HLSL generation | `ShaderGraphCore` | DXIL/SPIR-V compilation |
| GGLab surface/profile ABI | GGLab Runtime/Shader Toolchain domain, projected through a Surface Profile Descriptor | ordinary node/type/DAG semantics |
| Filesystem/native dialogs | Tauri host | Shader semantics |
| Process launch | Tauri host/tool service | DXC argument policy |
| HLSL compilation | `gglab-shaderc` / `ShaderToolchainCore` | UI behavior |
| DX12/Vulkan target policy | `ShaderToolchainCore` | editor graph logic |
| Artifact production/cache | `ShaderToolchainCore` | editor state |
| First authoritative preview | GGLab Preview Lab / GGLabRuntime | a second renderer/compiler |
| Production rendering | GGLab Runtime/RHI | editor state |

Two placement tests are useful:

1. If React Flow disappeared, would this rule still exist? If yes, it probably belongs below the UI adapter.
2. If ShaderGraph disappeared but handwritten HLSL remained, would this ABI/target rule still exist? If yes, it probably belongs in the Shader Toolchain/Runtime domain.

---

# 7. Technology direction

Recommended stack:

```text
Tauri 2
React
TypeScript
React Flow
Zustand
Tailwind CSS
shadcn/ui
Monaco Editor
Vite
Vitest
Playwright
```

## 7.1 Tauri 2

Tauri is the desktop shell and narrow native bridge.

Rust should remain small. It owns host responsibilities such as:

- filesystem access;
- native file dialogs;
- process/sidecar launch;
- tool discovery;
- OS integration;
- capability/security boundaries.

Rust should not become a second ShaderGraph compiler or Shader Toolchain policy layer.

## 7.2 React + TypeScript

React/TypeScript own the editor application and authoring experience.

TypeScript is also the initial implementation language for `ShaderGraphCore`, but that package must remain headless and independent of React/Tauri/DOM.

## 7.3 React Flow

React Flow owns node-canvas presentation and interaction:

- node placement;
- handles;
- edges;
- pan/zoom;
- selection;
- box selection;
- viewport;
- minimap/tooling;
- custom node rendering.

React Flow does **not** define the persisted graph or semantic type rules.

## 7.4 Zustand

Zustand owns editor/session state and narrowly subscribed UI state.

It is not a serialization format and is not allowed to become the graph contract.

## 7.5 Tailwind + shadcn/ui

These are presentation choices for a professional tool UI and are intentionally replaceable.

## 7.6 Monaco

Monaco is the host for generated HLSL and diagnostic inspection.

Do not assume Monaco itself is the HLSL correctness authority or a complete HLSL language service. Native correctness comes from `gglab-shaderc`.

---

# 8. Repository topology and authored-document ownership

The editor tool source should live in a separate repository, for example:

```text
graphics-gadget-lab-shader-editor/
├─ apps/editor/
├─ apps/cli/
├─ packages/shader-graph-core/
├─ packages/editor-ui/
├─ tests/
└─ docs/
```

This keeps Node/Tauri/Rust tooling out of the main C++ renderer build graph.

However:

> **Tool repository ownership is not authored-document ownership.**

For graphs authored for GGLab, the `.shadergraph` source and related material/test assets should live with the consuming product/content authority — initially the main `graphics-gadget-lab` repository unless a future content repository becomes authoritative.

Conceptually:

```text
graphics-gadget-lab-shader-editor/
    editor/tool implementation

graphics-gadget-lab/
    authored .shadergraph documents
    related material/test assets
```

The default review authority is the committed `.shadergraph` source.

Generated HLSL, source maps, and ShaderArtifact identities are derived review/build evidence.

Recommended flow:

```text
committed .shadergraph
        ↓
deterministic regeneration
        ├─ generated HLSL
        ├─ source map
        └─ ShaderArtifact/build identity
```

Generated HLSL should not be committed merely to make review convenient. If a future workflow commits it, regeneration must be one-way and mechanically verified; it must never become a second editable authority beside `.shadergraph`.

## 8.1 Authoring frontends: GUI and CLI

The tool provides two first-class authoring frontends over one semantic authority:

```text
                         ShaderGraphCore
                        /                 \
                       /                   \
                      /                     \
             GUI authoring frontend   CLI authoring frontend
             apps/editor              apps/cli
             Human                    AI / CI / automation
                      \                     /
                       \                   /
                        \                 /
                shared `.shadergraph` documents
```

Both frontends edit the same `.shadergraph` documents and receive all semantics
from the same core. Ownership is fixed:

- `ShaderGraphCore` is the only ShaderGraph semantic authority: node and port
  semantics, type rules, validation, DAG rules, deterministic HLSL lowering,
  and profile interpretation.
- The GUI frontend (`apps/editor`) is a presentation/interaction frontend:
  canvas, sessions, panels, and navigation over core-owned semantics.
- The CLI frontend (`apps/cli`) is a headless machine/automation frontend for
  AI agents, CI, automation, batch editing, and debugging/reproduction.

The CLI frontend owns its own presentation-level behavior:

```text
command and argument grammar
stdin/stdout handling
structured JSON request/response transport
stable exit behavior
CLI process/session lifecycle
```

It must **not** own, and must not re-derive locally:

```text
node semantics or node registries
port/type rules and type checking
connection and graph validation
DAG rules or lowering order
HLSL lowering semantics
Surface Profile interpretation
```

Every ordinary ShaderGraph semantic decision made through the CLI is a decision
made by `ShaderGraphCore`. The CLI serializes core-owned results; it keeps no
second metadata registry, no second error vocabulary, and no second semantic
rule set.

The split is one-way as well: command/argument grammar is an application
concern of `apps/cli` and does **not** move into `ShaderGraphCore`. The core
stays grammar-free; the CLI frontend is the only place command grammar exists.

Both frontends should converge on the same kind of semantic editing operations
(create node, connect ports, set property, create parameter, ...). A GUI
gesture and a CLI request both become core-interpreted semantic operations, so
an AI-authored edit and a human-authored edit carry identical semantics and
identical validation.

## 8.2 CLI design direction for AI/CI authoring

This is architecture direction, not an implementation commitment. None of the
capabilities listed below is frozen or implemented by this document.

The CLI primarily serves AI agents, CI, automation, and batch tooling. Its
target workflow is:

```text
discover   → query what exists: node families, node ports and types, profile facts
edit       → express semantic changes as structured requests
validate   → obtain core-owned structured diagnostics
emit       → produce deterministic HLSL for the authored graph
```

An agent queries the system for node/profile information through the frontend
instead of guessing port names, guessing types, or hand-editing arbitrary
document JSON. Node semantics come from `ShaderGraphCore`; profile facts come
from the Surface Profile Descriptor; the CLI only serializes both as
machine-readable descriptions.

Future command vocabulary under consideration, to be defined from the mature
core API rather than pre-built:

```text
describe    machine-readable node/profile descriptions
validate    structured graph diagnostics
apply       transactional semantic edits, all-or-nothing
emit        .shadergraph → generated HLSL
dry-run     planned changes plus validation result, without writing
```

Every command result carries structured diagnostics with stable codes and
graph-local node/port locations.

Terminology boundary:

- ShaderGraph → HLSL is called **emit** in this architecture.
- HLSL → ShaderArtifact remains the exclusive domain of `gglab-shaderc`.
- The CLI never replaces `gglab-shaderc`: it never reconstructs native compile
  invocation, target policy, or backend arguments, and it never derives native
  build readiness from executable existence.

Machine-use rules for the CLI:

- structured JSON in and structured JSON out; agents are never required to
  parse console prose;
- stable, documented exit behavior for success and failure classes;
- no partial mutation: an invalid request produces structured diagnostics and
  no partial document change.

---

# 9. `.shadergraph` document model

## 9.1 React Flow is not the file format

Do not persist raw React Flow `Node[]`/`Edge[]` state as the durable authoring contract.

The persisted format should be a GGLab-owned semantic document, conceptually:

```text
ShaderGraphDocument
├─ schemaVersion
├─ graphId
├─ profile
├─ profileVersion
├─ parameters[]
├─ nodes[]
├─ connections[]
└─ editorMetadata
```

## 9.2 Semantic data vs editor metadata

Semantic state includes:

- node identity/type/version;
- semantic properties;
- parameters;
- connections;
- graph/profile identity.

Editor metadata includes:

- node positions;
- collapsed state;
- comments/groups;
- viewport;
- selection/session presentation data when persisted at all.

Moving a node must not change generated HLSL.

## 9.3 Stable identity

Nodes, semantic ports, and parameters need stable graph-local identities.

Persisted identities must not be pointer-derived or UI-index-derived.

For parameters, stable semantic identity and human-facing display naming are separate concerns:

```text
parameter.id
    durable graph-local semantic identity

parameter.name
    human-facing display label unless a later Material Program contract explicitly promotes another naming field to external binding ABI

parameter.valueType
    the parameter's concrete graph value type, from the core value vocabulary
    (for example float/float2/float3/float4/Texture2D)
```

A parameter's concrete value type is **authored semantic state, not a dataflow
inference result**: the document declares it, and the core, the emitter, and
any future Material Program binding consume the same declared value. A
parameter's type must not change because a wire is reconnected, re-typed, or
removed. The `(class, valueType)` pairing is checked for profile conformance
against the descriptor's `parameterClasses` by one shared core service
consumed by emission, the GUI, and the CLI — the GUI must be able to report
"the profile does not permit this pair" without pretending to compile HLSL.
That vocabulary is descriptor data and is not hardcoded into ordinary graph
validation.

Generated HLSL symbols must not depend on a mutable display label. The v1 emitter derives parameter symbols from stable semantic identity using a deterministic ASCII-safe encoding or deterministic emission key. The exact spelling scheme is implementation detail, but renaming a display label alone must not silently change generated symbol identity or Shader semantics.

## 9.4 Versioning

Versioning should distinguish:

```text
schemaVersion
profileVersion
node typeVersion
```
Unknown/newer data must fail or degrade explicitly. Do not silently reinterpret it as an older/default node.

## 9.5 Unknown-node behavior

When a graph contains an unknown node/version, load enough information to preserve/recover the document and present an explicit placeholder/diagnostic.

Never silently substitute an arbitrary default node.

---

# 10. `ShaderGraphCore`

`ShaderGraphCore` is a pure TypeScript package with no dependency on:

- React;
- React Flow;
- Tauri;
- Zustand;
- DOM/Web APIs.

It should own:

```text
document schema/migration
node definitions
type system
connection/type validation
cycle detection
reachability
DAG compilation
deterministic lowering
HLSL emission
source-map generation
graph-native diagnostics
```

It should be consumable by:

```text
GUI editor frontend
CLI authoring frontend (machine/automation)
Vitest
Node CLI / CI
future batch tooling
```

The Surface Profile Descriptor crosses into `ShaderGraphCore` as a **serialized data document** such as JSON or an equivalent versioned machine-readable format.

`ShaderGraphCore` has no compile-time, include-time, link-time, FFI, or native-addon dependency on `GGLabRuntime`, `ShaderToolchainCore`, or their C++ headers/libraries merely to consume the profile contract.

## 10.1 One ordinary semantic authority

Node definitions must be the single authority for ordinary graph semantics.

The UI should ask the same semantic services used by compilation for connection validity and resolved types.

Avoid parallel definitions such as:

```text
TypeScript UI node registry
vs
another C++ ShaderGraph node registry
```

The narrow GGLab Surface Profile Descriptor defined later is **not** a replacement node registry. It describes only the cross-boundary profile contract.

---

# 11. Type system

The first value domain is intentionally small:

```text
float
float2
float3
float4
Texture2D
```

`bool` is deferred until a real semantic node requires it.

`Sampler` is **not** a first-class v1 graph value.

Do not introduce matrices, arbitrary structs, arrays, generics, or user-defined types before a concrete node requires them.

## 11.1 Numeric family

```text
Numeric = float | float2 | float3 | float4
```

Math nodes may express type constraints over `Numeric` without duplicating every node four times.

## 11.2 Conservative conversions

Initial implicit conversions should remain conservative.

For example:

```text
float × float3   → float3
float3 × float3  → float3

float2 → float3  not implicit
float4 → float3  not implicit
```

The coercion table belongs in the TypeSystem and must not be duplicated in UI components.
There is exactly one type-resolution authority in the core: a single forward
service resolves every node's output ports to concrete value types on a
port-level basis `(node, port)`, and the emitter and the UI both ask that
same service — neither re-derives types, so the coercion table stays in one
core place. That authority is standalone and owns the concrete constraint
of every input port (a connected source must bring a type the port
declares — the output node's required outputs included), grants no
semantics to a node version the core does not implement (it does not guess
that a future node behaves like a supported one), and resolves only within
the scope it is asked to resolve: whole canvas for authoring analysis, the
live slice for compilation — so dead experiments never block emission,
while authoring still sees their failures. The same one-authority rule
applies to profile conformance: the `(class, valueType)` pairing of
declared parameters is checked by one shared descriptor-aware service
consumed by the emitter and the GUI, not embedded in emission. Type
resolution is not emittability: a port can resolve to a type even when a
later emission gate refuses to lower the node (a descriptorVersion 1 file
serializes no generated texture signature, so `Texture2DParameter` and
`SampleTexture2D` refuse to lower there, while their ports —
`SampleTexture2D`'s `RGBA`/`RGB`/`R`/`G`/`B`/`A` included — still resolve
per port; a descriptorVersion 2 file freezes the signature and emission
lowers both per that contract). And whether a descriptor may serve a
profile line at all is a single shared compatibility verdict — the line's
required capabilities present, forbidden capabilities absent — judged on
capability, never on version numbers, and consumed by the emitter rather
than inferred inside it.

## 11.3 Port cardinality

Default to one incoming semantic connection per input port unless a node explicitly declares otherwise.

Connecting a new source to a single-input port should be one explicit editor transaction, not ambiguous multi-edge state that the compiler guesses about.

---

# 12. Initial `gglab.surface` profile

The first useful profile should be intentionally narrow.

Provisional identity:

```text
profile: gglab.surface
profileVersion: 1
```

The Runtime-facing function/input/output/resource seam remains provisional until Gate 0 proves or revises it.

## 12.1 Candidate outputs

Initial candidates:

```text
BaseColor : float3
Metallic  : float
Roughness : float
Emissive  : float3
Opacity   : float
```

These names are familiar and useful, but familiarity is not contract evidence.

Gate 0 freezes or revises them before the Surface Profile Descriptor/emitter treats them as authoritative.

Normal/tangent-space authoring is deferred until coordinate-space semantics are designed explicitly.

## 12.2 Candidate graph input

Initial authoring input:

```text
UV0
```

Gate 0 also proves a minimal externally driven scalar/vector parameter plus `Texture2D` resource flow. Their exact Runtime-facing ABI is discovered by the probe.

## 12.3 Initial node family

```text
Constants
- Float
- Float2
- Float3
- Float4

Parameters
- ScalarParameter
- VectorParameter

Math
- Add
- Subtract
- Multiply
- Divide
- Lerp
- Saturate
- OneMinus
- Min
- Max
- Dot
- Normalize

Input
- UV0

Texture
- Texture2DParameter
- SampleTexture2D

Output
- SurfaceOutput
```

`SampleTexture2D` exposes practical typed outputs:

```text
RGBA : float4
RGB  : float3
R    : float
G    : float
B    : float
A    : float
```

These channel outputs are **ShaderGraph node semantics**, owned by `ShaderGraphCore`.

They are not fields that the GGLab Surface Profile Descriptor must define.

General `ComponentMask`, `Split`, `AppendVector`, and `Swizzle` nodes remain deferred until real graphs require them.

---

# 13. Graph validation and compilation

Validation should produce structured authoring diagnostics, not asserts/crashes.

Initial validations include:

```text
UnknownNodeType
UnsupportedNodeVersion
UnknownPort
MissingRequiredInput
TypeMismatch
Duplicate/invalid connection
CycleDetected
MissingOutput
UnknownProfileFeature
```

Compilation pipeline:

```text
load / migrate document
      ↓
validate structure
      ↓
validate node/port types
      ↓
find output roots
      ↓
reachability / dead-node elimination
      ↓
cycle detection
      ↓
deterministic topological order
      ↓
HLSL emission
      ↓
source map
```

The topological order must be deterministic. Equivalent semantic graphs should not generate different HLSL merely because nodes were created or serialized in a different incidental order.

---

# 14. HLSL generation

HLSL is the authoring output of ShaderGraph.

For the Shader Toolchain:

> **HLSL is HLSL; its authoring origin is not privileged.**

Generated HLSL must be deterministic with respect to semantic graph state plus the frozen profile contract.

Editor-only state must not affect output.

Generated symbols use stable deterministic naming that can be mapped back to graph identity.

For parameters, v1 naming is based on stable semantic identity, not the mutable human-facing display label. The emitted symbol must be ASCII-safe and collision-free under a deterministic rule. A display-name-only rename therefore does not perturb generated HLSL unless a future separately reviewed Material Program binding contract explicitly makes a naming field part of Shader semantics.

Generated HLSL is derived data. `.shadergraph` remains the default authored source of truth.

## 14.1 Profile template boundary

`ShaderGraphCore` may use a profile-specific HLSL template/emitter boundary, but it must not duplicate DX12/Vulkan target lowering.

Its target is the frozen Surface Profile Contract, not raw RHI details.

---

# 15. Surface Profile Descriptor

After Gate 0 freezes the minimum viable GGLab surface seam, that cross-boundary contract may be projected into a machine-readable **Surface Profile Descriptor**.

In this document, **Surface Profile Descriptor** means the versioned machine-readable GGLab surface/profile contract. It does **not** mean a DX12 descriptor-heap entry, Vulkan descriptor binding, or other GPU RHI descriptor.

The Surface Profile Descriptor crosses repository/language boundaries as serialized data. It is not a C++ ABI/header import into `ShaderGraphCore`.

The Surface Profile Descriptor may contain:

```text
descriptorVersion
profileId
profileVersion
required generated function signature
available graph/runtime inputs
required surface outputs
supported resource/parameter classes
required shared HLSL contract/includes
resolved sampling contract/policy, if Gate 0 proves one is profile-owned
compatible process/artifact contract versions, when required
```

The Surface Profile Descriptor must **not** define:

```text
Add / Multiply / Lerp behavior
DAG rules
graph type inference
node registry implementation
SampleTexture2D RGBA/RGB/channel outputs
graph optimization
React Flow presentation
```

Those remain `ShaderGraphCore` responsibilities.

The ownership rule is:

```text
GGLab surface/profile contract
    = what a generated surface program must provide/consume

ShaderGraphCore
    = how users express and compute that result as a graph
```

The Surface Profile Descriptor is a projection of an already-proven Runtime-facing contract, not the source from which Gate 0 derives its answer.

---

# 16. Resource and parameter semantics

The Graph layer models logical authoring resources/parameters such as:

```text
Texture2DParameter
ScalarParameter
VectorParameter
```

It does not assign DX12 GPU descriptor indices or Vulkan bindings.

`Sampler` not being a first-class v1 graph value does **not** imply that the Runtime sampling contract is a single hard-coded default sampler.

At the current GGLab implementation point, per-material base-color sampling already follows a concrete texture-plus-sampler binding path: `PassForwardPBR.hlsl::PSMain` loads `MaterialData` from `g_Materials[IN.MaterialIndex]`, calls `SampleMaterialBaseColor(matData, IN.UV0, IN.UV1)`, and `SampleMaterialBaseColor(...)` resolves `matData.BaseColorBinding.TextureSamplerBinding` through `SampleTextureBinding(...)` before multiplying by `matData.BaseColorFactor`. Metallic/roughness sampling likewise uses `matData.MetallicRoughnessBinding.TextureSamplerBinding` through `SampleTextureBinding(...)`.

This is an observed current implementation fact, not yet the frozen ShaderGraph surface ABI. Gate 0 determines the smallest `gglab.surface` contract that should be frozen for logical `Texture2D` parameters:

- preserve the existing logical texture+sampler binding semantics;
- adopt a profile-owned default sampling policy;
- or choose another narrowly proven representation.

Only after Gate 0 should the Surface Profile Descriptor record whichever sampling contract is actually proven. The editor must not invent filter/address policy merely because `Sampler` edges are deferred.

Deferred until the real binding contract justifies them:

- first-class `Sampler` values;
- sampler graph edges;
- arbitrary filter mode;
- arbitrary wrap/address mode;
- comparison-sampler authoring.

Runtime material binding integration is a later layer and must not be improvised inside the React/Zustand editor state.

---

# 17. React Flow adapter and editor state

React Flow is an interaction/view adapter over `ShaderGraphDocument`.

Conceptually:

```text
ShaderGraphDocument
      ↓
ReactFlowAdapter
      ↓
React Flow Node[] / Edge[]
```

Custom node components render semantic node definitions but do not own them.

Connection gestures ask `ShaderGraphCore` whether a connection is valid.

Zustand state should be separated conceptually into:

```text
Document state
Session/UI state
Derived graph-compile state
Native build state
Preview/process state
```

Avoid components subscribing to the entire node/edge collection when they only need narrow derived state.

---

# 18. Undo / redo and editing UX

Undo/redo should record semantic editor transactions rather than raw mouse events.

Examples:

```text
CreateNode
DeleteSelection
MoveNodes
ConnectPorts
ReplaceConnection
SetNodeProperty
CreateParameter
RenameParameter
```

Continuous controls such as sliders should coalesce into useful transactions rather than generating hundreds of history entries.

Expected UX can include:

- node search/fuzzy creation;
- copy/paste;
- duplicate;
- delete;
- box selection;
- comments/groups later;
- minimap;
- inspector editing;
- generated HLSL/diagnostics panels.

UI richness must not leak into semantic persistence.

---

# 19. Tauri/native bridge

Tauri is a process/filesystem bridge, not a compiler architecture layer.

The desktop host exposes a narrow `ShaderToolService` for the toolchain loop,
in addition to the existing scoped document/descriptor file-IO surface (whose
contract is unchanged):

```text
ShaderToolService
├─ discover()          candidate tool facts (path + which discovery rule hit); a fact, never a readiness claim
├─ handshake()         runs the tool's discovery command; returns raw output bytes + exit code + timeout state
├─ compile(request)    executes exactly one structured compile; returns raw output bytes + exit code + timeout state
└─ cancel(buildId)     cancels exactly one in-flight build
```

The frontend must not receive an unrestricted shell API.

Process arguments are constructed structurally, not through concatenated shell strings.

Division of labor (owner decision, 2026-08-24):

- The **WebView never constructs raw argv** and holds no generic `spawn`
  capability of any kind. It composes domain-shaped request values
  (`NativeCompileRequest`: complete-program source bytes + identity, target,
  program stage, program entry); a generated function alone cannot satisfy
  that shape;
  argv does not exist anywhere in the TypeScript world.
- **Rust owns the bounded host boundary**: it validates the allowlisted
  request shape, serializes the approved request into the tool's invocation
  (structural arguments — host-internal, never a shell string, no
  backend-policy ownership), executes with timeout/cancel, and returns raw
  output bytes + exit code — the entire output of the boundary.
- **Protocol interpretation exists exactly once, in the TypeScript Toolchain
  Client**: handshake/result envelope parsing, status-vocabulary checking,
  version and compatibility judgment, and the build-state rules. Readiness
  composition and the product compile gate live in the editor
  orchestration — not in the service and not in the client.
- `launchPreview` remains a slot of the preview architecture, introduced only
  after the standalone Preview Lab milestone is accepted; it is not a Slice 2
  surface.

## 19.1 `gglab-shaderc` invocation

The editor invokes `gglab-shaderc` as an external process/sidecar, through
`ShaderToolService` only.

It must not reconstruct DXC/backend arguments such as Vulkan binding shifts, shader-model details, target-environment flags, or coordinate policy.

Those remain `ShaderToolchainCore` authority.

The generated HLSL is a **derived build input**: it is staged into a private
area owned exclusively by `ShaderToolService` — the service creates it, writes
the delivered bytes, compiles against it, and cleans it up. Every build
attempt owns its own private sub-area (per attempt), so concurrent attempts
sharing identical source bytes never share staging, and one attempt's
cleanup can never remove another attempt's source. The WebView never
handles staging paths; the build result carries a service-local staging
reference (a name for evidence, not a usable path) alongside the core's durable
source identity (SHA-256 of the exact generated bytes).

---

# 20. Tool discovery and compatibility readiness

Development builds need an explicit way to locate `gglab-shaderc` and, once Gate 0 has frozen it, a compatible Surface Profile Descriptor.

Recommended precedence:

```text
1. explicit editor setting / environment override
2. configured sibling GGLab build output
3. bundled deployment in packaged builds
```

The editor must not report native compilation as Ready merely because an executable exists.

**Strict readiness gate (owner decision, 2026-08-24).** Readiness is TWO
distinct state spaces in two domains — the tool's state is the client's
verdict, the build's readiness is the editor's composition — never one mixed
ladder, because mixing them leaves "tool OK but descriptor not" unnamed, and
forces a domain to decide what it cannot know:

```text
Tool compatibility (judged by the Toolchain Client):
  unavailable    no candidate resolved by the discovery rules
  discovered     an executable resolved — a FACT, never a readiness claim
  unproven       resolved, but not machine-readably proven compatible; the
                 honest state of every real tool until the toolchain handshake
                 contract exists and the client supports it
  incompatible   resolved, and the TOOL's OWN reported facts contradict the
                 required ones — facts the tool itself publishes; target
                 coverage is a build fact, NOT part of this verdict
  compatible     proven machine-readably compatible

Native build readiness (composed ONCE, by the editor orchestration):
  Ready          tool compatible AND profile/descriptor compatible (core
                 verdict) AND host execution capability (service report) AND
                 the explicit build target configured AND that target is
                 among the tool's published supported targets
  NotReady{…}   otherwise — ALWAYS with a structured reason list
                 (ToolUnavailable, ToolDiscovered, ToolUnproven,
                 ToolIncompatible, DescriptorIncompatible, HostUnavailable,
                 TargetNotConfigured, TargetUnsupported); reasons are
                 visible, complete, structured
```

The handshake is the operation that establishes or refreshes proof, and it
remains legal for ANY resolved candidate — `discovered`, `unproven`, and
`incompatible` alike (`unavailable` has no candidate to handshake); it is
exactly how an unproven tool — and an in-place updated tool — becomes `compatible`.
The client's tool-side guarantee therefore covers the COMPILE direction
only: it never forms a compile request out of an unproven / incompatible
tool. Refusing the handshake on those states would deadlock the state
machine and is explicitly NOT the rule.

Guarantees, each layer owns exactly its own:

- The **product compile gate lives in the editor orchestration**, and is
  gated on `Ready` **with no bypass**: no dev mode, environment flag, or
  local setting routes a request through a `NotReady` composition — the
  path does not exist to configure because none is defined.
- The **Toolchain Client guarantees the tool-operation level, split by
  operation**: it never forms a compile request out of an unavailable /
  unproven / incompatible tool (the refusal is structured); a handshake
  stays legal for any resolved candidate — it is the means by which those
  states enter, and re-enter after an update, `compatible`. It composes
  nothing — it does not know the descriptor profile, the host, or the
  target, and is not asked (target coverage is the editor's composition,
  because only the editor holds the configuration).
- The **Tauri service guarantees the boundary level**: it executes only
  allowlisted, in-shape domain requests, bounded. It knows nothing about
  readiness, and it cannot be asked.
- Readiness is **derived, never remembered** (recomposed on every input
  change); a downgrade (a reason appearing) is as visible as an upgrade.

A missing/incompatible Surface Profile Descriptor for a profile that requires it is a first-class compatibility failure, not a reason to guess ABI rules.

When multiple Surface Profile Descriptors are discoverable, selection first matches the graph's requested `profileId` and `profileVersion`. Within that compatible profile line, the editor selects the highest `descriptorVersion` it supports and records the exact selected descriptor/profile version in build state and the Build Inspector. A numerically newer descriptor for another profile/profileVersion must never cause an implicit profile upgrade.

The Build Inspector should expose the resolved tool path and its discovery
provenance, the proven tool version and process-contract axis, the producer
identity, the selected Surface Profile Descriptor / profile / descriptorVersion,
the explicit build target, and the current readiness state.

---

# 21. `gglab-shaderc` process-contract negotiation

A machine-readable compile result is necessary but not sufficient for an independently versioned editor and Shader Toolchain.

Before native compile requests, the editor proves that the discovered tool is contract-compatible.

**Wire-contract ownership (owner decision, 2026-08-24).** The discovery
handshake contract is owned by the external GGLab Shader Toolchain contract
authority — the normative design lives in the GGLab docs repository; the
implementation and its contract self-tests live in the main GGLab
repository. **What the editor requires is not what the editor owns.** This
document records only the FACTS the editor's compatibility verdict requires;
it does not define, duplicate, or assign values to the wire schema or to the
toolchain's own version axes. Those facts (v1):

```text
the tool's identity                      (the descriptor requires one)
the tool's version                        (judged against the descriptor's minimum under the descriptor's own comparison rule)
the tool's process-contract version axis  (checked against the range the client declares it supports)
the producer/compiler identity
the tool's published supported targets    (extracted as a tool FACT;
                                            whether it covers the configured target is the
                                            editor composition's judgment — the client holds
                                            no configuration, and this check is `TargetUnsupported`,
                                            a build fact, never a tool verdict)
```

The artifact contract/schema axis is **not** a v1 requirement: it enters
only when the editor/preview genuinely consumes a versioned ShaderArtifact
contract. Do not invent handshake requirements from facts the compile
result already carries.

The client declares the handshake-contract versions it supports, and
contract versions outside that range are explicitly unsupported (the client's
own range discipline) — never silently accepted. For everything inside a
supported published contract, the client follows the compatibility and
field-tolerance rules that contract defines; the descriptor reader's
strictness belongs to the descriptor schema the editor itself reads, and is
not projected onto an external wire contract. Until it supports a published
contract, its supported set is empty, which is exactly why no real tool can
be proven yet — and none may be compiled through.

An incompatible tool fails explicitly with a compatibility diagnostic. Do not:

- silently fall back to another compiler;
- parse ANY human-facing surface (`--version` text, the `targets` listing,
  help output) as compatibility evidence — human-facing output is stable for
  humans, not a contract;
- reconstruct missing target policy in the editor;
- bypass the readiness gate by any dev mode, environment flag, or local
  override — no such path exists to configure, because none is defined.

## 21.1 Surface Profile Descriptor compatibility

For a graph profile requiring a Surface Profile Descriptor, readiness also verifies:

```text
descriptorVersion
profileId
profileVersion
required/supported feature set
```

The graph requests a concrete `profileId`/`profileVersion`; Surface Profile Descriptor discovery may choose the highest editor-supported `descriptorVersion` only within that requested compatible profile line.

The editor declares the Surface Profile Descriptor version/range it supports and records the exact selected descriptor version.

A graph using a profile output/resource/parameter class absent from the Surface Profile Descriptor produces a first-class graph/profile diagnostic such as `UnknownProfileFeature` or equivalent.

Never silently replace an unsupported feature with a default.

If existing contracts lack required fields, add a narrow independently reviewed GGLab Toolchain/profile-contract enhancement.

---

# 22. Build state and stale-result handling

Native compilation is asynchronous and must be revisioned.

Each request should carry enough identity to establish which graph/HLSL revision produced it.

Conceptually:

```text
Graph revision N
      ↓
Generated source identity HN
      ↓
Build request BN
```

When a result returns, it only becomes **current** if it belongs to the
CURRENT BUILD INTENT (the semantic identity of the compile request: generated
source identity + target + stage/entry + the relevant proven tool/process
facts — identity, version, process-contract axis, and the producer/compiler
identity; the tool version does not imply the producer. The
generated-source SHA-256 is its durable content component, never its whole
anchor; same bytes under a different target, or under a different proven
producer, is a different intent) and it is the newest successful attempt
within that intent. Identity and attempt ordering are separate axes: a
result is matched by intent AND ordered by its attempt; no new persisted
identity is created.

Every result occupies an explicit, named state — there is no silent middle
ground — and a failed build is a state, not an exception:

```text
current      the newest successful result belonging to the current build intent
stale        a once-current result displaced by a newer build intent; retained as evidence only
last-good    the most recent successful result, preserved across newer failures
failed       explicit diagnostics carried by the machine contract — never prose
canceled     an in-flight build that was canceled by the user
```

A slow old compile must never overwrite a newer graph/artifact state. A failed
newer build must never blank or erase a safe last-good result (see §30).

Division of labor (owner decision, 2026-08-24): the **pure rules** — revision
binding, stale judgment, last-good selection, transition legality — live in
the Toolchain Client as headless, host-independent logic tested against fake
processes. The **session storage** of these states for the current session is
editor session state, composed in the shell — the same "pure verdict, session
composition" pattern the authoring operations already use.

---

# 23. Diagnostics model

Keep two diagnostic layers distinct.

## 23.1 Graph-native diagnostics

Produced by `ShaderGraphCore`:

```text
cycle
type mismatch
missing input
unknown node/version
unknown profile feature
invalid connection
missing output
```

Their location authority is graph-local node/port identity.

## 23.2 Toolchain diagnostics

Produced by native Shader compilation:

```text
HLSL syntax/type error
include error
compiler unavailable
artifact IO failure
target-policy failure
```

Their location authority is generated source identity/location, later mapped back through a source map.

Do not collapse both layers into an unstructured `string[]`.

---

# 24. ShaderGraph source map

The graph compiler should produce:

```text
ShaderGraphSourceMap
├─ generatedSourceIdentity
└─ ranges[]
   ├─ generated line/column range
   ├─ nodeId
   ├─ portId, when meaningful
   └─ semantic role
```

`generatedSourceIdentity` is:

> **SHA-256 of the exact generated HLSL bytes represented by the source map.**

Do not create a second persisted FNV/CRC/StringId-style generated-source identity.

`nodeId`/`portId` remain graph-local identities; they do not replace content identity.

Diagnostic flow:

```text
native diagnostic
  generated SHA-256 + line/column
          ↓
ShaderGraphSourceMap
          ↓
nodeId / portId
          ↓
Editor highlight/navigation
```

Given the same semantic graph, frozen profile contract, and graph compiler version, HLSL and source map should be deterministic together.

---

# 25. Build Inspector and observability

The editor should make the build explainable.

Useful fields include:

```text
graph path / graphId
schema/profile/profileVersion
selected descriptorVersion
generatedSourceIdentity
resolved gglab-shaderc path
processContractVersion
compilePolicyRevision
toolVersion
DXC/producer identity
target
recipe/build key
artifact binary hash/path
cache hit/miss
build revision
current/stale state
diagnostics
```

The goal is replayable evidence rather than opaque “Compile failed” UI.

**One source of truth per field (owner decision, 2026-08-24).** Every inspector
field has exactly one authority — discovery facts (service), proven tool
version / process-contract axis / producer identity (tool result, parsed by
the client), descriptor / profile compatibility (core verdict), target (explicit
build configuration), generated-function facts (descriptor), generated-source
identity (core emission), complete-program stage / entry (the main-owned program
composition), result states (session store over the client's rules), and
artifact facts (tool result) — and the inspector only projects. Descriptor
`generatedFunction` facts must never be projected into complete-program
stage/entry fields. A field with
two sources of truth is a review failure, in the same sense a
freeze-record/descriptor disagreement is one. The field-level table is in
`GGLab_Shader_Toolchain_Integration_Design.md` (§13).

---

# 26. Shader Preview architecture

## 26.1 Web rendering is not the authority

The editor may use browser rendering for UI tests, canvas behavior, thumbnails, or non-authoritative experiments.

The authoritative path is not:

```text
ShaderGraph → WGSL/GLSL → WebGPU/WebGL
```

That would create a second lowering/rendering truth.

## 26.2 First preview — GGLab Preview Lab

The first authoritative preview is a dedicated GGLab Lab/session:

```text
.shadergraph
   ↓
ShaderGraphCore
   ↓
Generated HLSL
   ↓
main-owned Preview adapter + PSMain
   ↓
gglab-shaderc
   ↓
Runtime Preview Artifact
   ↓
GGLab Shader Graph Preview Lab
   ↓
GGLabRuntime / Renderer / RenderGraph / RHI
```

**Program boundary correction (2026-08-30).** The generated
`EvaluateSurface` function is a function contract, not a complete Runtime pixel
program. Compiling function-only generated source as `stage=pixel,
entry=EvaluateSurface` is invalid program composition and is not qualification
evidence. Native qualification requires the generated function plus a
main-owned qualification `PSMain`; Runtime preview requires the generated
function plus a main-owned Preview `PSMain`. The Editor must not synthesize
either entry or pass binding. Its current function-only request composition is a
known implementation defect and must be removed or disabled until a reviewed
full-program operation exists. The fixed input contracts, standalone Preview
Program, ordinary runtime catalog mappings, visualizer, and milestone order are
approved for Milestone A by
`GGLab_Shader_Graph_Preview_Program_And_Lab_Design.md`. Its `build-preview`,
publication/session, Preview handshake, identity, and live last-good design are
directionally accepted only and require final owner approval before Milestone B.

It must follow normal GGLab Lab/runtime discipline:

- stable `gglab.lab.*` identity;
- normal project/ownership rules;
- controls that trigger Runtime rebuild/state transitions flow through the safe LabRuntime command/control path;
- preview UI/process code does not directly mutate Renderer/RHI internals;
- artifact/profile/backend identity remains observable;
- a failed compile/load does not blank or reset the scene when a safe last-good artifact exists.

Preview last-good behavior is explicit:

```text
new compile/load succeeds
    → atomically promote the newer artifact to current preview

new compile/load fails
    → keep rendering the last successfully loaded artifact
    → mark preview/build state Stale or LastGood
    → surface the new failure in the Editor/Preview UI
```

The UI should communicate the stale/last-good state with an explicit badge/status rather than making the rendered image look current when it is not.

Suggested primitives:

```text
Sphere
Plane
Cube
```

Suggested controls when justified:

```text
mesh
environment
camera
material parameters
active graph/artifact identity
active backend/target
```

## 26.3 Backend readiness

Preview backend enablement follows **GGLab production backend readiness**.

ShaderGraph work must not become the mechanism for bringing an immature backend to parity.

At the initial implementation point, DX12 is expected to be the default preview backend because it is the mature production path. This is an implementation policy, not a permanent architectural statement that Vulkan is secondary.

## 26.4 Future thin preview host

A future `ShaderPreview.exe` is allowed only as a thin composition root over GGLabRuntime/rendering contracts.

Trigger it when measured evidence shows that full GGLab Application/project startup materially harms authoring iteration and a thinner host would significantly improve the feedback loop.

Do not encode an arbitrary time threshold in this architecture.

The thin host must not duplicate material binding, PSO policy, RenderGraph behavior, RHI contracts, or Shader compilation policy.

## 26.5 Future embedded preview

Embedded shared-texture preview remains deferred.

Cross-process shared GPU resources, synchronization, resize lifetime, backend compatibility, and WebView presentation are presentation problems, not prerequisites for Shader-authoring correctness.

---

# 27. Persistence, canonicalization, and migration

Save only durable document/editor metadata according to the schema.

Semantic representation should be canonicalizable so incidental array order does not create semantic changes.

Migrations are explicit and versioned.

Unknown future data should fail/preserve clearly rather than be silently destroyed.

Save → load → compile should preserve semantic HLSL.

---

# 28. Testing architecture

Testing should be layered so most correctness can be validated without launching a GPU window.

## 28.1 `ShaderGraphCore` unit tests

High-value tests:

```text
node definition validation
port type compatibility
type resolution
cycle detection
required-input validation
unknown node/version behavior
unknown profile feature behavior
reachability
deterministic topological sort
deterministic naming
parameter display-label rename → generated HLSL symbol identity unchanged
schema round-trip/migration
canonicalization
source-map range generation
SampleTexture2D RGBA/RGB/R/G/B/A output typing
```

These tests own ordinary graph semantics.

The Surface Profile Descriptor must not become a second node-semantic oracle.

## 28.2 Golden HLSL tests

Representative graph fixtures compile to expected HLSL.

Expected-output changes should be intentional and reviewable like compiler golden tests.

## 28.3 Profile-conformance tests

After Gate 0 freezes the Surface Profile Descriptor, add a separate mechanical conformance test verifying generated `gglab.surface` HLSL against it:

- required function name/signature;
- declared cross-boundary inputs/outputs;
- required resource/parameter classes;
- required shared HLSL include/contract expectations;
- resolved sampling contract expectations, if Gate 0 makes them profile-owned.

This test does **not** use the Surface Profile Descriptor to define ordinary node behavior such as texture channel outputs.

## 28.4 Determinism tests

Examples:

```text
move nodes on canvas
→ HLSL unchanged

rename only a human-facing parameter display label
→ stable parameter symbol identity unchanged

reorder incidental serialization
→ semantic HLSL unchanged

save → load → compile
→ HLSL unchanged

compile same graph twice
→ HLSL + source map unchanged

hash exact generated bytes twice
→ generatedSourceIdentity unchanged
```

## 28.5 Tool/profile compatibility tests

Cover:

1. compatible process-contract handshake;
2. incompatible process contract → explicit failure;
3. compatible Surface Profile Descriptor;
4. unsupported descriptor version/profile feature → explicit diagnostic;
5. multiple Surface Profile Descriptors for one requested profile → highest editor-supported compatible `descriptorVersion` selected;
6. Surface Profile Descriptor for another profile/profileVersion → never selected as an implicit upgrade;
7. fake compile process matching the real machine contract;
8. real `gglab-shaderc` smoke when available.

## 28.6 Gate 0 / preview evidence

Gate 0 evidence must include the named fixture pair:

```text
gate0_probe.base_color_factor
    concrete A value
    concrete B value
    normal Runtime/material update path
    expected distinguishable surface result

gate0_probe.base_color_texture
    deterministic Texture A
    deterministic Texture B
    normal Runtime/material resource-binding path
    expected distinguishable sampled/surface result
```

It must also record:

- the exact `PassForwardPBR.hlsl::PSMain`-side hook site or revised equivalent established by the probe;
- the minimal modified shader/helper/source set;
- compile through the real GGLab Shader Toolchain;
- render through the real GGLab Lab/runtime path;
- active backend/target and produced artifact/build identity.

Later preview validation should include artifact load failure/success, last-good preservation/stale-badge behavior, backend readiness behavior, debug/validation cleanliness when applicable, and visual regression only when a stable capture workflow exists.

---

# 29. Performance principles

Optimize measured hot paths, not framework anxiety.

For React Flow/editor state:

- use narrow Zustand subscriptions;
- avoid unrelated components subscribing to the entire node/edge collection;
- memoize stable node renderers/callbacks where useful;
- cache expensive thumbnails;
- keep graph validation/compile derived and incremental only when evidence justifies complexity.

Typical Material Graph sizes are expected to be tens/hundreds of nodes, not 100,000-node visualization workloads.

Do not replace React Flow preemptively without profiling evidence.

---

# 30. Error handling

Expected authoring/tool failures are results, not process-aborting invariants.

Examples:

```text
invalid graph
unsupported profile feature
incompatible process contract
incompatible Surface Profile Descriptor
compiler unavailable
compile failure
artifact IO failure
stale build result
preview artifact load failure
```

The editor/Preview Lab preserves the last known-good native artifact when a new compile or artifact load fails where that behavior is safe. Failure state is surfaced explicitly as stale/last-good plus diagnostics; it is not hidden behind a seemingly current preview, and it does not blank/reset the scene merely because the newest build failed.

Architecture/programmer invariants may still assert in development code, but user-authored invalid ShaderGraphs must not crash the editor.

---

# 31. Implementation sequence

The slices below are sequencing guidance, not durable source identifiers.

The toolchain integration's construction-level design is recorded in
`GGLab_Shader_Toolchain_Integration_Design.md` (package topology, state
machines, service boundary, staging, testing, implementation order). This
section keeps the decisions and the slice boundaries; that document is the
build plan.

The CLI authoring frontend (§8.1/§8.2) rides on the same core milestones. Its
command surface is derived from the mature `ShaderGraphCore` API and is not
pre-built into the slices below; establishing the `apps/cli` package boundary
does not change this sequence.

### Stage record (owner, 2026-07-21)

The Slice 1 authoring loop is closed for the first stage:
author → connect → validated → deterministic, conformance-gated
HLSL (pinned golden fingerprints) → save/reopen with the same
semantic graph, HLSL and source identity. This is backed by the
core's golden suite, the headless CLI surface, and the editor's GUI
suite; a dedicated fixed scene (the texture golden and its
diagnostics dark twin) references the same paths for every later
screenshot and smoke test. Decisions recorded here:

1. Connected sockets present their RESOLVED concrete type — one fact,
   one color; a connected story never contradicts an unresolved one
   (owner decision, locked).
2. Authoring operations report three outcomes — a mutation (new
   document), an accepted no-op (the input instance is preserved;
   document identity, not the applied flag, is the mutation fact),
   and a refusal (the input with a structured refusal). Derivative
   session behavior builds on identity, never on the flag alone.
3. Editor session state uses small pure per-domain stores composed
   in the shell (history, position, gestures, layout) rather than a
   general-purpose UI state library — consistent with the non-goal
   that session state must never become a persisted contract.
4. Node deletion lands with its quiet header-menu presentation before
   the toolchain slice starts. Constant value editing lands as the
   CORE GATE (`setConstantValue`, three-outcome strict), and its UX is
   deferred to the node-inspector design: a selection-driven inspector
   (what a selected node — and every other node type — shows and
   offers) is a design decision of its own, and a global "constants
   table" was reviewed and rejected as the wrong presentation. (The
   "parameter value" gap resolved as a boundary, not a feature:
   parameter values are runtime-owned — they enter through the
   generated-function signature — and mapping runtime material state
   into those inputs is a main-repository obligation, so they
   deliberately never exist in the document. Constants are the only
   value-bearing authoring data.) The remaining canvas interaction
   refinements (the node inspector, multi-selection, box selection,
   dangling-wire node creation, edge rerouting, the history panel,
   recent files, a dedicated code pane) are deferred until after the
   toolchain loop (Slice 2/3) closes.

### Stage record (owner, 2026-08-24)

Slice 1 is closed and **merged into main** (PR #2). The active stage is
**Slice 2 — Shader Toolchain Integration** (branch
`3-shader-toolchain-integration`). Decisions recorded here; the construction
level is in `GGLab_Shader_Toolchain_Integration_Design.md`:

1. Native build runs behind a **strict readiness gate, as two state spaces
   in two domains** — ToolCompatibility (judged by the client):
   `unavailable / discovered / unproven / incompatible / compatible`; and
   NativeBuildReadiness (composed ONCE by the editor orchestration):
   `Ready` or `NotReady{reasons}`. A request may only be issued when the
   composition is `Ready`: no dev bypass, no environment-flag exception, and
   no such path to configure because none exists. A real tool whose
   process-contract axis lies outside the client's declared supported
   range, or whose facts miss the requirement, is `unproven` /
   `incompatible`, full stop: no compile request is formed out of it.
2. The handshake wire contract is **owned by the external GGLab Shader
   Toolchain contract authority** (normative design in the GGLab docs
   repository; implementation and contract self-tests in the main GGLab
   repository). This repository records only the editor's consumption
   requirements (the v1 facts a compatibility verdict needs; the client's
   supported-range discipline) — no wire schema, no values assigned to the
   toolchain's own version axes, no pre-declared unknown-field policy for the
   external contract, and the artifact-contract axis is not a v1
   requirement. *What the editor requires is not what the editor owns.*
3. The Toolchain Client (`shader-toolchain-client`, a new headless package)
   is a **sibling domain** of `shader-graph-core`: no dependency in either
   direction. It owns machine-protocol consumption, the ToolCompatibility
   verdicts, the build-intent / build-line (stale/current/last-good) pure
   rules, and the host-boundary contract (allowlisted operations + the
   `NativeCompileRequest` shape) — without understanding
   ShaderGraphDocument, GraphType, or node semantics, and with no argv
   anywhere in its vocabulary. The editor orchestration is the single
   composition and gate point: ToolCompatibility (client) +
   profile/descriptor compatibility (core) + host capability (service) +
   target configuration (configured, AND covered by the tool's published
    targets — the coverage check is made here, where the configuration
    lives, and never inside the client's tool verdict) + complete-program
    availability. Generated-function-only state is structured
    `ProgramCompositionUnavailable`, never `Ready`.
4. The desktop host exposes a **narrow `ShaderToolService`** (discover /
   handshake / compile / cancel), never a general-purpose shell. The WebView
   never constructs raw argv — it composes domain-shaped request values; the
   approved request is serialized into the tool's invocation INSIDE the host
   boundary (Rust), bounded, with no shell string and no readiness logic;
   protocol interpretation exists exactly once, in the TypeScript Toolchain
   Client.
5. **Corrected 2026-08-30:** target remains explicit build configuration, but
   `NativeCompileRequest.stage` / `.entry` are complete-program facts and cannot
   come from descriptor `generatedFunction` facts. The current function-only
   request is invalid and the real-product acceptance item is reopened. Until a
   main-owned qualification or Preview Program composition exists, the Editor
   may display generation/readiness facts but must not issue
   `entry=EvaluateSurface`. DXC/backend target policy remains
   `gglab-shaderc`'s.
6. **`apps/cli` gains no `build` command in Slice 2.** Native-build
   orchestration for the CLI is a separately reviewed deferred addition
   (it would add its own host-boundary implementation over the same client
   vocabulary — no protocol rework). The fake-test surface is the client /
   host-boundary contract directly: the test-side implementation of the
   declared boundary; it exposes no argv either.

## Gate 0 — Surface Integration Probe

Before editor Slice 1, implement the narrow GGLab-side probe defined in §5.

Acceptance requires:

- the real Forward PBR material-evaluation path to expose/consume the proposed surface seam;
- the implementation to record the exact shader hook site and minimal modified path set;
- `gate0_probe.base_color_factor` to cross the normal Runtime/material update path and produce the expected A/B surface difference;
- `gate0_probe.base_color_texture` to cross the normal Runtime/material resource path and produce the expected A/B sampled/surface difference;
- compilation and rendering through the real GGLab Shader Toolchain and Lab/runtime path.

A constant-only surface cannot pass.

Gate 0 freezes the initial Surface Profile Contract. Only then should a machine-readable Surface Profile Descriptor become the emitter target.

## Slice 1 — Editor shell + Graph → HLSL

Deliver:

- Tauri + React shell;
- React Flow canvas;
- Zustand session state;
- Tailwind/shadcn tool layout;
- pure `ShaderGraphCore`;
- `.shadergraph` schema;
- initial node/type system;
- validation;
- deterministic DAG compile;
- deterministic Surface Profile Descriptor-conforming HLSL;
- stable-ID-derived ASCII-safe parameter symbols;
- source map with exact-byte SHA-256 identity;
- Monaco generated-HLSL pane;
- save/load;
- core undo/redo;
- headless/golden/profile-conformance/UI tests.

Explicit non-goal:

```text
Do not invoke gglab-shaderc yet.
```

Acceptance:

```text
create graph
→ connect typed nodes
→ invalid edges rejected/explained
→ deterministic HLSL generated
→ profile conformance passes
→ save/reopen
→ same semantic graph/HLSL/source identity
```

## Slice 2 — `gglab-shaderc` + Artifact Inspector

Deliver:

- tool discovery;
- machine-readable process-contract negotiation;
- Surface Profile Descriptor version/profile compatibility and deterministic selection;
- explicit incompatible-tool/profile states;
- structured compile invocation;
- build-intent / attempt-ordering and stale-result protection;
- artifact/manifest display;
- Build Inspector;
- fake host-boundary tests (the declared contract's test-side implementation;
  the real tool is never a test fixture and never a test dependency, and the
  fake exposes no argv);
- exploratory manual smoke — the owner may run `gglab-shaderc` outside the
  editor against a complete-program fixture or the main-owned qualification
  harness, as investigative evidence only; it never changes the tool's
  `unproven` state and never enters the editor's product path;
- no function-only stage-acceptance smoke. The permanent main GGLab gate is
  the current qualification authority; the next real Editor product smoke is
  the Preview Milestone B path after the standalone Preview Lab is accepted.

Acceptance:

```text
compatible toolchain + compatible selected surface profile
→ generated HLSL + generated-source identity visible
→ no complete program in Slice 2
→ NotReady[ProgramCompositionUnavailable]
→ no native request / BuildId / artifact claim
```

The current implementation does not yet satisfy this corrected acceptance
chain; Slice 2 correctness closure is reopened. After closure, product progress
moves to standalone Preview Lab Milestone A and then live Editor Preview
Milestone B. The permanent main-repository generated-function gate remains the
native qualification authority meanwhile.

## Slice 3 — Compiler diagnostics → graph navigation

Deliver generated-source identity/location support, source-map lookup, Monaco markers, node/port highlighting, and diagnostic navigation.

Acceptance:

```text
native compile diagnostic
→ generated source SHA-256 + location
→ node/port navigation
```

## Slice 4 — GGLab Shader Graph Preview Lab

Deliver:

- stable Preview Lab identity;
- ShaderArtifact loading through GGLabRuntime;
- deterministic simple preview scene;
- sphere/plane/cube;
- justified environment/camera/material controls through safe Runtime command paths;
- active graph/artifact/profile/target identity;
- backend enablement gated by GGLab production readiness;
- editor control without direct Renderer/RHI mutation;
- last-good artifact preservation plus explicit stale/failure status.

Acceptance:

```text
Editor artifact identity
== Preview Lab artifact identity

Preview render path
== GGLabRuntime / Renderer / RenderGraph / RHI

failed newer build/load
→ last-good preview remains visible and explicitly marked stale
```

## Slice 5 — Material Program / Runtime integration

Only after the preceding contracts are stable, separately design how authored graphs become selectable Material Programs and how parameters/resources connect to persisted material/runtime systems.

This later design may cross:

- Material Program / ShaderArtifact identity;
- material persistence;
- parameter/resource binding;
- PSO selection;
- draw grouping;
- hot reload;
- asset publication.

Do not pre-design this by leaking editor state into `MaterialGPU` or RHI structures.

---

# 32. Dependency and release strategy

The editor consumes GGLab Shader production through versioned process/artifact/profile boundaries rather than source-level C++ linking.

A sibling-checkout development workspace is reasonable:

```text
Workspace/
├─ graphics-gadget-lab/
├─ graphics-gadget-lab-docs/
└─ graphics-gadget-lab-shader-editor/
```

The editor must not depend on fixed absolute paths.

## 32.1 Packaged Shader Toolchain is a deployment closure

Bundling `gglab-shaderc.exe` alone does not prove the packaged editor can compile on a clean machine.

The deployment closure may include:

```text
gglab-shaderc executable
required DXC runtime binaries
required native runtime dependencies
required tool/config data
explicit toolchain/producer identity
compatible Surface Profile Descriptor(s)
```

A packaged editor must not accidentally depend on an unrelated system DXC or developer-only SDK path unless that is an explicit observable override.

Discovery/handshake/dependency checks must succeed before native build readiness.

---

# 33. CI direction

Editor CI can include:

```text
TypeScript typecheck
lint/format
ShaderGraphCore unit tests
golden HLSL/profile-conformance tests
editor build
browser interaction tests
Tauri build
```

Optional cross-repository integration CI may consume a known compatible `gglab-shaderc`/Surface Profile Descriptor deployment when maintenance cost is justified.

Do not force every editor UI commit to rebuild the full GGLab renderer.

The main GGLab repository retains ownership of Shader Toolchain C++ tests, artifact contracts, Gate 0/Preview Lab Runtime evidence, and native backend correctness.

---

# 34. Architecture invariants

1. **React Flow is not the persisted ShaderGraph model.**
2. **Zustand is not the persisted ShaderGraph model.**
3. **`ShaderGraphCore` is headless and independent of React/Tauri/DOM.**
4. **There is one ordinary ShaderGraph node/port/type authority: `ShaderGraphCore`.**
5. **The Surface Profile Descriptor owns only cross-boundary GGLab profile/Runtime facts.**
6. **The Surface Profile Descriptor crosses into `ShaderGraphCore` as serialized data, not a C++/native dependency.**
7. **ShaderGraph produces HLSL, not DXIL/SPIR-V.**
8. **The editor never reconstructs DXC/backend target policy.**
9. **Generated HLSL is deterministic with respect to semantic graph state and the frozen profile contract.**
10. **Parameter display labels do not define generated HLSL symbol identity; stable semantic identity does.**
11. **Generated-source durable identity is SHA-256 of the exact generated HLSL bytes.**
12. **Graph/profile failures are explicit diagnostics, not silent fallback.**
13. **Native build results are revisioned; stale results cannot become current.**
14. **Compiler/tool/profile diagnostics use structured contracts, not console scraping.**
15. **Positive native-build readiness requires compatible toolchain and required Surface Profile Descriptor.**
16. **Surface Profile Descriptor selection may not implicitly upgrade a graph to another profile/profileVersion.**
17. **Packaged Shader Toolchain deployment is a dependency closure, not merely one executable.**
18. **Gate 0 proves both minimal input and output seams before the Surface Profile Descriptor is frozen.**
19. **Gate 0 records the exact Forward PBR hook site and replayable named input/resource fixtures.**
20. **A constant-only surface cannot satisfy Gate 0.**
21. **The first authoritative preview is a GGLab Preview Lab using GGLabRuntime/Renderer/RenderGraph/RHI.**
22. **A failed newer build/load does not replace or erase a safe last-good preview artifact.**
23. **A future dedicated preview host must remain a thin composition root, not a second renderer.**
24. **Preview backend enablement follows GGLab production backend readiness.**
25. **GGLab-owned `.shadergraph` documents live with the consuming product/content authority, not the editor-tool source repository by default.**
26. **WebGL/WebGPU results are not GGLab Shader-correctness evidence.**
27. **Custom HLSL, if introduced, is a constrained escape hatch and cannot bypass the active Surface Profile Contract.**
28. **Do not build a generic compiler framework for hypothetical future languages/backends.**
29. **Do not move Shader Toolchain/RHI ownership into the editor for convenience.**
30. **The GUI and the CLI are two first-class authoring frontends over the single `ShaderGraphCore` semantic authority; neither frontend defines graph semantics.**
31. **Command/argument grammar, JSON transport, and exit behavior belong to the CLI frontend; they do not move into `ShaderGraphCore`.**
32. **The CLI frontend never replaces `gglab-shaderc`: ShaderGraph → HLSL is emission; HLSL → ShaderArtifact stays with the Shader Toolchain.**

---

# 35. Deferred decisions

Deliberately not frozen by v0.3 until evidence requires them:

- exact package manager/workspace tooling;
- exact `.shadergraph` field spelling beyond the architectural shape;
- exact stable-ID encoding and ASCII-safe generated-symbol spelling;
- full Material Program and general parameter/resource binding model beyond Gate 0;
- exact `gglab.surface` function/input/output/resource signature **until Gate 0 freezes it**;
- exact Surface Profile Descriptor transport/producer after Gate 0;
- exact sampling representation/policy until Gate 0 determines whether existing texture+sampler semantics or a profile-owned policy is correct;
- HLSL highlighting provider for Monaco;
- comments/groups persistence details;
- automatic layout;
- reroute semantics;
- subgraphs/functions;
- static switches/variants;
- vertex-stage graph support;
- custom HLSL nodes;
- `bool` until a real node needs it;
- first-class `Sampler` values/edges;
- arbitrary sampler filter/address/comparison authoring;
- general component mask/split/append/swizzle operations;
- graph optimization beyond reachable/dead-node handling and deterministic lowering;
- thin dedicated preview composition root until measured startup/iteration evidence justifies it;
- embedded native preview;
- broader cross-repository release orchestration;
- whether source maps become packaged build artifacts;
- CLI command grammar and the concrete command set (`describe`/`validate`/`apply`/`emit`/`dry-run`), derived from the mature core API;
- CLI request/response JSON schema and its versioning;
- the CLI frontend executable identity (working direction: a distinct name such as `gglab-shadergraph`, clearly separate from `gglab-shaderc`).

If custom HLSL nodes are introduced later, they are a constrained **escape hatch**, not a shortcut around the typed graph/profile architecture. They must still emit within the active Surface Profile Contract and pass the same profile conformance boundary. They must not become an ordinary path for basic math/surface operations, declare backend-specific bindings or entry points, reconstruct DXC/RHI policy, or bypass Gate 0/profile compatibility.

---

# 36. Explicitly rejected early designs

## 36.1 Serialize React Flow directly

Rejected because it couples durable authoring data to the current UI library.

## 36.2 C++ `ShaderGraphCompiler.exe` as the initial graph compiler

Rejected because it would likely duplicate node/type semantics between TypeScript UI and C++ graph compilation, or force a schema/code-generation framework before the graph semantics mature.

Reconsider only when a real native execution-environment requirement exists.

## 36.3 C++ descriptor owns the entire TS node/type system

Rejected.

The Surface Profile Descriptor only projects GGLab cross-boundary surface/profile facts. C++ must not reclaim Add/Multiply/Lerp behavior, DAG semantics, type inference, node registry implementation, or other ordinary ShaderGraph semantics.

## 36.4 Direct editor → DXC

Rejected because it creates a competing Shader production authority.

## 36.5 WebGPU/WebGL production Shader preview compiler

Rejected because it creates a second graph lowering/language/rendering truth.

## 36.6 Miniature standalone renderer first

Rejected because preview correctness should reuse GGLabRuntime first.

## 36.7 Embedded preview first

Rejected because GPU interop/presentation complexity is unrelated to proving the authoring/compiler/artifact/runtime seam.

## 36.8 CLI frontend with its own semantics

Rejected. A CLI-side node registry, type rules, validation, DAG rules, HLSL lowering, or profile interpretation would create a second semantic authority. The CLI serializes `ShaderGraphCore` decisions; only command/argument grammar, JSON transport, and exit behavior are its own.

---

# 37. Why TypeScript `ShaderGraphCore`

The initial editor needs one place where both UI and compiler can ask:

```text
What ports does this node have?
What types do they accept?
Is this connection legal?
What property changes semantics?
How does this node lower to HLSL?
```

With a pure TypeScript package:

```text
React Editor ────────┐
                     │
Vitest ──────────────┼→ ShaderGraphCore
                     │
Node CLI / CI ───────┘
```

A separate native graph compiler would tend toward parallel semantic registries unless a more complicated code-generation framework were introduced.

This decision does **not** move native Shader compilation into TypeScript:

```text
TypeScript: ShaderGraph semantics → HLSL
C++:        HLSL → ShaderArtifact
Runtime:    ShaderArtifact → GPU execution
```

---

# 38. When to reconsider a native ShaderGraph compiler

Reconsider only when a real execution-environment requirement appears, for example:

- native cooker/build-farm graph compilation without JavaScript;
- a host platform/toolchain where JavaScript runtime deployment is inappropriate;
- measured build-farm scale/operational problems with the TypeScript compiler;
- another native product that must share graph semantics and cannot consume the existing package/process contract.

Any migration should preserve the `.shadergraph` schema, semantic test corpus, golden HLSL/profile-conformance tests, and `gglab-shaderc` boundary.

A hypothetical future need is not sufficient reason to pay that complexity today.

---

# 39. Relationship to future Material authoring

This document intentionally defines a **Shader Graph Editor**, not the final GGLab Material system.

Gate 0 proves only the smallest real data/surface seam.

Once different graphs produce materially different Shader programs, a future Material asset may need:

```text
Material asset
├─ Material Program / ShaderArtifact identity
├─ ShaderGraph reference
├─ parameter defaults
├─ texture/resource bindings
├─ render-state choices
├─ variant/static parameters
└─ preview metadata
```

This may interact with:

```text
PSO identity / selection
draw grouping
program/artifact lifetime
hot reload
parameter binding
asset publication
```

These concerns remain outside `ShaderGraphCore` and Gate 0.

They require a separately reviewed later Runtime/material design.

---

# 40. Recommended engineering order

```text
Gate 0: prove minimal runtime input + output seam
      ↓
Freeze initial GGLab Surface Profile Contract
      ↓
Project machine-readable Surface Profile Descriptor
      ↓
Correct graph document
      ↓
Correct type system / validation
      ↓
Deterministic Surface Profile Descriptor-conforming HLSL
      ↓
Excellent node UX
      ↓
Compatible gglab-shaderc handshake + ShaderArtifact build
      ↓
Diagnostics navigation
      ↓
GGLab Shader Graph Preview Lab
      ↓
Separately designed Material Program / Runtime integration
```

A beautiful graph editor whose generated Shader cannot consume real Runtime-driven material data is not the target.

A correct compiler with unusable authoring UX is not the target either.

The architecture is intended to let both improve without creating parallel Shader or rendering truths.

---

# 41. Reference technology notes

Implementation choices are based on current capabilities rather than being permanent architecture:

- Tauri 2 sidecars/external binaries: <https://v2.tauri.app/develop/sidecar/>
- React Flow custom nodes: <https://reactflow.dev/learn/customization/custom-nodes>
- React Flow performance guidance: <https://reactflow.dev/learn/advanced-use/performance>
- Zustand: <https://zustand.docs.pmnd.rs/learn/getting-started/introduction>
- shadcn/ui: <https://ui.shadcn.com/docs>
- Tailwind CSS: <https://tailwindcss.com/docs>
- Monaco Editor: <https://github.com/microsoft/monaco-editor>

The durable architecture is the responsibility split around `ShaderGraphCore`, the frozen GGLab surface/profile contract, `gglab-shaderc`, `ShaderArtifact`, and GGLab Runtime.

---

# 42. Conclusion

The Shader Graph Editor is a separate modern authoring application, but it is not a separate Shader or rendering architecture.

Its defining path is:

```text
Gate 0 proves/fixes GGLab surface seam
   ↓
freeze Surface Profile Contract + Surface Profile Descriptor
   ↓
.shadergraph
   ↓
ShaderGraphCore
   ↓
Generated HLSL + ShaderGraphSourceMap
   ↓
gglab-shaderc
   ↓
ShaderToolchainCore
   ↓
ShaderArtifact
   ↓
GGLabRuntime / Renderer / RenderGraph / RHI
   ├─ Shader Graph Preview Lab
   └─ Production GGLab
```

The most important decisions are:

- React Flow is presentation, not persistence.
- The GUI and the CLI are two first-class authoring frontends over the single `ShaderGraphCore` semantic authority; the CLI is a thin machine/automation frontend that owns only grammar, transport, and exit behavior.
- TypeScript owns ordinary graph/node/type/DAG semantics.
- Gate 0 proves both Runtime-driven input flow and output consumption before the surface ABI is frozen.
- Gate 0 anchors the probe to the real Forward PBR material-evaluation site and records replayable named fixtures rather than relying on a constant-only or eyeball-only demonstration.
- the Surface Profile Descriptor projects proven GGLab cross-boundary facts as serialized data without becoming a second graph-semantic authority or C++ dependency.
- `gglab-shaderc` remains the editor-facing native Shader production entry point: ShaderGraph → HLSL is emission (`emit`), and the CLI never replaces `gglab-shaderc`.
- tool/profile compatibility is machine-readable, selects within the requested profile line, and fails explicitly.
- Shader Toolchain packaging is a deployment closure including required DXC/runtime dependencies.
- parameter HLSL symbols derive from stable semantic identity rather than mutable display labels.
- generated-source identity is exact-byte SHA-256.
- ShaderArtifact remains the native execution boundary.
- the first authoritative preview is a GGLab Preview Lab, not a second renderer, and safe last-good preview state survives newer failures with explicit stale status.
- backend preview availability follows production readiness.
- custom HLSL is a constrained future escape hatch, never a bypass around Gate 0 or Surface Profile Contract conformance.
- full Material Program/PSO/draw-grouping integration is acknowledged early but designed separately.

This preserves GGLab's Shader North Star while proving the real Runtime seam before the project invests heavily in editor scale.
