# Golden authoring and native Preview Workspace

This directory is both the core's checked-in graph fixture collection and the
Editor's shared golden authoring sample. Open this directory directly as a
Workspace; no Workspace manifest, repository root, or copied graph is required.
These are tool-owned regression scenes, not product material assets.

## Open in the desktop Editor

1. Open **Explorer**, press **Choose…**, and select
   `packages/shader-graph-core/tests/fixtures` in the Shader Editor checkout.
2. Press **Discover**, then open **surface-texture-preview.shadergraph** for
   native Preview. **SurfaceTextureGolden.shadergraph** is the broader authoring
   golden; its four parameters do not match the current native Preview contract.
3. Use **GGLab Environment…** to import or verify and select a compatible
   Environment. The Preview sample requests `gglab.surface` profile v2; its descriptor
   is resolved from that Environment. Choosing a Workspace alone does not
   configure native compilation or Preview.
4. Click **Preview this graph**. It selects the sample as the Preview target,
   proves Preview compatibility, builds, and starts Runtime after successful
   publication. The bottom Preview panel shows progress and refusals. Native
   tool readiness must already be established for the selected Environment.
   The active editing tab and the Preview target remain separate selections;
   switching tabs alone does not change the target.

The directory picker selects `fixtures`, not the `.shadergraph` file.
Explorer lists the four graph documents; this README and the TypeScript
descriptor fixtures are not graph entries. Browser mode does not provide native
Workspace directory access.

## Scene roles

| File | Purpose |
| --- | --- |
| `surface-neon-reactor-preview.shadergraph` | Procedural cyan/magenta concentric neon rings over a dark backplate; 33 nodes using the frozen two-parameter Preview contract. |
| `surface-color-study-preview.shadergraph` | Interactive color study: UV gradient, tiled texture mask, cyan/orange palette, masked emission, metallic and roughness outputs. Uses the same frozen two-parameter contract. |
| `surface-texture-preview.shadergraph` | Native Preview sample for the frozen `gglab.preview-input.surface.texture2d` contract: exactly `p.rough` and `p.tex`. Texture RGB drives BaseColor, B drives Metallic, roughness comes from the Preview Lab, Emissive is zero and Opacity is one. |
| `SurfaceTextureGolden.shadergraph` | Legal Surface v2 graph: texture sampling, scalar/vector parameters, RGB fan-out, math and all five surface outputs. Zero graph diagnostics; fixed deterministic HLSL fingerprint. |
| `SurfaceDiagnostics.shadergraph` | Intentionally invalid graph for Problems/navigation and failed-emission behavior. It opens but must refuse emission. |
| `descriptor-v1.ts`, `descriptor-v2.ts` | Synthetic core contract fixtures, not descriptors to select in the app and not native compatibility evidence. |

The golden's semantic graph and generated HLSL identity are locked by
`../golden-scene-contract.test.ts`. GUI tests consume this exact file rather
than a second copy. Its existing canvas positions are presentation metadata.
Opening it does not make it the app's automatic startup document.

The graph declares a texture parameter; it does not package a texture file,
material instance, renderer or Environment. Runtime resource binding and visual
appearance remain owned by GGLab's Preview integration. Graph validation and
deterministic emission alone do not prove native compilation or Runtime output.
The native sample uses the Preview Lab's GGLab-owned deterministic texture and
sampler fixture; no external texture file needs to be selected or redistributed.
Changing its parameter IDs, classes, types or count can make it ineligible for
the frozen Preview contract. Graph logic may be edited within that contract.

[Native sample evidence](../../../../docs/texture-preview-sample-evidence.json)
records the exact sample hash, producer revision, Editor review baseline and
Debug/Release DX12/Vulkan Loaded observations. The opt-in native test reads this
sample file directly; it does not substitute the in-memory Environment probe.

Saving in place changes the checked-in regression fixture. Use **Save As** for
free-form experiments; edit the original when intentionally updating the golden
and review the corresponding tests. No runtime state or generated artifacts
belong in this fixture directory.

## Color study: see the graph change the image

Open **surface-color-study-preview.shadergraph**, then click **Preview this graph**.
The 22-node graph uses only the existing `p.rough` / `p.tex` contract; the editable
controls are ordinary constant nodes, not additional Runtime parameters.

