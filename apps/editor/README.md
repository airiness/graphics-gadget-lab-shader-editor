# @gglab/editor

Editor application shell and composition root for the GGLab shader graph
editor.

Owns: the web shell (`index.html` + Vite), and the composition root
(`src/app.tsx`) that wires the `@gglab/editor-ui` presentation surface to
the `@gglab/shader-graph-core` semantic services.

Never owns: graph semantics, type rules, validation, HLSL generation,
shader compilation, or backend target policy.

## Editor structure and canvas chrome

- **Collapsible node library** — every library section collapses/expands
  through its header, `Collapse all` / `Expand all` drive the whole
  library, and the whole sidebar collapses to a rail (expand intent).
  Section keys come from the palette's own structure (the parameters
  section + the catalog's category groups) — no separate registry. While a
  search query is live, matched sections are forced visible and the user's
  previous choice is restored when the query clears. All of it is UI
  session state in the composition root and the palette: it never enters
  `ShaderGraphDocument`.
- **Authoring by drag or click, with a closed runtime boundary** — a
  palette entry (node, or descriptor parameter choice) can be **dragged
  onto the canvas**: the palette shapes the transient drag payload from
  core/catalog/descriptor facts, and the parameter `valueType` is a
  `GraphType` at the type level — the decode boundary validates it with
  the core's own `isGraphType` runtime authority, so no downstream cast
  re-introduces an untrusted string. The flow viewport contributes only
  the screen→flow coordinate via `resolveDropCoordinate`: an unready
  instance means NO coordinate, and a coordinate-less drop is a no-op —
  never a silent creation at (0,0). The same core-judged authoring
  operation as a click creates the entry — `addNode(…, { position })` or
  the atomic `addParameter(…, { position })` (parameter entry + node +
  initial placement in ONE operation, refused atomically on a rejection).
  Click-to-add remains the alternative.
- **Editor button design language** — one kit with explicit variants:
  `primary` (reserved for genuinely strong main actions only),
  `secondary` (clear ordinary actions: Open Descriptor, Load, Generate
  HLSL), `toolbar` (canvas actions: Auto Layout; Fit View / Snap later),
  `ghost` (low priority), `icon` (26×26 compact controls), `destructive`.
  Geometry: 30px normal / 26px compact, 5px radius, 1px visible border,
  nowrap; states: raised rest, brighter hover, `translateY(1px)` + inset
  shadow when pressed, accent focus ring. A tool button is not a web CTA:
  `primary` is never the default surface.
