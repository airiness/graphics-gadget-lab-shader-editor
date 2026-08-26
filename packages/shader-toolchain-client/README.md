# @gglab/shader-toolchain-client

Headless client for the GGLab shader toolchain (gglab-shaderc).

Owns: the machine-protocol vocabulary (contract facts, envelopes, the
`NativeCompileRequest` shape, build intents, result states), the strict
readers for the published handshake (`describe`) and result (`compile`)
envelopes, the version/identity verdicts, the tool-compatibility state
machine, the revisioned build-line rules (stale / current / last-good), and
the host-boundary contract (the four allowlisted capabilities and their
request/result shapes) with its reference fake.

Consumed by the editor composition and the CLI authoring frontend. The
toolchain's wire contracts are published by the main GGLab repository; this
package consumes them strictly and declares the contract versions it
supports.

Invariants: pure TypeScript; no React, Tauri, DOM/Web API, Node/OS runtime
import, native addon, or C++ dependency. No argv type anywhere in its
vocabulary — invocation serialization is a host-internal detail of the
service that implements the declared boundary. Dependency-free from
`@gglab/shader-graph-core` in both directions: the editor is the single
composition point where their types may meet.
