# Workspace Environment authoring integration

The application now consumes the persistent Environment host through
`use-environment-authoring.ts`. An already selected Workspace Environment drives
ordinary tool discovery/handshake, Preview build/process controllers, and profile
resolution. The subsequently implemented menu workflow is documented in
[Desktop Environment import workflow](environment-desktop-workflow.md). The
verification section below records the historical binding-integration scope;
current acceptance gaps are tracked in [UX closure](ux-evolution-closure.md).

## Ownership and calling path

The guarded activation transaction still owns `WorkspaceSession.activeEnvironment`.
The application passes that selection and the live WorkspaceStore to
`useEnvironmentAuthoring`. The hook reopens the exact registered roots, verifies
registration equality, and opens the existing strict authoring host. It does not
accept a registry record as Ready/Current or activate a selection itself.

`createWorkspaceEnvironmentBinding(invoke, selection, isSelected, backend)` owns
one NativeBuildFlow, PreviewBuildController and AttachedPreviewRuntimeManager.
The two application hooks consume those same instances. Runtime stop/exit and
host shutdown finish before another binding is installed. A failed close retains
the owner for retry and blocks both replacement and fallback to legacy discovery.
The existing Re-discover action retries unavailable Environment initialization.
Changing backend requires the Preview build to finish and Runtime to stop first.
The native toolchain continues to own the actual target policy.

The optional `environment` inputs on `useNativeBuild` and `useShaderPreview` use
three explicit cases: omitted selects the legacy path, null blocks host admission,
and a current binding selects its owned controllers. During Environment changes,
the first render hides old native readiness. Coordinator gates additionally read
the live Workspace selection and binding, covering changes before React renders.
A late publication from a previous flow cannot auto-launch the replacement Runtime.
Unproven Runtime ownership is never converted into a no-Runtime fact.

Each document resolves its exact requested profile through the core-backed host
resolver. The editing tab, explicit Preview target, and each document in Problems
can therefore use different profile lines. Retarget resolves the current target's
descriptor inside the final synchronous Workspace commit. Manual descriptor
completions are ignored while an Environment is selected; the descriptor panel
shows the Environment instance with file loading disabled. Legacy executable-path
inputs are likewise disabled in Environment mode.

Build/Preview sessions remain retained as previous chronology sessions when their
binding changes. They are not fed into current Problems or Runtime projections.
Initialization and cleanup failures use the existing structured Environment
Output/Problems evidence channel. No compiler, backend policy, material ABI,
renderer, persisted graph contract or native toolchain process wire was added.

## Verification and limits

[Evidence](environment-workspace-authoring-evidence.json) records the producer
revision, Editor base revision and review source hashes. Native qualification ran
on 2026-09-10; the final hook/UI regression gates ran on 2026-09-11. The working tree
was not committed by the agent and is not represented as a clean Editor revision.

Synthetic React tests cover late admission, failed-close retry, blocked legacy
fallback, shared controller ownership, backend replacement refusal, readonly
profile presentation, cross-profile retarget/Problems, and an old build delivered
after selection changes. They are not native compatibility evidence.

The actual import qualification now opens registered bindings through the real
Rust registry/execution services and the same controller factory used by the hooks.
For Debug and Release, both DX12/Vulkan and Surface v1/v2 pass ordinary handshake,
Preview handshake, controller/coordinator publication and Runtime Loaded observation,
then strict shutdown. The existing import, duplicate import, cancellation and
activation proof checks still run. These are controller integration runs; they do
not drive the desktop menus or claim native old-to-new Environment switching.

To repeat for each configuration, follow the Environment import qualification
setup, including a fresh independent test registry root, and set:

```powershell
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '1'
$env:GGLAB_ENVIRONMENT_SOURCE = '<clean Main checkout at the pinned SHA>'
$env:GGLAB_ENVIRONMENT_IMPORT_QUALIFICATION = '1'
$env:GGLAB_ENVIRONMENT_ACTIVATION_QUALIFICATION = '1'
$env:GGLAB_PROOF_ENVIRONMENT = '<final Environment root>'
$env:GGLAB_PROOF_STATE = '<independent writable state root>'
$env:GGLAB_REGISTRATION_ROOT = '<fresh test registry directory>'
$env:GGLAB_IMPORT_REPORT = '<report JSON path>'
pnpm --filter @gglab/editor test src/environment-import-host.test.ts
```

Main remained read-only. Its existing pinned builds/published closures were reused;
no fresh Main build, Main self-test suite or extra validation-layer log qualification
was performed. Full desktop acceptance, the import menu, native switching between
two Environments, and clean committed replay remain future gates. Rust production
code is unchanged in this increment; only the explicit test bridge gains the
existing registry-open command. The existing large web-chunk build warning remains.
