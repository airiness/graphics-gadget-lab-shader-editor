# Environment writable execution and final-location proof

This implements the next part of the owner-approved Environment v1 integration.
The publication contract remains owned by
`D:/Grezzo/Ruisong/GraphicsGadgetLabDocs/GGLab_Environment_Publication_Contract.md`.
It adds no publisher, registry insertion, Workspace activation or UI flow.

## Responsibility and use

`packages/shader-toolchain-client/src/environment-proof.ts` orchestrates existing
machine readers, ordinary compatibility, Preview eligibility and binary Runtime
observation reading. Every profile/backend path requires a fresh session and the
exact publication returned by that session's successful native build. Successful
ordinary compilation must report the requested target. Missing, stale, rejected,
timed-out or canceled evidence cannot produce proof. Native failure errors retain
the structured process-reader outcome as well as an Environment diagnostic.

`apps/editor/src/environment-proof-host.ts` composes the strict storage reader,
core-owned descriptor validation and HLSL emission with the Tauri host. It checks
descriptor bytes against immutable membership, checks exact executable facts,
and re-verifies the entire closure and state after native proof. Documents are
snapshotted before asynchronous work. Its optional event sink accepts the existing
`EnvironmentEvidence.begin()` callback for Output/Problems; events do not register
or activate an Environment. Successful settlement occurs only after Runtime
termination has been confirmed.

```typescript
const storage = await createTauriEnvironmentStorageHost();
const execution = await createTauriEnvironmentProofHost();
if (storage && execution) {
    const environment = await storage.choose("environment");
    const state = await storage.choose("state");
    if (environment && state) {
        const result = await execution.prove(
            environment, state, [numericProbeDocument, textureProbeDocument],
            () => cancelled, environmentEvidence.begin(),
        );
        // result.proof is final-location evidence; result.runs records four paths.
    }
}
```

The two supplied documents must match the native Preview Lab's published numeric
and texture2d input contracts. A generic graph's successful Surface emission is
not sufficient for that particular Lab input contract. The real test uses
core-parsed numeric and SampleTexture2D graphs, not copied generated HLSL.
`cancel()` requests native cancellation, including cancellation during storage
verification. `close()` retries retained cleanup. If termination remains unproven,
the handle stays unavailable for reuse and close retries cannot invent success.

`apps/editor/src-tauri/src/environment_execution.rs` admits only host-selected
Environment/state directory IDs. It derives v1 role paths, observes exact native
executables and returns descriptor bytes. Commands accept intent, never caller
paths or argv: open-execution, execute, cancel-execution, close-execution.
Execute supports handshake, preview-handshake, compile-probe, build-preview,
launch, observe and stop. Native host observations are not semantic Ready claims;
the shared reader and proof pipeline supply that interpretation.

The existing `ShaderToolService` executes native work. Environment execution views
share desktop Runtime exclusion and process identity counters; dropping a view
does not shut down another view's Runtime. Stop must prove OS process termination.
An unproven exit keeps Runtime admission closed. Desktop teardown retains its
bounded process-cleanup behavior.

## Writable routing

Preview source-root is immutable `payload/Shaders`; generated graph HLSL is
create-only under `state/Generated/<execution>/staging/<attempt>`. Cache,
artifacts, publications, session pointers, observations and logs use the formal
state roles. Runtime receives explicit `--state-root`, backend and Lab/session
intent, uses state as working directory and final `VulkanLayers` as
`VK_LAYER_PATH`. Tool process output and Runtime stdout/stderr are retained in
state/Logs. Source, failed-attempt evidence and user state are never deleted.

Ordinary native qualification compiles the deployed
`Tests/SurfaceGeneratedV{1,2}ContractCompile.hlsl` under immutable shaderSources,
with a logical source locator and host-derived include root. These are explicit
qualification inputs: missing files cause refusal. The ordinary command does
not accept absolute generated sources under a different source-root. Preview's
separate generated-source argument is the native path for graph emission.

No state initialization occurs here. The existing producer must create a separate
state first. Failed or canceled proof preserves that state for explicit retry
with new execution/session IDs. This is not a hostile filesystem-substitution
sandbox; the existing local host trust model and strict ordinary-path checks
continue to apply. Closure integrity is checked before and after execution.

## Reproduction and evidence

Normal tests do not access a sibling repository. The opt-in native test requires
clean Main revision `0a4ce8f26e39fb8740758e4eb275db9d2fe619ec`, as pinned by
`tests/environment-producer-baseline.json`; it also checks the selected manifest's
producer revision. It records manifest provenance, exact native executable
hashes, EnvironmentId, final paths, sessions, publications and Editor HEAD/status.
Synthetic tests are orchestration evidence only.

After publishing a built deployment and creating an independent state through
the pinned producer's machine protocol, run from the Editor repository root:

```powershell
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '1'
$env:GGLAB_ENVIRONMENT_SOURCE = 'D:/path/to/clean-pinned-main'
$env:GGLAB_ENVIRONMENT_NATIVE_PROOF = '1'
$env:GGLAB_PROOF_ENVIRONMENT = 'D:/path/to/final-environment'
$env:GGLAB_PROOF_STATE = 'D:/path/to/independent-state'
$env:GGLAB_PROOF_REPORT = 'D:/path/to/proof-report.json'
pnpm.cmd --filter @gglab/editor test src/environment-proof-host.test.ts
```

Repeat with Debug and Release publications. Each run calls the actual TypeScript
adapter through an ignored Rust stdin bridge into the same production Rust
services used by Tauri. It tests four native paths, then independently tests
failed attempt 2 (exit 4), unchanged last-good pointer/Loaded observation and
successful recovery attempt 3 for each path. Finally it rechecks immutable closure.
This exercises actual host services, not a live WebView IPC/dialog walkthrough.

The 2026-09-09 local results are recorded in
`environment-final-proof-evidence.json`. Editor work is based on
`70a4cf9e0dbd2c41db992148e96f9e4bb2c1288d` plus the recorded working-tree source
hashes, **not** a clean committed Editor revision. The final environments were
retained from the earlier clean replay; their manifest provenance retains
`sourceDirty: true` from the producer's temporary source mirror. That flag is not
rewritten. This run obtains new Editor-native evidence at their final locations;
it does not claim fresh C++ builds, a newly isolated source checkout, system-call
tracing or a new producer qualification. Historical clean-replay evidence remains
bound to its original Editor revision. A clean replay of the eventual owner
commit is a separate gate.

Executed gates passed: root typecheck, tests (954 passed, seven opt-in cases
skipped), lint and diff check; Rust tests (86 passed, two ignored by default),
Rust Debug build, Editor web build and the separately enabled real producer
discovery test. Debug/Release native runs each passed all four proof paths and
all four last-good/recovery paths. Debug Vulkan logs reported validation enabled;
Release reported disabled. The captured Runtime logs for these sessions contained
no warning/error entries. Existing web dependency-directive/chunk-size warnings
and the Rust conformance fixture's unused-field warning remain.

## Remaining work

Guarded publisher/init-state operations and lost-finalization recovery are now
connected in [environment-producer-mutations.md](environment-producer-mutations.md).
Transactional registry insertion is now connected in
[environment-import-transaction.md](environment-import-transaction.md). Next connect
Workspace activation through the existing PreviewCoordinator. This proof primitive does not yet restore Current
after restart or enable production import. No additional contract approval is
requested for this increment.
