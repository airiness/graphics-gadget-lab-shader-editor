# Environment import readiness and publisher handoff

Current update (2026-09-11): the owner approved the v1 integration baseline in
`../../GraphicsGadgetLabDocs/GGLab_Environment_Publication_Approval.md`.
The producer alias defect and evidence baseline were closed by
[clean replay](environment-clean-replay.md). [Tauri storage integration](environment-tauri-storage.md)
adds native inspection/storage and recovery composition. Final proof, managed
state, guarded publication/registration and Workspace activation now have callable
implementations. The [persistent authoring host](environment-authoring-host.md)
adds final-location profile resolution and existing build/process boundaries.
[Workspace authoring integration](environment-workspace-authoring.md) connects the
desktop hooks; the menu import workflow remains incomplete. Earlier
approval/defect statements below describe the historical handoff rather than the
current gate.

Status: consumer implementation review, 2026-09-08. Strict readers, read-only
host verification, and a tested import transaction core are implemented. Actual
Environment import remains disabled pending owner review of the producer contract.

The assessment below records the earlier 2026-09-07 baseline. This document records consumer requirements and inspected
evidence; it does not define an approved publication protocol or manifest.

## Authority and inspected baseline

The authoring architecture remains
[`GGLab_Shader_Graph_Editor_Architecture.md`](GGLab_Shader_Graph_Editor_Architecture.md).
Process integration remains
[`GGLab_Shader_Toolchain_Integration_Design.md`](GGLab_Shader_Toolchain_Integration_Design.md).
The workspace guidance is owned by the sibling docs repository:
`../../GraphicsGadgetLabDocs/GGLab_Shader_Editor_Workspace_And_UX_Evolution_Guidance.md`,
especially sections 5.3-5.6, 14, and 16. It explicitly leaves the manifest
schema and publisher mechanism open, and requires main-repository approval
of the publication contract before Editor import implementation.

Inspected repository revisions:

| Repository | Revision | Relevant evidence |
| --- | --- | --- |
| Shader Editor | `9ed9e9c` | Shared GUI/CLI semantic edit commands; existing deployment-path-based Preview integration |
| Main GGLab | `ad40b36f` | Shader compiler commands, Runtime packaging script, deployment junction targets |
| GGLab docs | `9518201` | Workspace guidance and existing toolchain contract documentation |

These revisions describe the assessment, not a permanent readiness claim.
Recheck the producer implementation and contract before resuming import work.

## Historical boundary and missing prerequisite (2026-09-07)

No approved Environment publication protocol, manifest instance, or publisher
was found in the inspected first-party sources, tracked scripts, build targets,
and design documents.

- Main `Sources/Tools/ShaderCompiler/ShaderCompilerCommandLine.h` and `.cpp`
  expose compile, build-runtime, build-preview, targets, version, help,
  describe, and describe-preview. They provide no Environment publication
  operation. A future publisher need not be a shader compiler command.
- Main `Scripts/BuildArtifactOnlyRuntimePackage.ps1` creates an artifact-only
  Runtime package. Its validation explicitly forbids `gglab-shaderc.exe`,
  DXC dependencies, and shader source files. That package cannot provide the
  authoring and Preview build closure requested by the workspace guidance.
- Main `PropertySheets/LinkShaderDirectory.targets` and
  `PropertySheets/LinkAssetDirectory.targets` create deployment junctions to
  source resources. A development output directory therefore does not, by
  itself, establish independence from the source checkout.
- Editor `apps/editor/src/discovery-config.ts` and native
  `apps/editor/src-tauri/src/shader_tool/discovery.rs` discover an exact
  executable from configured locations. They do not enumerate published
  Environments or verify an immutable closure.
- Editor `apps/editor/src-tauri/src/shader_tool/service.rs` derives Preview
  shader, cache, artifact, and Runtime locations from the deployment root.
  Those existing development-layout assumptions must be replaced by
  publisher-owned roles for Environment operations.

Existing ShaderArtifact and Preview publication contracts establish their
own products. They do not establish the closure of an Environment containing
executables, dependencies, profile resources, composition inputs, and
designated writable state.

Consequently, the next dependency is the GGLab-owned publication contract
and implementation. Adding an Editor directory copier, guessed manifest
reader, or placeholder registry would not satisfy this dependency.

## Requested producer deliverables

The following are consumer acceptance needs for main-repository review.
Field names, version values, identity encoding, file layout, command names,
and copy membership remain producer decisions.

