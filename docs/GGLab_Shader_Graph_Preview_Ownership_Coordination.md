# GGLab Shader Graph Preview Ownership Coordination

> Status: **design-freeze candidate, 2026-09-05** — this revision folds the
> final architecture review into the plan. Slice 1 implementation has not
> started.
>
> Authority relationship: this document records the Preview ownership
> architecture decision and the Slice 1 implementation plan. The normative
> authoring baseline remains `GGLab_Shader_Graph_Editor_Architecture.md`; the
> host-side Preview boundary remains owned by
> `packages/shader-toolchain-client` and the Tauri host. Nothing here moves
> compiler or Runtime policy into the Editor.

## Why this document exists

Three consecutive review rounds on the multi-document Preview surface fixed
successively deeper symptoms of one structural defect: proof of Runtime exit
and Preview ownership were distributed across `PreviewBuildFlow`,
`useShaderPreview`, `app.tsx`, and the then-minimal `preview-coordinator.ts`.
The defects all appeared at those seams:

- stop acknowledgment was mistaken for process-exit proof;
- Preview ownership could still implicitly follow the active tab;
- `wait-failed` was treated as a completed teardown;
- after an unproven exit, a second Runtime launch was still admissible;
- asynchronous ownership transitions could commit against stale Workspace
  state.

The decision is therefore to stop adding seam patches and establish explicit
owners for Runtime lifetime, Workspace commit authority, Preview transition
procedure, and build state.

## Frozen ownership model

| Authority | Module | Owns | Never owns |
|---|---|---|---|
| Document/target state | `WorkspaceSession` reducers | Open documents, active document, `preview.targetDocumentId` | Runtime process lifetime |
| Workspace commit authority | `WorkspaceStore` | Current Workspace authoring state, synchronous atomic apply, publication/subscription | Preview-specific refusal vocabulary |
| Build authority | `PreviewBuildFlow` (renamed later to `PreviewBuildController`) | Handshake, build, publication, observation, build-side gate reasons | Runtime lifetime or target state |
| Runtime lifetime authority | `AttachedPreviewRuntimeManager` | Launch admission, Runtime ownership binding, stop/join proof, Runtime state machine | Build-domain refusal vocabulary or target state |
| Transition authority | `PreviewCoordinator` | Sole executor of retarget / target-close transitions and cross-domain gate composition | A second copy of target state |

`WorkspaceSession` remains the semantic owner of the target axis. The
Coordinator is the **procedure owner**, not a second state owner.

## Runtime state machine

The exact Slice 1 states are:

```text
idle
launching
running
terminating
exit-unproven
launch-refused
```

Transitions:

| From | Event | To |
|---|---|---|
| `idle` | launch admitted | `launching` |
| `launch-refused` | retry admitted | `launching` |
| `launching` | host launch accepted | `running` |
| `launching` | host launch refused | `launch-refused` |
| `running` | stop requested | `terminating` |
| `running` | natural proven exit (`exited` / `stopped`) | `idle` |
| `running` | natural `wait-failed` | `exit-unproven` |
| `terminating` | proven exit | `idle` |
| `terminating` | `wait-failed` | `exit-unproven` |

`exit-unproven` is a first-class safety state. Settlement arrival is not
synonymous with proven process death.

### Runtime ownership binding and identity

The Runtime manager must preserve the **existing deployment-isolation
semantics**. Today the Preview flow decides whether two candidates share a
deployment by exact `ToolCandidate.toolPath` equality; that is the Slice 1
deployment identity and must not be replaced by Preview Program Descriptor
identity.

These identities are distinct:

```text
Runtime executable identity
Tool deployment identity (Slice 1: exact candidate.toolPath)
Preview Program Descriptor identity
Preview target/document identity
```

Program Descriptor identity is a build/program contract. It is **not** proof
that two tool deployments are the same.

The manager exposes Runtime facts only:

```ts
interface OwnedRuntimeBinding {
    readonly runtimeId: PreviewRuntimeId;
    readonly runtimeIdentity: string;
    /** Exact ToolCandidate.toolPath of the deployment that launched it. */
    readonly deploymentToolPath: string;
}

interface AttachedPreviewRuntimeManager {
    readonly state: AttachedRuntimeState;
    readonly launchInFlight: boolean;
    readonly ownedRuntime: OwnedRuntimeBinding | null;

    launch(binding: RuntimeLaunchBinding): Promise<AttachedRuntimeLaunchResult>;
    terminateAndJoin(): Promise<TerminationProof>;
}
```

`ownedRuntime` projection is exact:

```text
idle             -> null
launching        -> null
launch-refused   -> null
running          -> same owned binding
terminating      -> same owned binding
exit-unproven    -> same owned binding
```

The binding is released only by a **proven** exit. In particular,
`exit-unproven` must retain the deployment identity because the process may
still be alive.

## Termination contract

The stable Slice 1 -> Slice 2 contract is:

```ts
type TerminationProof =
    | { readonly outcome: "terminated" }
    | { readonly outcome: "already-exited" }
    | { readonly outcome: "exit-unproven"; readonly runtimeId: PreviewRuntimeId };
```

Rules:

- `already-exited` is produced only from states where the manager has
  PROVEN there is no owned Runtime (`idle` / `launch-refused`); it is never
  inferred from the host's `alreadySettled` registry answer or a registry
  miss.
- One host stop request per RuntimeId: `stop()` and `terminateAndJoin()`
  join the same in-flight request; a failed stop request REJECTS the
  teardown and rolls state back to `running` (ownership retained) — it must
  never hang on a stale settlement and never is a proven teardown.
- Unmount / cleanup must call the strict teardown (fire-and-forget), not a
  plain `stop()`: a plain stop is a no-op while `launching` and would orphan
  a Runtime whose launch settles after unmount.
- `wait-failed` enters `exit-unproven` and retains ownership.
- In Slice 1, `exit-unproven` is sticky. Repeated Stop calls re-report the
  stored unproven fact and make no host call.
- The exact exit settlement for a RuntimeId is captured before the stop
  request and the async exit handler may migrate state only for the matching
  RuntimeId.

The current host removes its registry entry after the settlement thread ends;
that registry miss is not termination evidence and therefore cannot release
Editor ownership.

## Workspace commit authority

### Why React state is no longer the authority

A Preview transition crosses an `await` while the Workspace may legitimately
change. The required commit shape is:

```text
read CURRENT -> revalidate -> reduce(CURRENT) -> publish
```

A React functional updater cannot also provide a clean synchronous structured
result to the Coordinator. Promise resolution or external-variable result
smuggling from inside `setState` is explicitly forbidden.

Decision:

> The Workspace gets one synchronous external store authority. React is a
> projection of that store through `useSyncExternalStore`.

### Workspace authoring state

The store owns the Workspace-scoped facts needed by a commit-time Preview
transition, not only the document list:

```ts
interface WorkspaceAuthoringState {
    readonly session: WorkspaceSession<DocumentSession>;
    /** Current workspace-scoped profile descriptor fact used by core rules. */
    readonly profileDescriptor: SurfaceProfileDescriptor | null;
}
```

The exact UI loading/error presentation may stay outside this semantic fact,
but there must be **one** current descriptor authority. Preview code must not
capture a descriptor from a React render and carry it across an `await`.

A workspace descriptor change invalidates derived emission snapshots whose
result depended on the old descriptor. The implementation may invalidate all
open-document emission snapshots or attach an exact descriptor revision to
those snapshots, but it must never present an old-descriptor emission as
current.

### Generic store contract

`WorkspaceStore` is deliberately generic and contains no Preview-specific
`TransitionIntent`, refusal, Runtime, or build vocabulary:

```ts
interface StoreApply<TState, TResult> {
    readonly next: TState;
    readonly result: TResult;
}

class WorkspaceStore<TState> {
    getSnapshot(): TState;
    subscribe(listener: () => void): () => void;

    apply<TResult>(
        reduce: (current: TState) => StoreApply<TState, TResult>,
    ): TResult;
}
```

Contract:

- `apply` is synchronous and calls `reduce` exactly once against the current
  snapshot.
