# Host-backed application navigation preferences

The desktop host stores `application-preferences.json` under Tauri's application
data directory. `preferencesVersion: 1` is local application-storage versioning,
not a graph, Environment, or native process contract. The WebView cannot select
this file's location or write stored directory paths.

The host-owned dialogs remember separate locations for Workspace, graph Open / Save
As, GGLab source repository, published Environment, and writable state selection.
A cancelled dialog does not update history. Directory hints are canonicalized;
missing directories are omitted from the next dialog. Profile overrides and loose
development auxiliary dialogs still need their own persisted history integration.

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
This reopens Workspace context; restoring safe tab/target/Environment intent and
persisting layout are still outstanding UX evolution work.

Verification covers independent histories across store instances, unavailable
locations, lock contention/recovery, corrupt/versioned data preservation, and the
no-path frontend reopen request. Native dialog navigation and full desktop restart
remain UI acceptance scenarios; unit tests do not stand in for those observations.
