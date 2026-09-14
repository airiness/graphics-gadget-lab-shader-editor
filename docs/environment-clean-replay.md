# Environment review closure: clean replay

Executed on Windows on 2026-09-08 against this exact pair:

- Main: `0a4ce8f26e39fb8740758e4eb275db9d2fe619ec`.
- Editor: `07ecc3f1b659d40c0a332e8adca704ff6f6d63bd`.

The Editor fix is `a835ca86a4064f0221e6052a6b451d1933bb7380`; the following
Editor commit changes only the producer baseline. This evidence record is added
after the replay and names the tested commits rather than claiming its own
future commit was tested. It supersedes the pending replay statements in
[review-followup.md](review-followup.md), preserving that historical record.
The publication contract remains an implemented proposal pending owner review
before Editor import. No import approval, Environment feature or UX is added.

## Isolation and identity

Two new local clones were created with `--no-hardlinks`, under ignored
`.review-evidence/m` and `.review-evidence/e`. Their tracked trees were clean
before and after execution. Main's nine dependencies were checked out at the
exact gitlink revisions and checked clean. Neither clone reused the original
Main build output. Debug and Release were built freshly from the solution,
including package restore, with zero build warnings or errors.

[The machine-readable record](environment-clean-replay.json) contains full
revisions, dependency pins, tool versions, executable SHA-256 values, native
observations and raw report/log hashes. Raw logs remain local under ignored
`.review-evidence/`; they are not redistributed as repository build artifacts.
Fresh build hashes identify this execution; rebuilding on another machine is
not promised to reproduce identical native executable bytes.

Qualification reads Main only when explicitly enabled, requires the pinned
revision and a clean tracked tree, and never falls back to unversioned fixtures.
Ordinary tests were run with an explicitly nonexistent Main path.

## Results

| Gate | Result |
| --- | --- |
| Main Environment contract/unit suite | 21 passed; real distinct 8.3 alias exercised |
| Editor Windows alias qualification | long, uppercase and distinct short alias rejected; finalized control accepted |
| Main Debug and Release fresh solution builds | Both passed |
| Application self-tests, each configuration | 186 checks passed |
| App Runtime self-tests, each configuration | 44 checks passed |
| Toolchain self-tests, each configuration | 235 checks passed |
| Runtime self-tests, each configuration | 621 checks passed |
| Editor frozen-lockfile install, typecheck, lint, web build | Passed |
| Editor ordinary tests | 937 passed; six opt-in qualification tests intentionally skipped |
| Pinned client / Windows CLI qualification | 17 / 7 passed |
| Rust default suite | 76 passed; real producer test ignored by default |
| Rust real producer discovery, explicitly enabled | One passed; both freshly built deployment candidates preserved |
| Both clean trees, `git diff --check` | Passed |
| GitHub Actions at the tested Editor SHA | [Run 34230676864 succeeded](https://github.com/airiness/graphics-gadget-lab-shader-editor/actions/runs/34230676864) |

All eight Debug/Release x DX12/Vulkan x Surface Profile v1/v2 native paths
passed. Each used the published final location for ordinary and Preview
handshakes, native compilation, first production frame and Loaded observation.
Invalid compilation returned exit 4 and preserved last-good pointer and
observation; recovery loaded successfully and the immutable closure remained
unchanged. Debug Vulkan validation was enabled with zero warnings or errors.
Release Vulkan validation was disabled; its successful runtime checks do not
constitute validation-layer evidence.

## Replay commands

Use independent clean checkouts at the full SHAs above, with Main's recursive
submodules initialized at their recorded gitlinks. Verify `git rev-parse HEAD`
and `git status --porcelain` in each checkout. Use short absolute paths, Windows,
Python 3.12+, the pinned pnpm version, VS 2022 C++ tooling, Windows SDK and the
Main-required Vulkan SDK. The local run used the versions in the JSON record.

From Main, repeat the build command for Debug and Release:

```powershell
& 'C:/Program Files/Microsoft Visual Studio/2022/Professional/MSBuild/Current/Bin/MSBuild.exe' GraphicsGadgetLab.sln /restore /p:RestorePackagesConfig=true /m /p:Configuration=Debug /p:Platform=x64
python -B Tests/Environment/test_environment.py
```

For each configuration, run `GraphicsGadgetLab.exe --self-test all`,
`GGLabAppRuntimeTests.exe`, `GGLabShaderToolchainTests.exe` and
`GGLabRuntimeTests.exe` from `Build/Output/x64/<configuration>` with Main as the
working directory. Run final publication qualification using new output paths:

```powershell
python -B Tests/Environment/qualify_native.py --deployment Build/Output/x64/Debug --output D:/replay/nd
python -B Tests/Environment/qualify_native.py --deployment Build/Output/x64/Release --output D:/replay/nr
```

From Editor:

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '0'
$env:GGLAB_ENVIRONMENT_SOURCE = 'D:/absent-replay-main'
pnpm.cmd test
pnpm.cmd lint
pnpm.cmd --filter @gglab/editor build
cargo test --offline --manifest-path apps/editor/src-tauri/Cargo.toml
$env:GGLAB_ENVIRONMENT_SOURCE = 'D:/replay/main'
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '1'
pnpm.cmd --filter @gglab/shader-toolchain-client test tests/environment.test.ts --testTimeout=30000
pnpm.cmd --filter @gglab/shader-graph-cli test tests/environment.test.ts
python -B tests/qualify-environment-alias.py
cargo test --offline --manifest-path apps/editor/src-tauri/Cargo.toml --lib environment_io::tests::real_producer_discovery_is_read_only_and_candidate_preserving -- --ignored --nocapture
git diff --check
```

Replace `D:/replay/main` with the clean pinned Main checkout, not the active
sibling checkout. Offline Cargo requires the locked dependencies already cached;
a fresh machine must fetch them first. Output directories for native qualification
must not already exist. Check both repositories and dependency revisions again
after execution.

## Limits and execution notes

- The grouped manifest qualification exceeded Vitest's default five-second
  per-test limit, both during builds and on an idle retry (6.2 seconds). The final
  successful run explicitly used a 30-second integration-test limit. No fixture,
  assertion, revision guard or source file was changed to obtain that result.
- Main's real 8.3 regression covers verify, init-state and publish, including
  an absent destination and finalized control. On a volume without a distinct
  alias, Main explicitly skips and Editor reports unsupported with exit 77;
  that platform cannot claim successful short-alias execution evidence.
- Source isolation renamed only a disposable publication-source mirror. It
  was not system-level access denial or syscall tracing of the original checkout.
- Synthetic reader fixtures are not native compatibility proof. Main-owned
  native qualification is separate from Editor production import, which remains
  disabled pending the existing owner approval boundary.
- No fresh no-PCH build, long-path qualification, system-level isolation audit,
  or production Editor import/GUI end-to-end test was performed in this replay.
- The web build retained existing dependency directive/chunk-size warnings;
  Rust retained an existing unused-field warning. Neither gate failed.
