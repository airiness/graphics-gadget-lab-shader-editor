# Workspace and UX evolution closure

This is an implementation/evidence tracker, not a replacement specification.
The product requirements remain in the sibling docs repository:
`GGLab_Shader_Editor_Workspace_And_UX_Evolution_Guidance.md` (v0.5), especially
sections 4-12 and the 31 acceptance items in section 15. Editor architecture
remains in `GGLab_Shader_Graph_Editor_Architecture.md`.

Review baseline: Editor `3d63f83` (2026-09-12). Inline constant editing was
implemented in `7c56fd1`. The complete UX evolution objective is **not closed**.
Existing code and historical qualification are starting evidence, not automatic
proof of every acceptance scenario on the completed application.

## Acceptance inventory

Numbers refer to section 15 of the guidance. "Replay" means implementation
exists but final integrated acceptance still needs verification. "Open" includes
missing implementation or evidence too weak to establish completion.

| Item | Requirement | Current evidence / remaining work |
| --- | --- | --- |
| 1 | Workspace browsing | `workspace-discovery.ts`, Explorer in `app.tsx`; replay realistic nested Workspace. |
| 2 | Narrow host discovery/read/CAS/observation | `workspace_io.rs` and Workspace tests; replay containment and save races. |
| 3 | Explorer/Nodes separation | Activity switching in `app.tsx`; replay keyboard and narrow-window access. |
| 4 | Independent document session state | `document-session.ts`, `workspace-store.ts` and tests; replay two-document editing and evidence. |
| 5 | Canonical file identity, distinct same-graph files | Workspace host/session tests; final desktop replay required. |
| 6 | External change cannot be overwritten | Host CAS and Workspace tests; verify conflict/reload UX and missed-observation race. |
| 7 | Active tab differs from Preview target | `preview-coordinator.ts` and session tests; replay while Runtime is attached. |
| 8 | Explicit visible Preview target | Tab marker and Preview-this-graph action; replay Explorer/status discoverability. |
| 9 | One Runtime and identical-HLSL isolation | Coordinator ownership tests; retain native regression in final replay. |
| 10 | Stop/await on target close/switch/Environment switch | Coordinator stops/awaits Runtime, clears the closed target, and rotates session identity on ownership changes. Unit regressions cover late results and stale UI calls; native transition replay remains open. |
| 11 | Reject superseded results | Ownership reducers and controller tests; audit complete correlation coordinates. |
| 12 | Repository/deployment import workflow | `environment-desktop-workflow.md` and desktop workflow implementation; replay first use. |
| 13 | Finalize/validate/prove before registering | Environment import/final-proof tests and evidence; pinned native replay required. |
| 14 | No source proof transfer | Final proof implementation/evidence; retain adversarial coverage. |
| 15 | Immutable Environment and separate state | Managed-state implementation/evidence; replay closure unchanged after authoring. |
| 16 | Separate manifest/tool/profile/host/observation authorities | Environment reader and proof implementations; review boundaries at final integration. |
| 17 | Source-independent normal operation | Existing isolated producer/native evidence; repeat final Editor flow without source lookup. |
| 18 | Multiple Environments and deliberate switch | Registry and activation workflow; replay coexistence and failure preservation. |
| 19 | Document profile persisted and explicit | Explicit document Profile selection now uses the admitted catalog and core set-profile command, with history and isolation tests; native replay of both lines remains. |
| 20 | Loose configuration separate from Environment | Authoring binding gates exist; loose tool paths are now an explicit Advanced global surface, hidden while an Environment owns locations. |
| 21 | Selection-oriented right Inspector | Selection-only panel implemented; node/connection editing and contextual current problems have behavioral coverage. Global Document/Profile/Advanced dialogs and Bottom Panel Build/Preview details replace the old zones. Visual replay remains. |
| 22 | Direct node values via core operations | Inline Float/Float2/Float3/Float4 editing in `7c56fd1`; shared Inspector draft logic, document-scoped drafts, same core edit/history path. Runtime parameters remain inputs, not graph defaults. Visual/integrated replay still required. |
| 23 | Output/Build/Preview chronology vs current Problems | Bottom Panel and evidence projection tests; review legacy local note surfaces. |
| 24 | Problem source and document ownership | Owner-bound evidence origins and Problems tests; replay navigation after tab/revision changes. |
| 25 | Clear is presentation-only | Bottom Panel tests; retain state after clear in final scenario. |
| 26 | Semantic directories and correct persistence owners | Host-owned primary dialog histories and explicit last-Workspace re-admission implemented; layout persistence is now implemented; all existing file-dialog purposes now have separate history; safe session intent implemented in `3830de0`; desktop restart replay remains. |
| 27 | Responsive state/action/event hierarchy and semantic colors | Graphite/Iris roles, independent info/verdict colors, wrapping global actions and narrower desktop columns implemented; actual rendered overflow and keyboard acceptance remain open. |
| 28 | Safe restart, detached, no restored Current | Explicit last-Workspace re-admission implemented with no live proof restoration; safe tabs/target/Environment intent implemented in `3830de0`; desktop restart acceptance remains open. |
| 29 | No generic native authority | Narrow Tauri commands and existing Environment host; retain command-boundary review. |
| 30 | Reviewed GGLab-owned publication contract | Existing import approval and pinned producer records; preserve contract/revision provenance. |
| 31 | Both native backends remain qualified | `color-study-preview-sample-evidence.json` records Debug/Release DX12/Vulkan Loaded at the baseline; replay relevant native gates after remaining integration changes. |