- **Library controls without wrapping text** — the library head carries
  ONE state-derived bulk toggle (any open section: down-arrow action
  collapses all; fully collapsed: up-arrow action expands all — arrow
  mapping per the owner's choice) plus the collapse-sidebar button, each
  26×26 with `aria-label` + `title`; the meaning lives in the labels,
  never in two-line wrapped text in the narrow sidebar.
- **Both side rails collapse** — the node library (left) and the
   inspector (right) share ONE rail language (shared PanelOpen/PanelClose
   icons, the 48px `.gglab-side-rail` with vertical re-open text); each
   rail alone, or both together, maximize the canvas (composed
   `gglab-body-*-collapsed` grid states). The state is app-level layout
   state; the sections reappear unchanged on re-open.
- **Undo / Redo (document history)** — the session owns a bounded
   (50-step) history of the document; the app keeps the document AS
   `history.present`, so undo/redo and the authoring path are the same
   state transition. Rules: one user intent = one labeled step ("removed
   connection c3", "automatic layout"); a single auto-layout pass is ONE
   step (not node by node); a REFUSED operation is never recorded (undo
   must never "undo nothing"), and a NO-OP is never recorded either —
   the store is identity-guarded, so a zero-magnitude action cannot
   discard the user's redo branch; opening/importing a document RESETS the
   line (provenance is not undoable); the shared text-field guard keeps
   Ctrl+Z inside the library search / JSON viewport for that field's own
   editor; dirty stays derived (undoing back to the baseline un-dirties).
   Undo/Redo land as a disabled-aware toolbar pair (Ctrl+Z / Ctrl+Y /
   Ctrl+Shift+Z); and every document transition (open/import, undo,
   redo) clears the whole canvas session through one shared helper —
   selection, armed reconnect and menu (connection ids are
   document-scoped: a stale selection naming an id that ALSO exists in
   the new document is a delete/reconnect hazard) plus the diagnostic
   focus and the emission preview, both of which are bound to the
   revision they were derived from.
- **Golden graphs — the fixed smoke scenes** — `…/tests/fixtures/
  SurfaceTextureGolden.shadergraph` (fully legal v2 surface: scalar,
  vector and texture parameters, UV, typed-channel sampling, the math
  set, a fan-out, and all five SurfaceOutput inputs; opens with ZERO
  diagnostics and emits HLSL with a pinned durable SHA-256 fingerprint)
  and `…/tests/fixtures/SurfaceDiagnostics.shadergraph` (opens cleanly
  as a session — structural references resolve — then exposes the full
  semantic defect set with core-owned codes/severities, and refuses
  emission with the structured errors). These paths are the ONE stable
  scene reference for every editor screenshot and smoke test: new
  visual work renders against them, not ad-hoc state.
- **One fact, one color (owner decision, locked)** — a connected input
   socket is colored by the type it ACTUALLY carries (the concrete
   resolved type of its incoming wire), so the socket, the wire, and the
   hover tooltip all state the same fact; an unconnected socket shows its
   declared kind instead. The connection STATE (hollow ring vs solid dot)
   is the other axis, and a wrong-type feed is the graph's diagnostic to
   report — never a color clash to spell out. Do not re-color the socket
   back to a stable "own" color without revisiting this decision.
- **Connection lifecycle (port gestures)** — the advanced pair, on the
   same "core owns the semantics" rule. Both land as ONE atomic core
   operation each (never a UI-side remove+add sequence):
  - **Alt + click a port** = disconnect EVERYTHING attached to that
    ONE side of the port (the incoming of an input, the fan-out of an
    output). The port is passed to the core as the full three-part
    identity — node + port + SIDE — because the catalog itself ships
    same-named input/output ports (Saturate, OneMinus: `value` is TWO
    ports there); the clicked handle knows its side, the core never
    guesses the other one. Stale node → `UNRESOLVED_NODE_REFERENCE`;
    a port the catalog denies on THAT side for a known type →
    `UNKNOWN_PORT`; zero attachments on that side → honest no-op (same
    document instance, nothing dirties, no history step).
  - **Ctrl + click a connection** = arm the reconnect (a top-center hint
    chip shows it; the armed edge keeps the selection look). Then a plain
    click on ANY port confirms: the port's rendered side is the semantic
    fact — an input handle becomes the new target end (`to`), an output
    handle the new source end (`from`) — via the core's atomic
    `reconnectConnection`, which moves one endpoint of the SAME
    connection object (id, unknownFields, and the other end all
    survive). Esc or a blank click cancels — and cancel is a no-op,
    because nothing mutates until a port confirms (the revert rule holds
    by construction).
- **Connection lifecycle (interaction slice 1)** — selecting and
   deleting a connection follows ONE rule: the core owns the semantics,
   the app owns the session state, React Flow only supplies the gesture.
  - **Select**: LMB on an edge → session `selectedConnectionId` (never
    document data — selecting never dirties). Blank click clears.
  - **Delete**: `Delete`/`Backspace` (or the right-click menu's single
    `Delete Connection` item) → the core's atomic `removeConnection` on the
    authoring path (dirty/validation/serialization ride the same
    transaction). A stale id fails with a structured
    `CONNECTION_NOT_FOUND` and surfaces as a note — never silently
    swallowed, never a UI-side `edges.filter`.
  - **Guard**: graph shortcuts ask the shared `isEditingTextTarget`
    predicate first, so typing in the library search or the JSON
    viewport never deletes a wire. React Flow's built-in key-delete is
    disabled (`deleteKeyCode={null}`).
  - **Presentation**: selection = same-hue emphasis (thicker stroke +
    soft per-kind glow), never a re-color; wires stay a 2px stroke but
    keep a 12px interaction width so they stay pressable when zoomed.
  - **Out of scope here** (deliberately deferred): occupied-input
    replace, multi-selection, node deletion, create-node from a dangling
    wire, reroute, undo/redo. (Port disconnect and a single-endpoint
    reconnect landed above.)
- **Unity-style integrated port** — a PortRow IS one visual port: the
  real React Flow Handle (the sole socket glyph, carrying the
  data-category color, the connection state, and the focus state) and
  the port's semantic name. The port TYPE is **on-demand** (Unreal-style
  hover tooltip: `name — type`): the card width belongs to the names,
  type is never a permanent second column. **The type string is a
  core-owned fact, never a UI guess**: the core type resolver's concrete
  type where the graph resolves one (`resolveGraphTypes().typeAt` —
  outputs directly, inputs via the document connection's source), else
  the catalog's DECLARED set for that port (`NodePortDefinition.types`);
  nothing is keyed on the port id. The type strings live in the display
  DTO (`inputPortTypes` / `outputPortTypes`) so richer hover surfaces
  can reuse them. The projection test re-derives every display string
  from the core's own authorities and requires equality. The row cell is the Handle's
  positioning context (`position: relative`; `top: 50%` + centering
  transform; the inset = half the socket + the card's 1px border puts
  the socket OUTSIDE the card with its inner edge exactly tangent to
  the border line — attached, never floating, and a hollow ring never
  overlaps the border), so by construction: PortRow center = Handle
  center = React Flow edge anchor. Socket state language: **unconnected
  = a hollow ring of the data-category color, connected = a solid dot
  of the same color** (the connection state is presentation derived from
  the edge store — Handle count, ids, and wiring never change). No fake
  inner dot, no invisible external handle — one port, one real socket.
- **Placement patches only position** — drag placement, auto layout, and
  drop authoring all write `editorMetadata.nodes[*].position` through one
  shared position-patch helper, preserving the node's existing
  `NodeEditorState` (`unknownFields`, future presentation metadata); the
  unknown-metadata regression is locked by tests.
- **Canvas overlay layout** — zoom controls top-right, minimap
  bottom-right, dot grid behind the graph: fixed corners, no overlap. The
  xyflow attribution is hidden through its official `proOptions`
  configuration; the editor's own brand bar (top) and status bar (bottom)
  stay — this is the editor's branding, not a library credit.
- **One geometric system** — node-card geometry (header height, port-row
  rhythm, handle size/position, card width) lives in exactly one place
  (`FLOW_GEOMETRY` in editor-ui): the TS projection, the inline handle
  styles, and the CSS all consume it (the CSS via custom properties the
  viewport injects), so the handle center, the port-row center line, and
  the React Flow edge anchor agree by construction. Tests lock the shared
  axis and the row rhythm.
- **Auto layout (one click)** — `autoLayout` (editor-ui, dagre, left-to-
  right) computes positions for the whole graph and the composition root
  writes them into `editorMetadata.nodes[*].position` (session state). The
  core is re-asked as usual; the tests prove that applying a layout keeps
  the semantic fields, the validation verdict, and the emitted HLSL +
  identity byte-identical.
- **Tailwind + shadcn-style kit (first phase: chrome)** — Tailwind v4 is
  the utility layer for the app shell; editor-ui carries a small
  shadcn-style kit (button / badge / input / collapsible / separator)
  themed from this app's existing design tokens, so the chrome (sidebar,
  panels, buttons, inputs, status badges, diagnostics panels) is the kit.
  `ShaderNode` / port rows / canvas geometry intentionally stay the
  dedicated node design language, not the generic kit.

## Visual foundation (editor design system)

- **Shell** — brand bar (profile line + contract status chips, both core
  facts), a full-bleed canvas (the protagonist), an inspector on the right,
  and a status bar (node/connection/parameter counts, graph verdict, HLSL
  state + identity prefix — all core-derived, none invented).
- **Node anatomy** — the port is the visual core: every catalog port gets
  its own labeled row, its own handle position, and a data-category dot
  (scalar / vector / texture). The card carries a category rail from the
  core's node categories, plus hover / selected / diagnostic-focus states.
  Colors are a **presentation mapping over core-owned vocabulary** (the
  catalog's type lists and categories); the UI owns the palette, never the
  words.
- **Canvas chrome** — dot grid, zoom controls, and a minimap (category
  colors) around the projection; pure presentation, adding no node, port,
  or semantic fact.
- **Primitives** — a shared token set (neutrals, semantics, data
  categories, radii, shadows, type scale) and a button / field / chip /
  panel / fact vocabulary on `:root`, referenced by class — structured so
  a Tailwind theme can consume the same tokens when the component kit
  grows.
- **Library search** — a pure case-insensitive string filter over display
  names in the palette; presentation convenience, never a semantic fact.

### Typography

One unified family stack, one mono stack, and a fixed role scale —
everything else in the sheet references the tokens.

- **Families** — the UI stack is ONE family (Noto Sans CJK first: one
  family covers Latin + CJK), then CJK-capable local faces
  (`BIZ UDGothic`, `Microsoft YaHei`), then the Latin system face —
  CJK-capable faces stay **ahead** of pure-Latin ones, so a missing Noto
  never re-introduces a random cross-family CJK fallback. When the UI
  gains real localization this is the single place to branch per
  language (e.g. `:lang(zh-CN)` → an SC-first stack).
- **Mono** — equal-width Latin first (`Cascadia Mono` → `Consolas`), the
  CJK fallback **after** the mono Latin (a proportional CJK face in front
  of them would break code alignment), then the generic tail. Used for
  code, paths, node/type IDs, and diagnostic code — never for prose.
- **Role scale** — six sizes (`--type-micro` 10.5 / `--type-meta` 11 /
  `--type-body` 12 / `--type-code` 11.5 / `--type-node` 13.5 /
  `--type-display` 15), two semantic weights (`--weight-strong` 600,
  `--weight-heading` 700), two line heights (`--lh-body` 1.5,
  `--lh-code` 1.6), one caps tracking (`--tracking-caps` 0.09em).
  Every surface in the app — UI body, panel titles, node titles, port
  labels, secondary/meta text, diagnostic code, status bar — is on this
  scale.
- **Lock** — the typography regression test verifies the token values,
  the family ordering, and that no stray literal font metric survives
  anywhere in the sheet (the same exact-boundary discipline as the
  capability set).

### Buttons

The GGLab Tool Button Language is **one component kit** (`Button` +
`ButtonGroup` in `@gglab/editor-ui`) — there are no button classes in
the app sheet, and no parallel button vocabulary anywhere.

- **Variants (frozen set of six)** — `primary` (the single strong main
  action of a context, e.g. the Save in the unsaved-changes dialog),
  `secondary` (ordinary actions: Open, Save, Save As, Generate),
  `toolbar` (canvas/tool actions: Auto Layout, future Fit/Snap),
  `ghost` (low-priority: Cancel, auxiliary), `icon` (26×26 square
  controls, e.g. library bulk controls), `destructive` (the danger
  slot — defined and available, not yet adopted by any surface).
- **Frozen geometry** — 28px text buttons / 26×26 icon buttons, the
  `--r-1` radius, 10px horizontal padding, 6px icon gap, 14px icons,
  nowrap; control text sits on the type scale (`--type-body` /
  `--weight-strong` — 12px/600). **ONE uniform 1px neutral edge, ONE
  shared raised surface, and ONE label color on every ordinary
  variant** — no variant blends into the app background, invents its
  own border/shade/label tint; hierarchy comes from the semantic fills
  (primary: the accent fill, destructive: the error tint) and position.
- **Library bulk** — the node library has ONE bulk toggle whose action
  derives from the section state — any open section: click collapses
  everything; every section collapsed: click expands everything (the
  arrow mapping follows the owner's choice: expanded library → up
  arrow, fully collapsed → down arrow); no second control.
- **Five states, all explicit** — rest (raised off the panel with a
  visible border: **a button must read as a button in a still
  screenshot, never only on hover**), hover (brighter background +
  border + text), pressed (1px sink + inset shadow), focus-visible
  (2px ring, keyboard), disabled (no pointer response, 50% opacity).
  ONE focus ring everywhere: a global rule guarantees the kit's ring
  values on every raw control too, so the user-agent default focus
  frame can never leak through a non-kit button.
- **Optical centering** — CJK line metrics (the rendered UI families)
  reserve a large descent region, so the Latin cap band of a
  flex-centered natural line box sits above the optical center; labels
  carry the measured correction (1.5px down — the midpoint of the
  candidate families' 1.0–2.4px band), applied in ONE place in the
  kit.
- **Dialog order** — the unsaved-changes footer reads
  `[Save] [Don't Save] [Cancel]` (primary first, right-aligned).
- **Group** — `ButtonGroup` is one action unit (fixed 8px spacing,
  shared alignment): document I/O, dialog footers. A row of buttons
  can never degrade into loose inline text; order and the
  primary/secondary/ghost hierarchy belong to the caller (see the
  Dialog order bullet).
- **Utility scan scope** — the kit's Tailwind classes live in the
  editor-ui package, outside this package's default candidate scan; the
  app sheet declares an explicit `@source` for that package, so kit
  classes compile from their home (the lock test guards the directive —
  without it, a class like `flex-col` silently never generates).
- **Lock** — the button-kit regression test freezes the variant set,
  the geometry baseline, the scale typography, the five states, and
  asserts that no parallel button language survives in the app sheet.

## Current surface (authoring loop)

- **Canvas** — the document projected into React Flow v12
  (`@xyflow/react`): one node/edge per core entry, and **ports are the
  UI unit** — each port (name, direction, order from the core node
  catalog) gets its own labeled row and its own handle position, so a
  node's six channel outputs are six distinct, individually grabbable
  points. Connecting two ports is an interaction intent; the core's
  validation and port-level type services decide whether it holds, and
  their structured diagnostics are what renders. Dragging is controlled
  end-to-end: the viewport owns transient node state that follows the
  mouse in real time, and the document is written exactly once, on drag
  stop, as session state (never per frame).
- **Node palette + parameters** — the node section is the core's node
  catalog (no UI-side registry). The parameter section is a **pure
  projection of the loaded descriptor instance**: classes and their full
  value-type lists come from `parameterClasses`, the descriptor's
  `deferred` set is named but not authorable, and with no descriptor
  loaded the section says so explicitly instead of offering a vocabulary
  of its own. Adding a parameter is atomic (document entry + node that
  names it, or the unchanged input).
- **Node creation** — node version and creation-time property values come
  from the core's `createNode` (the single authority for what a new node
  of a type carries; a future CLI asks the same service). The GUI owns
  no default values.
- **Diagnostics → canvas navigation (strict mode: structured data only)** —
  each side-panel entry is selectable; the target comes from the entry's
  `dataPath` anchor resolved against the document. A node anchor
  (`$.nodes[K]`) highlights the node; a connection anchor
  (`$.connections[K]`) highlights the edge and both endpoint ports —
  those ports are fields of the structured connection itself. Nothing is
  mined from the human-readable message (it is a display surface, not a
  contract); port-accurate navigation for node-anchored diagnostics waits
  for a structured diagnostic target. Anchors without a canvas target
  (profile-level, parameter level) stay in the panel.
- **Descriptor instance panel** — loads one frozen Surface Profile
  Descriptor through the core's strict reader (serialized data document —
  never a C++ ABI or header import); compatibility and conformance are the
  core's shared verdicts, which is what the side panel reports, including
  the capability-based refusals (`PROFILE_MISMATCH`,
  `MISSING_PROFILE_CAPABILITY`, `FORBIDDEN_PROFILE_CAPABILITY`).
- **Save / load** — save is the core's `.shadergraph` serialization
  authority (`serializeShaderGraphDocument`): the canonical, deterministic
  disk format (fixed field order, retained forward-compatible fields
  written back as siblings — never as the model's internal
  `unknownFields` bookkeeping keys, and never a raw `JSON.stringify` of
  the model object, which a re-parse would re-nest and corrupt). Load is
  the core's reader; save → load is a structurally lossless round trip
  (locked by a regression that also demonstrates the raw-dump corruption
  the authority prevents). Load failures surface the reader's structured
  diagnostics.
- **Emission preview** — the core's deterministic HLSL service
  (`emitHlsl`), shown with its generated-source identity (SHA-256 of the
  exact generated bytes). Emission requires a loaded descriptor (the
  profile contract) and is refused with the core's diagnostics otherwise.

## Web GUI Foundation: frozen

This package's interaction + visual foundation is the final Web GUI
slice. After review it is considered **frozen**: the next stage hosts the
existing React/Vite editor unchanged inside the Tauri 2 desktop
shell (Slice 0), rather than widening the Web GUI scope. No Tauri,
native dialogs, filesystem IO, undo/redo, property inspector, context
menus, new nodes/parameter classes, or toolchain integration live in
the Web GUI.

## Desktop shell (Tauri 2)

```
apps/editor
├─ React/Vite frontend       (unchanged; the browser app)
└─ src-tauri                 (thin desktop host — the only new thing)
```

Slice 0's entire job is:

```
existing React/Vite editor → Tauri WebView → native Windows desktop window
```

The Rust/Tauri layer deliberately knows nothing about ShaderGraph
semantics, `profileVersion`, descriptor compatibility, or HLSL emission.

### Native document I/O (slice 1)

The desktop app can now read and write real files, through the thinnest
possible native surface. The layer contract (one direction, never
widened):

```
native layer      →  official Tauri plugins ONLY; the shell owns no
                     custom commands. Dialogs choose a path; scoped
                     UTF-8 file access serves it.
core              →  parse / serialize (the .shadergraph disk format,
                     descriptor reading).
editor (the app)  →  document + session state; decides which text moves.
```

Access model — this is the whole point of using the official plugins
instead of hand-written path commands: when the user picks a file in a
native dialog, the dialog plugin adds **that path** to the filesystem
scope, and only scoped access is granted. File access can therefore only
ever touch files the user explicitly chose; no arbitrary-path read/write
command exists in the host.

Native surface (registered in `src-tauri`, ACL-locked by
`capabilities/default.json` to exactly):

- `core:default`
- `dialog:allow-open` + `dialog:allow-save` — native dialogs only choose
  a path (`.shadergraph` / JSON filters);
- `fs:allow-read-text-file` + `fs:allow-write-text-file` — scoped UTF-8
  text read/write (`readTextFile` / `writeTextFile` in
  `@tauri-apps/plugin-fs`); IO failure is an explicit rejection.

The JS side uses the official public API only
(`@tauri-apps/plugin-dialog` `open`/`save`, `@tauri-apps/plugin-fs`
`readTextFile`/`writeTextFile`) — never internal wire command names.

The app keeps this behind a small **host/file abstraction**
(`src/host-io.ts`): a `FileChannel` whose four host functions (`open` /
`save` / `readTextFile` / `writeTextFile`) are *injected* — so the
module is unit-testable with fakes, has no Tauri import of its own, and
the plugin JS is dynamically imported, code-split out of the web bundle,
and loaded only inside the desktop webview. The read boundary verifies
its payload is really a string (a runtime boundary, not a cast). The
browser build keeps its text save/load surface untouched.

UI (desktop only, above the existing text save/load block, which stays
as the web path and the copy-to-clipboard path):

- **Open…** — native open dialog → scoped UTF-8 read → **core** document
  reader → the session is *replaced*: the document becomes current and
  the invalidated derivatives (diagnostic focus, the emission preview,
  the operation notes) are cleared — a stale build result is never
  current;
- **Save** — the core's canonical `.shadergraph` serialization written
  to the path owned by the CURRENT document (a file-opened one); a
  pathless document (seeded or text-imported) instead gets the save
  dialog (default name `Untitled.shadergraph`);
- **Save As…** — native save dialog → same canonical bytes to the new
  path, which the document then owns;

The Save target is derived from **document provenance** (owned in
`src/document-session.ts`): a file-opened document owns its path; a
text-imported document owns none — so an imported document can never
silently overwrite a file opened earlier, and a replaced session never
inherits a previous document's path.
- **descriptor Open** — the panel receives an optional host file-open
  injection (native dialog → UTF-8 text → the core's strict descriptor
  reader); without one it falls back to the browser file input. Cancel
  is a no-op; an IO failure (e.g. the file vanished after the dialog) is
  an explicit `IO` rejected state carrying the host's message.

### Document session (slice 2)

The session record for the current document carries everything the
desktop surface needs (owned by `src/document-session.ts`, so the UI,
the title, and the close guard all use the same rules):

```
DocumentSession
├─ provenance      file path (owned)  |  imported (owns no path)
├─ savedBaseline   canonical bytes of the last saved / established state
└─ dirty           ⇔  serializeShaderGraphDocument(current) ≠ savedBaseline
```

Because the core's serialization is deterministic and structurally
stable, `dirty` is a byte comparison over two canonical forms — a
structural comparison (locked by a test: equal documents in different
key order are NOT dirty). Re-saving establishes the new baseline
(`sessionSaved`); replacing the document establishes a fresh baseline
(new document ⇒ not dirty).

Behavior:

- **window title** — `GGLab Shader Graph Editor — MyShader.shadergraph`,
  gaining a trailing ` *` exactly while dirty (the same rule drives the
  status bar; path display uses `basenameOf`);
- **Ctrl/⌘+S** saves, **Ctrl/⌘+Shift+S** saves-as — classified by the
  pure `saveShortcutOf` authority (browser builds keep their native
  defaults);
- **unsaved close guard** — Tauri 2.11.5's close model (verified in the
  core + api sources): with a JS close listener registered, EVERY close
  attempt (`X` or `close()`) is auto-prevented by the core and the
  api's `onCloseRequested` wrapper destroys the window after the
  handler resolves **only if the handler did not call
  `preventDefault()`**. The guard therefore decides FIRST (an in-page
  Save / Don't Save / Cancel overlay — deterministic, always visible,
  no dialog permission needed) and only prevents when the session must
  STAY (Cancel, or a save that did not complete). The question stays up
  until answered — like a modal confirmation, with no auto-cancel
  countdown; while it is up, further close attempts (X-mashing) are
  ABSORBED: prevented and ignored by a re-entry guard
  (`closePendingRef`), never answered by a second question or a second
  resolver. Clean sessions simply return without preventing, so the
  wrapper's destroy completes the close. Every step is recorded in the
  operation notes. The decision (`choice + save outcome → close/stay`)
  is the pure `closeAction` rule, tested without any window;
