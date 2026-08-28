# GGLab Shader Editor — Toolchain Integration Design

> Status: Construction-level design (active stage, started 2026-08-24)
> Scope: how the shader editor CONSUMES the external Shader Toolchain contract and completes the toolchain-integration stage: tool discovery, the strict readiness gate, the narrow host service, native compile request composition, generated-source staging, revisioned build state, the Build Inspector, the test model, and the implementation order.
> Authority relationship: Implements the owner decisions recorded in `GGLab_Shader_Graph_Editor_Architecture.md` (§19 – §22, §25, §31 stage record, 2026-08-24). It does not modify the baseline; where the two differ, the baseline wins and this document is a defect to report.
> Read first: the architecture baseline, then this document.

One sentence for the whole document:

> **What the editor requires is not what the editor owns.** The editor states
> the facts it requires and the ranges it supports; it owns neither the
> toolchain's wire contract nor the toolchain's version axes.

---

## 1. Scope / Non-goals

**In scope (this document builds):**

- Tool discovery model: precedence rules, candidate facts, failure as structured state.
- The strict readiness gate, as two state spaces in two domains: ToolCompatibility (`unavailable / discovered / unproven / incompatible / compatible`, client verdict) and NativeBuildReadiness (`Ready` / `NotReady{reasons}`, editor composition), with no bypass path.
- The new headless `shader-toolchain-client` package: machine-protocol consumption, ToolCompatibility verdicts, the host-boundary contract (allowlisted operations + the `NativeCompileRequest` shape — no argv in its vocabulary), build-intent and build-line (stale/current/last-good) pure rules, and reference host-boundary fakes.
- The narrow Tauri `ShaderToolService` (discover / handshake / compile / cancel).
- Native compile request composition (target/stage/entry/source) and generated-source staging.
- Revisioned asynchronous build state and last-good preservation.
- Toolchain diagnostics transport (carry, display, bind — not yet navigate).
- The Build Inspector model: exact fields, each with one source of truth.
- The test model: pure client tests, host-boundary fakes (exposing no argv), intent/attempt ordering (including the producer-identity intent case), ToolIncompatible/ToolUnproven/ToolUnavailable, TargetUnsupported as a readiness reason (never a tool-state change), the per-attempt staging rule, plus the two kind-distinct manual smokes (exploratory — permitted at any time, outside the editor, state-changing never; stage-acceptance — after the handshake, real product path).

**Out of scope (explicit non-goals):**

- Defining, proposing, or duplicating the toolchain handshake/result wire schema, or assigning values to any toolchain version axis, or pre-declaring the external contract's unknown-field policy. That authority is the GGLab Shader Toolchain contract authority's (normative design in the GGLab docs repository; implementation and self-tests in the main GGLab repository).
- Native diagnostic → graph navigation via the source map (a later stage's work).
- The Preview Lab, Material Programs, and Runtime integration.
- A `build` command or any native-build orchestration in `apps/cli` (owner-deferred; separately reviewed).
- Packaging/deployment closure (the packaged toolchain + DXC runtime).
- Any second compiler, backend policy, or material ABI — invariant, not negotiable.

---

## 2. Existing authorities

| Authority | Owns | Consumed here as |
| --- | --- | --- |
| `shader-graph-core` | node/port/type authority; validation; deterministic emission; source map; generated-source identity (SHA-256 of exact bytes); descriptor reading; profile×descriptor compatibility (capability-based verdict) | a headless sibling; facts passed in, never a dependency target |
| Surface Profile Descriptor | the frozen cross-boundary profile facts, including the narrow tool requirement (tool identity, minimum version, its comparison rule) and the generated-function facts (name/stage) | a serialized data document parsed by core's strict reader |
| `gglab-shaderc` (external) | the toolchain process contract: the machine-readable result envelope (published, stable), status vocabulary, exit codes, targets; and the discovery handshake contract — owned by the GGLab Shader Toolchain contract authority: normative design in the GGLab docs repository, implementation and contract self-tests in the main GGLab repository | an external process; consumed through the client's strict readers and verdicts |
| Tauri host (`ShaderToolService`) | bounded process execution; serialization of an approved allowlisted request into the tool invocation (host-internal); scoped file IO (existing) | a host boundary; no protocol interpretation, no readiness, no policy |

---

## 3. Package topology

```text
apps/editor                      composition root; session stores; Build Inspector
├─ @gglab/editor-ui              presentation only (unchanged)
├─ @gglab/shader-graph-core      graph semantics / emission / source map / profiles (unchanged)
└─ @gglab/shader-toolchain-client   NEW — machine protocol, compatibility verdicts,
                                    build intent / result states
                                    (current/stale/last-good), the host-boundary
                                    contract, NativeCompileRequest shape
                                    (headless pure TypeScript, no argv anywhere)

host boundary (declared by the client package, implemented outside it):
├─ Tauri ShaderToolService (Rust)   the product implementation: allowlisted-request
│                                   validation → tool-invocation serialization
│                                   (host-internal) → bounded execution
└─ TS fakes                         the test-side implementation of the same boundary
```

Both headless packages remain independently usable and independently testable. The client package never imports React, Tauri, the DOM, or any Node/OS runtime API; it ships no process execution and owns no argv — invocation serialization is host-internal (Rust), and the test fakes never expose argv either.

---

## 4. Dependency rules

- **`shader-graph-core ⟂ shader-toolchain-client`:** no dependency in either
  direction — no type imports, no value imports. They are sibling domains.
- **`apps/editor → { @gglab/editor-ui, @gglab/shader-graph-core, @gglab/shader-toolchain-client }`**: the editor is the single composition point.
- **Composition mapping:** because the client does not know core's types, the
  editor's composition layer maps core facts into the client's plain value
  inputs: the descriptor's tool requirement (identity, minimum version,
  comparison rule), the emission's source bytes + its SHA-256 identity, and
  the descriptor's generated-function facts (stage, entry). The editor is the
  only place where a core type and a client type meet.