## Remaining execution order

The direct values, persistence, shell surfaces, theme, keyboard, explicit Profile
and Preview ownership changes below are implemented. They are not future coding
steps. Remaining work is acceptance and any corrections that acceptance reveals:

1. Execute [the UI and restart replay](ux-evolution-acceptance.md), recording
   actual outcomes for Workspace identity/save conflicts, independent editing,
   profile migration, Preview transitions, Environment coexistence and layout.
2. Retain controlled tests for races and authority boundaries that a normal UI
   walkthrough cannot prove. Current working-tree native runs cover both
   configurations/backends and identical-graph owner transitions.
3. Replay on the actual reviewed clean Editor and pinned producer revisions.
   Current changes remain uncommitted and cannot establish clean replay.
4. Close each of the 31 inventory items only with matching evidence. In
   particular, native Loaded does not prove desktop focus or safe restart UX.

On 2026-09-13 the existing local development server was listening on port 5173,
but Computer Use reported a missing native pipe and browser inventory was empty;
creating an in-app browser failed as unavailable. GUI execution therefore needs
restored UI tooling or owner-run acceptance. No user window was manipulated.

No new graph parameter defaults, compiler, material ABI, renderer, or Environment
contract is introduced by this work. Main/docs repositories remain read-only.

## Inline editing verification

The inline editor delegates to the same `setConstantValue` adapter and core
`applyGraphEdit` operation as the Inspector. Draft state is keyed by document
session; the Inspector also remounts across sessions to prevent same-node-ID
text drafts from leaking across documents. Numeric parsing rejects non-finite
values before submission. Unknown/Runtime parameter nodes have no invented
editable default. Port positions remain unchanged, with constant footer sizes
included in automatic layout.

Component regression coverage includes vector submission, rejected/local drafts,
Escape, other-surface updates, document-key replacement, and canvas gesture
isolation. Actual browser/desktop visual verification is outstanding: the UI
connector reported no available browsers or apps in this execution environment.
The native compiler/Preview process contracts are unchanged; no new native
qualification is claimed for this presentation change.

## Navigation preference implementation

See `application-preferences.md` and `application_preferences.rs`. Host-owned
semantic dialog histories and explicit Workspace reopen now have implementation
and regression coverage. This does not close all persistence or restart criteria:
layout, auxiliary dialog history, and safe document/Environment intent remain work.

## Layout preference implementation

Host-backed layout persistence now covers the active sidebar activity, panel
visibility, and Bottom Panel view/height. Hydration and writes preserve user
interaction ordering and reject unknown/native state. This closes the layout
storage implementation portion of items 26/27; rendered restoration, responsive
visual polish and full safe Workspace/session resume still require completion.

## Auxiliary selection implementation

Descriptor, tool executable and build-output selection now have host-owned
semantic histories, fixed selection purposes and no arbitrary frontend dialog
options. Only a selected descriptor receives single-file read scope. The generic
WebView open-dialog permission has been removed. Actual native dialog navigation
remains part of final desktop acceptance.


## Safe session intent implementation

