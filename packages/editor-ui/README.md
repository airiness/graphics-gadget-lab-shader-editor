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

- **React Flow is a presentation/interaction adapter** — the core's
  `ShaderGraphDocument` is the persisted model; the flow nodes/edges are a
  deterministic one-way projection of it (ports come from the core node
  catalog; unknown node types are rendered as explicit "unknown" cards,
  never silently dropped).
- **Session state is session state** — canvas placement lands in
  `editorMetadata` and never changes generated HLSL (a core invariant the
  tests lock at the GUI boundary).
- **Structured-only diagnostics** — panels render the core's
  `ShaderGraphDiagnostic` entries (code / severity / message / location);
  this package adds no classification of its own.
- **One authority per rule** — the shared profile × descriptor compatibility
  verdict and the parameter conformance verdict are asked of the core, not
  inferred from version numbers here.

Build/serve/test from the repository root: `pnpm typecheck`, `pnpm test`,
`pnpm lint`. The React runtime is a peer dependency (the app provides it).
