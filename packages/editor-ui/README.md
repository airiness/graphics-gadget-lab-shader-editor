# @gglab/editor-ui

Presentation components for the GGLab shader graph editor.

Owns: canvas node/edge presentation (the React Flow projection), the node
palette, panels (diagnostics, descriptor instance), GUI adapters over the
core's document edit commands, the one-click auto layout (positions for `editorMetadata`), the
single geometry source for the node card, and the small editor chrome
kit (button / badge / input / collapsible / separator).

Queries the headless core's semantic services for everything it shows:
the node palette is the core's node catalog itself (there is no UI-side
node registry), descriptor loading is the core's strict reader, and
connection validity / conformance / compatibility verdicts are the core's.
This package never redefines graph semantics.

`session/authoring-operations.ts` forwards edits to core `applyGraphEdit`.
It maps changed/unchanged/refused results to the existing GUI transaction
shape and retains structured refusal diagnostics. Creation adapters may add
an initial canvas position after a successful core edit; a refused edit never
writes placement. Node IDs, constant shapes, parameter declarations and node
deletion semantics are owned by core. History, selection and gestures remain
GUI responsibilities.

Rules this slice implements (mirrored in `apps/editor`'s composition
root):

- **Visual foundation** — the `ShaderNode` design language renders the
  port as the visual unit (labeled row, own handle, data-category dot;
  category rail from the core's node categories). Data-category and
  node-category colors are presentation mappings over core-owned
  vocabulary — the UI owns the palette, never the words. Canvas chrome
  (dot grid, zoom controls, minimap) is pure presentation. The library
  search filter is a plain string over display names. Primitives
  (button / field / chip / panel / fact) sit on shared `:root` tokens so
  a future Tailwind/shadcn kit can theme the same facts.

- **React Flow v12 (`@xyflow/react`) is a presentation/interaction
  adapter, and dragging is controlled end-to-end** — the core's
  `ShaderGraphDocument` is the persisted model; the flow projection is
  the source of truth, and the viewport's transient node state follows
  both the projection (on commit / load / focus change) and the mouse
  (drag position changes are consumed in real time, so there is no
  teleport-on-release). The document is written exactly once, on drag
  stop, as session state — never per frame (ports come from the
  core node catalog; unknown node types are rendered as explicit
  "unknown" cards, never silently dropped).
- **Ports are the UI unit** — each port (name / direction / order from the
  catalog) renders on its own labeled row at its own handle position. The
  UI owns only layout (rows, offsets, grid slots); it owns no port
  semantics.
- **One geometric system for the card** — `FLOW_GEOMETRY`
  (`flow/flow-geometry.ts`) is the single home of the header height, port
  row rhythm, handle size/position, and card width. The TS projection
  (`portTop` / `handleStyle`), the inline handle styles, and the CSS (via
  custom properties the viewport injects) all consume it, so the handle
  center, the port-row center line, and the React Flow edge anchor agree
  by construction — no parallel literals.
- **Auto layout is session-state computation** — `autoLayout`
  (dagre, left-to-right) turns the document's nodes + connections into a
  positions map for `editorMetadata.nodes[*].position`; it reads the core
  catalog for card sizes, defines no graph semantics, skips self-loops and
  unknown endpoints for layout, and is deterministic. The composition root
  writes the result as session state and the core keeps judging the
  document — emission and identity never move with placement.
- **One position-patch helper** — every placement write (drag stop, auto
  layout, drop authoring) goes through `withNodePosition`, which patches
  the node's `position` ONLY and preserves its existing `NodeEditorState`
  (`unknownFields`, future presentation metadata). Placement can never drop
  metadata it does not own (a regression test locks this, including
  through a full layout pass with pre-existing unknown metadata).
- **Palette → canvas DnD is intent + coordinate, never semantics** — the
  palette shapes a transient drag payload (node type, or the descriptor's
  `(class, valueType)` choice) from core/catalog/descriptor facts; the
  parameter `valueType` is a `GraphType` in the payload TYPE, and
  `decodeAuthoringDrop` closes the runtime string boundary with the core's
  own `isGraphType` authority (an unknown vocabulary word decodes to
  `null` — never a cast downstream). The flow viewport contributes only
  the screen→flow coordinate through `resolveDropCoordinate`, and a drop
  with an unready instance (no coordinate) is a no-op, never a silent
  (0,0) creation. The creation is the same core-judged authoring
  operation as a click — `addNode(…, { position })` or the atomic
  `addParameter(…, { position })` (parameter entry + node + initial
  placement in one operation; a refusal returns the unchanged input
  whole).
- **Unity-style integrated port anatomy** — a PortRow is one visual port:
  the row itself renders its real React Flow Handle (the sole socket
  glyph, type-category color + focus state) next to the semantic label.
  The row cell is the Handle's positioning context, so the shared
  invariant holds by construction: PortRow visual center = Handle center
  = React Flow edge anchor (sizes/insets from `FLOW_GEOMETRY`). No inner
  fake dot, no external invisible handle.
- **Chrome kit, node language stays dedicated** — the editor chrome
  (buttons, status badges, inputs, collapsible sections, separators) uses
  a small shadcn-style kit (`components/ui/`) themed from the app's design
  tokens; `ShaderNode`, the port rows, and the canvas geometry stay the
  dedicated node design language, not the generic kit. The palette's
  collapse is UI session state: per-section, `Collapse all` / `Expand
  all` (keys derived from the palette's own section structure — no
  separate registry), or the whole-library rail; while a search query is
  live, matched sections are forced visible and the previous choice is
  restored when it clears.
- **One authority per rule** — node version and creation-time property
  values come from the core's `createNode` (the GUI owns no defaults; a
  future CLI asks the same service); the parameter authoring vocabulary
  is a pure projection of the loaded descriptor instance (`parameterClasses`,
  with the `deferred` set named but never offered — with no descriptor
  loaded there is no vocabulary, and the UI will not invent one); the
  shared profile × descriptor compatibility verdict and the parameter
  conformance verdict are asked of the core, not inferred from version
  numbers here. Authoring operations are atomic: a refusal returns the
  unchanged input.
- **Diagnostic navigation is strict-structured** — the canvas target of a
  selected diagnostic comes from its `dataPath` (`$.nodes[K]` → the node;
  `$.connections[K]` → the edge plus the endpoint ports that are fields of
  the structured connection itself). Nothing is parsed from the
  human-readable message — it is a display surface, not a contract — and
  port-accurate navigation for node-anchored diagnostics waits for a
  structured diagnostic target. Anchors without a canvas target resolve
  to an explicit no-target.
- **Session state is session state** — canvas placement lands in
  `editorMetadata` and never changes generated HLSL (a core invariant the
  tests lock at the GUI boundary).
- **Structured-only diagnostics** — panels render the core's
  `ShaderGraphDiagnostic` entries (code / severity / message / location);
  this package adds no classification of its own.

Canvas chrome (dot grid, controls top-right, minimap bottom-right) is
pure presentation: fixed overlay corners, no overlap. The xyflow
attribution is hidden through `proOptions` at the app's request; the
editor's own branding lives in the app shell. The viewport also exposes
an `onFlowReady` fit trigger (session convenience — auto layout and load
fit the graph; no semantics).

Build/serve/test from the repository root: `pnpm typecheck`, `pnpm test`,
`pnpm lint`. The React runtime is a peer dependency (the app provides it).
