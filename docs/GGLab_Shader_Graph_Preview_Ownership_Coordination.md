# GGLab Shader Graph Preview Ownership Coordination

> Status: Plan approved 2026-09-04 — Slice 1 implementation not yet started
>
> Authority relationship: this document records the preview-ownership
> architecture decision (ownership authorities, Runtime state machine,
> termination contract) and the Slice 1 implementation plan. The normative
> authoring-architecture baseline remains `GGLab_Shader_Graph_Editor_Architecture.md`;
> the host-side preview boundary types remain owned by
> `packages/shader-toolchain-client` (`preview-runtime-boundary.ts`) and the
> Tauri host. Nothing in this document overrides those authorities.

## Why this document exists

Three consecutive review rounds on the multi-document Preview surface
(rounds targeting `888476d`, `e7fb359`) fixed the same structural defect at
successively deeper seams instead of removing the defect itself:

| Round | Finding (as recorded) | Where it actually lived |
|---|---|---|
| 1 | `stopAttachedPreview()` return value was only a stop-request acknowledgment, not proof the Runtime process left; ownership transitions committed against a possibly live process | `PreviewBuildFlow` (apps/editor) + two app handlers composing `stop → emit → commit` by hand |
| 2 | The Preview target live-followed the active document before the first explicit choice; closing the target dropped ownership back into a live follow | `preview-coordinator.ts` (`resolvePreviewTarget`) + `workspace-session.ts` close semantics |
| 3 | `wait-failed` (host could only best-effort kill/wait and cannot prove exit) counted as a proven teardown; a missing exit settlement under an attached Runtime was reported as a no-op | `stopAttachedPreviewAndWait()` in `PreviewBuildFlow` |

The pattern: Runtime lifecycle semantics are spread over four modules
(`preview-build-flow.ts`, `useShaderPreview.ts`, `app.tsx`,
`preview-coordinator.ts`) and held together by local agreement at the seams.
Every defect landed on a seam, not inside a module. The review decision was to
**stop adding seam patches** and converge preview ownership onto explicit
authorities with one formal transition executor.

Additionally, one hard invariant was still unenforced at the moment this plan
was approved: after a `wait-failed` settling, the flow reported state
`exited`, and `launchAttachedPreview()` admitted a second Runtime launch. This
plan turns that invariant into a launch-admission rule of the Runtime manager,
with a red test pinned before the fix.

## Decision: ownership authorities

Four authorities, one each, with the split owned along the existing seam —
not as a file-moving exercise:

