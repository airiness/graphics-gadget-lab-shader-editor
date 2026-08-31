# @gglab/shader-toolchain-client

Headless client for the GGLab shader toolchain (gglab-shaderc).

Owns: the machine-protocol vocabulary (contract facts, envelopes, the
`NativeCompileRequest` and `NativePreviewBuildRequest` shapes, build intents,
result states), the process-
level channel interpretation over the boundary's raw execution facts
(terminal states first — canceled / timed-out — then channel discipline:
stderr empty, stdout valid UTF-8, and the intact document's exit code
matching the observed process exit code), the strict readers for the
published ordinary handshake/result (`describe` / `compile`) and dedicated
Preview handshake/result (`describe-preview` / `build-preview`) envelopes, the
version/identity verdicts, the candidate-observation identity (path +
observed identity), and the tool-compatibility state machine around it —
every resolved state carries the candidate it is about (the state owns the
current candidate; the proof owns the proof facts), total over every
settlement, and race-safe: a candidate-scoped event (a handshake
settlement, a candidate invalidation) applies only to the candidate the
state currently carries, a stale settlement is ignored, and a canceled
handshake is not evidence; a timed-out / channel-violated / unreadable
handshake and a launch failure are unproven; and an invalidated candidate —
reported alike on a handshake or a compile attempt, a lifecycle event, not
a handshake settlement — stops being a resolved fact: the tool returns to
unavailable, proof void, until a fresh discovery + handshake — plus the
client-owned closure of every compile settlement into one structured
attempt outcome (a read envelope, or a structured termination fact, but
never a free-form reason) — and the revisioned build-line rules (stale /
current / last-good) over those outcomes, and the host-boundary
contract (the four allowlisted capabilities, the pre-spawn provenance
guarantee with its structured pre-spawn refusals — the candidate-invalidated
fact (changed / missing / unreadable) and the launch-failed fact — and the
request / result shapes) with its reference fake.

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
