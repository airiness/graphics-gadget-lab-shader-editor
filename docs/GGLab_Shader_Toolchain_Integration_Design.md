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
- The strict readiness gate: `unavailable / discovered / unproven / incompatible / ready`, with no bypass path.
- The new headless `shader-toolchain-client` package: machine-protocol consumption, tool-compatibility verdicts, build result/revision, stale/current/last-good pure rules, and the process-runner boundary.
- The narrow Tauri `ShaderToolService` (discover / handshake / compile / cancel).
- Native compile request composition (target/stage/entry/source) and generated-source staging.
- Revisioned asynchronous build state and last-good preservation.
- Toolchain diagnostics transport (carry, display, bind — not yet navigate).
- The Build Inspector model: exact fields, each with one source of truth.
- The test model: pure client tests, fake host/process, stale ordering, incompatible/absent tool, and the optional owner-run real smoke.

**Out of scope (explicit non-goals):**

- Defining, proposing, or duplicating the toolchain handshake/result wire schema, or assigning values to any toolchain version axis. That authority is the main GGLab repository's.
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
| `gglab-shaderc` (external) | the toolchain process contract: the machine-readable result envelope (published, stable), status vocabulary, exit codes, targets; and the discovery handshake contract (to be established/extended there per that repository's review) | an external process; consumed through the client's strict readers and verdicts |
| Tauri host (`ShaderToolService`) | bounded process execution; scoped file IO (existing) | a transport; no protocol judgment of any kind |

---

## 3. Package topology

```text
apps/editor                      composition root; session stores; Build Inspector
├─ @gglab/editor-ui              presentation only (unchanged)
├─ @gglab/shader-graph-core      graph semantics / emission / source map / profiles (unchanged)
└─ @gglab/shader-toolchain-client   NEW — machine protocol, compatibility verdicts,
                                    build result/revision, stale/current/last-good rules,
                                    process-runner boundary (headless pure TypeScript)

host boundary (outside the packages):
├─ Tauri ShaderToolService (Rust)  implements the process-runner port for the GUI
└─ test fakes                            implement the same port for the test suites
```

Both headless packages remain independently usable and independently testable. The client package never imports React, Tauri, the DOM, or any Node/OS runtime API; process execution is a port it declares, not code it ships.

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
  envelopes, revision tokens, result states). It never understands
  `ShaderGraphDocument`, `GraphType`, node semantics, or graph diagnostics.
- **Host implementations never import each other:** the Tauri service and the
  test fakes are independent implementations of the one declared
  process-runner port.

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
  rule:       explicit-config | sibling-build | bundled,
  toolPath:   <resolved executable>,
  resolvedAt: <session time>
}
```

If no rule resolves a candidate, discovery fails as the state `unavailable`,
carrying one structured reason per failed rule (which rule, why it failed).
Discovery is pure editor-side bookkeeping over configuration facts; it does
not execute the tool and does not interpret any of its output.

---

## 6. Readiness state machine

Five explicit states; every rung is visible, none is implied:

```text
unavailable    no candidate resolved by the discovery rules
discovered     a candidate resolved — a FACT, never a readiness claim
unproven       resolved, but not machine-readably proven compatible; the honest
               state of every real tool until the toolchain handshake contract
               exists and the client declares it supported
incompatible   resolved, and its facts contradict the required ones
ready          proven tool compatibility
               AND compatible required Surface Profile Descriptor (core verdict)
               AND host execution capability (service report)
               AND the explicit build target configured
```

Transitions and their events:

```text
(any)        → unavailable   discovery fails on all rules
ready/discovered/unproven/incompatible → discovered        a new candidate resolves
discovered   → unproven      handshake attempted; the client does not support a
                             published contract, or the tool's facts are absent
discovered   → incompatible  the tool's facts contradict the required ones
                             (identity mismatch, version below the required
                             minimum, target absent, contract out of range)
unproven / discovered / incompatible → ready   all four ready-conditions hold
ready        → unproven / incompatible         descriptor, config, or tool facts
                             change and any ready-condition is lost