- **The client's vocabulary is its own plain value types** (contract facts,
  envelopes, the `NativeCompileRequest` shape, build intents, result states).
  It never understands `ShaderGraphDocument`, `GraphType`, node semantics, or
  graph diagnostics — and it contains no argv type at all: argument arrays
  exist only inside the host boundary.
- **Host implementations never import each other:** the Tauri service and the
  test fakes are independent implementations of the one declared host-boundary
  contract (the allowlisted operations and their request/result shapes,
  declared by the client package).

---

## 5. Tool discovery model

Precedence (first hit wins; every step is either a candidate or a recorded failure):

```text
1. explicit editor configuration (a path set by the user in editor settings)
2. configured sibling GGLab build output (a configured build-output location)
3. bundled deployment (packaged builds; absent in development)
```

Each resolved candidate is a fact record — never a readiness claim:

```text
toolCandidate = {
  rule:                explicit-config | sibling-build | bundled,
  toolPath:            <resolved executable>,
  observationIdentity: <host-generated identity of the file at resolution>,
  resolvedAt:          <session time — observation METADATA, not identity>
}
```

The candidate's identity is `toolPath + observationIdentity`: the rule is
WHERE the path was found (not what the executable is), and the resolution
moment is WHEN it was looked at — looking at the same unmodified
executable again invalidates nothing. `observationIdentity` is
host-generated (file identity, size/mtime, a hash, or the host's opaque
provenance token — the host implementation decides what it is); a changed
observation of the same path — the binary replaced under the path — is a
DIFFERENT candidate.

Because of that, proof binds to the exact candidate observation it was
taken under, and it never travels: a proof under one observation applies
to no other, and a changed observation loses its proof (re-discover,
re-handshake the new candidate). The boundary enforces the other half of
the guarantee — provenance continuity AT SPAWN TIME: `handshake(candidate)`
and `compile(candidate, request)` spawn only after the host's pre-spawn
check confirms the path's current observation still matches the
candidate's identity — otherwise the settlement is structured: the
observation is `changed` (the path's current observed identity, for
re-discovery), `missing`, or `unreadable`, and the host did NOT spawn;
bounded execution failing to launch at all settles as the
`launch-failed` fact. None of these is a spawn of an unverified
executable, a crash, or an OS error code promoted to protocol.

TOCTOU is part of the guarantee: the check must hold the candidate
across the launch (for example a file handle whose share mode blocks
write/delete/replace until process creation settles) — an executable
that merely looks and then launches through the path is NOT
provenance continuity.

If no rule resolves a candidate, discovery fails as the state `unavailable`,
carrying one structured reason per failed rule (which rule, why it failed).
Discovery is pure editor-side bookkeeping over configuration facts; it does
not execute the tool and does not interpret any of its output.

---

## 6. Readiness — two state spaces in two domains

The tool's state is the client's verdict; the build's readiness is the
editor's composition. They are separate state spaces — never one mixed
ladder — because mixing them makes names ambiguous ("incompatible" meaning
either the tool or the descriptor) and forces one domain to decide what it
cannot know:

**Tool compatibility (judged by the Toolchain Client):**

```text
unavailable    no CURRENTLY VALID resolved candidate — none found, or the
               resolved observation was refuted by the host at spawn time
discovered     a candidate resolved — a FACT, never a readiness claim
unproven       resolved, but not machine-readably proven compatible: the
               observed process-contract axis falls outside the client's
               declared supported range, the tool's machine facts are
               absent, or its handshake does not read, or the
               channel is violated, or the attempt times out, or the
               launch fails
incompatible   resolved, and the TOOL's facts contradict the required ones
compatible     proven machine-readably compatible
```

Ownership, and the stale-settlement rule: EVERY resolved state carries the
candidate it is about — the state owns the current candidate, the proof
owns the proof facts (the contract axis taken under), so "which candidate"
has exactly one authority. Handshake and compile are asynchronous:
settlements may settle out of order, after discovery has moved on.
Therefore a CANDIDATE-SCOPED event (a handshake settlement, a candidate
invalidation) applies ONLY to the candidate the state currently carries;
a settlement that lands over a different candidate is stale and is
ignored — the tool lifecycle applies the same discipline the build line
already applies to slow old attempts, and the old candidate cannot loop
back into proof through a late event. A candidate-resolved event is the
one that may supersede: a new observation is a new fact.

Tool-side transitions fire only on tool-side events. The handshake is the
operation that establishes or refreshes proof, and it remains LEGAL for any
resolved candidate — `discovered`, `unproven`, and `incompatible` alike
(`unavailable` naturally has no candidate to handshake); re-handshaking is
exactly how `unproven` and `incompatible` tools enter — and re-enter after
an update at the same path — `compatible`. Target COVERAGE by the tool is
not a tool-state question (it is a build readiness input below), so the
same executable must not oscillate between `incompatible` and `compatible`
when the user changes the target. Tool compatibility is the TOOL's
compatibility; target readiness is ONE BUILD's compatibility.

A re-statement of the REQUIREMENT (the judgment input — the tool
identity, minimum version, comparison rule) is tool-side too: every
verdict was taken under it, so a changed requirement voids them. The
candidate observation is unaffected (the tool did not change; the
demand did), so the tool drops to `discovered` keeping its candidate,
and a fresh handshake re-proves it under the new requirement. The
client never re-judges from stored facts and never compares versions
itself — re-proof is the handshake. A re-statement of the SAME value
changed nothing: the verdict stands.