- the window surface needs `core:window:allow-set-title` (title) +
  `core:window:allow-destroy` (the actual close path, invoked by the
  api wrapper); all are part of the exact capability set.

Known boundary (deliberate, recorded): a document established from
text (Load from text / the seeded document) takes its content as the
clean baseline — a never-persisted `Untitled` document is not "dirty"
and closing it does not prompt. This matches the
`dirty = modified since the established state` rule but not some
desktop editors' "Untitled content is unsaved" semantics. When a real
New / Import / Recovery surface exists, the session should grow a
persistent-backing/needs-save axis (`savedBaseline` +
`hasPersistentBacking`, or an explicit "needs save" state for imports)
instead of relying on the import-as-baseline shortcut.

Layout:

- `src-tauri/src/main.rs` — the window + the two official plugins
  (dialog, fs). No custom commands, no state, no graph knowledge;
- `src-tauri/tauri.conf.json` — window (1440×900, min 960×600),
  `devUrl` = the Vite dev server, `frontendDist` = `../dist`, and the
  tightened `csp` / `devCsp` (production `script-src 'self'`; `connect-src`
  limited to the IPC origin — plus the dev preamble and HMR WebSocket
  origin in `devCsp`);
- `src-tauri/capabilities/default.json` — exactly `core:default` +
  `core:window:allow-destroy`/`core:window:allow-set-title` +
  `dialog:allow-open`/`dialog:allow-save` +
  `fs:allow-read-text-file`/`fs:allow-write-text-file`;
