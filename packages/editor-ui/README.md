# @gglab/editor-ui

Presentation components for the GGLab shader graph editor.

Owns: canvas node/edge presentation (the React Flow projection), the node
palette, panels (diagnostics, descriptor instance), the document
authoring operations (pure data construction on the core's document
model), and other UI components.

Queries the headless core's semantic services for everything it shows:
the node palette is the core's node catalog itself (there is no UI-side
node registry), descriptor loading is the core's strict reader, and
connection validity / conformance / compatibility verdicts are the core's.
This package never redefines graph semantics.

Rules this slice implements (mirrored in `apps/editor`'s composition
root):

- **React Flow v12 (`@xyflow/react`) is a presentation/interaction
  adapter** — the core's `ShaderGraphDocument` is the persisted model; the
  flow nodes/edges are a deterministic one-way projection of it (ports
  come from the core node catalog; unknown node types are rendered as
  explicit "unknown" cards, never silently dropped).
- **Ports are the UI unit** — each port (name / direction / order from the
  catalog) renders on its own labeled row at its own handle position. The
  UI owns only layout (rows, offsets, grid slots); it owns no port
  semantics.
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
- **Diagnostic navigation is anchor-resolved** — the canvas target of a
  selected diagnostic comes from its `dataPath` (`$.nodes[K]`,
  `$.connections[K]`) via the document, and a port is highlighted only when
  the message names it verifiably against the core catalog; anchors
  without a canvas target resolve to an explicit no-target.
- **Session state is session state** — canvas placement lands in
  `editorMetadata` and never changes generated HLSL (a core invariant the
  tests lock at the GUI boundary).
- **Structured-only diagnostics** — panels render the core's
  `ShaderGraphDiagnostic` entries (code / severity / message / location);
  this package adds no classification of its own.

Build/serve/test from the repository root: `pnpm typecheck`, `pnpm test`,
`pnpm lint`. The React runtime is a peer dependency (the app provides it).