Explorer now offers explicit restoration of host-backed per-Workspace tab,
active-tab, Preview-target, Environment and build-target intent. It re-discovers
and reads files, preserves already-open edits, reuses the existing Environment
verification workflow and never serializes native truth. Interrupted restoration
retains the previous saved intent for retry. See `application-preferences.md` for
the bounded host contract and recovery behavior.

This implements the safe persistence portion of restart acceptance. A full desktop
restart with an actual registered Environment and fresh Preview observation is
still outstanding. Selection-only Inspector/global engineering panel placement,
semantic theme and responsive visual acceptance remain separate closure work.


Verification for the session-intent working tree based on `e6055ef`:
`pnpm typecheck`, `pnpm test` (1,026 passed; nine explicit opt-in skips),
`pnpm lint`, Editor Vite build and `git diff --check` passed. Rust library tests
passed 74 checks with three explicit native opt-in skips. No Main revision was
modified or newly qualified; this is implementation regression evidence, not the
final clean cross-repository or desktop acceptance replay.


## Selection and global surface implementation

The right Inspector now always presents the selected node or connection and its
current attributable problems. It does not contain graph-wide configuration,
text import/export, emission or native lifecycle sections. Global actions expose
Document, Profile and Advanced configuration dialogs, file actions, target choice
and Preview entry. Build/Preview Bottom Panel views retain chronology and provide
expandable current facts and advanced controls. Hiding/collapsing these surfaces
never resets their controllers or evidence. Loose tool configuration remains
separate from an active imported Environment.

Behavior tests uncovered an existing selection regression: the node setter already
cleared the edge selection, but calling the edge setter with null immediately
cleared the node again (and vice versa). A single exclusive update now preserves
the requested target. Node-menu selection uses one atomic presentation patch.
Coverage includes a real React Flow node click, contextual node/connection display,
connection/node deletion and Undo, modal cancellation and document-text drafts,
and opening the appropriate evidence view with the Inspector collapsed.

Typecheck, the root test suite (1,027 passed; nine opt-in skips), lint and Editor
build are the implementation gates for this change. Native contracts and Rust
code are unchanged. Actual visual acceptance remains open: the computer-use
runtime returned `native pipe is unavailable` and CUA returned no browsers/apps.
These failures are recorded as missing visual evidence, not as product failures
or successful desktop acceptance. Theme/responsiveness and the full integrated
acceptance replay remain required work.


## Semantic theme implementation

Graphite surface/text tokens and Iris interaction tokens now own shell colors.
Information, success, warning and error have independent roles; Preview target and
open-file markers use interaction color, not success. Failed evidence and error
Problems use the error token (including correction of an undefined `--err`
fallback). Graph type/category hues retain their authority. Edge neutral/mix
colors, foreground ink and dialog scrims are centralized as tokens.

Global actions/header wrap, metadata can wrap, the status strip can scroll, and
side columns narrow below 1100 pixels without changing saved collapse preferences.
Reduced-motion preferences suppress incidental transitions. CSS color checks
require a 4.5:1 minimum for all small-text semantic roles on each shell surface;
this is measured token evidence, not a rendered accessibility audit. Typecheck,
root tests (1,030 passed; nine opt-in skips), lint, Editor build and diff check
passed. Full visual/keyboard/desktop acceptance remains outstanding.

## Preview ownership closure

Guidance section 12.4 requires target close to clear Preview target and live
ownership. The reducer now clears the target without an active-tab fallback.
Only the first open in an empty Workspace seeds initial intent; opening another
tab after a target close leaves ownership unset until an explicit Preview action.

After proven Runtime teardown, a different target or target close rotates the
Preview session identity. Settled attempts remain in chronology; publication,
launch candidate, handshake and observation state do not transfer. Late
handshakes and observations cannot populate the new session. No-target
composition is explicitly unavailable and stale UI calls cannot launch an old
publication. Regression coverage includes different document owners sharing the
same graph object, failed close revision checks, and unproven Runtime exit.

These are controller and React integration regressions using fake process hosts,
not fresh native Runtime or rendered desktop acceptance evidence. Full native
transition and desktop restart replay remain outstanding.

Verification: root typecheck, tests (1,035 passed; nine opt-in skips), lint,
Editor production build and git diff check passed. The production build reports
third-party module directive and bundle-size warnings. No native or Rust code
changed in this ownership correction; native qualification was not rerun.

