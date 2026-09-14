# Environment import transaction

The Editor application now composes actual final-location native proof with
atomic registry registration. This is a service integration; Workspace activation
and its UI remain the next step. The v1 owner approval dated 2026-09-09 remains
the authority; this document introduces no producer contract.

## Calling the service

```ts
const importer = await createTauriEnvironmentImportHost();
// Obtain Environment/state directory handles from the existing storage host.
// Initialize independent state through the existing producer mutation host first.
const outcome = await importer!.importSelected(environment, state, probeDocuments,
    () => cancelled, event => output(event));
const snapshot = await importer!.snapshot();
```

`createTauriEnvironmentImportHost` is exported by
`apps/editor/src/environment-import-host.ts` and returns null outside Tauri.
`probeDocuments` contains the numeric Surface v1 and texture Surface v2 graphs;
core validates/emits them against the final published descriptors. Callers cannot
supply a proof, registry record or native compiler arguments to this importer.
`cancel()` cancels active native work. After settlement, `close()` retries retained
native cleanup if a close failure occurred. Failed cleanup prevents registration.

The transaction verifies closure and existing state, runs ordinary/Preview
handshakes, ordinary compilation, Preview compilation and Runtime Loaded observation
for DX12/Vulkan and both profile lines, stops/joins Runtime, and reverifies final
facts before registration. No source-deployment proof is transferred.

## Authority and commit boundary

The shared client owns strict observation interpretation, proof validation,
transaction outcomes and registry conflict semantics. The application privately
composes the actual proof service. Rust observes filesystem facts and performs
native work; it does not reconstruct profile/compiler compatibility semantics.

Three narrow native commands prepare, commit and discard registration admission.
Prepare takes selected directory IDs and returns current observations plus a
one-use token. The application strictly validates those observations against the
completed proof. Commit takes only the token, reobserves both trees, rejects
changed observations, then invokes internal no-replace registry insertion. The
native service extracts only the identity/state binding needed to form a record;
its synthetic unit tests are observation-admission tests, not manifest validation
or native compatibility evidence. There is no arbitrary record/path/proof insert
IPC. Tokens are process-local, bounded to four pending admissions and discarded
on precommit refusal or duplicate registration. A lost prepare reply can retain
an unknown token until host restart; exhausting the bounded admission pool fails
closed and requires restarting the host. No user state is deleted.

This is the existing trusted application/host model. A native admission token
means matching filesystem observations, not a cryptographic proof capability or
protection against a hostile WebView. Filesystem observations do not provide a
transaction against arbitrary concurrent external tree replacement.

Cancellation before commit dispatch refuses registration. Dispatch starts a
non-cancellable commit attempt: late cancellation never invents rollback. If the
reply is lost, the application reads the registry and accepts only an identical
committed binding. An absent, conflicting or unreadable winner remains a structured
refusal with `registrationMayHaveCommitted`; state is retained for explicit retry.
This flag is conservative once the shared transaction enters registration.

The persisted record contains only registry version, EnvironmentId, Environment
root and state root. Registry snapshots always report `readiness: unverified`.
Restart/duplicate import repeats actual final proof. Registration does not switch
the active Workspace, restore Current, or persist Ready. Failed proof, cancellation
and conflicting imports preserve prior records and writable state. The importer
never initializes, overwrites or deletes state implicitly.

## Replaying qualification

Use the exact clean Main revision in `tests/environment-producer-baseline.json`,
with its built published Environment and independent state. Ordinary tests never
resolve a sibling checkout. Set these variables only for the opt-in gate:

```powershell
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '1'
$env:GGLAB_ENVIRONMENT_SOURCE = '<clean pinned Main checkout>'
$env:GGLAB_ENVIRONMENT_IMPORT_QUALIFICATION = '1'
$env:GGLAB_PROOF_ENVIRONMENT = '<final published Environment>'
$env:GGLAB_PROOF_STATE = '<matching independent short state path>'
$env:GGLAB_REGISTRATION_ROOT = '<fresh test registry path>'
$env:GGLAB_IMPORT_REPORT = '<output JSON path>'
pnpm.cmd --filter @gglab/editor test src/environment-import-host.test.ts
```

The bridge uses the production Rust storage, execution and registration services;
its test registry override is not read by production IPC. The test exercises failed
proof without insertion, lost commit acknowledgement, a new application service
instance reading unverified records, duplicate import with fresh proof and cancelled
retry preserving the record. It does not simulate a full OS process restart.

Evidence and gate results are recorded in
`environment-import-transaction-evidence.json`, bound to the Editor base revision
and changed source hashes. They are working-tree evidence, not a clean committed
Editor replay. Main is unchanged and not rebuilt in this increment.

A first run against the previous mutation's long generated state path refused
Preview source staging before registration (`native-failed`). That state was
retained. Qualification therefore uses the same immutable publications and newly
initialized short independent state paths. Windows long-path support is still
unqualified; the managed path layout needs addressing before exposing the complete
Workspace import flow. This failure is not evidence of a successful import at the
original state location.

Live desktop UI/IPC walkthrough, installer packaging, a fresh clean cross-repo
replay and a new last-good regression run were not executed in this increment.
Earlier proof qualification owns historical last-good evidence. No additional
owner contract approval is required for this service integration.

Executed qualification on 2026-09-09 (handoff 2026-09-10): typecheck, lint,
965 TypeScript tests (nine opt-in cases skipped), 91 Rust tests (three ignored),
Editor web build, real producer discovery and diff check passed. Separately enabled
Debug/Release import qualifications passed all eight backend/profile/configuration
combinations, then repeated actual proof for duplicate import. Existing web build
warnings and the Rust unused fixture-field warning remain. Both sibling repositories
were clean and unchanged at handoff.

The managed-path follow-up is recorded in
[environment-managed-state.md](environment-managed-state.md). The failed long-state
evidence above remains historical; new allocation uses a compact layout.
