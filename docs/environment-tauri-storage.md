# Tauri Environment storage and recovery substrate

The project owner approved the Environment v1 integration baseline on 2026-09-09.
The authoritative approval record lives in the docs repository:
`../../GraphicsGadgetLabDocs/GGLab_Environment_Publication_Approval.md`.
Its evidence pair is Main `0a4ce8f26e39fb8740758e4eb275db9d2fe619ec` and Editor
`07ecc3f1b659d40c0a332e8adca704ff6f6d63bd`. Those pins have not changed.
Historical `implemented-pending-owner-review` bootstrap metadata is still parsed
as that revision's metadata; it is not a live feature flag or permission grant.

## Implemented boundary

`apps/editor/src-tauri/src/environment_storage.rs` owns local Windows path
canonicalization, reparse/hardlink refusal, streaming file hashes, bounded text
reads, registry file storage and host-issued directory handles. Canonical final
basenames determine staging status, including case and distinct 8.3 aliases.
File reads use handles denying write/delete sharing while the file is observed.
Directory observation is a snapshot, not a lifetime closure lock or a native
executable launch guard. Existing launch-time executable checks remain required.

`packages/shader-toolchain-client/src/environment-storage-boundary.ts` validates
raw IPC correlation and shape and adapts facts to the existing strict closure
verifier. Manifest schema, membership, role rules and EnvironmentId remain owned
by that shared verifier. State inspection checks existing designated directories
and state binding; it never creates missing state. Registry snapshots use the
existing SET/record projection and always report readable records as `unverified`.

`apps/editor/src/environment-storage-host.ts` connects Tauri to those shared
services. It snapshots handle fields before asynchronous IPC, uses host-issued
IDs for reads and registry keys for reopening, and preserves structured errors.
There is no arbitrary path, file content write, executable or argv IPC capability.

The four new commands are:

- `shader-environment-choose-directory`: native folder dialog and selection kind
  (`environment` or `state`); nullable host-issued directory handle.
- `shader-environment-observe-directory`: selected directory ID; raw filesystem
  inventory, hashes for immutable files, and manifest/state metadata text.
- `shader-environment-registry-scan`: no arguments; read-only scan of
  `<Tauri app data>/environment-registry`.
- `shader-environment-registry-open`: record key; rereads a saved binding and
  returns selection handles for its existing Environment and state roots.

Inspection does not create a missing registry. Records retain the established
`<EnvironmentId hex>/registration.json` layout. The native insert implementation
is host-internal, uses flushed private stage files and a no-replace Windows
directory rename, and returns an existing winner for shared-core comparison.
It requires canonical, existing, disjoint Environment/state roots. Insert has
no WebView command: future native proof composition must invoke it internally.
Abandoned pending directories and invalid records are retained and reported.

Handles expire at process restart. Up to 64 selections are retained, and at most
one directory observation runs at a time; competing observations receive
`host-busy`. Inventory is bounded to 30,000 entries and 10,000 directories;
metadata to 16 MiB; registry records to 64 KiB and scans to 1,024 entries.
Hashing streams 64 KiB chunks, checking a 120-second per-file budget; inventory
checks its 120-second budget between entries. These are cooperative work bounds,
not an interruptible kernel-I/O deadline. Registry/recovery only reopens paths
already recorded in the host-owned storage. No hostile filesystem-substitution
or untrusted local registry security claim is made.

## Use and recovery

The adapter is available to desktop composition without adding an App UI flow:

```typescript
const host = await createTauriEnvironmentStorageHost();
if (host) {
    const snapshot = await host.snapshot(); // Every record is unverified.
    const selected = await host.choose("environment");
    if (selected) {
        const closure = await host.verify(selected); // Integrity, not native Ready.
    }
}
```

`host.recover(record, proveFinal, cancelled)` opens the exact saved binding and
composes `recoverEnvironmentRegistration` with fresh native directory/state
observations. `proveFinal` must be supplied by the existing native compatibility,
descriptor and Runtime services; there is no fabricated/default implementation.
The shared transaction rechecks closure and saved registry binding after proof.
Recovery does not initialize state, insert records, activate an Environment, or
restore a persisted Current claim. Pre-admission failures throw structured
`EnvironmentContractError`; admitted transaction failures retain the shared
`EnvironmentImportOutcome` refusal semantics. Canonically changed saved paths
are refused for explicit reselection, not silently rebound to proof.

## Remaining integration

Production import remains disabled for implementation reasons, not missing
owner approval. Exact executable/profile/Runtime proof and formal writable-state
routing are now implemented in [environment-final-proof.md](environment-final-proof.md).
The next work connects guarded publish/init-state and lost-finalization
reconciliation, then Workspace activation through PreviewCoordinator. Neither
the native internal storage insert nor injected test proof enables production
registration. Main production code and its pinned bootstrap bytes are unchanged.

## Verification

Windows tests exercise real files, canonical staging case/short aliases, junction
and hardlink rejection, bounded/invalid UTF-8 records, missing-state refusal,
restart scan, concurrent no-replace registration and corrupt-record isolation.
Short-name tests print an explicit skip when the volume provides no distinct
alias; the local run exercised a distinct alias. Shared IPC tests exercise the
strict reader, invalid/rebound observations, membership/hash/link failures,
existing-state validation and unverified registry projection. Synthetic manifests
and injected proof callbacks are unit evidence, not native compatibility proof.

Run root `pnpm typecheck`, `pnpm test`, `pnpm lint`, the Editor web build and
`cargo test --offline --manifest-path apps/editor/src-tauri/Cargo.toml`.
Executed on 2026-09-09: typecheck, lint, web build and both repository diff checks
passed; TypeScript tests passed 945 with six cross-repository cases intentionally
skipped, and Rust passed 82 with one real-producer test ignored by default.
That real discovery test was separately enabled against clean Main
`0a4ce8f26e39fb8740758e4eb275db9d2fe619ec` and passed, preserving Debug/Release
candidates. The publisher SHA-256 was
`cfbe8fa0caf0c0683fa7a010067fb03dd2c50d61a5d09137123793e50e9f7f5b`.
The web build retained existing dependency-directive/chunk-size warnings and
Rust retained its existing unused fixture-field warning. ESLint now excludes
the already Git-ignored `.review-evidence/` replay clones and outputs.

This increment does not perform C++ rebuilds, DX12/Vulkan compilation, Runtime
load qualification or a live desktop-dialog walkthrough. Previous clean-replay
native evidence remains attached to its original revisions.