## Keyboard tab navigation

Open-document tab semantics now belong to the focusable label button, with the
close action outside that tab. Document actions are outside the tablist. The
sidebar, documents and Bottom Panel use one keyboard adapter for arrows and
Home/End: focus and activation move together, selection wraps, and modified keys
remain available to platform shortcuts. Only the selected tab is a sequential
keyboard stop in each set. Existing activation intents retain document and
Preview ownership; navigation introduces no semantic edit.

React integration tests exercise focus, selection, wrapping, modifier handling,
and two-document navigation without moving the Preview target. These tests do
not establish native desktop focus or screen-reader acceptance.

Keyboard change verification: root typecheck, tests (1,038 passed; nine opt-in
skips), lint, Editor build and diff check passed. Native/Rust gates were not
rerun for this frontend-only change.

## Explicit document profile choice

The Profile dialog projects the active document request and admitted Environment
catalog. Selection alone is not a mutation. Apply invokes core set-profile with
the selected descriptor, records an accepted change in that document history,
and invalidates derivative emission. Core refusal leaves document/history
unchanged and exposes structured diagnostics in the dialog and Output. Attempted
migration diagnostics are not substituted for the current graph Problems set.

Environment host catalogs are available only after admission, copied on read,
and unavailable after closure. Loose development offers only its loaded
descriptor. No descriptor path picker is needed in Environment mode, and neither
catalog admission nor Environment selection upgrades a document implicitly.

Regression coverage exercises explicit application, undo/redo, serialized profile
persistence, another document retaining its profile, and visible core refusal.
These tests do not replace native compatibility or Runtime load evidence.

Profile verification: root typecheck, tests (1,041 passed; nine opt-in skips),
lint, Editor build and diff check passed. Rust library tests passed (74 passed,
three ignored). The strengthened two-document GUI test also passed separately.
Final-position native ownership qualification is being tracked separately.

## Final-position native ownership replay

See [working-tree evidence](ux-evolution-native-evidence.json) for producer SHA,
Editor base revision, changed source hashes, exact execution identities and
observations. The Editor tree is uncommitted; this is not a clean committed replay.
Both Debug and Release completed real import/activation, ordinary and Preview
handshakes, native publication, and eight authoring Loaded observations each.
Each configuration covers DX12/Vulkan, profile v1 and two v2 samples. The color
study additionally switches to a distinct document owner with identical graph
content on each backend, proving stop/await, fresh session identity, old-input
refusal and a new publication reaching Loaded. DX12 target close proves cleared
ownership after teardown. Registered Environment reuse also passed after a loaded
Vulkan Preview. Producer verification after the runs accepted both unchanged
immutable closures. Each run used fresh separate writable state and registry.

Main builds and published closures were reused from the pinned clean producer;
Main self-tests, a new validation-layer audit and source-access denial were not
rerun. Desktop connection recheck failed with native-pipe os error 2. Actual
rendered UI and restart acceptance therefore remain open, as does clean committed
replay. Native success does not close those separate acceptance items.

## Descriptor file read lifecycle

Loose descriptor file reads now capture and reset the browser input before
awaiting text, so React event release cannot cause a post-read exception and the
same file can be selected again. Browser IO failures use the existing structured
rejection state. Newer reads (including cancelled native picks), readonly
Environment admission and component unmount invalidate previous completions.
This closes an asynchronous configuration race; it does not change descriptor
semantics or native admission contracts.

Regression tests cover browser success/retry, IO failure, cancelled-newer-request
supersession, readonly transitions and late failure after unmount. This frontend
change postdates the native evidence snapshot above; its tests are separate from
native and rendered desktop acceptance.

Descriptor lifecycle verification: root typecheck, tests (1,045 passed; nine
opt-in skips), lint, Editor build and diff check passed. Native gates were not
rerun for this file-picker lifecycle change.

## Owner acceptance: node action menu

The owner reported that the node header dropdown could not be used. The real
React Flow regression reproduced a missing menu: the chevron opened it, then
its click bubbled to the card selection handler which dismissed it. The button
now isolates pointer/mouse and click intents and carries the adapter's nodrag
and nopan classes. A real-node integration test covers open, Delete Node and
Undo; a direct menu-callback test alone did not cover the event route.
The automated regression passes after the fix; owner desktop retest is pending.
