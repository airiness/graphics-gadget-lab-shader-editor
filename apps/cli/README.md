# @gglab/shader-graph-cli

Machine/automation authoring frontend for the GGLab shader graph editor.

Owns: a structured command surface (machine-readable in/out, stable exit
behavior, dry-run, transactional batch edits) and serialization of core-owned
results, designed for AI agents, CI, automation, batch editing, and headless
debugging/reproduction.

Never owns: graph semantics, node registries, port/type rules, connection
validation, DAG rules, HLSL lowering, profile interpretation, or shader
production. Those come from `@gglab/shader-graph-core` and the frozen surface
profile descriptors; native compilation remains the domain of
`gglab-shaderc` in the main GGLab repository.

Together with `@gglab/editor` (the GUI frontend), this package is one of two
frontends over the single semantic authority, `@gglab/shader-graph-core`.

## Command surface

```
usage: shader-graph <command> [arguments] [options]

commands:
  validate <document> [--descriptor <descriptor.json> | --descriptors-dir <base>]
      Core authoring checks (structural validation, whole-document
      port-level type resolution), plus — when a descriptor instance is
      supplied — the shared profile x descriptor compatibility verdict and
      parameter (type, class) conformance against it.

  emit <document> --descriptor <descriptor.json> | --descriptors-dir <base>
      Deterministic HLSL emission: generated source, source map, and the
      SHA-256 generated-source identity — exactly the core's bytes.

  descriptor <descriptor.json>
      Inspect one Surface Profile Descriptor instance (version axes,
      profile line, texture-signature contract presence, sampling posture,
      deferred sets, tool identity).

  edit <document> --commands <commands.json> [--descriptor <descriptor.json>]
      Apply the core's atomic edit batch and return canonical documentText.
      No input files are modified. A descriptor is required for set-profile.

  edit-commands
      Serialize the core-owned command catalog (required field kinds and
      optional string identity fields); no positional argument.

options:
  --help     print usage (exit code 2)
  --pretty   indent the JSON envelope
```

An edit command file is a JSON array, for example:

```json
[
  { "kind": "add-node", "nodeType": "Float", "nodeId": "roughness" },
  { "kind": "set-constant-value", "nodeId": "roughness", "value": 0.4 }
]
```

On success, `payload` contains `{ status, createdIds, documentText }`, directly
from the core result and canonical serializer. `createdIds` aligns with the
commands; parameter creation reports the created node ID. Use explicit
`parameterId` and `nodeId` when later commands must reference a new parameter.
The returned text can be reviewed or saved by the caller. A refused batch
returns no partial payload and identifies the refusing command through
`EDIT_TRANSACTION_REFUSED`. Invalid command-file data uses core diagnostics
and exit 1; malformed CLI options use exit 2. Edit success means the requested
transaction was accepted, not that the resulting graph validates or emits.
Run `validate` and `emit` separately for those checks.

## Machine contract

- **stdout**: exactly one JSON envelope per command run —
  `{ ok, command, diagnostics, payload }` — serialized with fixed key
  order, so an identical request yields identical bytes across runs and
  platforms. Usage errors may print the usage text instead.
- **failure envelope invariant** (enforced centrally by `buildEnvelope`):
  a failure envelope never carries a payload — `payload` is present only
  when `ok` is true.
- **strict grammars**: each command declares its exact positional count
  and its allowed options/flags (`command-grammar.ts`). An unknown option
  (a typo such as `--descripter`), an extra positional, a missing
  positional, a duplicate option, or a value-option that would swallow
  another `--` token is a structured usage error — **never a silently
  ignored token**. A typo'd descriptor option therefore can never
  silently downgrade a request (e.g. profile-bound validation to
  document-only validation) and come back green.
- **exit codes** (classified centrally, so no command can misclassify):
  - `0` command succeeded — `payload` set;
  - `1` command failed — the request was well-formed but the document,
    descriptor, or environment could not satisfy it: semantic codes
    (`CYCLE_DETECTED`, `TYPE_MISMATCH`, `PROFILE_MISMATCH`,
    `MISSING_PROFILE_CAPABILITY`, `FORBIDDEN_PROFILE_CAPABILITY`, …) and
    environment codes (`FILE_NOT_FOUND`, `FILE_UNREADABLE`,
    `DESCRIPTOR_NOT_RESOLVED`);
  - `2` invocation error — malformed call to the CLI itself or usage
    (`INVALID_ARGUMENT`, `MISSING_ARGUMENT`, `MISSING_OPTION`, unknown
    command, `--help`).
  - A mixed envelope containing any non-usage error is classified `1`; a
    real failure is never masked as a usage problem.
- **stable codes**: core diagnostic codes for graph/descriptor/compatibility
  rules (e.g. `PROFILE_MISMATCH`, `MISSING_PROFILE_CAPABILITY`,
  `FORBIDDEN_PROFILE_CAPABILITY`, `CYCLE_DETECTED`) and CLI-level codes for
  CLI-owned failures (`INVALID_ARGUMENT`, `MISSING_ARGUMENT`,
  `MISSING_OPTION`, `FILE_NOT_FOUND`, `FILE_UNREADABLE`,
  `DESCRIPTOR_NOT_RESOLVED`). Codes are stable vocabulary, never free form.
- **descriptor resolution** (`--descriptor file` or `--descriptors-dir
  dir`): discovery walks `<base>/<profileIdDir>/<profileVersionDir>/descriptor.json`,
  every candidate is parsed by the core's strict reader, and the **highest
  supported descriptorVersion within the document's requested profile
  line** is selected — never across lines. Success envelopes carry
  `payload.descriptorResolution = { selected, considered }`; every
  considered candidate is listed with its support state, so a newer
  descriptorVersion the reader does not support is explicitly surfaced
  (e.g. `failure: UNSUPPORTED_DESCRIPTOR_VERSION`) — never silently
  dropped, and never reinterpreted.

## Invocation

The bin shim (`bin/shader-graph.js`) registers the workspace's `tsx`
devDependency as the ESM resolution hook and runs `src/index.ts` in-process,
so the repository's relative import specifiers resolve at runtime:

```
shader-graph <command> ...                                  # pnpm-linked bin (workspace)
node apps/cli/bin/shader-graph.js <command> ...             # equivalent direct form
```

`main()` is also importable (it takes the argv slice and an optional
stdout sink), which is what this package's tests drive.

## Environment proposal inspection

`environment-discover <absolute-repository-root>` reads the producer bootstrap
and returns deployment candidates without selection.
`environment-verify <absolute-environment-root>` independently validates the
manifest and filesystem closure; `--profiles` additionally validates final
Surface Profile descriptors through core. Both accept `--pretty` and use the existing
JSON envelope/exit convention. Windows, PowerShell, and (for discovery) Python
3.12+ are required. No environment is imported, registered, activated, or
claimed natively ready. See `../../docs/environment-import-readiness.md`.

`environment-registry <absolute-registry-root>` inspects Editor-owned saved
Environment/state bindings without creating directories or activating them.
Every restored record is `unverified`; malformed records produce structured
CLI failure diagnostics. See `../../docs/environment-registry.md`.