| Deliverable | What the Editor needs to consume |
| --- | --- |
| Bootstrap discovery | A bounded way to identify eligible deployments and the publisher; ambiguous candidates can be presented for selection without assuming a single Debug/Release path |
| Publication process | An explicit invocation contract with structured outcomes, supported-version behavior, cancellation/failure semantics, and an unambiguous finalized destination |
| Immutable closure | A versioned, bounded manifest with membership, roles, relative locators, hashes, provenance, and an authoritative Environment identity rule |
| Locator rules | Containment, path normalization, duplicate/collision handling, and link/reparse-point policy that prevent hidden dependencies on the source checkout |
| Writable state | Designated cache, produced artifact, Preview publication/pointer, observation, and log locations; their mutation cannot change immutable identity or replace contract truth |
| Finalization | Atomic visibility of a complete publication, defined existing-destination behavior, and interrupted-publication handling |
| Runtime integration | A supported way to resolve immutable inputs and writable outputs at the final location, including required base registries and Preview resources |
| Compatibility and fixtures | Explicit consumer version rejection, positive and negative manifest/process fixtures, and producer-owned evidence for relocation and source-independent operation |

The manifest locates facts; it does not supersede their authorities. Exact
executable observations remain host-owned, tool capabilities remain
handshake-owned, profile semantics remain descriptor/core-owned, and loaded
Preview publication state remains Runtime-observation-owned.

## Editor implementation sequence after producer delivery

1. Read the approved producer specification and fixtures. Add strict readers
   and a narrow host adapter for that actual contract. Keep path derivation,
   filesystem access, executable observation, and process invocation in the
   host; expose bounded operations and host-issued identities to the WebView.
2. Implement import as bootstrap/preflight, producer-owned staging and
   finalization, final-location verification, then registration. Source
   candidate proof must never be transferred to the destination candidate,
   even if executable hashes match. Cancellation or failure must leave the
   current registration and active configuration unchanged.
3. Verify the finalized manifest and immutable closure, observe the final
   executables, obtain fresh ordinary and Preview handshakes, and resolve
   required descriptors through core. Register only a verified result;
   retain structured failure evidence for unsuccessful imports.
4. Integrate the Environment registry and workspace selection. Registration
   must not implicitly launch or retarget Runtime. Active switching follows
   the existing Preview coordinator's stop/await/revalidate discipline;
   unproven termination prevents the switch. Keep Loose Development
   Configuration explicit and separate from Environment role resolution.
5. Resolve each document's persisted profile request within the active
   Environment without upgrading its profile line. Project verified facts
   into the GUI and preserve exact executable checks at every use boundary.

This is a consumer work order, not a serialized state-machine specification.
Final transaction details depend on the approved producer contract.

## Acceptance evidence required before claiming completion

- Unknown manifest/process versions, malformed roles, escaped paths,
  missing members, hash mismatches, and incompatible handshakes/descriptors
  produce explicit rejection and cannot create an active registration.
- Failed or cancelled staging, finalization, verification, and registration
  preserve the previous usable Environment. Concurrent imports and retries
  follow the producer's finalized-destination semantics.
- A copied executable with identical bytes still receives fresh proof at
  its final path. Executable replacement after verification is refused by
  the existing launch/use provenance boundary.
- Cache/artifact/Preview activity changes only designated writable state;
  the immutable closure and Environment identity remain intact.
- Switching while Runtime is attached respects confirmed termination,
  revalidates current workspace state, and rejects stale results from the
  previous Environment.
- With the source checkout unavailable, a finalized Environment can perform
  the supported authoring-to-native-Preview workflow. DX12/Vulkan evidence
  must come from main-owned native qualification for the supported targets;
  Editor unit tests alone cannot establish that claim.

The assessment did not run the publisher, relocate a deployment, or execute
native Preview qualification. There is no Environment publisher to consume
at the inspected baseline, and the sibling repositories were read-only.


## Consumer implementation update (2026-09-08)

The main repository now contains committed producer implementation `cbef1f80`;
its branch is `181-shader-editor-workspace`. The docs repository was inspected
at `61b287b`. Both sibling worktrees were clean. The publication contract and
bootstrap still explicitly state `implemented-pending-owner-review`.
The historical missing-publisher finding above is superseded by this update.

The external contract is
`../../GraphicsGadgetLabDocs/GGLab_Environment_Publication_Contract.md`.
It states: "Editor import remains gated on owner review under Workspace/UX
guidance section 14." The owner explicitly authorized reviewable readers,
fixtures, interface adaptation, and import-core work before that review;
this does not approve or enable import.

### Implemented consumer responsibilities

