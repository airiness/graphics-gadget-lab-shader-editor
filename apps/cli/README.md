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

options:
  --help     print usage (exit code 2)
  --pretty   indent the JSON envelope
```

## Machine contract

- **stdout**: exactly one JSON envelope per command run —
  `{ ok, command, diagnostics, payload }` — serialized with fixed key
  order, so an identical request yields identical bytes across runs and
  platforms. Usage errors print the usage text instead.
- **exit codes**: `0` command succeeded (payload set), `1` command failed
  (structured `diagnostics` set, payload null), `2` usage error.
- **stable codes**: core diagnostic codes for graph/descriptor/compatibility
  rules (e.g. `PROFILE_MISMATCH`, `MISSING_PROFILE_CAPABILITY`,
  `FORBIDDEN_PROFILE_CAPABILITY`, `CYCLE_DETECTED`) and CLI-level codes for
  CLI-owned failures (`INVALID_ARGUMENT`, `MISSING_ARGUMENT`,
  `MISSING_OPTION`, `FILE_NOT_FOUND`, `FILE_UNREADABLE`,
  `DESCRIPTOR_NOT_RESOLVED`). Codes are stable vocabulary, never free form.
- **descriptor selection** (`--descriptors-dir`): discovery under
  `<base>/<profileIdDir>/<profileVersionDir>/descriptor.json`, every
  candidate parsed by the core's strict reader; the **highest supported
  descriptorVersion within the document's requested profile line** is
  selected — never across lines, never by reinterpreting an unsupported
  serialization.

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