- `src-tauri/icons/` — self-generated flat motif (two linked node cards,
  repo palette) as a classic **DIB-based** `icon.ico` (the older Windows
  resource compiler on this machine rejects PNG-compressed ICOs) plus the
  same pixels as `icon.png`.

Known pitfalls (all locked by config + comments in the code):

- the Vite dev watcher must stay out of `src-tauri/` (and any cargo
  `target/`): watching cargo-owned files in parallel crashes the dev
  server with `EBUSY`. Handled in `vite.config.ts` via
  `server.watch.ignored` (chokidar **v4** spells it `ignored`, not
  `ignore` — the v3 spelling is silently ignored);
- **native drag & drop is disabled on the window**
  (`dragDropEnabled: false`): the editor's palette → canvas authoring is
  HTML5 DnD, and Tauri's default native drag-drop target on Windows
  intercepts the WebView's `dragover`/`drop` (presenting a forbidden
  cursor) — upstream Tauri documents that HTML5 drag and drop on the
  frontend **requires** it off. No native OS file drop is needed in this
  slice (later desktop file flows use native dialogs, not drop targets);
  this is a desktop-host-only setting — the browser build is unaffected;
- Rust/cargo is a build-time-only requirement (never bundled); the web
  build stays standalone.

Run (requires a stable Rust toolchain + WebView2 runtime; the web build
still runs standalone exactly as before):

