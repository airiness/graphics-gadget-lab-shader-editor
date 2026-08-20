# @gglab/editor

Editor application shell and composition root for the GGLab shader graph
editor.

Owns: desktop shell wiring, the narrow native tool bridge, and the
presentation surface built from `@gglab/editor-ui` on top of the
`@gglab/shader-graph-core` semantic services.

Never owns: graph semantics, type rules, validation, HLSL generation,
shader compilation, or backend target policy.
