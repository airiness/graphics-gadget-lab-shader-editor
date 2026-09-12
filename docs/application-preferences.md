# Host-backed application navigation preferences

The desktop host stores `application-preferences.json` under Tauri's application
data directory. `preferencesVersion: 1` is local application-storage versioning,
not a graph, Environment, or native process contract. The WebView cannot select
this file's location or write stored directory paths.

The host-owned dialogs remember separate locations for Workspace, graph Open / Save
As, GGLab source repository, published Environment, and writable state selection.
A cancelled dialog does not update history. Directory hints are canonicalized;
missing directories are omitted from the next dialog. Descriptor overrides, loose
tool executable selection, and loose build-output selection each use independent
host-owned histories as well.

Writes acquire an OS-released file lock, re-read the current file, and atomically
replace it using a private sibling file. Concurrent windows cannot lose another
operation's history through a read/modify/write race. A busy lock produces an error
rather than waiting indefinitely. Corrupt, oversized, unknown-field or unsupported
version files are rejected and preserved, not overwritten with defaults. Preference
errors propagate through the existing structured operation/error surfaces. A failure
occurs before document Open/Save As IO, so a successful save is never reported as a
preference failure after the fact. No preferences directory is a graph or Environment
payload location.

Explorer's **Reopen last Workspace** calls `shader-workspace-reopen-last` with no
arguments. The host looks up only its remembered Workspace location and passes it
through `WorkspaceFileService::register_selected_root` again. The Editor then uses
its normal discovery/cancellation flow with the fresh host capability. A missing
root reports that no previous Workspace is available. It never restores cached
file tokens, Runtime processes, native compatibility proof, or a Current claim.
This reopens Workspace context. The separate explicit session restore below
re-admits saved document and Environment intent.

Verification covers independent histories across store instances, unavailable
locations, lock contention/recovery, corrupt/versioned data preservation, and the
no-path frontend reopen request. Native dialog navigation and full desktop restart
remain UI acceptance scenarios; unit tests do not stand in for those observations.

## Layout preferences

`shader-editor-read-layout` and `shader-editor-save-layout` read/write only a
validated layout projection: library/Inspector/Bottom Panel visibility, Bottom
Panel height and view, and the active Explorer/Nodes activity. They accept no
storage location, native path, graph document, Runtime state or compatibility
claim. Layout is an optional field of the version 1 application preference file;
existing files without it retain the default layout until the user changes it.

The host constrains persisted Bottom Panel height to 96-480 pixels. The existing
responsive layout continues to clamp its effective size against the actual Canvas
space on restoration and window resize. Layout writes preserve the independent
directory histories under the same host lock and atomic file replacement.

`bindLayoutPreferences` waits for startup hydration, keeps local interactions that
occur while the read is pending, coalesces drag changes, serializes writes, and
flushes the final observed state on normal component disposal. A failed read never
causes defaults to overwrite unreadable settings. Read/write failures go to
structured Output. Abrupt process termination before an outstanding write settles
may lose the newest layout adjustment; it cannot promote any persisted Runtime
claim. Saving failures retain the last successful layout and can be retried by a
subsequent layout change.

The regression suite checks hydration ordering, superseded readers, write order,
final flush, unknown data rejection, and coexistence with semantic directory
history. Native dialog and desktop visual/restart acceptance remain separately
tracked in `ux-evolution-closure.md`.

## Auxiliary selection boundary

`shader-editor-pick-auxiliary` accepts only `descriptor`, `tool-executable`, or
`build-output`. The host fixes the dialog purpose, file/folder mode, filters and
remembered starting directory. The frontend receives one selected path or null;
an executable selection remains only a candidate, not permission to launch it or
proof of compatibility. Only descriptor selection adds the chosen file to the fs
plugin's read scope. Tool and build-output selection grant no recursive scope.

All application file selection now goes through purpose-specific host commands.
The WebView no longer has `dialog:allow-open`; the remaining fs permission is
`fs:allow-read-text-file` for explicitly scoped auxiliary reads. Document IO still
uses the existing host canonical handles and CAS save operations. This change
neither expands generic filesystem access nor introduces a process/argv API.


## Workspace session intent

After opening or reopening a Workspace, **Restore saved session** in Explorer
loads that root's saved tab/active-tab/Preview-target intent. The optional
`workspaces` field in application preferences retains up to ten Workspace records,
with at most 32 file-backed tabs per record and the existing 64 KiB total limit.
Exceeding the limit reports a preference error and preserves the previous file.
The host filters admitted tabs outside the selected root; untitled tabs are not
persisted. Existing layout and directory histories are preserved.

`shader-workspace-read-resume` requires a freshly admitted Workspace URI.
`shader-workspace-save-resume` accepts only Workspace/document URIs, active and
Preview document URIs, an optional Environment ID, and the requested build target.
The host resolves document URIs through its current capability registry and checks
root containment. Stored strings do not grant new filesystem access. Restoring
performs a fresh complete discovery and reads current file snapshots, obtaining
new revision tokens. Already-open tabs, including unsaved edits, are kept intact;
missing or invalid files are reported rather than recreated from cached bytes.

Environment intent reuses the same already-active Environment, if present. Otherwise
it requires one unambiguous registered identity and runs the existing Verify and
Use workflow, including final-location proof. It does not
restore an executable path, a compatibility claim or a live Runtime handle from
preferences. Verification can run its own native probe; it does not launch an
attached authoring Preview. The Preview coordinator restores the target only if
current descriptor/emission readiness allows it. A refusal leaves the existing
target intact and reports the reason. Retrying after descriptor readiness settles
reuses the already-activated Environment rather than resetting its readiness again.
Build target selection remains subject to
the existing native target policy. A restarted application begins detached.

Writes are coalesced and serialized. Initial hydration never replaces saved intent
with startup defaults. During restore the writer drains earlier work and pauses;
partial progress, cancellation and retries do not overwrite the saved session.
The next deliberate tab/target/Environment change can save a new intent. A user
edit, tab change or Workspace switch stops further restoration; already-opened
tabs are retained. Cancellation does not roll back completed opens or a completed
Environment activation. It prevents remaining work, and the coordinator checks
that the target intent is still valid after joining an old Runtime. No graph
content, undo history, process/session identity, native build result or `Current`
claim is serialized.

Automated checks cover preference persistence/bounds, fresh host admission,
outside-root filtering, current file rereads, hydration/write ordering, partial
restore preservation and cancelled target transitions. Full desktop restart,
native dialogs and restored-Environment proof remain manual/native acceptance
items; this change does not claim a new native qualification run.