ready        → unavailable                     the tool is no longer resolvable
```

Hard invariants:

- **The compile path is gated on `ready`, with no bypass.** There is no dev mode,
  environment flag, or local setting that routes a compile through an
  unproven or incompatible tool; the path does not exist to configure because
  none is defined. The client itself refuses a compile call that is not
  backed by a `ready` composition, and the refusal is a structured result.
- **`ready` is derived, never remembered.** It is recomposed from
  current facts; a session restart starts at worst at `discovered`.
- **Downgrades are as visible as upgrades.** Losing `ready` is a state
  change, surfaced in the Build Inspector, not a silent capability drop.

---

## 7. Tool compatibility consumption

The editor's verdict requires a small set of FACTS from the tool. The
handshake's wire form — fields, values, version axes — is owned by the
external Shader Toolchain authority. This document names the facts a verdict
needs; it does not define the contract and assigns no values to the
toolchain's axes:

```text
required facts for the verdict:
  the tool's identity                          (the descriptor requires one — the editor never picks it)
  the tool's version                            (judged against the descriptor's minimum under the descriptor's own comparison rule)
  the tool's process-contract version axis      (checked against the range the client declares it supports)
  the producer/compiler identity
  the published supported targets               (the explicitly configured target must be among them)
  artifact contract/schema compatibility facts  (as the toolchain publishes them)
```

Reader discipline (the descriptor-reader pattern, applied to a sibling axis):

- The client DECLARES the handshake-contract versions it supports and rejects
  unsupported or newer ones explicitly. Unknown or newer data fails or
  degrades explicitly; it is never silently reinterpreted.
- Until the client supports a published contract, its supported set is empty.
  That is exactly why, today, every real tool is `discovered-but-unproven` —
  and none may enter the compile path. This is a state of the world, visible
  and explainable, not a missing feature to be papered over.
- When the toolchain publishes (or extends) the contract through its own
  review, the client gains a strict reader for that published form —
  consumption of an external contract, never a definition of one.

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

The composition chain, in order — each stage has one job and never does the
next stage's job:

```text
editor composition          facts in → request value out (no argv here)
   ↓
shader-toolchain-client     request + protocol contract → structural argv (the ONLY place argv is built)
   ↓
Tauri ShaderToolService     bounded execution: validated arg array, kill/timeout, exit + raw output bytes
   ↓
gglab-shaderc               production compilation (its own policy, its own evidence)
   ↓
raw output + exit code →    client parses the published envelope → verdict + result facts
```

Every request is bound to a **revision token** derived from: the source
identity, the target, the proven tool facts, and the client's protocol
version. A result's match against the current revision is what makes it
`current` (see §11).

The first real target is **`gglab-dx12`**, as explicit configuration — a
deployment choice for the development environment, not a semantic fact and
not a default smuggled into the descriptor.

---

## 9. Tauri ShaderToolService boundary

The service is the GUI's process boundary and nothing else.

```text
capabilities (exactly these, plus the existing scoped document/descriptor file I/O):
  discover(config)      → toolCandidate facts + per-rule failure reasons
  handshake(candidate)  → raw output bytes + exit code + timeout state
  compile(requestValue) → buildId ; later: raw output bytes + exit code + timeout state
  cancel(buildId)       → explicit canceled state for that build