```text
(any)                     → unavailable   discovery fails on all rules
discovered/unproven/…     → discovered    a new candidate observation resolves —
                                           an observation event, so any proof of a
                                           prior observation drops with it
discovered/unproven/…     → discovered    the REQUIREMENT (judgment input) is
                                           re-stated — every verdict taken under
                                           the old requirement is void; the
                                           candidate observation stays a fact
                                           (the tool did not change; the demand
                                           did); a fresh handshake re-proves
discovered                → unproven      handshake attempted; the observed
                                           contract axis is outside the client's
                                           declared supported range, or the
                                           tool's machine facts are absent, or
                                           the handshake does not read
discovered                → incompatible  the tool's facts contradict the required
                                          ones (identity mismatch, version below
                                          the required minimum, contract axis
                                          out of range) — facts the tool itself reports; target COVERAGE is a build
                                           fact, not part of this verdict
unproven / incompatible   → compatible    a (re-)handshake proves the tool's
                                           facts under a contract the client
                                           supports; the proof BINDS to the exact
                                           candidate observation it was taken under
compatible                 → unproven / incompatible   tool facts change and
                                          proof is lost — or a changed
                                          observation of the candidate resolves
                                          (the binary replaced at the path) and
                                          the proof bound to the old observation
                                          no longer applies
(any)                     → unavailable   the host refutes the candidate's observation
                                           (changed / missing / unreadable) on a handshake or a compile
                                           attempt — the refuted observation is no longer a
                                           fact, the proof bound to it is void, and there is no candidate
                                           left to handshake; a fresh discovery + handshake re-enters
(any)                     → unavailable   the tool is no longer resolvable
```

A handshake CANCELED by the operator is not tool evidence: no fact was reported, so the state stays exactly as it was — an explicit action, not an observation.

**Native build readiness (composed ONCE, by the editor orchestration):**

```text
Ready      tool compatible
           AND profile/descriptor compatible (core verdict)
           AND host execution capability (service report)
           AND the explicit build target configured
           AND the configured target ∈ the tool's published supported targets
NotReady   otherwise — ALWAYS with a structured reason list:
           [ToolUnavailable | ToolDiscovered | ToolUnproven | ToolIncompatible
            | DescriptorIncompatible | HostUnavailable | TargetNotConfigured
            | TargetUnsupported]
```

Reasons are visible, complete, and structured: every non-Ready input
contributes its reason. A `NotReady{…}` is the inspector's explanation, not
a failure.

Guarantees, per layer — each layer guarantees exactly what it owns:

- **The product compile gate lives in the editor orchestration.** Only a
  `Ready` composition issues a native compile request. No bypass: no dev
  mode, environment flag, or local setting routes a request through a
  `NotReady` composition — the path does not exist to configure because none
  is defined.
- **The Toolchain Client guarantees the tool-operation level, split by
  gate** — this is the distinction that keeps the state machine from
  deadlocking:
  - Handshake gate: the handshake is the operation that establishes or
    refreshes proof, and it is LEGAL for ANY resolved candidate —
    `discovered`, `unproven`, and `incompatible` alike (`unavailable`
    naturally has no candidate to handshake). Re-handshaking `unproven` or
    `incompatible` is exactly how they enter `compatible`; for that reason
    the old formulation "the client refuses handshakes on unproven tools"
    is WITHDRAWN — it would make `compatible` unreachable.
  - Compile gate (client-side half): it never forms a legal COMPILE operation
    (a `NativeCompileRequest`) out of an unavailable / unproven /
    incompatible tool — and only for the candidate observation its proof was
    taken under; a changed observation is refused as unproven again. Every
    refusal is a structured result.
  It composes nothing — it does not know the descriptor profile, the host,
  or the target, and it is not asked.
- **The Tauri service guarantees the boundary level:** it executes only
  allowlisted, in-shape domain requests, bounded. It knows nothing about
  readiness and enforces nothing about it — readiness is not its domain.
- **Readiness is derived, never remembered:** recomposed from current facts
  on every input change; a session restart starts at worst at `discovered`.
  Downgrades (a reason appearing) are as visible as upgrades.

---

## 7. Tool compatibility consumption

The editor's verdict requires a small set of FACTS from the tool. The
handshake's wire form — fields, values, version axes — is owned by the
external Shader Toolchain authority. This document names the facts a verdict
needs; it does not define the contract and assigns no values to the
toolchain's axes:

```text
required facts for the verdict (v1):
  the tool's identity                          (the descriptor requires one — the editor never picks it)
  the tool's version                            (judged against the descriptor's minimum under the descriptor's own comparison rule)
  the tool's process-contract version axis      (checked against the range the client declares it supports)
  the producer/compiler identity
  the tool's published supported targets        (extracted as a tool FACT;
                                                 whether the CONFIGURED target is
                                                 among them is judged by the
                                                 editor composition — the client
                                                 holds no configuration)
```

The artifact contract/schema axis is **not** required in v1: it enters only
when the editor/preview genuinely consumes a versioned ShaderArtifact
contract (deferred, §15). Do not invent handshake requirements from facts
the compile result already carries (`binaryPath`, `binaryHash`,
`cacheRecordPath` are result evidence, not handshake requirements).

Reader discipline:

