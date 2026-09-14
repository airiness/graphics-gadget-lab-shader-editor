# Correctness and evidence review closure

Historical closure status: **blocked**, not ready to claim all review gates passed.
The subsequent working-tree fixes and current submission boundary are recorded
in [Review follow-up](review-followup.md). No Environment
functionality, import activation, or UX is added by this change.

## Editor correctness changes

Document sessions retain an opaque owner token backed by a private graph snapshot.
Only the document owner projects `DocumentEvidenceOrigin`: the session identity,
canonical revision and core-emitted source map are captured together. Callers
cannot supply an emission or construct a valid origin. Admission checks reject
unbranded objects; a copied owner token cannot rebind its session identity or
revision. Accepted history transitions mint a new snapshot; presentation-only
changes preserve it. The Preview composition checks its document is the owner's
snapshot. Native toolchain wire contracts are unchanged.

Build and Preview origin maps use `BuildId.sequence`. Regression tests reconstruct
BuildId objects while retaining the issuing owner. All Problems snapshot creation
and replacement share first-seen stable-identity deduplication; workspace composition
cannot bypass it. Build and Preview chronology retain historical attempts.

## Reproducible producer input

`tests/environment-producer-baseline.json` pins producer commit
`aa462d091e46f0cd5412ecc6564ce2cc393c369e`. The TypeScript fixture loader and
Rust real-producer opt-in test check HEAD and tracked worktree cleanliness before
consumption. `GGLAB_ENVIRONMENT_SOURCE` may select an isolated checkout, but cannot
select a different revision. Arbitrary fixture-directory overrides are rejected.
Updating the producer requires an explicit reviewed baseline change and rerun.
A future Main commit therefore fails this Editor's qualification rather than
silently replacing its evidence. Untracked native deployment outputs are separate
inputs, identified by executable hashes in the native evidence record.

The inspected Editor base is `3834509b771b57fb9b06607a613902ce5b2a51e5`.
Editor checks in this review run include the uncommitted patch on that base.
They are **not** evidence of two clean committed revisions. The owner requested
manual submission; no commit or Git history mutation was performed. After the
producer fix and Editor review commit exist, record both full commit IDs and
rerun from clean isolated checkouts before marking review closure complete.

For clean replay, clone each repository to a new directory, detach each clone at
the recorded full commit, and verify `git status --porcelain` is empty. Build
Main Debug and Release deployments with its owning build instructions before
real discovery/native qualification; a source-only clone is insufficient. Record
the newly built executable hashes rather than borrowing this run's binary evidence. Set
`GGLAB_ENVIRONMENT_SOURCE` to the pinned clean Main clone. From the Editor root:

```powershell
pnpm.cmd install --frozen-lockfile
pnpm.cmd typecheck
pnpm.cmd test
pnpm.cmd lint
git diff --check
cargo test --manifest-path apps/editor/src-tauri/Cargo.toml
cargo test --manifest-path apps/editor/src-tauri/Cargo.toml --lib environment_io::tests::real_producer_discovery_is_read_only_and_candidate_preserving -- --ignored --nocapture
pnpm.cmd --filter @gglab/editor build
python -B tests/qualify-environment-alias.py
```

The last command intentionally exits 1 on the pinned producer's defect. It is a
qualification gate, not a passing regression that blesses the producer's current
acceptance. It asserts physical identity, reports whether a distinct short alias
exists, and checks a renamed finalized control. It writes only disposable fixtures.
The Editor's Windows CLI test separately requires `incomplete-publication` through
its actual canonical-path reader. Filesystem hosts canonicalize the final root
after refusing reparse ancestors and before core staging classification.

## Main-repository revision request

Reproduction on Windows with distinct 8.3 names enabled:

| Same physical directory | Producer verify result |
| --- | --- |
| `.staging-long-review-name` | `incomplete-publication` |
| uppercase spelling | `incomplete-publication` |
| `STAGIN~1` short alias | **accepted (failure)** |
| renamed finalized control | accepted |

`Scripts/Environment/publish_environment.py:is_staging_name` still classifies the
caller basename after `plain_path`/`abspath`. Short aliases conceal the reserved
prefix. Resolve the actual final directory identity/path before classifying an
existing publication, without relaxing reparse/hardlink/containment validation.
Apply the rule consistently to verify and init-state, and review existing and
nonexistent publish destinations and ancestor aliases. Preserve the internal
private-staging verification exemption; it must not be exposed through requests.

Extend the main-owned contract and fixtures with the 8.3 policy and actual
same-file evidence, including the no-distinct-alias case. If short aliases are
unsupported, specify and enforce an explicit fail-closed rejection. Do not accept
a staging directory merely because its caller spelling lacks the reserved prefix.
Run the Environment tests, short-alias qualification and relevant native regressions,
commit the fix, then explicitly update this Editor's pinned producer revision.
Neither sibling repository was edited for this review.

## Executed evidence and limitations

- Main contract suite: 20 tests passed on the pinned clean tracked revision.
- Main Windows short-alias qualification: **failed**, distinct alias available.
- Editor root tests: 955 passed (160 core, 244 client, 46 CLI, 505 Editor).
- Editor typecheck, lint, diff whitespace check, and Vite build passed.
- Rust: 76 passed; the separately executed opt-in discovery test also passed and
  printed the pinned producer revision, publisher/interpreter hashes and both candidates.
- Main native qualification: Debug/Release x DX12/Vulkan x profile v1/v2, eight
  paths passed using the existing exact deployment executables. Final-location
  handshakes, ordinary compilation, Loaded observations, failed-build last-good
  retention, recovery and immutable closure checks passed. Debug Vulkan validation
  was enabled; Release validation was disabled. See the compact
  [native evidence record](review-closure-native-evidence.json).

Native commands used the pinned producer's `Tests/Environment/qualify_native.py`
with each existing `Build/Output/x64/{Debug,Release}` deployment and a new ignored
`.review-evidence/native-{debug,release}` output directory. Original source
checkouts were not moved or modified. Only the temporary source mirror became
unavailable; this is not system-wide checkout access denial. Raw local logs and
reports remain in those output directories, with report hashes recorded above.
No fresh Main C++ build or clean post-review Editor revision qualification was
performed. Existing deployment binaries are qualified by their recorded hashes,
not asserted to be freshly built from the pinned source revision. Publication
contract owner approval remains pending and was not inferred from these tests.
