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
  three 26×26 icon buttons (Collapse all / Expand all / Collapse
  sidebar) with `aria-label` + `title`; the meaning lives in the labels,
  never in two-line wrapped text in the narrow sidebar.
- **Unity-style integrated port** — a PortRow IS one visual port: the
  real React Flow Handle (the sole socket glyph, carrying the
  data-category color + focus state) and its semantic label share the
  same row. The row cell is the Handle's positioning context
  (`position: relative`; `top: 50%` + centering transform; a negative
  inset makes the socket straddle the card border), so by construction:
  PortRow center = Handle center = React Flow edge anchor. No fake inner
  dot, no invisible external handle — one port, one real socket.
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
- **Save / load** — the document serialized to JSON text and back through
  the core's reader; load failures surface the reader's structured
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
menus, new nodes/parameter classes, or toolchain integration live here.

## Run

```
pnpm install
pnpm dev        # from the apps/editor package (Vite dev server)
pnpm test       # GUI slice tests (vitest + jsdom + React server render)
pnpm build      # production bundle (dist/)
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
  generated-source identity;
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