transport-level bounds (Rust's actual job):
  argv arrives as a structured array; count and per-argument length bounded;
  NO shell string, ever; output bytes captured whole (bounded) or timed out;
  the spawned process is the discovered tool at the candidate path, nothing else
  timeout and cancel are enforced per build
```

Prohibited, by construction:

```text
no generic spawn(argv) — the service exposes only the four capabilities above
no protocol parsing, status interpretation, version comparison, or
    diagnostic classification in Rust (the raw bytes + exit code ARE the output)
no staging-path exposure: the WebView receives names/identities, never paths it can use
no bypass route: nothing in the service can compile through a non-ready composition
```

The service owns no graph knowledge, no profile knowledge, and no
DXC/backend policy. If a service-level test needs protocol content, the test
has escaped its boundary and is wrong.

---

## 10. Generated-source staging

The generated HLSL is a **derived build input**, and its staging is owned
exclusively by the service:

```text
ownership   the service's private area (its host data location); the WebView
            has no path into it, no read, no write, no list
lifetime    created for a build; the bytes are written by the service from the
            delivered emission; kept until the build settles (result, failure,
            or cancellation); cleaned by the service; re-created on service
            restart — never a durable session claim
collision   staging names derive from the source identity (the SHA-256 hex);
            the same bytes can never occupy two different stagings, and two
            different byte strings can never share one
evidence    the result carries, always, the core's durable source identity
            (SHA-256 of the exact bytes that were compiled), plus a
            service-local staging NAME (for the inspector, not a usable path)
```

The WebView's compile flow delivers bytes + identity to the service and
receives results back; it never names, opens, or manages a staging file.

---

## 11. Revisioned asynchronous build model

```text
revision := generated-source identity (SHA-256 of the exact emitted bytes);
            the anchor is the core's durable identity — never a session counter
            alone, never a timestamp
```

Every build result occupies exactly one explicit state. A failure is a state,
not an exception, and a slow late result is data, not a correction:

```text
current      the newest SUCCESSFUL result whose revision matches the CURRENT emission
stale        a once-current result displaced by a newer revision; retained as evidence
last-good    the most recent successful result — preserved across newer failures
failed       explicit structured diagnostics from the machine contract; never prose
canceled     an in-flight build canceled by the user; explicit, never lost
```

Rules (pure, client-owned, host-independent):

- A result becomes `current` only if its revision matches the current
  emission's revision and it is the newest such result.
- Advancing the emission demotes the previous `current` to `stale`. Stale
  results are retained, never silently dropped.
- `last-good` survives any number of newer failures. A failed newer build
  never blanks, erases, or downgrades a safe `last-good`.
- A slow, old completion that lands after a newer revision MUST NOT become
  current and MUST NOT replace a newer state — it arrives as `stale` evidence
  or a `failed` state, with its revision visible.
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
  - each diagnostic is bound to the revision/result it belongs to, so a stale
    result cannot lend its diagnostics to a current one.
- Boundary: Slice-level navigation of a native diagnostic back to a graph
  node/port (through the source map) is deliberately NOT done here. This
  stage carries, displays, and binds; navigation is the diagnostics stage's
  work, built on this stage's revision binding.

---

## 13. Build Inspector model

One source of truth per field; the inspector only projects. Two sources of
truth for one field is a review failure.

| Field | Source of truth | Notes |
| --- | --- | --- |
| readiness state | composed (editor), from the three siblings | the ladder itself, not a boolean |
| discovered tool path + provenance | service (discovery) | which rule resolved it |
| tool identity | client verdict over the tool's facts | checked against the descriptor's requirement |
| tool version | tool's proven fact (via the client's reader) | judged under the descriptor's own rule |
| process-contract axis (+ client-supported range) | tool's proven fact / client declaration | explicit rejection shown when out of range |
| producer/compiler identity | tool's proven fact | displayed, not parsed by hand |
| descriptor instance (id/profile/descriptorVersion) | core's reader over the loaded document | the descriptor is a fact, not a guess |
| profile×descriptor compatibility | core's capability verdict | the core owns this judgment |
| build target | explicit configuration | never the descriptor, never the tool |
| stage / entry | descriptor generatedFunction facts | the descriptor's legit facts in the request |
| generated-source identity | core's emission (SHA-256) | the revision anchor |
| staging evidence | service (local name) + core identity | name for evidence, not a usable path |
| build-line states (current/stale/last-good/failed/canceled) | session store over the client's rules | the ordered line, newest visible |
| recipe/build key, binary hash, binary format | tool result (via the client's reader) | the toolchain's own evidence |
| cache hit/miss | tool result | as the toolchain reports it |
| diagnostics (this stage: carried, not yet navigated) | tool result via the client | structured layer, bound to its revision |

The inspector is the stage's "replayable evidence, not opaque *Compile
failed*" surface: a reviewer must be able to determine, from it alone, which
tool, under which contract facts, compiled which exact bytes, to what
evidence, and why the state is what it is.

---

## 14. Testing

**Test placement:** the Toolchain Client's own suite (the package where the
semantics live) — the real tool is never a test fixture and never a test
dependency. Fake host/process tests exercise the product path end-to-end
against fakes, in the same suites.

**Pure client tests (no host, no process):**

- strict parsing of the published result envelope: well-formed, every
  failure status in the vocabulary, unknown fields, out-of-range versions,
  missing required facts — all explicit, never partially accepted;
- version/compatibility verdicts: version at/above/below the required
  minimum; identity mismatch; target absent from the supported facts;
  contract axis in/out of the client's declared supported range;
- the readiness state machine: every transition, including downgrade events;
  the no-bypass invariant (a compile request without a `ready` composition is
  a structured refusal);
- build-line rules: stale ordering, late slow results, last-good preservation
  across failure runs, cancellation;
- compile-request composition: determinism of the structural argv for fixed
  inputs (same facts → same argv → same protocol shape);
- the client's vocabulary independence: no import of core types, asserted
  at the build boundary (test that fails if a core type leaks in).

**Fake host / process tests (the product path):**

- a fake process-runner implementing the port: deterministic envelopes, exit
  codes, timeout behavior, cancel behavior;
- the full chain: composition → client → (fake) service → fake tool → result
  facts → inspector state, driven entirely by fakes;
- required scenarios (each a named test):
  1. compatible proven tool + compatible descriptor → `ready` → compile →
     artifact/build facts visible;
  2. incompatible tool (each contradiction kind) → `incompatible` + explicit
     structured reason;
  3. absent tool (every discovery rule fails) → `unavailable` + per-rule
     reasons;
  4. unproven tool (handshake contract unsupported) → `unproven`, compile
     refused, nothing executes;
  5. stale ordering: slow old result lands after a newer revision — cannot
     become current;
  6. failure after success: `last-good` preserved and explicitly displayed;
  7. cancel in flight: explicit `canceled` state; prior states untouched;
  8. timeout: an explicit failed state with the timeout fact, not a hang.

**Non-normative test invariant:** no test asserts against a human-facing
tool surface (`--version` text, `targets` listing, help output). A test that
does is a test of the wrong layer and is deleted, not fixed.

**Optional owner-run real smoke (manual, recorded):**

- permitted only after the toolchain handshake contract exists and the
  client declares it supported — never before;
- first target: explicit `gglab-dx12`;
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
  reuses this design as-is: the CLI would add a Node process-runner
  implementation and its own command grammar/envelope over the same
  client — zero protocol rework.
- **Native diagnostic → graph navigation** (source-map lookup, markers,
  node/port highlighting) — the diagnostics stage, built on §11's revision
  binding and §12's transport.
- **Preview Lab / Material Programs / Runtime integration** — later stages;
  `launchPreview` stays a reserved slot, unbuilt.
- **Node inspector and the remaining canvas interaction refinements** — the
  owner's deferred list; they land after the toolchain loop closes.
- **Packaging / deployment closure** (the packaged toolchain + DXC runtime
  as a dependency closure) — a packaging decision, not this design's.
- **The handshake contract itself** — external authority (main GGLab
  repository). This repository's obligation is the consumption discipline in
  §7; the definition and its version values are not ours to make.

---

## 16. Implementation order and exit criteria

Sequencing guidance (like the baseline's slice sequence — guidance, not
durable identifiers):

**Step 1 — the records (this round).** The baseline tightened with the owner
decisions; this document landed; the stage-state entries updated.
*Exit:* owner review of the records; no code.

**Step 2 — `shader-toolchain-client`.** The package: its plain value
vocabulary; the strict reader for the published result envelope; the
handshake facts interface + the (today empty) supported-range declaration and
its explicit "contract not supported" result; the version/identity/target
verdicts; the readiness composition input side (tool side); the build-line
rules; the process-runner port + reference fakes; the full §14 pure + fake
suite.
*Exit:* package tests green; `shader-graph-core` unmodified and dependency-free in both directions; no host API imported anywhere in the package.

**Step 3 — the Tauri `ShaderToolService`.** The four capabilities; bounded
execution (argv bounds, timeout, cancel, whole-output capture); private
staging owned per §10; the capability set extended only for these commands.
*Exit:* host tests with a trivial dummy executable emitting fixed bytes prove
execution/caption/timeout/cancel; no protocol content in any host test.

**Step 4 — editor composition and surface.** The readiness composer (core
verdict + client verdict + host facts + target config); the build-line session
store over the client rules; the Build Inspector per §13; the explicit target
configuration (development default: `gglab-dx12`, always user-visible and
changeable); the compile/cancel actions routed through client → service only.
*Exit:* the readiness ladder is visibly explicit at every rung; a compile
request without `ready` is a structured refusal the user can read; the
inspector fields each show their single source of truth.

**Step 5 — the gate opens (externally blocked).** After the toolchain
handshake contract exists and the client declares it supported: a real tool
proves, and the optional owner-run smoke runs (first target `gglab-dx12`).
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
- no code path assembles a shell string, and no WebView code path produces
  raw argv;
- `shader-graph-core` is byte-identical in its public surface (no new
  imports in either direction with the client);
- a failed or canceled build never erases a safe `last-good`, and a slow old
  result never replaces a newer one.
