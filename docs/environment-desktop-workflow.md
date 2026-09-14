# Desktop Environment import workflow

The header's **GGLab Environment…** action opens the desktop import surface.
It implements the approved Environment v1 integration scope documented in
`../../GraphicsGadgetLabDocs/GGLab_Environment_Publication_Approval.md`.

- **Import from Repository…** selects a publisher through native bootstrap
  discovery. Each returned deployment has its own **Publish and use** action;
  no Debug/Release candidate is selected implicitly. The existing publisher
  creates the immutable Environment and its independent writable state.
- **Import published Environment and state…** selects two existing directories.
  This route requires no source repository and never initializes or overwrites
  the selected state.
- **Verify and use** opens a saved registry binding and reruns final-location
  verification. Registry records never restore native readiness by themselves.
- **Recover publication or state operations** lists durable host-owned intents.
  Rechecking a complete target needs no publisher. An incomplete target can be
  retried with the original publisher through **Retry with original publisher…**.
  Publisher path/hash admission remains enforced by the existing mutation host.

`apps/editor/src/environment-workflow.ts` composes the existing discovery,
mutation, storage and activation hosts. It introduces no publication protocol,
state layout or persistent registry format. `environment-panel.tsx` presents
that session workflow; `environment-probe-documents.ts` constructs core-authored
in-memory probe graphs. Probe source alone is not native compatibility evidence.

Every attempt admits one operation at a time and captures the Workspace root
and selected Environment. A changed context or cancellation prevents activation.
Durable publish/state operation IDs and selected state survive same-session
failures. Restart recovery reuses a matching state intent; multiple matching
intents require explicit state selection. Existing registration at another root
is a conflict, with its registered entry available for explicit reuse. There is
no automatic deletion, migration, replacement or choice of a newer state.

Activation owns the Preview transition lease. It stops and joins the previous
Runtime before invoking final-location proof, which launches its own Runtime.
It retains the final teardown/revalidation before the atomic Workspace commit.
A failed proof can therefore leave Preview stopped, while preserving selection,
document edits, registrations, state and last-good evidence. Selecting an
Environment is followed by the authoring host's independent current readiness
checks. Discovery and saved registration are not displayed as Ready.
If proof cleanup cannot confirm process exit, retry first repeats cleanup on the
retained execution; it does not create a replacement proof owner.

Progress and structured failures feed the existing Environment Output/Problems
projection. The dialog prevents source changes and dismissal during an attempt,
while keeping cancellation available. Browser mode explicitly requires the
desktop application for import.

## Verification scope

See `environment-desktop-workflow-evidence.json` for the exact working-tree
baseline and commands/results. The native registered-reuse qualification uses
real directory observations, registry, final-location compilation, Runtime
Loaded observations and activation. Its mutation journal listing is deliberately
an empty test adapter: this does not qualify the repository publication route or
native file-picker interaction as a combined desktop end-to-end operation.
Synthetic workflow tests cover candidate selection, publication/state sequencing,
cancellation, interrupted state recovery, ambiguous states and proof retry.
Synthetic UI tests cover explicit candidate actions and busy/cancel controls.

The native invocation is documented in
[Workspace authoring integration](environment-workspace-authoring.md). Use a
clean checkout at `tests/environment-producer-baseline.json`'s exact revision,
its qualified final Environment and state, and a fresh registration root for
each Debug/Release run. Set both import and activation qualification flags.
The test now also invokes the registered-reuse workflow while the preceding
Vulkan Preview has a Loaded observation. No source deployment proof is reused.

Manual desktop acceptance still includes the directory pickers, repository
publication end to end, dialog layout/focus, and cancellation through the visible
UI. Existing Vite dependency-directive and bundle-size warnings remain.