With Runtime's default **1x1 White** texture, the mesh UV's U coordinate blends
**Cool Color** (cyan) into **Warm Color** (orange). The same mask adds colored
emission toward the warm end. For a patterned version, select **Texture2D v2 →
Texture Fixture → Procedural Checker** in the Runtime Preview Lab. The graph
multiplies the tiled texture's red channel by the UV gradient before clamping
the result; the checker therefore modulates both the palette and emission.
No external texture is required.

Use **Save As** before experimenting. Select these labeled constant nodes in the
Editor, change their values in the Inspector, then click **Preview this graph**
again to publish the edited graph:

| Node | Initial value | Experiment and expected effect |
| --- | --- | --- |
| Cool Color / Warm Color | `[0.01, 0.7, 0.95]` / `[1, 0.08, 0.01]` | Swap the two colors to reverse the palette. |
| Gradient Direction | `[1, 0]` | Set `[0, 1]` to use V instead of U; `[0, 0]` makes the entire surface the cool color and removes emission. |
| Texture Tiling | `3` | With Procedural Checker selected, compare `1` and `6` to change pattern density. White texture has no pattern to tile. |
| Glow Strength | `0.65` | Set `0` to remove emission, or `1.5` to make it stronger. |
| Metal Strength | `0.85` | Set `0` while viewing Metallic to remove its mask. |
| Polished Roughness | `0.08` | Set `0.9` while viewing Roughness to change the warm end of the gradient. |

Runtime **Preview Program → Output View** can isolate **Base Color**, **Emissive**,
**Metallic**, and **Roughness**. The current **Combined** visualizer adds Emissive
to lit BaseColor; it does not evaluate a metallic/roughness PBR BRDF or promise
bloom. Use the individual output views to inspect those graph outputs directly.
Runtime's **Texture2D v2 → Roughness** controls the other end of the roughness
blend without rebuilding. Mesh UV layout determines the placement of the gradient.

The native qualification test reads both checked-in Preview samples and requires
successful publication and Runtime Loaded observations on each backend. Native
Loaded evidence does not itself assert screenshot appearance.
[Color study evidence](../../../../docs/color-study-preview-sample-evidence.json)
records the exact sample hash and Debug/Release DX12/Vulkan results.


## Neon reactor: procedural rings

Open **surface-neon-reactor-preview.shadergraph** and select **Preview this graph**.
Use Runtime **Combined** or **Emissive**, with the default **1x1 White** texture.
The intended effect is two concentric soft-edged neon rings: a cyan inner ring,
a magenta outer ring and a midnight-blue backplate. Placement follows the mesh
UVs; changing the preview mesh can change how the rings wrap. The graph is static
and does not require bloom, a time input or external textures.

The 33-node graph computes squared UV distance from Reactor Center. Each ring
subtracts a target squared radius, squares that difference, scales/clamps it and
inverts it to obtain a smooth bright band. Separate color branches are added and
scaled into Emissive. The Runtime texture only modulates the dark BaseColor, so
ring visibility does not depend on a particular texture fixture. Runtime
Roughness, Metallic and Opacity retain their explicit Surface output paths.

Use Save As before experimenting:

| Node | Initial value | Experiment |
| --- | --- | --- |
| Reactor Center | `[0.5, 0.5]` | Move to `[0.35, 0.6]` to shift both rings. |
| Inner Radius Squared | `0.045` | Set `0.09` to expand the cyan ring. This is radius squared. |
| Outer Radius Squared | `0.16` | Set `0.12` to bring the magenta ring inward. |
| Inner / Outer Sharpness | `14000` / `5200` | Lower values widen the bands; higher values narrow them. |
| Inner / Outer Neon Color | `[0.01, 0.85, 1]` / `[1, 0.015, 0.25]` | Try green and amber for another palette. |
| Glow Strength | `2.5` | Compare `0`, `1` and `4`; zero leaves only the dark backplate. |

After editing, Preview this graph republishes the changed source. Combined adds
Emissive to the lit base; glow here describes emission intensity, not a bloom
post-process. No new node semantics or Runtime input parameters are introduced.
Native compilation/Loaded evidence is recorded separately from visual inspection.

[Neon reactor evidence](../../../../docs/neon-reactor-preview-sample-evidence.json)
records Debug DX12/Vulkan native compilation and Runtime Loaded for this sample.
Release and rendered appearance were not requalified in this run.
