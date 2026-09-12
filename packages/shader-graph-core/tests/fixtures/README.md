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
Explorer lists the three graph documents; this README and the TypeScript
descriptor fixtures are not graph entries. Browser mode does not provide native
Workspace directory access.

## Scene roles

| File | Purpose |
| --- | --- |
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
