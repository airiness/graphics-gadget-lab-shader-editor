# Environment registry persistence and recovery

Status: implemented Editor-owned persistence substrate. Production Environment
import remains disabled. The main-owned publication proposal still requires
owner review, and its Windows staging case-alias defect is still present at
main revision `cbef1f80`. This document does not approve that proposal.

## Ownership and persisted record

The shared `shader-toolchain-client` owns registration record parsing,
comparison, snapshots, and restart recovery orchestration. A host owns atomic
storage and filesystem checks. The Node implementation is in
`apps/cli/src/environment-registry-storage.ts`; the Tauri storage implementation
and production import wiring remain outstanding.

This is Editor operational metadata, not a second Environment manifest.
Each record has exactly these fields:

```json
{
  "registryVersion": 1,
  "environmentId": "sha256:<64 lowercase hexadecimal characters>",
  "environmentRoot": "D:/GGLab/Environments/example",
  "stateRoot": "D:/GGLab/States/example"
}
```

`registryVersion` versions this Editor record only. It does not couple graph,
profile, descriptor, manifest, or producer protocol versions. Readers reject
unknown versions, fields, invalid identities, overlapping roots, and staging
names (case-insensitively). The record key is the existing EnvironmentId's
hexadecimal suffix; it is not a new content identity algorithm.

Records never persist a native proof, descriptor, manifest copy, active
workspace selection, or a Ready flag. Restart snapshots label every readable
record `unverified`. Invalid records remain on disk and produce diagnostics;
other readable records remain inspectable. A saved path is not authority to
skip ordinary final-location host validation.

## Commit and concurrent registration

The Windows Node storage layout is:

```text
registry root/
  <EnvironmentId hexadecimal suffix>/registration.json
  .pending-<UUID>/registration.json
```

Registration first validates the existing transaction's final proof coordinate.
The host writes a complete record into a private pending directory, flushes and
closes the file, then renames the nonempty directory to the final key without
replacement. The rename is the commit point. Existing identical bindings are
idempotent; different root/state bindings for the same EnvironmentId are refused.
Concurrent identical attempts converge on the committed winner. A pre-existing
invalid destination is never repaired or replaced implicitly.

The registry root must be on local Windows storage, ordinary and disjoint from
both Environment and state. Ancestors and entries are checked for reparse
points; records must be independent regular files. Records are bounded to
64 KiB and registry enumeration to 1024 entries, including pending entries.

A failed or interrupted attempt can leave a pending directory. Scanning reports
pending names separately and never restores them as registrations. Pending
contents are not resumed, overwritten, or automatically deleted. Cleanup and
storage garbage collection require a separate host policy. These guarantees
cover process interruption and namespace visibility, not arbitrary storage
corruption, hostile concurrent path substitution, or power-loss durability.

`prepareEnvironmentImport` now reports `registrationMayHaveCommitted` when an
exception occurs after entering the registration callback. Lost acknowledgement
must not be treated as rollback. Scan the registry and perform fresh recovery
before retrying; initialized state remains at the reported recovery location.

## Restart recovery

`recoverEnvironmentRegistration` first checks that the exact saved binding is
still present and readable. It then performs final closure verification,
requires the saved EnvironmentId, inspects existing matching state, requests
fresh final-location proof, re-verifies the closure, and rechecks the saved
binding after asynchronous work. It does not initialize missing state, write a
new registration, switch active Environment, or overwrite last-good records.

The recovery host exposes `recoverExistingState`, not state initialization.
Native services remain responsible for exact executable observations, ordinary
and Preview compatibility, core-owned profile validation, and Runtime evidence.
The recovered transaction result can carry fresh in-memory evidence, while the
persisted snapshot remains unverified on every reload.

`withEnvironmentRegistry` composes an existing import host with the durable
registry's registration callback. Neither helper enables a production import
route or supplies fabricated native evidence.

## Inspection and use

From the repository root:

```powershell
node apps/cli/bin/shader-graph.js environment-registry D:/GGLab/EditorRegistry --pretty
```

Inspection does not create a missing registry directory. It returns the existing
CLI envelope with saved locations, `unverified` posture, pending names, and
explicitly disabled import availability. Corrupt records make CLI inspection
fail with structured diagnostics and a null payload, following the CLI envelope
contract. Programmatic snapshots retain valid records alongside diagnostics.

Programmatic host composition:

```typescript
const registry = new EnvironmentRegistry(new NodeEnvironmentRegistryStorage(registryRoot));
const host = withEnvironmentRegistry(nativeImportHost, registry);
// Production invocation remains disabled pending approval and native host integration.
const snapshot = await registry.snapshot();
```

The shared classes are exported by `@gglab/shader-toolchain-client`. The Node
storage class is a host implementation; the GUI does not import Node APIs.

## Verification scope

Tests cover strict record parsing, concurrent registration, last-good record
preservation, corrupt-record isolation, unverified restart snapshots, mandatory
fresh proof, missing state, replaced closure, changed registry binding during
recovery, and lost acknowledgement after commit. Windows filesystem tests
exercise actual record persistence, abandoned stages, hardlinks, junctions,
read-only CLI inspection, and two separate Node processes racing to register.
All native proof receipts in these registry tests are synthetic. They do not
qualify DX12/Vulkan compilation, Runtime loading, or Preview correctness.

Executed checks: `pnpm typecheck`, `pnpm test` (947 tests), `pnpm lint`,
and `git diff --check` passed. The original producer approval status and
staging defect were rechecked without modifying either sibling repository.
No native shader compilation, Runtime launch, or Tauri desktop build was run
for this persistence change.