- If `reduce` returns `next !== current`, the store replaces the snapshot
  first and notifies subscribers afterwards.
- If `next === current`, it returns the result without manufacturing a new
  snapshot or notification.
- `getSnapshot()` returns the same immutable object identity while the store
  has not changed, as required by `useSyncExternalStore`.
- The store instance is stable for the App lifetime.
- `reduce` is pure with respect to the store. A thrown exception leaves the
  current snapshot unchanged, publishes nothing, and propagates to the caller
  (**strong exception safety**).
- Reentrant `apply` while another `apply` is reducing or publishing is an
  invariant violation and is rejected. Subscribers observe committed state;
  they do not start nested transactions from the notification call stack.

React uses `useSyncExternalStore(store.subscribe, store.getSnapshot)`; there is
no React-state mirror that may later overwrite the store.

## Commit-time semantic resolution

A retarget refresh must use the target document and descriptor facts that are
current **after** Runtime teardown proof settles.

Inside the synchronous `WorkspaceStore.apply` callback:

1. locate the requested target in `current.session`;
2. read `current.profileDescriptor`;
3. ask the core-owned profile/descriptor compatibility rules for the verdict;
4. run `emitHlsl` for that exact target document and exact current descriptor;
5. write the resulting emission to that target DocumentSession presentation;
6. commit the Preview target reducer in the same synchronous application.

Forbidden:

```text
capture ActiveDocument descriptor
capture descriptor before await
capture target emission before await
silently substitute another profile/descriptor line
```

If the current descriptor cannot legally emit the current target, the
transition returns `target-emission-unavailable` and the Workspace snapshot is
unchanged.

A required regression is:

```text
retarget starts with descriptor D1
Runtime teardown waits
descriptor changes to D2
teardown settles
-> commit-time emission uses D2, or refuses under D2
-> D1 is never used
```

## Coordinator transition discipline

Both retarget and target-close transitions obey the same discipline.

1. Claim one strict single-flight slot.
2. Record a transition identity (`kind`, target document id, monotonic
   sequence for evidence only).
3. Use `claim -> try { ... } finally { release }`; every refusal and exception
   releases the slot.
4. `manager.terminateAndJoin()` is the transition's **last await** whenever a
   teardown is required.
5. After that await, perform exactly one synchronous `WorkspaceStore.apply`.
6. Revalidate the intent against that apply-time snapshot.
7. Resolve target emission and run the Workspace reducers inside that same
   synchronous application.
8. Never pre-compute a whole next Workspace snapshot before the await and
   write it back afterwards.

Strict single-flight means exactly this:

```text
transition A is in flight
transition B arrives
-> B returns transition-in-flight immediately
-> no queue
-> no auto-supersede
-> user may retry after A completes
```

The transition sequence is evidence/identity only; it is not a
latest-intent-wins protocol.

### `retargetTo(targetDocumentId)`

Normal retarget:

```text
claim
-> validate target exists (early guard)
-> await terminateAndJoin
-> exit-unproven: refuse; no Workspace mutation
-> store.apply(CURRENT):
     revalidate target still exists
     resolve current descriptor + current target emission
     update target presentation emission
     commitWorkspacePreviewTarget
-> return { ok: true, targetChanged: true }
-> finally release
```

Same-target `Preview This Graph` is an approved fast path:

```text
claim
-> target already is Preview target
-> NO Runtime termination
-> store.apply(CURRENT):
     revalidate same target still exists/is target
     resolve current descriptor + refresh target emission
     do not move PreviewTarget axis
-> return { ok: true, targetChanged: false }
-> finally release
```

`targetChanged: false` does not mean the Workspace was unchanged; the target's
presentation emission may have changed.

### `closeTarget(documentId)`

```text
claim
-> validate document is the Preview target
-> await terminateAndJoin
-> exit-unproven: refuse; tab remains open
-> store.apply(CURRENT):
     revalidate document is still open and still target
     closeWorkspaceDocument(CURRENT.session, documentId)
     reducer re-seeds Preview target from the active document of CURRENT
-> return ok
-> finally release
```

