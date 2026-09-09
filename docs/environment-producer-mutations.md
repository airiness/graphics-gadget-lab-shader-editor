# Guarded producer mutations and reconciliation

The owner-approved Environment v1 contract remains authoritative in
`../../GraphicsGadgetLabDocs/GGLab_Environment_Publication_Contract.md` and
`GGLab_Environment_Publication_Approval.md`. This increment connects the actual
producer's publish/init-state operations. It does not enable registry insertion,
Workspace activation or a new App UI flow.

## Boundaries

- `environment_mutation.rs` owns durable operation intents, host-managed target
  paths, deployment executable re-observation, execution exclusion and recovery
  inspection. The WebView supplies a repository handle plus an explicitly chosen
  candidate, or a selected published Environment handle. It cannot supply output
  paths, publisher paths, arbitrary process arguments or a copy recipe.
- `environment_io.rs` continues to observe bootstrap/publisher/Python and hold
  executable/script sharing guards. The same bounded executor is now used for
  discovery and mutation. A mutation has a 900-second execution budget; streams
  remain limited to 16 MiB and Python preflight to 30 seconds.
- `environment_process_job.rs` assigns Python to a Windows kill-on-close Job
  before delivering stdin. The supported publisher consumes stdin before starting
  native work, so its descendants inherit that Job. Stop/timeout/overflow and
  normal parent exit all close descendant pipe owners and confirm zero active
  Job processes before returning. Assignment or termination failure is explicit.
  This is not a sandbox for an untrusted Python installation or publisher.
- `environment-mutation.ts` in the shared client reads machine envelopes and
  reconciles final filesystem facts. Successful stdout alone is insufficient.
  Publication must match selected publisher/deployment/executable facts and pass
  the strict closure reader; state must match the selected Environment and pass
  the strict state reader. The result is `integrity-verified` with
  `nativeReadiness: unproven`, not a registered or active Environment.
- `environment-mutation-host.ts` composes those readers with Tauri and the existing
  storage adapter. Its optional event callback accepts `EnvironmentEvidence.begin()`.
  The final-location native proof service remains separate and mandatory before
  future registration.

## Intent, storage and retry

Production destinations are host-derived beneath the Tauri application data root:

```text
environment-operations/<operationId>.json
environment-operations/<operationId>.running
environments/<operationId>/
environment-state/<operationId>/
```

The intent record has an independent Editor-owned `intentVersion: 1`. It records
operation, source binding and destination before any publisher invocation.
Unknown/edited versions, rebound destinations, links and malformed records are
refused. A torn record is not executable. There is no power-loss durability claim.
Intents and producer-owned `.staging-*` / `.work-*` debris are retained. No user
state deletion, migration, garbage collection or automatic cleanup is introduced.

Existing targets are inspected instead of sending another mutating request.
Missing targets may be retried explicitly with the same intent and reselected
original publisher. Pre-spawn failure leaves that intent retryable. Cancellation
uses process-tree termination (`cancelFile: null` is the supported producer wire
choice); the producer's private staging may remain. Cancellation does not admit
a target that happened to finalize concurrently: reconcile explicitly afterward.

Lost stdout or a lost IPC reply causes read-only reconciliation at the recorded
target. Recreating the adapter or host does not change the durable intent binding.
The original repository is unnecessary for read-only reconciliation of an already
finalized result; a new write requires the original selected publisher.

A `.running` marker survives app/process death or unproven termination. It blocks
automatic mutation replay and admission, even after application restart. Restart
alone is not termination proof. The current API permits inspection, but does not
clear such markers automatically; resolving that condition needs an explicit
owner-controlled recovery decision. Previously usable Environments and state
remain untouched. Native calls currently admit at most four simultaneous writes.

## Calling the adapter

```typescript
const mutations = await createTauriEnvironmentMutationHost();
if (mutations) {
    const publishIntent = await mutations.preparePublish(repository, selectedCandidate);
    const publication = await mutations.settle(publishIntent, repository, () => cancelled);
    if (publication.status === "integrity-verified") {
        const inspected = await mutations.inspect(publishIntent.operationId);
        const stateIntent = await mutations.prepareState(repository, inspected.target!);
        const state = await mutations.settle(stateIntent, repository, () => cancelled);
        // Next: fresh final-location proof, guarded registration, then Workspace activation.
    }
}
```

`cancel(operationId)` requests cancellation, including the admission race before
the worker starts. Callers also keep their cancellation intent in the supplied
callback. For restart/lost-result recovery, use `list()` then `inspect(id)` and
`settle(savedIntent, null)`; passing null deliberately performs no producer write.
For an already published Environment, call `prepareState` directly with its
storage selection handle, without discovery or publish.

Native IPC is limited to prepare-mutation, run-mutation, cancel-mutation,
inspect-mutation and list-mutations. There is no native registry insertion exposed
by this work and no change to compiler/backend/profile/Runtime wire contracts.

## Verification

Normal tests need no sibling checkout. The real opt-in test first requires clean
Main `0a4ce8f26e39fb8740758e4eb275db9d2fe619ec` using the existing pinned fixture
resolver. It calls the actual TypeScript adapter through an ignored Rust bridge
into production services. Each Debug/Release test publishes a new closure,
verifies it, retries publication without overwrite, creates separate state,
discards the real init-state reply to test transport-loss recovery, retries state
without overwrite and reopens the saved intent with a new adapter. Rust tests
separately recreate the host service over retained intents.

```powershell
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '1'
$env:GGLAB_ENVIRONMENT_SOURCE = 'D:/path/to/clean-pinned-main'
$env:GGLAB_ENVIRONMENT_MUTATION_QUALIFICATION = '1'
$env:GGLAB_MUTATION_ROOT = 'D:/short/editor-test-store'
$env:GGLAB_MUTATION_CONFIGURATION = 'Debug' # Repeat with Release.
$env:GGLAB_MUTATION_REPORT = 'D:/path/to/mutation-report.json'
pnpm.cmd --filter @gglab/editor test src/environment-mutation-host.test.ts
```

The test root is explicit, test-only and never read by production root selection.
Keep it short on the qualified local Windows filesystem. Tests do not delete
generated publications or state. The pinned checkout must already have built
deployments and the producer's runtime dependencies available.

The local evidence is in `environment-producer-mutations-evidence.json`. It records
the Editor base revision and working-tree source hashes, not a clean committed
Editor replay. No Main code was changed or rebuilt in this increment. Producer
publication executes its own native build-runtime gates for both targets; this
does not replace Editor ordinary/Preview/Runtime proof at the new final locations.
Those final proof paths, a live desktop dialog/IPC walkthrough, installer packaging,
long-path support and a new clean cross-repository replay were not executed here.

Executed on 2026-09-09: root typecheck, lint and diff check passed; TypeScript tests
passed 964 with eight opt-in cases skipped, and Rust tests passed 90 with three
ignored bridge/discovery cases. Both separately enabled Debug/Release producer
adapter qualifications passed, including injected init-state reply loss. The
Editor web build passed with its existing dependency-directive/chunk-size warnings;
Rust retained the existing unused conformance-fixture field warning. The Windows
descendant test actually starts a child that inherits output pipes, then verifies
bounded shutdown and that the child cannot perform its delayed write.
