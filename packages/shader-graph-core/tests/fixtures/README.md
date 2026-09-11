# Golden authoring Workspace

This directory is both the core's checked-in graph fixture collection and the
Editor's shared golden authoring sample. Open this directory directly as a
Workspace; no Workspace manifest, repository root, or copied graph is required.
These are tool-owned regression scenes, not product material assets.

## Open in the desktop Editor

1. Open **Explorer**, press **Choose…**, and select
   `packages/shader-graph-core/tests/fixtures` in the Shader Editor checkout.
2. Press **Discover**, then open **SurfaceTextureGolden.shadergraph**.
3. Use **GGLab Environment…** to import or verify and select a compatible
   Environment. The golden requests `gglab.surface` profile v2; its descriptor
   is resolved from that Environment. Choosing a Workspace alone does not
   configure native compilation or Preview.
4. Click **Preview this graph**. It selects the golden as the Preview target,
   proves Preview compatibility, builds, and starts Runtime after successful
   publication. The bottom Preview panel shows progress and refusals. Native
   tool readiness must already be established for the selected Environment.
   The active editing tab and the Preview target remain separate selections;
   switching tabs alone does not change the target.

The directory picker selects `fixtures`, not the `.shadergraph` file.
Explorer lists the two graph documents; this README and the TypeScript
descriptor fixtures are not graph entries. Browser mode does not provide native
Workspace directory access.

## Scene roles

| File | Purpose |
| --- | --- |
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

Saving in place changes the checked-in regression fixture. Use **Save As** for
free-form experiments; edit the original when intentionally updating the golden
and review the corresponding tests. No runtime state or generated artifacts
belong in this fixture directory.
