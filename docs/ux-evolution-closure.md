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
| 10 | Stop/await on target close/switch/Environment switch | Coordinator and Environment workflow tests; final native transition replay. |
| 11 | Reject superseded results | Ownership reducers and controller tests; audit complete correlation coordinates. |
| 12 | Repository/deployment import workflow | `environment-desktop-workflow.md` and desktop workflow implementation; replay first use. |
| 13 | Finalize/validate/prove before registering | Environment import/final-proof tests and evidence; pinned native replay required. |
| 14 | No source proof transfer | Final proof implementation/evidence; retain adversarial coverage. |
| 15 | Immutable Environment and separate state | Managed-state implementation/evidence; replay closure unchanged after authoring. |
| 16 | Separate manifest/tool/profile/host/observation authorities | Environment reader and proof implementations; review boundaries at final integration. |
| 17 | Source-independent normal operation | Existing isolated producer/native evidence; repeat final Editor flow without source lookup. |
| 18 | Multiple Environments and deliberate switch | Registry and activation workflow; replay coexistence and failure preservation. |
| 19 | Document profile persisted and explicit | Core edit/profile resolution and Environment binding; replay two profile lines. |
| 20 | Loose configuration separate from Environment | Authoring binding gates exist; loose tool paths are now an explicit Advanced global surface, hidden while an Environment owns locations. |
| 21 | Selection-oriented right Inspector | Selection-only panel implemented; node/connection editing and contextual current problems have behavioral coverage. Global Document/Profile/Advanced dialogs and Bottom Panel Build/Preview details replace the old zones. Visual replay remains. |
| 22 | Direct node values via core operations | Inline Float/Float2/Float3/Float4 editing in `7c56fd1`; shared Inspector draft logic, document-scoped drafts, same core edit/history path. Runtime parameters remain inputs, not graph defaults. Visual/integrated replay still required. |
| 23 | Output/Build/Preview chronology vs current Problems | Bottom Panel and evidence projection tests; review legacy local note surfaces. |
| 24 | Problem source and document ownership | Owner-bound evidence origins and Problems tests; replay navigation after tab/revision changes. |
| 25 | Clear is presentation-only | Bottom Panel tests; retain state after clear in final scenario. |
| 26 | Semantic directories and correct persistence owners | Host-owned primary dialog histories and explicit last-Workspace re-admission implemented; layout persistence is now implemented; all existing file-dialog purposes now have separate history; safe session intent implemented in `3830de0`; desktop restart replay remains. |
| 27 | Responsive state/action/event hierarchy and semantic colors | Open: current shell still uses the old blue accent; complete Graphite/Iris roles, overflow and layout validation. |
| 28 | Safe restart, detached, no restored Current | Explicit last-Workspace re-admission implemented with no live proof restoration; safe tabs/target/Environment intent implemented in `3830de0`; desktop restart acceptance remains open. |
| 29 | No generic native authority | Narrow Tauri commands and existing Environment host; retain command-boundary review. |
| 30 | Reviewed GGLab-owned publication contract | Existing import approval and pinned producer records; preserve contract/revision provenance. |
| 31 | Both native backends remain qualified | `color-study-preview-sample-evidence.json` records Debug/Release DX12/Vulkan Loaded at the baseline; replay relevant native gates after remaining integration changes. |

## Remaining execution order

1. Finish direct constant editing, including document isolation, shared history,
   graph gesture isolation, node geometry and actual rendered interaction checks.
2. Complete host-backed semantic dialog directories and safe Workspace resume
   intent; restore no native handles, executable proof or Runtime Current claim.
3. Move global configuration and detailed native state into their appropriate
   global/Bottom Panel surfaces; keep the right Inspector selection-oriented.
4. Complete theme roles, responsive global actions, collapse/resize preferences
   and keyboard/accessibility polish against ordinary desktop sizes.
5. Run every acceptance scenario against the final tree, retain exact Editor and
   producer provenance, repeat affected native regression gates, and record gaps
   explicitly. Owner review remains a review of concrete implementation/evidence.

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