A non-target tab close remains a plain Workspace reducer operation and does not
depend on Preview machinery.

## Build / Runtime gate composition

The Runtime manager exposes facts; the Coordinator maps those facts into the
build refusal vocabulary.

The existing deployment isolation is preserved:

```text
coordinator.gate(composition)
    if manager.launchInFlight
        -> attached-runtime-launching

    else if manager.ownedRuntime != null
         and current compatible ToolCandidate exists
         and manager.ownedRuntime.deploymentToolPath
             != currentCandidate.toolPath
        -> attached-runtime-deployment-mismatch

    else
        -> controller.buildGate(composition)
```

Do **not** compare `deploymentToolPath` with Preview Program Descriptor
identity. Descriptor identity remains part of the Preview build requirement,
not the Runtime deployment-equality predicate.

The current success-first UX is preserved:

```text
Preview build publishes
-> if Runtime manager is idle, auto-launch is permitted
-> running / terminating / launching suppress auto-launch
-> exit-unproven refuses launch structurally
```

A retarget transition itself never auto-launches.

## Recovery semantics

`exit-unproven` means the old Runtime may still exist.

Slice 1 therefore provides no formal recovery inside the current editor
session:

- retarget is blocked;
- closing the Preview target is blocked;
- a second Runtime launch is blocked;
- repeated Stop re-reports the stored unproven fact without a host call;
- a user declaration never releases ownership.

Restarting the Editor is an **operational reset only**, not termination proof.
The Slice 1 "no second Runtime after an unproven exit" guarantee is therefore
session-scoped. Extending that guarantee across restart requires Slice 2 or a
host-level process-lifetime guarantee.

## Target module shape — Slice 1

| File | Action |
|---|---|
| `src/preview-runtime-manager.ts` | New Runtime state machine, owned deployment binding, launch admission, `terminateAndJoin` |
| `tests/preview-runtime-manager.test.ts` | Runtime lifecycle, sticky unproven, deployment binding retention, second-launch refusal |
| `src/workspace-store.ts` | New generic synchronous Workspace external store + React projection hook |
| `tests/workspace-store.test.ts` | exactly-once apply, snapshot stability, notify ordering, strong exception safety, reentrancy refusal |
| `src/preview-coordinator.ts` | Formal transition executor and Runtime-fact -> build-refusal composition |
| `tests/preview-coordinator.test.ts` | retarget/close ordering, stale-state revalidation, descriptor-during-await regression, strict single-flight, finally re-claim |
| `src/preview-build-flow.ts` | Remove Runtime lifetime fields/methods; retain build/observation authority |
| `src/useShaderPreview.ts` | Compose controller + Runtime manager + Coordinator; preserve build-success auto-launch |
| `src/app.tsx` | Workspace/descriptor facts project from `WorkspaceStore`; handlers become thin Coordinator calls |
| `tests/gui-surface.test.tsx` | Move pins to the new seams |

Untouched in Slice 1:

- `workspace-session.ts` reducer semantics;
- `packages/shader-toolchain-client` contracts;
- fake host boundary;
- Tauri/Rust host implementation;
- `packages/editor-ui`.

## Slice 1 execution steps

Each boundary must be independently green and reviewable.

| Step | Content | Exit gate |
|---|---|---|
| 0 | Red test: `wait-failed` must prevent a second Runtime launch | Red for the existing defect; baseline recorded |
| 1 | Extract `AttachedPreviewRuntimeManager`; preserve exact deployment equality (`candidate.toolPath`) and owned binding through `terminating` / `exit-unproven` | typecheck + manager/flow/surface tests + lint |
| 2 | Introduce generic `WorkspaceStore`; move WorkspaceSession and the workspace-scoped descriptor semantic fact under its synchronous authority; React becomes `useSyncExternalStore` projection | full workspace gates + store tests |
| 3 | Formalize `PreviewCoordinator`; retarget/close use strict single-flight, final-await rule, commit-time descriptor resolution, one synchronous store apply, and deployment-aware gate composition | full editor suite + lint |
| 4 | Isolated rename `PreviewBuildFlow` -> `PreviewBuildController` | full workspace gates |
| 5 | Closure verification | root `pnpm typecheck`, `pnpm test`, `pnpm lint` |