- The client DECLARES the handshake-contract versions it supports. Contract
  versions outside its declared range are explicitly unsupported (the
  client's own range discipline) — never silently accepted, never silently
  reinterpreted.
- For everything inside a supported published contract, the client follows
  the compatibility and field-tolerance rules THAT CONTRACT defines — the
  descriptor reader's strictness belongs to the descriptor schema the
  editor itself reads, and is not automatically projected onto an external
  wire contract (published optional fields are optional; how they are
  handled is the contract's business, not ours to pre-declare).
- The supported set is exactly one declared fact, declared exactly once in
  the client (its declaration module). The published machine process
  contract v1 is in that set — the client's reader for that published form
  is complete and tested. Any axis OUTSIDE the declaration is explicitly
  unsupported, and the state ladder shows it verbatim (unproven when the
  client declares no range at all; incompatible when a declared range does
  not cover the observed axis) — an explicit refusal of the axis, never a
  hidden guess. The declaration is a state of the world, visible and
  explainable, and it moves only when the toolchain publishes or extends
  the contract through its own review.
- When the toolchain publishes (or extends) the contract through its own
  review, the client gains a strict reader for that published form —
  consumption of an external contract, never a definition of one.
- The client owns the channel interpretation BELOW the document level too:
  over the boundary's raw execution facts (stdout bytes, stderr bytes, exit
  code, timeout, cancel) it judges the process-level contract — the terminal
  states first (canceled / timed-out settle before anything is read), then
  channel discipline (stderr must be empty; stdout must decode as UTF-8),
  then the document reading, and only then the consistency fact that the
  intact document's own exit code equals the process exit code the host
  observed. The editor composes states from those outcomes, never from raw
  stream or exit-code checks of its own.

**The result envelope is already a published, stable toolchain contract**
(machine-readable, tested in the toolchain repository). Consuming it —
parsing it strictly, checking its status vocabulary, extracting the build and
artifact facts — is client work and needs no toolchain-side change.

---

## 8. Native compile request composition

The request is composed at the editor's composition point from facts with
exactly one source each:

```text
target   ← explicit build configuration (owner-selected; ALWAYS explicit;
           never derived from the descriptor)
stage    ← descriptor generatedFunction fact
entry    ← descriptor generatedFunction fact
defines/includes ← descriptor contract facts (empty for the frozen v2 profile; the slot exists)
source   ← the staged generated HLSL: bytes = core's emission; identity = SHA-256 of the exact bytes
roots    ← service-owned locations (its private staging/cache/artifact areas)
```

The API shape keeps the target rule structural: the caller of the compile
entry supplies the request FACTS — a shape with NO target field — and the
composition point itself injects the configured target into the request
value. That same value is what the well-formed gate judges AND what the
boundary issues: configuration → request → BuildIntent is a one-way fact
stream, and no call shape can judge one target and issue another.

The flow, in order — each stage has one job and never does the next stage's
job, and **no argv exists anywhere on the TypeScript side**:

```text
NativeCompileRequest          domain-shaped, composed at the editor's
                              composition point:
                                { source bytes, sourceIdentity,
                                  target, stage, entry,
                                  defines/includes (empty in v2) }
   ↓
Tauri ShaderToolService       the product host boundary: validates the
                              allowlisted request shape, then serializes the
                              approved request into the tool's invocation
                              (structural arguments — host-internal, no shell
                              string, no policy), and executes bounded
                              (timeout/cancel; the pre-spawn provenance
                              check precedes the spawn; stdout + stderr
                              bytes + exit code + timeout/cancel state — or
                              the pre-spawn refusal (candidate-invalidated: changed / missing /
                              unreadable, or launch-failed) — is the entire output)
   ↓
gglab-shaderc                 production compilation (its own policy, its own evidence)
   ↓
raw output surface →         the Toolchain Client owns the full
                              interpretation, level by level: process-level
                              channel facts FIRST (canceled/timed-out are
                              terminal; stderr must be empty; stdout must
                              decode; the document's exit code must equal
                              the observed process exit code), THEN the
                              envelope read — verdicts + result facts
```

**Build intent and attempt identity — three concepts, not one.**

```text
GeneratedSourceIdentity   SHA-256 of the exact emitted bytes — the core's
                          durable CONTENT identity (unchanged)
BuildIntent               the semantic identity of the compile request:
                          sourceIdentity + target + stage/entry +
                          descriptor-contract inputs (defines/includes) +
                          the relevant proven tool/process facts
                          (identity, version, process-contract axis) —
                          everything that actually affects what the tool compiles
BuildId                   the identity of ONE concrete asynchronous attempt
                          (session-local, ordered) — who came later, when two
                          attempts share an intent
```

Identity and ordering are separate axes: same source bytes under a different
target is a DIFFERENT intent; two attempts within one intent are ordered by
BuildId. A result can be `current` only if it belongs to the current
BuildIntent and is the newest successful attempt within that intent (§11).
This creates no new persisted identity — both are session-local structured
data, and the durable content identity stays the core's SHA-256 and nothing
else.

The first real target is **`gglab-dx12`**, as explicit configuration — a
deployment choice for the development environment, not a semantic fact and
not a default smuggled into the descriptor.

---

## 9. Tauri ShaderToolService boundary

The service is the GUI's process boundary and nothing else.

```text
capabilities (exactly these, plus the existing scoped document/descriptor file I/O):
  discover(config)            → toolCandidate facts + per-rule failure reasons
  handshake(candidate)        → execution output (stdout bytes + stderr bytes
                                + exit code + timeout/cancel state) — or the
                                pre-spawn refusal (candidate-invalidated: changed / missing / unreadable,
                                or launch-failed) BEFORE the spawn
  compile(candidate, request) → buildId ; the same settlement when it settles
  cancel(buildId)             → explicit canceled state for that build

the boundary's actual job (all host-internal, in Rust):
  allowance      the request is one of the declared operations, in declared shape
                 (source bytes + identity present; target/stage/entry present)
  serialization  an APPROVED request is mapped to the tool's invocation —
                 structural arguments, no shell string, ever; this mapping is
                 a host-internal detail and owns no DXC/backend policy
  execution      the pre-spawn provenance check runs FIRST: the
                 candidate's path is observed and compared to its carried
                 identity; a mismatch settles as the structured
                 candidate-invalidated refusal (changed / missing / unreadable) and does NOT spawn; a launch the host could not attempt settles as launch-failed. Otherwise the
                 tool at the candidate path is spawned, nothing else; BOTH
                 streams captured whole (bounded) or timed out; timeout and
                 cancel enforced per build; the output surface (stdout + stderr
                 bytes, exit code, timeout/cancel state) — or the
                 candidate-invalidated / launch-failed refusal — is the ENTIRE output of the boundary
                 TOCTOU: the check must hold the candidate across the launch (a share mode that blocks write/delete/replace) — look-then-launch is NOT continuity
  staging        the private per-attempt area (§10)
```

Prohibited, by construction:

```text
no generic spawn(argv) — the service exposes only the four capabilities above
    and serializes only approved requests
no protocol interpretation in Rust — no envelope parsing, status
    interpretation, version comparison, or diagnostic classification
    (the raw output surface — stdout + stderr bytes, exit
    code, timeout/cancel state — or the pre-spawn refusal (candidate-invalidated / launch-failed) — is the entire output)
no readiness logic in the service — it does not know the descriptor, the
    profile, the host state, or the target policy; whether a request is
    allowed is decided above it, and the service cannot be asked
no staging-path exposure: the WebView receives names/identities, never
    paths it can use
no argv in the TypeScript world — no host interface, test fake, or client
    API exposes an argument array
```

The service owns no graph knowledge, no profile knowledge, and no
DXC/backend policy. If a service-level test needs protocol content, the test
has escaped its boundary and is wrong.

Implementation clauses (the Windows platform, the toolchain's platform):

```text
provenance guard  the pre-spawn check opens the candidate file read-only
                  with NO share mode (write, delete, rename, and replace
                  all fail while the handle is held), hashes it on that
                  handle (the observation identity is a SHA-256 content
                  hash — a stable "changed" detector), and holds the
                  handle until process creation settles: the
                  check-to-launch window is CLOSED by the guard itself,
                  not by timing. Identity now different → changed (the
                  current identity is reported, for re-discovery); no
                  file → missing; no readable handle → unreadable.
discovery single-flight  two levels, same direction: the SERVICE
                  serializes its own implementation (at most one
                  in-flight discovery per service session — a concurrent
                  discover is serialized behind the running one); the FLOW
                  decides which invocation is current — a call made while
                  a discovery is in flight JOINS that execution, not a
                  competing one, so a late settlement of an older call can
                  never supersede a newer observation. The service's lock
                  serializes the implementation; it cannot, and need not,
                  decide product intent. Discovery is light bookkeeping —
                  it gets no second async scheduling system of its own.
                  Handshake runs the same single-flight discipline in the
                  flow: never two concurrent handshakes for one
                  candidate — every entry point (startup bring-up, the
                  button) shares the one lane.
handshake candidate  the candidate a handshake compiles from is the one
                  the compatibility STATE carries; the UI holds no
                  private stale copy. The state machine's stale-settlement
                  rule is the backstop, not the design.
timeout policy    bounded execution is host policy — a handshake budget
                  and a compile budget as service constants, internal to
                  the host, not client configuration.
```

---

## 10. Generated-source staging

The generated HLSL is a **derived build input**, and its staging is owned
exclusively by the service:

```text
ownership   the service's private area (its host data location); the WebView
            has no path into it, no read, no write, no list
isolation   every attempt owns its own staging area:
              staging/<buildId>/<sourceIdentity>.hlsl
            Two builds — even the same bytes under a different target, or a
            double build click — NEVER share an area, so attempt A's
            cleanup can never remove attempt B's source
lifetime    created per attempt; the bytes are written by the service from
            the delivered emission; kept until that attempt settles (result,
            failure, or cancellation); cleaned by the service per attempt;
            re-created on service restart — never a durable session claim
evidence    the result carries, always, the core's durable source identity
            (SHA-256 of the exact bytes that were compiled), plus a
            service-local staging NAME (for the inspector, not a usable path)
```

A shared-by-name layout (`staging/<sourceIdentity>.hlsl`) is explicitly
excluded: concurrent attempts with identical source bytes would alias one
file, and a settling attempt could delete a live attempt's input. Per-attempt
areas make the lifetime rules local and trivial; refcounting/CAS is
deliberately not introduced in this stage.

The WebView's compile flow delivers bytes + identity to the service and
receives results back; it never names, opens, or manages a staging file.

---

## 11. Revisioned asynchronous build model

```text
BuildIntent := the compile-request identity (defined in §8):
               sourceIdentity + target + stage/entry
               + descriptor-contract inputs (defines/includes)
               + the relevant proven tool/process facts (tool identity,
                 tool version, process-contract axis, producer/compiler
                 identity)
BuildId     := the session-local, ordered identity of ONE asynchronous attempt
```

There is deliberately NO new persisted "BuildRevision": the durable content
identity stays the core's SHA-256 of the exact bytes, and intent + attempt
identity are session-local structured data over it.

Every build result occupies exactly one explicit state. A failure is a state,
not an exception, and a slow late result is data, not a correction:

```text
current      the newest SUCCESSFUL result belonging to the CURRENT BuildIntent,
             and the newest successful attempt within that intent
stale        a once-current result displaced by a newer BuildIntent; retained
             as evidence
last-good    the most recent successful result — preserved across newer failures
failed       explicit structured diagnostics from the machine contract; never prose
canceled     an in-flight build canceled by the user; explicit, never lost
```

Rules (pure, client-owned, host-independent):

- A result becomes `current` only if it BELONGS TO the current BuildIntent —
  intent match, not merely the source bytes (same bytes under a different
  target or stage, or different proven tool facts, is a DIFFERENT intent) —
  and it is the newest successful attempt within that intent (BuildId
  ordering).
- Advancing the build intent (a new emission, or the same emission under a
  changed target/stage/tool facts) demotes the previous `current` to `stale`.
  Stale results are retained, never silently dropped.
- `last-good` survives any number of newer failures. A failed newer build
  never blanks, erases, or downgrades a safe `last-good`.
- A slow, old completion that lands after a newer intent MUST NOT become
  current and MUST NOT replace a newer state — it arrives as `stale` evidence
  or a `failed` state, with its BuildIntent and BuildId visible.
- Cancellation is an explicit terminal state for that build; the prior
  `current`/`last-good` is untouched.
- In-flight builds are "in flight", not "current"; readiness and state
  reports say exactly that.

Division of labor (baseline §22): the client owns these rules as pure logic
tested against fakes; the **session storage** (the ordered line of results for
the current session, and which one is displayed as current/last-good) is
editor session state, composed in the shell. Session storage is never a
persisted contract — the same rule as the authoring-operation session stores.

---

## 12. Toolchain diagnostics transport

- Source: the structured diagnostics carried by the toolchain's machine
  contract (message + the tool's own location facts, e.g. source identity /
  position). The client parses them into typed records; severity and status
  are preserved verbatim.
- Rules:
  - diagnostics are NEVER mined from human-facing output — no line scraping,
    no regex over prose, ever;
  - toolchain diagnostics stay a distinct layer from graph-native diagnostics
    (the two-layer diagnostic model); they are never merged into one
    unstructured list;
  - each diagnostic is bound to the build it belongs to (its BuildIntent and
    BuildId), so a stale result cannot lend its diagnostics to a current one.
- Boundary: navigation of a native diagnostic back to a graph node/port
  (through the source map) is deliberately NOT done here. This stage
  carries, displays, and binds; navigation is the diagnostics stage's work,
  built on this stage's intent/attempt binding.

---

## 13. Build Inspector model

One source of truth per field; the inspector only projects. Two sources of
truth for one field is a review failure.

| Field | Source of truth | Notes |
| --- | --- | --- |
| readiness state | composed (editor orchestration): NativeBuildReadiness = ToolCompatibility (client) + profile×descriptor (core) + host capability (service) + target configured + target supported by the tool (facts vs config) | `Ready`, or `NotReady{reasons}` — every reason structured and visible, not a boolean |
| discovered tool path + provenance | service (discovery) | which rule resolved it |
| tool identity | client verdict over the tool's facts | checked against the descriptor's requirement |
| tool version | tool's proven fact (via the client's reader) | judged under the descriptor's own rule |
| process-contract axis (+ client-supported range) | tool's proven fact / client declaration | explicit rejection shown when out of range |
| producer/compiler identity | tool's proven fact | displayed, not parsed by hand |
| descriptor instance (id/profile/descriptorVersion) | core's reader over the loaded document | the descriptor is a fact, not a guess |
| profile×descriptor compatibility | core's capability verdict | the core owns this judgment |
| build target | explicit configuration | never the descriptor, never the tool |
| configured target supported by the tool? | the editor composition, from the client-extracted `supportedTargets` fact and the configuration | target READINESS — one build's compatibility, judged where the configuration lives; the tool's compatibility verdict never changes when the target changes |
| stage / entry | descriptor generatedFunction facts | the descriptor's legit facts in the request |
| build intent (target / stage / entry / source identity / tool identity / tool version / process-contract axis / producer identity) | the composed NativeCompileRequest (editor, from the client's vocabulary) | the `current`-ness anchor: the semantic identity of the compile request |
| generated-source identity | core's emission (SHA-256) | the core's durable CONTENT identity; a component of the build intent |
| staging evidence | service (local name) + core identity | name for evidence, not a usable path |
| build-line states (current/stale/last-good/failed/canceled) | session store over the client's rules | the ordered line, newest visible |
| recipe/build key, binary hash, binary format | tool result (via the client's reader) | the toolchain's own evidence |
| cache hit/miss | tool result | as the toolchain reports it |
| diagnostics (this stage: carried, not yet navigated) | tool result via the client | structured layer, bound to its build (BuildIntent + BuildId) |

The inspector is the stage's "replayable evidence, not opaque *Compile
failed*" surface: a reviewer must be able to determine, from it alone, which
tool, under which contract facts, compiled which exact bytes, to what
evidence, and why the state is what it is.

---

## 14. Testing

**Test placement:** the Toolchain Client's own suite (pure verdicts,
envelope parsing, the ToolCompatibility state machine, build-line rules —
no host at all); the editor application suite exercises the product path
end-to-end (orchestration gate → request → fake service → result states)
against the host-boundary fake, the test-side implementation declared in
§3. The real tool is never a test fixture and never a test dependency,
anywhere.

**Pure client tests (no host, no process):**

- strict parsing of the published result envelope: well-formed forms, every
  failure status in the vocabulary, the contract's own handling of its
  published optional fields (per the contract's rules), contract versions
  outside the client's supported range, missing required facts — all
  explicit, never partially accepted, never silently reinterpreted;
- version/compatibility verdicts: version at/above/below the required
  minimum; identity mismatch; contract axis in/out of the client's declared
  supported range. Target coverage is NOT one of these: the client extracts
  `supportedTargets` as a tool FACT, and whether the configured target is
  among them is the editor composition's call (§6);
- the ToolCompatibility state machine: every transition, including downgrade
  events — and the re-handshake transitions `unproven → compatible` and
  `incompatible → compatible` (a tool updated at the same path), which
  require handshakes to remain legal on those states;
- the client's tool-operation guarantee, split by gate: a COMPILE request is
  never formed out of an unavailable / unproven / incompatible tool (the
  refusal is a structured result); a HANDSHAKE IS formed for any resolved
  candidate — it is the operation that establishes or refreshes proof, and
  refusing it on `unproven` would make `compatible` unreachable;
- build-line rules: stale ordering, late slow results, last-good
  preservation across failure runs, cancellation, attempt ordering within
  one intent;
- request-value composition: determinism of the `NativeCompileRequest` for
  fixed inputs (same semantic compile request → same request VALUE — a
  value, never an argument array);
- the client's vocabulary independence: no import of core types, and no
  argv type in the client's vocabulary at all (tests that fail if either
  leaks in).

**Host-boundary tests (the product path, in the editor suite):**

- the host-boundary fake implementing the declared contract (§3):
  deterministic envelopes, exit codes, timeout behavior, cancel behavior;
  the fake exposes no argv;
- the full chain: Ready composition (gate) → `NativeCompileRequest` →
  (fake) service → fake tool → envelope → client verdict → result states →
  inspector state, driven entirely by fakes;
- the gate (editor orchestration): a `Ready` composition issues requests;
  for EACH `NotReady` reason type (`ToolUnavailable`, `ToolDiscovered`,
  `ToolUnproven`, `ToolIncompatible`, `DescriptorIncompatible`,
  `HostUnavailable`, `TargetNotConfigured`, `TargetUnsupported`) nothing is
  issued and the reason is visible;
- required scenarios (each a named test):
  1. compatible proven tool + compatible descriptor + capable host +
     configured target → `Ready` → compile → artifact/build facts visible;
  2. incompatible tool — facts that the tool itself reports contradict the
     required ones (identity, version, contract axis; target mismatch is
     NOT one of these kinds) → `ToolIncompatible` + explicit structured
     reason;
  3. absent tool (every discovery rule fails) → `ToolUnavailable` + per-rule
     reasons;
  4. unproven tool (handshake contract unsupported) → `ToolUnproven`; the
     client refuses a COMPILE request (structured refusal); a (re-)handshake
     stays legal as the way to refresh proof; no compilation executes;
  5. same source bytes, target changed (different intent): the slow old
     result of the old intent lands late — cannot become current;
  6. failure after success: `last-good` preserved and explicitly displayed;
  7. cancel in flight: explicit `canceled` state; prior states untouched;
  8. timeout: an explicit failed state with the timeout fact, not a hang;
  9. two quick attempts sharing identical source bytes: separate per-attempt
     staging areas, separate BuildIds; settling one never affects the other;
  10. compatible tool whose supported targets do not include the configured
      target (e.g. a DX12-only tool with Vulkan configured): the tool state
      STAYS `compatible`; the composition is `NotReady[TargetUnsupported]`;
      switching the target to a supported one flips the composition to
      `Ready` with the tool state untouched — no incompatible↔compatible
      oscillation for the same executable;
  11. the tool's proven producer identity changes (a different DXC under the
      same gglab-shaderc version): a DIFFERENT BuildIntent — a slow result
      of the old producer lands late and cannot become current; the late
      result is `stale` evidence with its intent visible.
  12. two different intents in flight, and the NEWER one settles FIRST
     (the mirror of 5's order): the newer one is current the moment it
     settles; the late old attempt lands as `stale` and cannot displace
     it — the intent anchor never moves backwards;
  13. a candidate-invalidation settlement landing INSIDE the second
     attempt's admission window: the tool state drops (it is a lifecycle
     event for the current state), but the admitted attempt keeps its
     OWN admission-bound intent — its BuildIntent never rebinds to a
     later state, and its settlement never crashes against a state
     without proven facts;
  14. a requirement CHANGE (higher minimum, new identity, …) voids the
     verdict taken under the old requirement: the candidate observation
     stays a fact (→ `discovered`, NotReady until re-proof), a fresh
     handshake re-proves under the new requirement, and a re-statement
     of the SAME value changes nothing;
  15. the newest gate invocation's record stays GATE FACTS ONLY: with #1
     and #2 issued, #2 settled, and #1 settling LATE, no record mixes a
     gate with another attempt's outcome (the "gate #N + outcome of
     attempt #M" attempt does not exist), and the surface's "newest
     issued attempt outcome" is the NEWEST ISSUED attempt's own line
     record — never the late older one;
  16. the TARGET the gate judges is the target that gets issued: the
     caller's input carries no target, the composition injects the
     configured one, and the issued BuildIntent's target is exactly that
     value (one-way: configuration → request → BuildIntent);
  17. discovery is SINGLE-FLIGHT: a discover made while one is in flight
     shares that exact execution (one boundary call), the lane closes on
     settlement, and the next call is a fresh discovery;
  18. handshake is SINGLE-FLIGHT too: a handshake made while one is in
     flight (say, the startup bring-up) joins that execution — never two
     concurrent handshakes for one candidate.

**Non-normative test invariants:** no test asserts against a human-facing
tool surface (`--version` text, `targets` listing, help output) — such a
test is testing the wrong layer and is deleted, not fixed. And no test
captures or asserts argv strings or staging file paths: those are
host-internal details, not a contract surface.

**Manual smoke — two kinds, two roles:**

*Exploratory smoke (permitted at any time, including before a handshake
contract exists):*

- the owner may run `gglab-shaderc` from outside the editor (terminal) to
  investigate the tool's behavior against a known emission;
- it is investigative evidence ONLY: it must not change the tool's state
  (`unproven` stays `unproven`), must not flow into the editor's product
  path, and must not surface in the editor as any readiness claim;
- it is not a readiness proof and not a stage-exit input.

*Stage-acceptance smoke (after the handshake exists; part of closure):*

- permitted only after the toolchain handshake contract exists and the
  client declares it supported;
- first target: explicit `gglab-dx12`; through the REAL editor product path
  (Ready composition, real service, real tool) — not via the terminal;
- run by the owner, outside CI (never a CI default), and recorded with the
  toolchain checkout identity (commit) + binary identity + the observed
  verdict and result facts — evidence in the working record, not in
  fixture files;
- a failed smoke is an explicit result with its diagnostics preserved — it
  never becomes a silent skip.

---

## 15. Deferred

- **`apps/cli` build / native-build orchestration** — owner-deferred;
  separately reviewed when (not if, assumed) it is wanted. The protocol
  reuses this design as-is: the CLI would add its own host-boundary
  implementation (allowlisted request → invocation serialization → bounded
  execution) and its command grammar over the same client vocabulary — zero
  protocol rework.
- **Native diagnostic → graph navigation** (source-map lookup, markers,
  node/port highlighting) — the diagnostics stage, built on §11's
  intent/attempt binding and §12's transport.
- **Preview Lab / Material Programs / Runtime integration** — later stages;
  `launchPreview` stays a reserved slot, unbuilt.
- **Node inspector and the remaining canvas interaction refinements** — the
  owner's deferred list; they land after the toolchain loop closes.
- **Packaging / deployment closure** (the packaged toolchain + DXC runtime
  as a dependency closure) — a packaging decision, not this design's.
- **The artifact contract/schema axis in the handshake** — not a v1
  requirement (§7); it enters only when the editor/preview genuinely
  consumes a versioned ShaderArtifact contract.
- **The handshake contract itself** — owned by the GGLab Shader Toolchain
  contract authority: the normative design lives in the GGLab docs
  repository; the implementation and its contract self-tests live in the
  main GGLab repository. This repository's obligation is the consumption
  discipline in §7; the definition and its version values are not ours to
  make.

---

## 16. Implementation order and exit criteria

Sequencing guidance (like the baseline's slice sequence — guidance, not
durable identifiers):

**Step 1 — the records (this round).** The baseline tightened with the owner
decisions; this document landed; the stage-state entries updated.
*Exit:* owner review of the records; no code.

**Step 2 — `shader-toolchain-client`.** The package: its plain value
vocabulary (contract facts, envelopes, the `NativeCompileRequest` shape,
build intents, result states); the host-boundary contract (allowlisted
operations + request/result shapes) and reference host-boundary fakes; the
strict reader for the published result envelope; the handshake facts
interface + the supported-range declaration (the published v1 axis) and
its explicit "contract not supported" result for axes outside the
declaration; the version/identity/target verdicts; the
ToolCompatibility state machine; the build-intent and build-line rules
(stale/current/last-good, ordered by buildId); the full §14 pure suite.
*Exit:* package tests green; `shader-graph-core` unmodified and
dependency-free in both directions; no host API imported anywhere in the
package; no argv type exists anywhere in its vocabulary.

**Step 3 — the Tauri `ShaderToolService`.** The four capabilities;
allowlisted-request validation + approved-request → invocation serialization
(host-internal); bounded execution (no shell string, timeout, cancel,
whole-output capture); private per-attempt staging per §10; the capability
set extended only for these commands.
*Exit:* host tests with a trivial dummy executable emitting fixed bytes prove
execution/capture/timeout/cancel; no protocol content and no readiness
logic in any host test.

**Step 4 — editor composition and surface.** The `NativeBuildReadiness`
composer (ToolCompatibility + core's descriptor verdict + host capability +
target config) with structured `NotReady{reasons}`; the product gate (only
`Ready` issues); the build-line session store over the client's rules; the
Build Inspector per §13; the explicit target configuration (development
default: `gglab-dx12`, always user-visible and changeable); the
compile/cancel actions routed through gate → request value → service only.
*Exit:* both state spaces are visibly explicit at every rung; no request is
issued for a `NotReady` composition, with complete visible reasons; the
inspector fields each show their single source of truth.

**Step 5 — the gate opens (externally blocked).** After the toolchain
handshake contract exists (contract authority: normative design in the GGLab
docs repository; implementation and self-tests in the main GGLab
repository) and the client declares it supported: the real tool proves, and
the stage-acceptance smoke runs through the real editor product path (first
target `gglab-dx12`). The repository-side half of this step is the
discovery configuration surface: the rule 1/2 values of section 5 become
explicit, visible, changeable configuration — passed to the discovery
request verbatim; an empty value is the honest "not configured" (that
rule records its own failure), and `bundled` is a world FACT stated in
the request, not a setting to be hidden.
*Exit:* the baseline's acceptance — compatible toolchain + compatible
selected profile → `Ready` → generated HLSL → `gglab-shaderc` → artifact /
build identity visible — holds in the desktop application, with the smoke
recorded.

**Global exit criteria for the stage:**

- the acceptance chain above holds, and every intermediate state (at every
  rung, and at every result state) is visible and explainable from the
  Build Inspector alone;
- no test depends on a real binary, a machine-specific path, or a
  human-facing tool output;
- no code path assembles a shell string anywhere, and argv does not exist
  in the TypeScript world at all (client, editor, test fakes);
- ToolCompatibility and NativeBuildReadiness are distinct state spaces in
  the code, and the single composition point is the editor orchestration —
  the service holds no readiness logic;
- `shader-graph-core` is byte-identical in its public surface (no new
  imports in either direction with the client);
- a failed or canceled build never erases a safe `last-good`, and a slow old
  result never replaces a newer one.
