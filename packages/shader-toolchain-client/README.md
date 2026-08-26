# @gglab/shader-toolchain-client

Headless client for the GGLab shader toolchain (gglab-shaderc).

Owns: the machine-protocol vocabulary (contract facts, envelopes, the
`NativeCompileRequest` shape, build intents, result states), the process-
level channel interpretation over the boundary's raw execution facts
(terminal states first — canceled / timed-out — then channel discipline:
stderr empty, stdout valid UTF-8, and the intact document's exit code
matching the observed process exit code), the strict readers for the
published handshake (`describe`) and result (`compile`) envelopes, the
version/identity verdicts, the candidate-observation identity (path +
observed identity; a proof binds to the exact observation it was taken
under) and the tool-compatibility state machine around it, the revisioned
build-line rules (stale / current / last-good), and the host-boundary
contract (the four allowlisted capabilities, the pre-spawn provenance
guarantee with its structured candidate-changed refusal, and the request /
result shapes) with its reference fake.

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
