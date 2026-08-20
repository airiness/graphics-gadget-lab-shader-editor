# @gglab/shader-graph-cli

Machine/automation authoring frontend for the GGLab shader graph editor.

Owns: a structured command surface (machine-readable in/out, stable exit
behavior, dry-run, transactional batch edits) and serialization of core-owned
results, designed for AI agents, CI, automation, batch editing, and headless
debugging/reproduction.

Never owns: graph semantics, node registries, port/type rules, connection
validation, DAG rules, HLSL lowering, profile interpretation, or shader
production. Those come from `@gglab/shader-graph-core` and the frozen surface
profile descriptors; native compilation remains the domain of
`gglab-shaderc` in the main GGLab repository.

Together with `@gglab/editor` (the GUI frontend), this package is one of two
frontends over the single semantic authority, `@gglab/shader-graph-core`.