- `packages/shader-toolchain-client/src/environment-contract.ts`: strict bounded
  JSON and manifest reader, duplicate-key rejection, exact fields/roles,
  locator/member checks, and independent domain-prefixed canonical identity.
  Hashing is supplied by the host; the shared package remains free of OS,
  Node, DOM, React, and graph-semantic dependencies.
- `environment-closure.ts`: common closure verification against a host-owned
  complete inventory, including missing/extra files, digests, reparse and
  hardlink refusals. A valid closure is not a compatibility certificate.
- `environment-protocol.ts`: bootstrap, request and response readers for the
  actual producer proposal, operation/exit correlation, explicit candidate
  lists, and an injectable producer transport. It contains no publisher or
  copy algorithm.
- `environment-import.ts`: reviewable verify/state/proof/reverify/register
  transaction, state binding reader, disjoint input/state path projection,
  cancellation checkpoints, and explicit retained-state recovery location.
  The registration callback must commit atomically and idempotently; it must
  not activate a workspace or launch Runtime. Late cancellation cannot undo
  an already committed registration. Native proof is required at the exact
  final tool/Runtime paths and for the same Environment and state binding.
- `apps/cli/src/environment-host.ts`: Windows read-only filesystem and producer
  adapter. It checks ancestors and all entry reparse attributes before
  descending, checks link counts, streams file hashes, bounds JSON/process
  output, observes the publisher, and consumes bootstrap search roots.
  `inspectEnvironmentState` checks an existing state without overwriting it.
  Mutating producer operations are refused with `approval-required`.
- `apps/editor/src/environment-evidence.ts`: structured Output chronology and
  current Problems projection, including Environment root and member/JSON
  location. Late attempts cannot overwrite newer Problems; Output Clear does
  not mutate the diagnostic owner. The shell subscribes to this evidence
  store, but no production import command currently produces these events.

Environment semantics live in the GUI/CLI-shared toolchain client core, not
`shader-graph-core`: deployment protocols are a sibling domain of ordinary
ShaderGraph semantics. The CLI adds a workspace dependency on that existing
package. No graph semantics or native production policy moved.

### Read-only entry points

Run from the Editor repository root on Windows:

```powershell
node apps/cli/bin/shader-graph.js environment-discover D:/Grezzo/Ruisong/GraphicsGadgetLab --pretty
node apps/cli/bin/shader-graph.js environment-verify D:/Grezzo/Ruisong/GraphicsGadgetLab/Build/Output/EQ8/environment --profiles --pretty
```

Both return the existing CLI JSON envelope. Discovery returns all producer
candidates without selection. Verification returns the independently verified
manifest, `nativeReadiness: "unproven"`, and disabled import availability.
`--profiles` additionally reads the final hashed profile members and validates
them using `shader-graph-core`, without changing a document profile request.
Neither command initializes state, writes a registry, activates an Environment,
or performs native shader compilation/Runtime launch.

The proposal-level core is callable as `prepareEnvironmentImport(host, root,
stateRoot, cancelled, emit)`. Its host interface is an explicit seam for the
future approved production composition, not a durable registry implementation.
Its test hosts are synthetic and cannot establish native compatibility.

### Tests and qualification boundary

Tests read the main repository's actual `Tests/Environment/fixtures/index.json`,
manifest vectors, filesystem vectors, and process vectors directly. A missing
producer checkout fails these tests explicitly; vectors are not silently
skipped or copied. `GGLAB_ENVIRONMENT_FIXTURES` can point to another checkout's
fixture directory. The bootstrap test reads the corresponding source checkout.

The Windows host tests materialize synthetic vectors in disposable test roots
and exercise real hardlinks/junctions, malformed UTF-8, CLI failure envelopes,
and existing-state inspection. Transaction tests cover cancellation, identity
replacement during proof, wrong final executable location, retry, last-good
preservation, and lost state-initialization replies. Restart/retry coverage is
at the host-interface level; it is not evidence for an on-disk registry.

A read-only consumer check of all 299 members in the actual EQ8 final closure
succeeded (`sha256:50127ee6dcb1218bd29c8a115a35ef670872be00f4f1bca8386109854b34f34c`).
Both final Surface Profile v1/v2 descriptors passed core parsing and role checks. Real
bootstrap discovery returned Debug and Release candidates. Those checks are
consumer evidence of closure integrity and discovery only. Producer native
qualification remains historical evidence; no Editor DX12/Vulkan compile,
Runtime launch, Loaded observation, or last-good native recovery was executed.

### Remaining approval and implementation work

Owner review of the external publication contract is still required before
actual import is enabled. This change does not modify that contract or its
approval status. After approval, production work must still provide:

