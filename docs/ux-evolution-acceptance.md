# Workspace UX acceptance replay

Status: executable acceptance checklist; results are **not yet recorded**.
This is an evidence procedure for the 31 acceptance items in section 15 of the
sibling Workspace And UX Evolution Guidance, not an additional specification.
Implementation and automated evidence are indexed in [the closure tracker](ux-evolution-closure.md).

## Record the actual run

Record date, Editor commit and dirty status, producer commit, desktop build mode,
window dimensions/display scale, EnvironmentId, executable observations, backend,
state root, and the outcome of each scenario below. Capture structured Output,
Build, Preview and Problems evidence when a scenario involves native work.
A screenshot demonstrates presentation, not native compatibility or identity.

Current automated native evidence is a working-tree run based on Editor
3ecb28abf975237ad961392eb544bed95f587d7d and clean producer
0a4ce8f26e39fb8740758e4eb275db9d2fe619ec. It is not a clean committed replay.
The descriptor picker lifecycle correction followed that native source snapshot.
Do not attach a later Editor SHA to those historical observations.

Use a disposable content Workspace and independent test state/registry. Copy the
first-party surface-texture-preview and surface-color-study-preview fixtures
there, including a nested folder and a second file with identical graph bytes.
Do not edit golden fixtures, an immutable Environment or ordinary user content
while exercising conflicts and failures. Keep at least two documents open when
testing target close; the shell deliberately retains its last document tab.

## Workspace and document identity (items 1-6)

1. Choose the content folder as Workspace. Wait for discovery to settle. Open
   both nested and top-level shadergraphs from Explorer without further pickers.
2. Open the same physical file through another host-canonical spelling. Expect
   the existing tab. Open the byte-identical copy at another file identity.
   Expect a separate tab even though graphId and generated HLSL match.
3. Give each document distinct selection, viewport and edits. Switch repeatedly;
   each must retain its own state and undo/redo history. Saving one must not clear
   the other's dirty marker or change the other file.
4. Modify a disposable file externally after opening it, then try Save. Require
   a conflict/refusal rather than overwrite; recovery must be explicit. The
   missed-watcher race and root-escape invariant additionally require the host
   CAS/containment tests; ordinary UI timing cannot establish those guarantees.

## Authoring surfaces and keyboard (items 3, 19-22, 27)

1. Switch Explorer/Nodes, document tabs and Bottom Panel tabs using arrows and
   Home/End. Confirm visible selection and focus move together. Tab through
   close/actions separately and verify readable focus markers.
2. Select a node and a connection. Check that the right Inspector follows that
   selection while global Document/Profile/Advanced settings stay separate.
3. Edit a constant inline and through Inspector, then undo/redo. Both paths must
   produce the same authored value; typing must not drag, delete or reconnect
   nodes. Invalid drafts must not silently change persisted graph values.
4. In Profile, inspect the document request before selecting another catalog
   entry. Selection alone must not change it. Apply a compatible choice, save,
   undo/redo and reload. A second document must retain its original request.
   A refused migration must expose core diagnostics and preserve the document.
5. In Environment mode, verify loose executable/descriptor overrides cannot
   replace admitted locations. In loose mode, cancel and retry descriptor file
   selection; no stale result may appear after dismissal or Environment entry.
6. Check ordinary desktop sizes (for example 1440x900 and 1024x768) and the user's
   normal scale. Global actions, collapsed rails and resized Bottom Panel must
   remain usable without covering the Canvas. Check modal focus/return and
   long file paths. Record actual sizes and any inaccessible control.

## Preview ownership and evidence (items 7-11, 23-25, 31)

1. Preview the color study on DX12. Require native build publication and a Runtime
   Loaded observation. Switch editing tabs; the target marker and Runtime must
   remain attached to the explicit target, not the active tab.
2. Preview the identical graph in the other document. Require old Runtime exit,
   a new session identity, a new publication and a new Loaded observation.
   Previous chronology may remain; it must not become the new Current state.
3. Close the target with another document open. Require stop/await, no target,
   no automatic launch of the remaining tab and no reuse of an old publication.
4. Cause an invalid graph/build in disposable content after a successful Preview.
   Require explicit failure/stale/last-good reporting. Recover the graph and
   build successfully; distinguish new observation from historical success.
5. Navigate a located Problem, switch/revise its owner, and navigate again.
   No Problem may jump to an unrelated same-named node in another document.
   Check one stable Problem per current identity, while Build/Preview retain
   history. Clear each evidence view and verify it does not erase actual state
   or fabricate success. Repeat native ownership checks for Vulkan.
6. Late-result rejection also requires controlled controller/host tests: a fast
   successful manual click sequence alone does not exercise supersession races.

## Environment admission, coexistence and independence (items 12-18, 20, 29-30)

1. Import through one repository selection and explicitly choose a deployment.
   Verify final-location proof finishes before usable registration/activation.
   Try cancellation and retry. Preserve the previously usable Environment on
   failure; do not automatically delete state created by an interrupted attempt.
2. Import a second Environment and switch deliberately with a live Preview.
   Require old Runtime exit, cleared old proof, and fresh readiness for the new
   selection. Both registrations must remain available.
3. Exercise Import published Environment and state without a publisher selection.
   Normal authoring must resolve the admitted Environment, never sibling source
   paths. A source-unavailable replay must use a disposable source mirror made
   unavailable after publication; do not rename or deny access to the real Main
   checkout. Record the isolation method and its limits.
4. Verify each closure with the pinned producer after authoring. EnvironmentId,
   manifest member hashes and immutable files must remain unchanged; generated
   work belongs to independent state roots. Main-owned negative fixtures,
   executable-observation tests and protocol review remain required evidence for
   authority boundaries that are not observable from screenshots.

## Restart and semantic locations (items 26, 28)

1. Open two files, select different active and Preview-target tabs, choose an
   Environment and backend, and adjust layout. Save intended content explicitly.
2. Exit and restart the desktop application. Reopen the saved Workspace through
   host admission and use Restore saved session. Verify fresh directory/file
   reads, separate tabs and intended selections; no Runtime handle, old build
   readiness, Loaded observation or Current claim may be restored from settings.
3. Verify saved Environment intent requires fresh Verify and use when necessary.
   Start a new Preview and require its own handshake/publication/observation.
4. Exercise Open, Save As and advanced descriptor dialogs independently. Each
   uses its own semantic directory history, while Save retains the document's
   canonical file authority and CAS token. Cancel must not create a write.

## Completion record

For each scenario record PASS, FAIL or NOT RUN, exact observations and artifact
locations. A FAIL becomes a reproducible issue; NOT RUN stays open. Keep automated
race/protocol evidence separate from UI observations. Before claiming clean
closure, replay required gates on the actual reviewed clean Editor and pinned
Main revisions; the current dirty working tree cannot supply that claim.
