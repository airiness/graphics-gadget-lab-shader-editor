# Guarded Environment discovery

Current update (2026-09-09): owner review approved the v1 integration baseline.
See `../../GraphicsGadgetLabDocs/GGLab_Environment_Publication_Approval.md` and
[Tauri storage integration](environment-tauri-storage.md). The historical
discovery evidence below remains bound to its original revisions. Approval does
not enable unfinished publish/init-state, proof or activation services.

Subsequent implementation: [guarded producer mutations](environment-producer-mutations.md)
now connects publish/init-state and process-tree lifetime containment. The discovery
implementation and evidence narrative below describe the earlier increment.

This increment connects read-only producer discovery to the desktop host. It
consumes the publication proposal; it does not approve it or enable import.

## Ownership and invocation

`apps/editor/src-tauri/src/environment_io.rs` owns native folder selection
registration, bootstrap preflight, publisher/interpreter observations, and
bounded process lifetime. `lib.rs` exposes only these commands:

- `shader-environment-choose-repository`: native folder dialog, nullable handle.
- `shader-environment-discover`: repository ID and settlement channel; returns
  a discovery ID immediately.
- `shader-environment-cancel-discovery`: discovery ID; returns a boolean.

`packages/shader-toolchain-client/src/environment-host-boundary.ts` owns the
headless result contract and strict IPC/producer response decoding.
`apps/editor/src/environment-host.ts` adapts Tauri and buffers settlements that
arrive before admission returns. It preserves structured diagnostic codes.

Frontend composition can call:

```typescript
import { createTauriEnvironmentDiscoveryHost } from "./environment-host.js";

const host = await createTauriEnvironmentDiscoveryHost();
const repository = await host?.chooseRepository();
if (host && repository) {
    const attempt = await host.discover(repository);
    // await host.cancel(attempt.discoveryId) when the user cancels.
    const outcome = await attempt.completion;
    // Present every candidate for explicit selection; nativeReadiness is unproven.
}
```

There is no automatic App invocation or new import UI. The browser-only host
returns null. Discovery does not register an Environment, create writable state,
change active selection, or grant ordinary/Preview readiness. Existing strict
closure reading, registry persistence and recovery remain separate services.

## Execution bounds

The host accepts a dialog-selected local Windows directory, not caller-supplied
publisher paths or argv. Bootstrap locators reject traversal and reserved names;
reparse ancestors and hardlinked executable/script files are refused. The host
rechecks selected bootstrap and publisher hashes before execution and retains
Windows sharing guards for bootstrap, publisher and interpreter through execution.
It resolves Python from PATH without installing or configuring tools and probes
Python 3.12+ using a fixed machine exit-code check.

Only the producer's structured `discover` request is constructed. No human log
parsing determines success. Each output stream is capped at 16 MiB; the Python
probe has a 30-second budget and discovery a 120-second budget. Cancellation,
timeout and overflow are explicit failures. At most eight discoveries and 64
repository handles are retained per host session. Selection handles expire on
restart. A changed publisher requires repository reselection.

The executor kills and reaps the direct child. Current producer discovery does
not launch native descendants. This is not a process-tree executor for future
publish operations; descendant-aware cancellation and lost-finalization recovery
must be implemented before enabling mutating producer operations. File guards
identify the selected files, not the complete Python installation or all imported
modules; this boundary does not sandbox execution of an untrusted repository.

## Verification and remaining gates

The producer implementation used for discovery is committed as
`aa462d091e46f0cd5412ecc6564ce2cc393c369e` (publisher SHA-256 below).
The earlier `cbef1f80` working-tree reference was not a reproducible baseline.
Cross-repository tests now require this exact clean producer revision through
`tests/environment-producer-baseline.json`; see [Review closure](review-closure.md).
New producer `staging-cases.json` drives both shared reader and Windows CLI tests;
the latter verifies three spellings refer to one physical staging directory.
Historical unresolved-defect statements in earlier readiness records describe
the previous producer baseline and are superseded by this follow-up.

Executed checks:

- Root TypeScript typecheck and lint passed.
- Root `pnpm test`: 952 passed (160 core, 244 toolchain client, 45 CLI,
  503 Editor), including the updated exact native-command allowlist.
- `git diff --check` passed; neither sibling repository was modified.
- Rust suite: 76 passed, one opt-in integration test ignored in the default run.
- The opt-in real producer test was separately executed and passed. Discovery
  returned both Debug and Release deployments without choosing either.
- Editor Vite build passed with dependency directive and chunk-size warnings.

Reproduce the read-only real producer check from the repository root:

```powershell
cargo test --manifest-path apps/editor/src-tauri/Cargo.toml --lib environment_io::tests::real_producer_discovery_is_read_only_and_candidate_preserving -- --ignored --nocapture
```

It defaults to the sibling main repository; `GGLAB_ENVIRONMENT_SOURCE` can select
another producer checkout. The test runs discovery only. Its observed publisher
SHA-256 was `e4ee6713032e3acd0bc2c36b1a1c20b3d2a50630479df1cad7f7bdbcd68ebc47`.
Synthetic process tests cover script replacement, sharing guards, invalid
bootstrap data, cancellation, timeout and output overflow. IPC tests cover
admission races, correlation, changed identity, malformed bytes and host errors.

No live desktop dialog walkthrough, DX12/Vulkan shader compilation, Runtime
launch/load observation, or final-location compatibility qualification was run.
Actual import, init-state, publication, Tauri registry storage, state routing,
final-location proof and activation remain unimplemented in this native boundary.
The external contract still explicitly requires owner review before Editor
import; the producer fix does not satisfy or remove that approval requirement.
