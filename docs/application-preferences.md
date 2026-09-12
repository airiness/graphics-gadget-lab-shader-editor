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
This reopens Workspace context; restoring safe tab/target/Environment intent
remains outstanding UX evolution work.

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