## Hard invariants and tests

| # | Invariant | Primary test |
|---|---|---|
| 1 | Switching ActiveDocument never changes PreviewTargetDocument | WorkspaceSession / pure resolver |
| 2 | A real retarget commits only after prior Runtime termination is proven | Coordinator ordering |
| 3 | Failed/unproven teardown leaves target unchanged and target tab open | Coordinator refusal |
| 4 | `exit-unproven` is sticky in Slice 1 | Runtime manager |
| 5 | `exit-unproven` can never admit a second Runtime | Runtime manager red-test closure |
| 6 | `running`, `terminating`, and `exit-unproven` retain the same owned deployment binding | Runtime manager state projection |
| 7 | Deployment mismatch compares the launched ToolCandidate deployment, not Program Descriptor identity | Coordinator gate regression |
| 8 | Target-close uses the same Coordinator ownership transition | Coordinator close-target |
| 9 | No transition crossing an await commits a stale Workspace snapshot | Coordinator stale-document / active-move tests |
| 10 | Descriptor changes during teardown are observed at commit time | Coordinator D1 -> D2 regression |
| 11 | Every Coordinator refusal/exception releases the single-flight claim | Coordinator re-claim matrix |
| 12 | WorkspaceStore is generic, exactly-once, snapshot-stable and strongly exception-safe | WorkspaceStore tests |

## Risk register

| Risk | Required mitigation |
|---|---|
| A prettier state machine silently loses existing deployment isolation | Pin `ToolCandidate.toolPath` deployment equality before extraction; regression test A -> B deployment change |
| WorkspaceStore becomes a Preview-domain service | Generic `apply<TResult>` contract; no Preview types in the store module |
| React remains a competing Workspace authority | React reads only through `useSyncExternalStore`; no mirrored `setWorkspace` state |
| Descriptor is captured before Runtime teardown completes | Descriptor semantic fact lives under synchronous Workspace authority and is read inside commit-time apply |
| Descriptor change leaves inactive document emissions falsely current | Invalidate all affected emission snapshots or bind them to an exact descriptor revision |
| Single-flight claim leaks on refusal/throw | `try/finally` + re-claim tests for every refusal class |
| External-store notification introduces nested mutation | Reject reentrant apply while reducing/publishing; notify only after commit |
| Build success no longer auto-launches | Preserve existing success-first hook behavior, with Runtime manager admission |
| `wait-failed` registry miss is mistaken for proof | `alreadySettled` is never mapped to `already-exited` |
| Zombie Runtime survives editor restart | Explicitly outside Slice 1 guarantee; Slice 2 / host lifetime binding required |

## Slice 2 boundary

Slice 2 may replace the Editor-composed stop + exit proof with a host-native
contract without changing the upper Coordinator contract:

```text
terminate_and_join(runtimeId)
    -> terminated
    -> already-exited
    -> exit-unproven
```

It may additionally expose `is_runtime_alive(runtimeId)` and/or a host-level
process-lifetime binding if cross-restart ownership guarantees are required.
Only the host can provide a genuine re-proof once Slice 1 has entered
`exit-unproven`.

## Verification and handoff

Per implementation boundary, run its local exit gate. At Slice 1 closure run
from the repository root:

```text
pnpm typecheck
pnpm test
pnpm lint
```

The implementation report must include the invariant-to-test mapping above and
state any limitation that cannot be exercised without the real desktop host.

### Proposed implementation commits

1. `refactor(editor): extract the attached Runtime lifecycle into a dedicated manager`
2. `refactor(editor): make Workspace authoring state a synchronous store authority`
3. `refactor(editor): consolidate Preview ownership transitions in PreviewCoordinator`
4. `refactor(editor): rename PreviewBuildFlow to PreviewBuildController`

This document is the stop point for local seam patches. Once this freeze
candidate is accepted, subsequent implementation review should judge the code
against these authorities and invariants rather than reopen the ownership
model ad hoc.
