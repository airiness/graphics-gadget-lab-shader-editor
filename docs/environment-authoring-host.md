# Environment authoring host

The persistent host in `apps/editor/src/environment-authoring-host.ts` adapts a
selected final Environment and separate writable state to the existing
`HostToolBoundary`, `PreviewObservationBoundary` and `PreviewRuntimeBoundary`.
It is a callable desktop composition service. The
[Workspace authoring integration](environment-workspace-authoring.md) now connects
application hooks to this host. The import menu remains outstanding; one-click
import is not ready for user acceptance. Verification below records this service's
original boundary qualification.

## Calling the host

```ts
const host = await createTauriEnvironmentAuthoringHost();
if (host === null) throw new Error("Desktop host required");
try {
    await host.open(environmentHandle, stateHandle, activeSelection, "vulkan");
    const descriptor = host.resolveProfile(document);
    // Supply these boundaries to the existing authoring controllers.
    const tool = host.boundary;
    const observations = host.observation;
    const runtime = host.runtime;
} finally {
    await host.close();
}
```

`activeSelection` is the Workspace selection produced by the guarded activation
transaction; the directory handles come from native selection/recovery. Keep the
host reachable until `close()` succeeds, even after a failed `open()`. Failed
cleanup is retryable on the same host. A closed host is single-use; changing
Environment, state or backend requires a new host and coordinator-owned teardown.
The future hook integration must guard completions against the active Workspace
selection and must not treat opening this service as a Ready/Current event.

Admission revalidates the closure and writable state, compares final roots and
exact executable hashes with the selection, and checks both Surface descriptors
and the Preview Program descriptor identity against the manifest. Profile
resolution uses core-owned parsing and compatibility checks for the document's
exact profile line. Returned descriptors are copies. No profile upgrade occurs.
Discovery returns this execution's observed candidate; subsequent handshakes and
builds retain the native pre-spawn executable observation checks. Admission does
not promise an OS-level immutable filesystem lock for the session lifetime.

## Responsibilities and lifecycle

- Rust holds selected paths, stages source, invokes the existing ShaderToolService,
  and writes generated output, artifacts, caches and logs to independent state.
  The native toolchain owns compilation and target policy. Its process wire
  contract is unchanged.
- The adapter serializes execution RPCs while native build workers run
  asynchronously. Build IDs come from native admission, and polling/cancellation
  use their sequence values within one execution. Canceling a build does not
  cancel the host. Native collection rejects foreign and already-collected IDs.
- The attached Runtime uses the explicit backend selected at admission. Preview
  requests for another backend are refused. Stop requests and exit promises keep
  their native Runtime IDs; foreign IDs cannot stop another execution's process.
  Each launch gets separate create-new stdout/stderr logs, including repeated
  launches of the same Preview session.
- Shutdown immediately refuses new work, cancels and joins pending work, then
  releases the execution. Concurrent shutdowns share one promise. A failed join
  retains the native handle for retry and never restores admission.
- Existing client controllers still own compatibility, revisioned readiness,
  publication identity and last-good interpretation. This adapter adds no
  compiler, renderer, profile ABI, registry format or diagnostic semantics.

## Verification

See [the recorded evidence](environment-authoring-host-evidence.json). The native
qualification remains opt-in and enforces `tests/environment-producer-baseline.json`.
Ordinary unit tests use explicit synthetic IPC data and do not access Main.

For each built configuration, select a final Environment and state published from
the pinned clean Main revision, then run from the Editor root:

```powershell
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '1'
$env:GGLAB_ENVIRONMENT_SOURCE = '<clean checkout at the pinned producer SHA>'
$env:GGLAB_ENVIRONMENT_NATIVE_PROOF = '1'
$env:GGLAB_PROOF_ENVIRONMENT = '<final published Environment root>'
$env:GGLAB_PROOF_STATE = '<independent state root>'
$env:GGLAB_PROOF_REPORT = '<output JSON path>'
pnpm --filter @gglab/editor test src/environment-proof-host.test.ts
```

This runs fresh final-location ordinary/Preview proof, then exercises the actual
persistent boundaries for both profiles and backends: successful publication and
Loaded observation, invalid HLSL exit 4 with unchanged active pointer, recovery,
stop/join, same-session relaunch followed by a **new** publication/Loaded record,
and a cancellation request followed by another successful build. Cancellation may
race with completion; synthetic tests separately require cancellation settlement.
Closure verification is repeated after the runs. Historical source-deployment
proof is not transferred to the final location.

Desktop hook transitions, native old-to-new Environment switching, menu import,
manual UX acceptance and a clean committed Editor replay remain unexecuted.
Main is unchanged; its existing pinned Debug/Release builds and published closures
were reused, not rebuilt in this increment. The existing large web-chunk warning
does not prevent the Editor web build.
