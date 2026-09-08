# Review follow-up: diagnostic identity, CI isolation and staging aliases

This record describes working-tree fixes on Editor
`f15cd35e168635ac251073b04565d625d9f270db` and Main
`aa462d091e46f0cd5412ecc6564ce2cc393c369e`. It is not final clean-revision
qualification and does not approve Environment import.

## Diagnostic identity

Graph problem identity is a collision-safe JSON tuple of document session,
document revision, diagnostic code, severity, data path and message. Aggregate
array position is excluded. A diagnostic repeated by graph validation and failed
emission therefore has one identity and one Problems entry. Different facts and
different revisions retain distinct identities. The new regression uses actual
core validation and emission on an invalid graph; it does not inject duplicate
Problems entries as a substitute for the reported trigger.

## Ordinary tests and opt-in producer qualification

Ordinary tests use explicit local synthetic manifests built from the consumer's
role constants. These are unit data, not producer/native compatibility evidence,
and never a fallback when qualification fails. Ordinary tests require no sibling
checkout, including when the configured Main path does not exist. CI exercises
that absence explicitly.

Only tests enabled with `GGLAB_ENVIRONMENT_QUALIFICATION=1` read producer fixtures.
Every fixture/revision read happens inside the test body. Importing the helper or
registering skipped tests does not read Main. The version pin and tracked-clean
checks remain mandatory; a missing checkout, changed SHA or dirty checkout fails
an explicitly requested qualification. No arbitrary fixture fallback is permitted.

From the Editor root, with a clean checkout of the pinned Main revision:

```powershell
$env:GGLAB_ENVIRONMENT_QUALIFICATION = '1'
$env:GGLAB_ENVIRONMENT_SOURCE = 'D:/path/to/pinned-clean-main'
pnpm.cmd --filter @gglab/shader-toolchain-client test tests/environment.test.ts
pnpm.cmd --filter @gglab/shader-graph-cli test tests/environment.test.ts
```

The second command requires Windows for physical filesystem qualification.
Grouped vector tests still iterate every producer case; the smaller test count
reflects lazy grouping rather than dropping vectors. The Rust real-producer test
remains separately opt-in through `--ignored` and keeps its revision guard.

The GitHub Actions API confirmed run `34198240804` at Editor `f15cd35` failed in
the Ubuntu workspace test step, while the Windows Rust job passed. The job log
endpoint returned HTTP 401. No new remote run has been published by this work,
so remote green status is not claimed.

## Main-owned staging fix

With owner authorization, Main's `plain_path` now rejects reparse ancestors before
resolving existing filesystem components, including Windows 8.3 names. It rechecks
the resolved ancestors. Missing destination suffixes are retained after resolving
existing ancestors. Staging classification uses that final canonical basename;
verify, init-state and publish share the rule. Internal staging verification
remains a private exemption, not a new machine-request capability.

Main's new Windows regression asserts the short and long paths name the same
physical directory, rejects long/case/short aliases through all three process
operations, checks absent publication preflight, and accepts the renamed final
control through verify and init-state. Lack of a distinct short basename is an
explicit unittest skip. Distinct short names were available in this run; the test
executed and passed. The Editor alias qualification script also reports an
explicit skip (exit 77 and null qualification result) when no distinct alias
exists, rather than reporting successful short-alias evidence. Main README documents this policy. The docs repository was
not modified and the proposal approval state remains unchanged.

## Executed checks and submission boundary

- Main Environment suite: 21 passed, including the real 8.3 regression.
- Editor ordinary suite with an explicitly nonexistent Main path: 937 passed,
  six cross-repo tests skipped intentionally (160 core, 227 client, 44 CLI,
  506 Editor passed).
- Opt-in qualification using an isolated clean clone of the unchanged pin:
  17 client tests and seven Windows CLI tests passed. The new dirty Main tree
  was not substituted for the pinned revision.
- Editor typecheck, lint, web build and diff whitespace check passed.
- Main working-tree native regression with existing Debug/Release deployments:
  all eight DX12/Vulkan x profile v1/v2 paths passed, including last-good retention,
  recovery and immutable closure. No fresh C++ build was performed. See
  [working-tree native evidence](review-followup-native-evidence.json); raw reports
  remain under ignored `.review-evidence/alias-fix-{debug,release}`.
- Rust suite: 76 passed; the real-producer discovery test was not rerun against
  the uncommitted Main fix because its clean-revision guard intentionally refuses it.

The Main fix has no commit SHA yet. The existing producer pin is deliberately
unchanged. Final replay requires committing the reviewed Main fix, committing the
Editor fixes, then a separate Editor change containing only the new producer pin
and its qualification metadata. Record those actual full commits, create clean
checkouts, rebuild Main Debug and Release, and run the full qualification list.
Only a subsequent successful GitHub Actions run establishes remote green status.
Existing binaries and uncommitted fixes are not a substitute for that final replay.