```
pnpm tauri dev      # from the repo root (or: pnpm tauri:dev in apps/editor)
pnpm tauri build    # release build (needs the stable Rust toolchain)
```

Environment note: on machines with `HTTP_PROXY`/`HTTPS_PROXY` set,
export `NO_PROXY=localhost,127.0.0.1` before starting, so the embedded
webview's loopback requests bypass the proxy.

## Run

```
pnpm install
pnpm dev        # from the apps/editor package (Vite dev server)
pnpm test       # GUI slice tests (vitest + jsdom + React server render)
pnpm build      # production bundle (dist/)
pnpm tauri dev  # desktop window (requires the Rust toolchain)
```

## Invariants locked by this package's tests

- the palette is the core node catalog itself, and the parameter
  vocabulary is the descriptor's own (a descriptor admitting no class
  offers no such class — no UI-side register can drift);
- authoring operations are atomic data construction — a refusal returns
  the unchanged input (never an orphan parameter entry) — and validity
  is the core's call, rendered in the core's stable codes;
- node creation defaults are core catalog facts (`createNode`), not UI
  constants;
- ports are the UI unit: every port renders on its own row at a distinct
  position (six channel outputs, six distinguishable points);
- diagnostic navigation targets come from the `dataPath` anchor alone
  (node → node; connection → edge + structured endpoint ports); a
  node-anchored diagnostic never highlights a port mined from the
  message; anchors without a canvas target resolve to an explicit
  no-target, never a fake one;