| Authority | Module | Owns | Never owns |
|---|---|---|---|
| Target/document state authority | `WorkspaceSession` (`workspace-session.ts`, **unchanged**) | Document set, active tab, `preview.targetDocumentId` (seeded at first open, re-seeded at a target close, moved only by an explicit commit) | Any Runtime lifecycle |
| Build authority | `PreviewBuildFlow` (slimmed body of today's flow) | Handshake, build, publication, observation, build-side gate reasons | Process state, launch, termination |
| Runtime lifetime authority | `AttachedPreviewRuntimeManager` (**new**, apps/editor) | Runtime state machine, single-flight launch, terminate-and-join, Registry binding (runtimeId ↔ target binding identity) | Build eligibility, target state |
| Transition authority | `PreviewCoordinator` (formal class, `preview-coordinator.ts`) | The sole executor of retarget and target-close transitions; composition of the build gate with Runtime state; structured refusal results | A second copy of target state (procedure owner only) |

Consequences of the split:

- The existing pure helpers `resolvePreviewTarget` /
  `hasExplicitPreviewTarget` remain in `preview-coordinator.ts` as the
  coordinator's pure core; they are the sole read path for the target axis
  from UI and tests. **No target state is duplicated anywhere.**
- The `TerminationProof` contract is defined in apps/editor and implemented
  over the existing host boundary. Slice 1 therefore touches **no client
  package types, no fake host boundary, no Tauri/Rust code, no editor-ui**.
- `stopAttachedPreviewAndWait()` (the seam patch of round 3) is retired: its
  responsibility moves to the manager's `terminateAndJoin()`, and its callers
  (two hand-rolled app handlers) move to the coordinator.

## Runtime state machine (manager-owned)

Semantic states (approved minimum set: `idle`, `running`, `transitioning`,
`exit-unproven`), refined with the two directions of a transition plus one
terminal launch refusal:

| From | Event | To |
|---|---|---|
| `idle` | launch request admitted | `launching` |
| `launch-refused` | launch request (retry) | `launching` |
| `launching` | host launches the Runtime | `running` |
| `launching` | host refuses the launch | `launch-refused` |
| `running` | stop request | `terminating` |
| `running` | natural exit, proven (`exited` / `stopped`) | `idle` |
| `running` | natural exit fact `wait-failed` | `exit-unproven` |
| `terminating` | exit settles as `terminated` | `idle` |
| `terminating` | exit fact is `wait-failed` | `exit-unproven` |

State set (exact kinds, for code and tests):

| State | Payload | Meaning |
|---|---|---|
| `idle` | last exit fact (optional) | No attached Runtime; Registry ownership released |
| `launching` | session facts | Launch in flight (transition, launch direction) |
| `running` | `runtimeId`, `runtimeIdentity`, launched target-binding identity | Process attached and accepted |
| `terminating` | `runtimeId` | Stop requested, exit settlement pending (transition, terminate direction) |
| `exit-unproven` | `runtimeId`, unproven reason | Host could not prove the process left (`wait-failed`). Registry ownership NOT released; **sticky in Slice 1** — no host re-proof exists to leave this state |
| `launch-refused` | host refusal result | Terminal launch refusal; retry permitted |

Transition rules (manager-enforced, not caller-enforced):

- **Launch admission: only from `idle`** (and the retry path from
  `launch-refused`). Launch is refused from `launching`, `running`,
  `terminating`, and **`exit-unproven`**. This is the structural enforcement
  of the "no second Runtime after an unproven exit" invariant — it can no
  longer depend on the ordering of caller code.
- `running` → `idle` on a proven natural exit (exit kind `exited` /
  `stopped`).
- `terminating` → `idle` on `terminated`; → `exit-unproven` on `wait-failed`.
- Any attached state → `exit-unproven` on a natural exit fact of kind
  `wait-failed` (round 3's core overload removed: settlement arrival no longer
  equals proven exit).
- `terminating` + repeated termination call = idempotent join on the same
  settlement (no second stop request).
- `exit-unproven` is **sticky in Slice 1**: a repeated `terminateAndJoin()`
  call returns the stored unproven fact with **no host re-issue**. The current
  host has no remaining process authority to re-prove with: the wait-failed
  settle loop reaps best-effort and then the settle thread ends, the runtime
  registry entry is removed, and a later `stop_preview_runtime` for the same
  id is merely a registry miss that answers `already_settled: true` (verified
  against `service.rs::stop_preview_runtime` / `settle_preview_runtime`).
  `alreadySettled` is a *registry* fact, not a *termination* proof — the
  manager therefore **never** derives `already-exited` from it; that outcome
  is produced only from manager state `idle`. Real re-proof / process queries
  are the Slice 2 host-native contract's responsibility.
- The settlement handle for a specific `runtimeId` is captured locally before
  the stop request is sent (a round-1 race: the exit handler may clear the
  settlement field while the request is in flight) and the exit handler only
  migrates state for the matching `runtimeId`.

## Termination contract (stable across Slice 1 → Slice 2)

```ts
type TerminationProof =
    | { readonly outcome: "terminated" }                    // exit proven (stop requested → proven exit)
    | { readonly outcome: "already-exited" }                // no attached Runtime (manager state idle); idempotent no-op; never derived from a host `alreadySettled` answer
    | { readonly outcome: "exit-unproven"; readonly runtimeId: PreviewRuntimeId };

interface AttachedPreviewRuntimeManager {
    readonly state: AttachedRuntimeState;
    launch(binding: RuntimeTargetBinding): Promise<AttachedRuntimeLaunchResult>;
    terminateAndJoin(): Promise<TerminationProof>;
    // build-side gate contribution (Runtime half only)
    buildBlocker(composition: PreviewCompositionInput): BuildGateRefusal | null;
}
```

- Slice 1 **implements** the tri-value judgment by composing the existing host
  boundary (`stopAttachedPreview` outcome + `exited` settlement + exit kind).
- **Slice 1 declares no re-proof path**: the host releases the runtime
  registry and all process authority once the wait-failed settle loop
  completes, so re-issuing `stopAttachedPreview` for that id cannot perform a
  second kill+wait — it is at best a registry miss (`alreadySettled: true`),
  which is not termination evidence. `terminateAndJoin()` from
  `exit-unproven` therefore short-circuits to the stored `exit-unproven`
  fact with no host call, and a repeated "Stop Preview" honestly re-reports
  the unproven condition (the `exit-unproven` state is sticky for the editor
  session. A restart only discards the current editor-side session state —
  it does not prove the old OS Runtime has exited, and cross-restart ownership
  proof belongs to Slice 2 (see the recovery-semantics section).
- Slice 2 **replaces** that implementation with a host-native
  `terminate_and_join` command (Rust + client types + host-io test pin) that
  owns real re-proof / process queries.
- The coordinator and the UI **never change** between the two slices; the
  tri-value contract is the stable interface. This is the
  "upper contract must not be re-touched" requirement.

## Transition procedures (coordinator-owned, sole execution path)

Both procedures take the target document/session inputs plus the
**`WorkspaceMutationPort`** contract, and return a **structured
result** — the app maps refusals to user notes in exactly one place.

### `WorkspaceMutationPort` (the commit authority contract)

A commit must be an **atomic** `read current` → `revalidate` →
`reducer(current)` → `publish` against the current session. A read-only
getter cannot express that guarantee (it permits
`provider() → compute next → set(next)`, where "next" was computed from a
stale snapshot), so the contract the coordinator receives expresses commit
authority, not snapshot access:

```ts
interface WorkspaceMutationPort {
    /**
     * Atomically apply ONE workspace mutation against the session as it
     * currently stands, and report the structured result. The app-side
     * implementation is the SAME authority path used by every other
     * workspace change — a functional state update, i.e. the shape of
     * `setWorkspace(current => revalidate-and-reduce(current))`.
     */
    attempt(mutation: WorkspaceTransitionMutation): Promise<WorkspaceTransitionResult>;
}

interface WorkspaceTransitionMutation {
    /** The recorded intent identity (kind, target, sequence) for evidence. */
    readonly intent: TransitionIntent;
    /**
     * Runs INSIDE the atomic update, receiving the session `current` as it
     * stands at apply time. Returns the reduced session, or a structured
     * refusal — in which case `current` is published unchanged. Revalidation
     * of the intent identity must happen here, on `current`, in the same
     * synchronous application.
     */
    readonly apply: (current: WorkspaceSession) =>
        { readonly ok: true; readonly next: WorkspaceSession; readonly changed?: boolean }
        | { readonly ok: false; readonly refusal: TransitionRefusal };
}
```

**Forbidden**: `provider() → compute next → setWorkspace(next)` (a whole next
session pre-computed from an older read, written back over the state at
apply time). **Required shape**: `setWorkspace(current => apply(current))` —
with revalidation, reducer and refusal decision all made inside that single
synchronous application against `current`. A long-lived ref snapshot (e.g.
the app's render-cache `workspaceRef`) remains observation-only, never commit
authority.

### Transition discipline (both procedures)

A transition crosses an `await` (the `terminateAndJoin` proof); the
WorkspaceSession can legitimately change during that window (a document
closed, the active tab moved). The discipline therefore is:

1. **Record the intent identity at start**: `kind` (`retarget` /
   `close-target`), `targetDocumentId`, and a monotonically increasing
   transition sequence — identity/evidence of the recorded intent only.
2. **Strict single-flight**: one transition at a time. While a transition is
   in flight, every further transition call is **refused immediately** with
   `transition-in-flight` (an honest refusal; the UI prompts a retry). No
   queueing, no auto-supersede — the user retries once the in-flight
   transition completes. The sequence is **never** a latest-intent /
   supersession protocol.
3. **Last await**: `manager.terminateAndJoin()` is the transition's final
   `await`.
4. **Revalidate current inside one atomic application**: after the last
   await, the coordinator applies the mutation through the
   `WorkspaceMutationPort`; the recorded intent identity is revalidated against the `current`
   that the functional update supplies, in the same synchronous application as the reducer: for `retarget`, the
   requested document is still open; for `close-target`, the requested document is still the
   Preview target (and its re-seed, when it commits, is derived from the active
   document of that same `current` session).
5. **Synchronous commit burst**: from revalidation through the emission
   refresh (where applicable) to the target commit there is **no further
   await** — the commit cannot observe a stale snapshot, and no newer intent
   can interleave between revalidation and commit.
6. **Commit authority, not snapshot access**: the coordinator holds no
   getter and no pre-computed next session. Required shape:
   `setWorkspace(current => revalidate-and-reduce(current))` — exactly the
   `WorkspaceMutationPort.attempt` contract defined above: revalidation, the
   reducer, and the refusal decision all happen inside that one synchronous
   application against `current` (through the same workspace-authority path
   the app already uses for every other workspace change). Forbidden shape:
   `provider() → compute next → setWorkspace(next)`. A long-lived ref
   snapshot (e.g. the app's render-cache `workspaceRef`) is observation-only,
   never commit authority; a commit result computed from a stale session is
   refused, not applied.

> Hard invariant: **no Preview ownership transition that crosses an `await`
> may commit state computed from a stale `WorkspaceSession` snapshot** (the
> re-seed of a close-target commit is defined by the current active document
> at commit time; a stale transition never takes effect, and no pre-computed
> whole-session value is written back on top of the current state).

### `retargetTo(targetDocumentId)`

| Step | Action | On failure |
|---|---|---|
| 1 | Claim the single-flight slot; record the intent identity (kind, target, sequence); guard: target document is open in the current session | refuse `target-not-open` / `transition-in-flight` (strict single-flight — immediate refusal, no queueing) |
| 2 | No-op path: if the target is already the Preview target, skip steps 3–4 (no Runtime interaction) | n/a |
| 3 | `proof = await manager.terminateAndJoin()` — the transition's **last await** | `exit-unproven` (sticky stored fact — no host call was made) → refuse `runtime-exit-unproven`, **zero Workspace/target mutation** |
| 4 | Apply the mutation via the `WorkspaceMutationPort`: revalidate the intent identity inside that one atomic application (requested document still open) | refuse `target-stale` — **zero Workspace/target mutation** (the proven teardown already completed; nothing leaks, no stale state is written) |
| 5 | Refresh the target's own emission from the current document content (`emitHlsl` stored in the target's presentation — never borrowed from the active document) — synchronous | refuse `target-emission-unavailable` |
| 6 | `commitWorkspacePreviewTarget` inside the same atomic application against `current` (the reducer remains state authority) — synchronous | refuse `target-commit-refused` (defensive) |
| 7 | Release the single-flight slot; return `{ ok, changed }` | n/a |

The coordinator does **not** auto-launch: launching the Runtime remains an
explicit user action (behavior preserved).

### `closeTarget(documentId)`

| Step | Action | On failure |
|---|---|---|
| 1 | Claim the single-flight slot; record the intent identity; guard: `workspace.preview.targetDocumentId === documentId` (a non-target tab close never passes through the coordinator — plain reducer close) | refuse `not-target` / `transition-in-flight` (strict single-flight — immediate refusal, no queueing) |
| 2 | `proof = await manager.terminateAndJoin()` — the transition's **last await** | `exit-unproven` → refuse `runtime-exit-unproven`; the tab stays open, **zero Workspace/target mutation** |
| 3 | Apply the mutation via the `WorkspaceMutationPort`: revalidate inside that one atomic application (the requested document is still the target and still open) | refuse `target-stale` — **zero Workspace/target mutation** |
| 4 | `closeWorkspaceDocument` inside the same atomic application — the reducer re-seeds the target onto the surviving active document **of that commit-time `current` session** — synchronous | refuse on reducer rejection (defensive) |
| 5 | Release the single-flight slot; return `{ ok }` | n/a |

Plain (non-target) tab closes continue to call the reducer directly: closing a
tab that is not the Preview target has no Runtime implications and must not
depend on preview machinery.

### Gate composition (cross-domain, coordinator-composed)

The build gate is a composed decision, with no controller owning another
controller's state:

```text
coordinator.gate(composition)
    = manager.buildBlocker(composition)        // attached-runtime-launching,
       ?? controller.buildGate(composition)    //    attached-runtime-deployment-mismatch
                                              // (manager holds the binding identity)
                                              // + all build-side reasons (controller)
```

The existing "if a build publishes and no Runtime is up, launch one" UX
behavior in the UI composition is preserved and now reads the manager's state
(`running` / `terminating` / `launching` suppress the auto-launch) instead of
the flow's private state.

## Recovery semantics

`exit-unproven` blocks retarget, target-close, and second-Runtime launch, and
**persists** across repeated Stop attempts (sticky in Slice 1). `wait-failed`
means the liveness of the old Runtime is **unknown**: an unproven Runtime may
still be alive. A user declaration ("I ended the process myself") therefore
never releases ownership — and neither does anything else in Slice 1:

- Within the current editor session there is **no formal recovery** from
  `exit-unproven`. There is simply no remaining host authority to re-prove
  with.
- "Stop Preview", repeated → `terminateAndJoin()` → the manager
  short-circuits (no host call) and the UI **re-reports the stored unproven
  condition** — it does not claim a re-proof was performed.
- Launch attempts against a still-registered host session are refused
  honestly by the host (`session-already-running`) rather than silently
  reattached.
- An editor restart is an **operational reset only**: it clears the
  editor/host's in-memory registry and sessions. It does **not** verify that
  the old OS process is gone, and it is therefore **not a termination proof**
  and must never be reported as a genuine release.

Guarantee boundary: the "no second Runtime after `exit-unproven`"
guarantee holds within an editor session in Slice 1. If that guarantee must
survive an editor restart (a still-alive zombie process could keep occupying
the preview), Slice 1 is insufficient — it requires the Slice 2 host-native
contract or a host-level lifetime guarantee (kill-on-host-exit or a
process-lifetime binding of the preview process to the host that spawned it).

What Slice 2 adds (true re-proof and process-death verification): a real
`terminate_and_join` capable of acquiring fresh host evidence, an optional
`is_runtime_alive` query, and the host-level lifetime guarantee above — only
at that point may a repeated "Stop / verify" attempt re-acquire host proof,
and only then can the guarantee be extended across restarts.

UI copy stays honest at every level: "the Runtime could not be proven
terminated, so ownership is retained as unproven for this session. Restarting
the editor is an operational reset, not a proof the process is gone (host-side
re-proof arrives with the native termination contract)."

## Target module shape (Slice 1 inventory)

All changes stay inside `apps/editor`:

| File | Action |
|---|---|
| `src/preview-runtime-manager.ts` | **New**: state machine, launch lane, `terminateAndJoin`, Registry binding, `buildBlocker`, `TerminationProof` type |
| `tests/preview-runtime-manager.test.ts` | **New**: all Runtime lifecycle tests migrate here (state names updated) + the unenforced-invariant red test + sticky `exit-unproven` semantics (re-invoking `terminateAndJoin` returns the stored fact and issues **no second host stop call** — the fake records stop calls; never derives `already-exited` from a registry miss) |
| `src/preview-coordinator.ts` | **Rewritten/extended**: pure `resolvePreviewTarget` / `hasExplicitPreviewTarget` retained (now the class's pure core) + new `PreviewCoordinator` class |
| `tests/preview-coordinator.test.ts` | New transition tests (procedure ordering, refusal zero-Workspace/target-mutation on the unproven and stale paths, close/re-seed through one path, strict single-flight — a second transition refused immediately with `transition-in-flight` while one is in flight, no queueing and no supersession — stale transitions never taking effect, re-seed defined by the active at commit time, commit via the WorkspaceMutationPort (one atomic application against `current`; no pre-computed older session ever written back)) + sticky `exit-unproven` reporting (repeated Stop re-reports, no host call); existing pure-target tests retained |
| `src/preview-build-flow.ts` | **Slimmed**: Runtime members, `launchAttachedPreview`, `stopAttachedPreview`, `stopAttachedPreviewAndWait`, `runtimeExitSettlement` removed; `buildGate` keeps only build-side reasons; constructor no longer takes a Runtime boundary |
| `src/useShaderPreview.ts` | Composes controller + manager + coordinator (still one instance per `nativeFlow`); unmount uses `void manager.terminateAndJoin()` (best-effort, never blocks unmount); the plain Stop action becomes `terminateAndJoin`; `stopPreviewAndWait` retires |
| `src/app.tsx` | `onPreviewThisGraph` and the target path of `closeOneTab` become thin coordinator calls with one shared refusal→note mapping; `stopPreviewRuntimeIfAttached` and the two hand-rolled catch blocks are deleted |
| `tests/gui-surface.test.tsx` | Pins migrate to the new seams (list in the churn inventory) |
| — | **Untouched**: `workspace-session.ts`, everything in `packages/shader-toolchain-client`, the fake host boundary, Tauri/Rust host code, `packages/editor-ui` |

One known UI-adjacent surface to inventory inside Step 2 (not editor-ui):
every consumer of the runtime state *kind* for display copy (`stopping` →
`terminating`, `exited` → `idle`/`exit-unproven`). Label text must be updated
at that step; editor-ui itself is not modified.

## Slice 1 execution steps (each independently green and independently reviewable)

| Step | Content | Exit gate |
|---|---|---|
| 0 | **Red test first**: assert "after a `wait-failed` settling, a launch admission is refused". Current code fails this test (today: `wait-failed` → state `exited` → launch admitted). Confirm the other six hard invariants already hold at the current seams (baseline green). | The new test is red for the right reason; baseline table recorded |
| 1 | **Extract the manager** (`preview-runtime-manager.ts`): state machine per this document, launch admission only from `idle`/`launch-refused`, `terminateAndJoin` implemented over the existing boundary with the already-fixed race semantics (local settlement capture, `runtimeId`-matched exit migration). Flow delegates; its public surface stays unchanged for this step. Migrate all Runtime tests; state-kind literals rewritten per the state table; red test goes green. | `pnpm typecheck`; flow + manager + `shader-preview-surface` tests green; lint on touched files |
| 2 | **Formalize the coordinator** (class in `preview-coordinator.ts`): `retargetTo` / `closeTarget` / composed `gate` / sticky `exit-unproven` reporting (no host re-proof claim) / transition discipline (intent identity, strict single-flight — immediate refusal, no queueing or supersede — last-await, current-session revalidation, synchronous commit burst, WorkspaceMutationPort commit (one atomic application against `current`)). Rewire the hook; thin the two app handlers and delete `stopPreviewRuntimeIfAttached`; one shared refusal→note map; display-copy inventory update; gui-surface pins updated. | `pnpm typecheck`; full `apps/editor` test suite green (includes the invariant #8 stale-transition and strict-single-flight tests); lint |
| 3 | **Rename (approved, separate commit)**: `PreviewBuildFlow` → `PreviewBuildController` (class, file name, imports, residual pins). After the split the object is a build controller and the "flow" name only describes a bygone two-domain object. Small isolated diff; behavior unchanged. | Full workspace gates |
| 4 | **Closure**: root `pnpm typecheck`, `pnpm test`, `pnpm lint`; the invariant→test mapping table (§ below) into the report; known limitations (real-host timing only exercisable on the desktop host; web path has no flow and is a proven no-op); commit proposals. | All three gates green from the repository root |

Step 1 and step 2 are the first two commit boundaries; step 3 is the approved
third isolated commit. Every boundary is green and independently
reviewable — consistent with the owner's per-slice commit discipline.

## Hard invariants and their tests (acceptance mapping)

| # | Invariant | Where it is enforced | Where it is tested | Status before Slice 1 |
|---|---|---|---|---|
| 1 | Switching the active document never changes the Preview target | `WorkspaceSession` reducer + pure resolver | `workspace-session`, `preview-coordinator` pure tests | Enforced (round 2 fix) — retained |
| 2 | Before a retarget commits, the prior Runtime must be proven terminated | Manager `terminateAndJoin` | Manager `terminated` path + coordinator ordering test | Enforced (round 1) — migrates |
| 3 | On a failed teardown the target does not change | Coordinator refusal short-circuit (zero Workspace/target mutation) | Coordinator refusal test | Enforced (round 1 catch-structure) — migrates |
| 4 | After `wait-failed`, a repeated retarget still fails | Manager state `exit-unproven` refusal | Coordinator refusal test (unproven case) | Partially enforced (flow reject) — strengthened |
| 5 | After `wait-failed`, launching a second Runtime is impossible | **Launch admission only from `idle`/`launch-refused`** | Manager admission test (the Step 0 red test) | **NOT enforced — this slice closes it** |
| 6 | Closing the Preview target goes through the same coordinator transition | `closeTarget` | Coordinator close-target test | Enforced (round 1 close path) — migrates |
| 7 | The build/runtime cross-state gate is composed by the coordinator; no controller owns another's state | `coordinator.gate` = `manager.buildBlocker ?? controller.buildGate` | Coordinator gate-composition tests | Enforced (flow-private) — restructured |
| 8 | **No Preview ownership transition that crosses an `await` may commit state computed from a stale `WorkspaceSession` snapshot** (a stale transition never takes effect; a close-target re-seed is defined by the current active document at commit time; the commit is a single atomic `WorkspaceMutationPort` application — shape `setWorkspace(current => revalidate-and-reduce(current))` — through the same workspace-authority path the app already uses, with ref snapshots observation-only and a pre-computed older session never written back on top of the current state) | Transition discipline: intent identity at start, strict single-flight, last-await rule, current-session revalidation, synchronous commit burst, WorkspaceMutationPort commit | Coordinator stale-transition and strict-single-flight tests (document closed during teardown, active moved during teardown, a second transition refused by `transition-in-flight` while one is in flight — no queueing, no supersession) | **Not yet expressed — this slice introduces it** |

## Churn inventory (honest rewrite surface)

Known pin/assertion rewrites required by the state rename and the seam move
(all inside `apps/editor`):

- `tests/preview-build-flow.test.ts` — Runtime-lifecycle cases migrate to the
  manager test file; state-kind literals rewritten (`stopping` → `terminating`,
  natural proven `exited` → `idle`, new `exit-unproven` assertions).
- `tests/gui-surface.test.tsx` — the flow's `kind === "stopping"` wait-for-exit
  pin and the strict-teardown pins move to the manager/coordinator seams; the
  refusal→abort pins are retained against the new app shape.
- `tests/shader-preview-surface.test.tsx` — state-mirror cases updated to the
  new state names; the `stopPreviewAndWait` interface pin retires with the
  hook API change.
- `src/useShaderPreview.ts` — `stopPreviewAndWait` retires (subsumed by
  `stopPreview` = terminate-and-join); the `runtime` field is read from the
  manager (display layer aligns).
- `tests/toolchain-host-preview-observation.test.ts` — **not affected**
  (its `kind: "exited"` literal is the host *protocol* message, not the flow
  state). Verified during planning.

## Risk register

| Risk | Mitigation |
|---|---|
| State-kind rename ripples into display copy | Step 2 runs a consumer inventory of the state kind first; editor-ui is untouched; all display text stays in apps/editor |
| The "build → auto-launch if no Runtime up" UX behavior in the UI composition is silently changed | Explicitly preserved in the hook rewrite: it reads manager state (`running`/`terminating`/`launching` suppress it) instead of flow-private state |
| Unmount cleanup semantics regress | The current fire-and-forget stop request becomes `void manager.terminateAndJoin()` (best-effort join; an unproven result never blocks unmount) — semantics only widen |
| Step 1 → Step 2 intermediate state breaks review | Step 1 keeps the flow's public surface unchanged (internal delegation), so the intermediate boundary is independently green |
| Scope creep beyond the seam | Non-goals are explicit: no client-package types, no fake host boundary, no Rust, no editor-ui, no file relocations |
| An async transition commits a stale Workspace snapshot (a document closed or the active tab moved while the teardown proof was pending; a slow older transition out-writes a newer user intent) | The transition discipline of the procedure section: strict single-flight (immediate refusal while in flight), last-await rule, current-session revalidation (intent identity still holds), a synchronous commit burst, and the WorkspaceMutationPort commit path (one atomic application against `current`) — pinned as invariant #8 by the coordinator's stale-transition and strict-single-flight tests |
| Slice 1 claims a re-proof the host cannot perform | `exit-unproven` is sticky; a repeated Stop only re-reports the stored unproven condition; real re-proof and process queries are deferred to the Slice 2 host-native contract |
| A still-alive (zombie) Runtime outlives an editor restart and is mistaken for released | Editor restart is documented as an **operational reset, not a termination proof**; the cross-restart "no second Runtime" guarantee is explicitly out of scope for Slice 1 and requires the Slice 2 host-native contract or a host-level process-lifetime guarantee (kill-on-host-exit) |

## Confirmed decisions

1. **Rename approved, as a separate third commit**: `PreviewBuildFlow` →
   `PreviewBuildController` ships with this slice but as an isolated
   third boundary (behavior unchanged; small diff).
2. **Same-target `Preview This Graph` semantics approved**: when the
   requested target is already the Preview target, the transition refreshes
   that target's own emission, performs **no Runtime interaction** at all,
   and reports `{ ok, changed: false }` (no teardown, no launch, no
   re-commit churn).

## Slice 2 boundary (planned, not implemented here)

Host-native termination command (the "real" `terminateAndJoin`), defined at the
`PreviewRuntimeBoundary` (shader-toolchain-client) and implemented in the
Tauri host:

- a single host command `terminate_and_join(runtimeId)` returning the tri-value
  (`terminated` / `already-exited` / `exit-unproven`) — the host can join the
  process or consult its process table to prove termination, replacing the
  editor-side inference of (stop outcome + exit kind), and enabling real
  re-proof (absent in Slice 1);
- optional `is_runtime_alive(runtimeId)` for the recovery re-proof path,
  turning "retry Stop" into a precise host query;
- optionally, a host-level lifetime guarantee (kill-on-host-exit or a
  process-lifetime binding of the preview process to its spawning host) if
  the "no second Runtime after an unproven exit" guarantee is required to
  survive an editor restart;
- `tests/host-io.test.ts` (Rust source pins) and the fake host boundary updated
  to the command;
- the Slice 1 `TerminationProof` contract, manager signature, coordinator, and
  hooks are NOT modified by this swap — that is the stability requirement this
  design exists to meet.

## Verification and handoff

- Per step: the step's exit gate (see the execution table).
- Closure (step 4): from the repository root — `pnpm typecheck`,
  `pnpm test`, `pnpm lint` — all green; the invariant→test mapping table
  reported; known limitations stated (real-host process timing is only
  exercisable on the desktop host; the web composition path constructs no
  flow and is a proven no-op there).
- Commit discipline: no commits by the authoring agent; the owner commits each
  reviewable slice with the proposed message below.

### Proposed commit slices

Boundary 1 (step 0 + step 1):

```
refactor(editor): extract the attached Runtime lifecycle into a dedicated manager

Runtime launch, termination, and Registry ownership move out of the build
flow and into AttachedPreviewRuntimeManager, which owns the state machine
(idle, launching, running, terminating, exit-unproven, launch-refused) and
admits launches only from idle and launch-refused — so a Runtime whose exit
could not be proven (wait-failed) can never be superseded by a second
Runtime. terminateAndJoin returns the tri-value proof (terminated /
already-exited / exit-unproven) implemented over the existing host boundary;
a host wait-failed exit is a first-class unproven state, no longer reported
as "exited".
```

Boundary 2 (step 2):

```
refactor(editor): consolidate Preview ownership transitions in the PreviewCoordinator

Retarget-to-target and close-the-target become the sole coordinator
transitions: terminate-and-join first, revalidate the intent identity
against the CURRENT WorkspaceSession (strict single-flight — refused
immediately while one is in flight, no queueing or supersession — last-await
rule, synchronous commit burst applied via the WorkspaceMutationPort
against `current` in one atomic application), refresh the target's own emission, then commit through the
WorkspaceSession reducer — with zero Workspace/target mutation on any
refusal. A transition that crosses an await never commits a stale snapshot,
and an older transition never out-writes a newer user intent. The app
handlers degrade to thin calls with one shared refusal-to-note mapping; Stop
Preview becomes an idempotent terminate-and-join, and an unproven exit
stays unproven — a repeated Stop re-reports it honestly (the current host
cannot re-proof after settlement), and a user declaration or an editor
restart (operational reset, not a termination proof) never releases
ownership.
```

Boundary 3 (step 3 — approved separate commit):

```
refactor(editor): rename PreviewBuildFlow to PreviewBuildController

After the Runtime lifecycle extracted into the manager, the remaining object
is a build controller (handshake, build, publication, observation). Rename
the class and its module to describe the lasting semantics and update the
residual pins; behavior is unchanged.
```
