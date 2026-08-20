# @gglab/shader-graph-core

Headless GGLab ShaderGraph semantics package.

Owns: graph document schema and versioning, type rules, validation, DAG
compilation, deterministic HLSL generation, and source maps. Consumed by the
editor application, the test harness, and future CLI/batch tooling.

Invariants: pure TypeScript; no React, React Flow, Zustand, Tauri,
DOM/Web API, native addon, or C++ dependency. Surface profile descriptors
are consumed as serialized data documents, never as C++/native imports.