- viewport node state is transient and controlled: drag position changes
  are consumed in real time and a fresh projection (commit, load, focus)
  re-syncs it in 1:1;
- save → load → compile preserves the generated HLSL bytes and the
  generated-source identity, and save → load is structurally lossless:
  the saved text is the core's canonical `.shadergraph` serialization
  (no `unknownFields` bookkeeping keys; retained unknown fields at every
  level round-trip to their own position);
- canvas placement (session state) never changes generated HLSL or its
  identity;
- the flow projection invents no entries (one node/edge per core entry,
  ports from the catalog);
- geometry has one source of truth: handle center, port-row center line,
  and the edge anchor all derive from the same `FLOW_GEOMETRY` (shared axis
  and row rhythm locked);
- auto layout only touches `editorMetadata` (positions): semantic fields,
  the core's validation verdict, and the emitted HLSL bytes + identity stay
  byte-identical, and the layout is deterministic for a given document;
- the node library collapse state (sections and the whole sidebar) lives in
  the UI, never in the document;
- the drag payload's parameter `valueType` is a `GraphType` at the type
  level: the decode boundary validates it with the core's own `isGraphType`
  authority (an unknown word decodes to `null`, never a trust cast);
- a drop with an unready flow instance produces NO coordinate and is a
  no-op — never a silent node at (0,0);
- one port renders exactly one real Handle (no orphan, no duplicate
  socket, no secondary dot glyph), and the Handle keeps its
  data-category class;
- the action affordance is the button design language (raised rest,
  brighter hover, pressed translate + inset shadow, accent focus ring);
  `primary` stays reserved, not the default surface.
