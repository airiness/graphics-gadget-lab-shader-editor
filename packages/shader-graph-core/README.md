# @gglab/shader-graph-core

Headless GGLab ShaderGraph semantics package.

Owns: graph document schema and versioning, type rules, validation, DAG
compilation, deterministic HLSL generation, source maps, and semantic edit
commands. Consumed by the editor application, CLI and test harness.

Invariants: pure TypeScript; no React, React Flow, Zustand, Tauri,
DOM/Web API, native addon, or C++ dependency. Surface profile descriptors
are consumed as serialized data documents, never as C++/native imports.

`.shadergraph` disk format: owned by this package. `serializeShaderGraphDocument`
is the canonical, deterministic serialization (fixed field order, sorted
retained-field keys, canonical nested JSON, 2-space indent, trailing
newline), and `parseShaderGraphDocument` is its inverse — the pair closes a
byte-stable, structurally lossless round trip in which retained
forward-compatible fields stay at their own level. Frontends must not
hand-roll document serialization: a raw `JSON.stringify` of the model
object emits the internal `unknownFields` bookkeeping keys, which the
reader then re-nests — corrupting the round trip.

## Semantic edits

`GraphEditCommand` and `graphEditCommandCatalog` define the shared edit
vocabulary. `readGraphEditCommand` and `parseGraphEditCommands` reject unknown
commands/fields and malformed arguments. `applyGraphEdit` serves typed callers
through the same command boundary and returns `changed`, `unchanged`, or
`refused`, a document, structured diagnostics, and an optional created ID.
Unchanged and refused operations preserve the input document instance.

Commands cover node creation/deletion, constant values, parameter creation and
display-name changes, connection creation/deletion/reconnect/port disconnect,
and explicit profile selection. Omitted creation IDs use the first available
`nN`, `pN` or `cN` identity in the corresponding document namespace. Explicit
IDs must be valid and unused. Parameter creation returns its node ID and
creates its parameter entry atomically. Runtime parameter values are not
document properties and have no edit command.

`applyGraphEdits` applies a batch atomically. A refusal returns the original
document, no created IDs, the failed command index, and structured diagnostics
(including `EDIT_TRANSACTION_REFUSED` at `$.commands[index]`). A net no-op
returns the original instance. `createdIds` aligns with successful commands;
non-creation entries are null. Intermediate incomplete graphs are allowed:
validation and emission remain separate services, not edit-success claims.

`set-profile` requires a descriptor matching the explicitly requested profile
line and runs the existing compatibility/conformance services. Supplying a
descriptor to an ordinary edit never changes the document's profile. Constant
edits reject unsupported node versions. Unknown fields survive edits; deleting
a node also removes its connections and its retained metadata entry. Canvas
placement, history and selection are frontend concerns.
