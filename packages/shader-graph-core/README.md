# @gglab/shader-graph-core

Headless GGLab ShaderGraph semantics package.

Owns: graph document schema and versioning, type rules, validation, DAG
compilation, deterministic HLSL generation, and source maps. Consumed by the
editor application, the test harness, and future CLI/batch tooling.

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
