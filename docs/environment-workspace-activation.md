# Workspace Environment activation transaction

The application service now connects actual final-location import/proof to
Workspace Environment selection through the existing PreviewCoordinator. This
increment implements the ownership transaction, not the complete interactive
Environment workflow. Menu/UI entry points and persistent Environment-bound
native authoring services remain unavailable. A selected Environment never
inherits the legacy host's Ready/Current claims.

## Calling the service

```ts
const activation = await createTauriEnvironmentActivationHost();
const outcome = await activation!.activate(
    previewCoordinator, environmentHandle, stateHandle,
    [numericProbeGraph, textureProbeGraph], () => cancelled, evidence.begin(),
);
```

`createTauriEnvironmentActivationHost` lives in
`apps/editor/src/environment-activation-host.ts` and returns null outside Tauri.
The handles come from the storage service; state preparation remains an explicit
producer operation. The actual import service verifies and registers the selected
Environment and runs fresh native proof. Callers cannot supply a serialized proof
or registry record as activation permission. A private WeakMap binds a frozen,
one-use admission to observations from that actual import.

The same coordinator lease serializes activation, Preview retarget and target
close. It rejects a competing transition or existing Preview build before
preparing anything. It prepares the candidate while preserving the old Workspace
selection, then strictly terminates/joins the old attached Runtime. This is the
last await before one synchronous WorkspaceStore commit. Cancellation, preparation
failure, unproven Runtime exit or a changed Workspace root/Environment binding
refuses that commit. Registration may already have succeeded; refusal never
claims registry rollback or deletes state. Cancellation after teardown may leave
the old Runtime stopped even though the previous selection is retained.

The commit reads current document records, preserving edits, history, tabs,
selection, viewport and the explicit Preview target. It sets a frozen
`WorkspaceSession.activeEnvironment` with EnvironmentId, final roots, exact tool
and Runtime observations, and a session-local activation sequence. It clears the
old descriptor/emission and diagnostic focus facts. The activation sequence is
an ownership correlation, not a persisted format version or EnvironmentId.

Legacy descriptor completions carry no Environment binding and cannot update a
selected Environment context. Legacy Preview gates refuse as host-unavailable;
Runtime projection remains idle with no current publication. Problems composition
excludes those old native owner instances while Build/Preview chronology remains
available. No saved registration or previous Loaded observation becomes current
under the new selection. Environment-bound profile resolution and native host
replacement must be integrated before enabling interactive activation.

The activation sink uses the existing structured Environment event/Problems
channel: `activate` records the ownership phase and the final `settled` event
records activation refusal after any successful import. A failed evidence sink
does not change the committed transaction outcome. The callback's attempt identity
continues to isolate stale Problems entries through EnvironmentEvidence.

## Qualification

Unit tests use explicitly synthetic import receipts and real coordinator/Runtime
manager state machines. They cover forged admission, failed preparation,
single-flight rejection, current edits during teardown, cancellation after import,
Workspace replacement, unproven exit, old descriptor/publication isolation and
throwing evidence sinks. Existing retarget/close tests still apply.

For actual final-location qualification, enable the existing import test plus:

```powershell
$env:GGLAB_ENVIRONMENT_ACTIVATION_QUALIFICATION = '1'
```

Use the exact producer pin and Environment/state/registry variables documented in
[the import transaction](environment-import-transaction.md). The extra stage runs
fresh native proof before selecting the Environment in a real WorkspaceStore. It
starts from no attached old Runtime; old-Runtime switching is covered by synthetic
transition tests, not claimed as native switch evidence. The actual qualification
also repeats registry import/recovery checks and leaves independent state intact.

See `environment-workspace-activation-evidence.json` for source hashes, exact
revisions, final roots and results. No Main code, producer pin, compiler/backend
policy, profile ABI or Runtime implementation changes in this increment. Full
desktop UI switching, native old-to-new attached Runtime switching, persistent
Environment-bound authoring, a new last-good regression and clean committed replay
remain unexecuted. The owner-approved v1 integration scope is unchanged.

Executed on 2026-09-10: typecheck, 973 TypeScript tests (nine opt-in cases skipped),
lint, 93 Rust tests (three ignored), Editor web build and diff check passed.
Debug/Release native qualification passed DX12/Vulkan and both profile lines,
including an additional fresh proof for Workspace activation (12 Preview runs per
configuration across import, duplicate import and activation). Runtime Loaded
observations were required by each proof. Activation began without an attached
old Runtime. Existing web build and Rust fixture warnings remain; Main was
unchanged. PowerShell formatted pnpm stderr banners as NativeCommandError records;
actual command exits and test summaries passed.
Final frontend and Rust verification were repeated with explicit exit-code capture; both exited 0.