1. A narrow Tauri adapter with guarded publisher lifetime, publish/finalize
   reconciliation, and approved state initialization. The read-only Node
   adapter observes script bytes before/after execution but is not the native
   executable lock/launch proof used by `ShaderToolService`.
2. Durable atomic registration, startup recovery, and an explicit state reuse
   policy. Failed initialization/proof must preserve existing state; no automatic
   cleanup is implemented. A lost publish reply must trigger destination
   verification, never an assumption that no finalization occurred.
3. Actual final-location ordinary/Preview handshakes, descriptor validation
   through core, and Runtime observations using the existing authorities.
   The transaction's host proof receipt is not a replacement for those services.
4. Integration of the state path plan into the existing native service,
   including Runtime `--state-root`, state working directory/logs, and final
   `VK_LAYER_PATH`. Existing development-mode launch/build paths are unchanged.
5. Workspace activation through the Preview coordinator, with stop/await and
   revalidation; actual final-location DX12/Vulkan qualification.

Consumer resource limits additionally bound JSON nesting to 128 and filesystem
inventory to 10,000 directories / 30,000 entries; overflow is an explicit refusal.
Numeric JSON tokens with fractional/exponent syntax are refused rather than
silently reinterpreted as integer version fields. Windows PowerShell is used
only by the read-only Node host to obtain reparse attributes that Node lstat
alone does not expose. No machine tools were installed or reconfigured.


### Producer feedback: staging case-alias acceptance

A concrete producer defect was reproduced on Windows against `cbef1f80` using
only a disposable synthetic closure. `verify()` rejects a root spelled
`.staging-case` with `incomplete-publication`, but accepts the same physical
root when requested as `.STAGING-CASE`. No rename/finalization occurred.
The implementation uses case-sensitive `root.name.startswith(".staging-")`
after `abspath`, which preserves the supplied case spelling.

Reproduction: materialize the producer's `valid.json` and its documented
synthetic member bytes inside `.staging-case`; call the reference reader first
with that path and then with the uppercase spelling. Observed results:

```json
[
  {"pathSpelling":".staging-case","accepted":false,"code":"incomplete-publication"},
  {"pathSpelling":".STAGING-CASE","accepted":true}
]
```

This conflicts with the proposal's rule that staging names are unusable until
finalization. The Editor explicitly refuses the reserved prefix irrespective
of ASCII case and tests both spellings, including a real Windows alias. This
is a documented fail-closed consumer refusal, not compatibility evidence or a
silent workaround. The main repository must make staging checks consistent
with Windows identity, apply the same reservation to publication destinations,
and add regression vectors for both spellings before enabling Editor import.
The main implementation and external contract were not modified here.

### Executed Editor checks

- `pnpm typecheck`: passed.
- `pnpm test`: 933 tests passed (160 core, 235 toolchain client, 40 CLI, 498 Editor).
- `pnpm lint`: passed.
- `pnpm --filter @gglab/editor build`: passed; Vite reported dependency
  `use client` directive and bundle-size warnings. Generated output is ignored.
- `git diff --check`: passed. Neither sibling worktree was modified.

No Tauri desktop build, native DX12/Vulkan compilation, or Runtime qualification
was performed by this consumer change. The remaining approval gate and producer
staging defect above prevent treating these checks as completed import readiness.

## Registry persistence follow-up

The next consumer increment implements the Editor-owned durable record, Windows
Node storage, restart recovery, and read-only CLI registry inspection described
in [Environment registry persistence and recovery](environment-registry.md).
This supersedes the earlier statement that all registry tests use only an
in-memory host interface: actual filesystem persistence and two-process commit
coverage now exist. Production Tauri wiring, actual import/state creation,
workspace activation, and native qualification remain outstanding.

Main `cbef1f80` and the publication proposal were rechecked: the staging
case-alias defect and owner-review gate remain unchanged. Neither sibling
repository was modified.


## Guarded discovery follow-up

The main repository working-tree fix now rejects staging case aliases consistently.
The Editor consumes its new `staging-cases.json`, including three spellings of
one physical Windows directory. This supersedes the unresolved-defect status
above; the owner-review gate remains pending. See
[Guarded Environment discovery](environment-tauri-host.md) for the implemented
read-only Tauri boundary and its remaining integration limits.


## Review closure baseline

The current reproducible producer baseline is
`aa462d091e46f0cd5412ecc6564ce2cc393c369e`, not the historical `cbef1f80`
working-tree description. The case-alias fix does not close Windows 8.3 aliases:
a distinct short alias of the same staging directory is still accepted by the
producer. [Review closure](review-closure.md) records the failing qualification,
consumer canonical-path refusal, exact revisions, and remaining main-owner work.
