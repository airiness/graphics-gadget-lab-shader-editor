# Managed Environment state path qualification

New Editor-owned producer intents use `intentVersion: 2`. Publications retain
`environments/<operationId>`. New writable state uses `s/<compactOperationId>`
under the same managed application-data root. The compact spelling is the
lowercase base-36 encoding of the complete 128-bit hexadecimal operation ID;
it is reversible, case-insensitive-safe and never a truncated hash.

The intent version owns this Editor storage-layout change only. Producer request,
manifest, state binding, source identity and native wire contracts are unchanged.
Version 1 intents still resolve their original `environment-state/<operationId>`
location. The reader supports versions 1 and 2 and rejects unknown versions;
native journal validation recomputes the exact destination for the saved version.
Existing operations, state and registry records are never moved or rewritten.

The Windows execution host supports state roots of at most 90 UTF-16 code units
in their canonical path spelling. New init-state preparation checks this before
creating its target parent or writing an intent; opening an execution checks it
before native work. Refusal uses structured `path-too-long` diagnostics and
preserves existing state. This is a conservative Editor host support limit, not
an Environment publication rule or a claim of general Windows long-path support.
A managed application-data root too long for the compact destination is explicitly
refused; no fallback writes outside the managed root, drive mappings or aliases
are created. Existing long state remains readable for inspection/reconciliation,
but execution requires explicit selection of a shorter independent state.

The limit leaves room below the traditional 260-unit boundary for the pinned
producer's Preview cache source path, full SHA-256 and temporary suffix. The
native implementation owns those names and remains the compatibility authority;
this limit does not reconstruct native shader/backend policy. Requalify it when
changing the pinned producer. The full source hash and per-attempt isolation in
Editor staging remain intact.

The earlier failure was native `StageGeneratedSource` below a 117-unit managed
state path. This increment qualifies newly generated compact managed paths,
using actual producer mutation and then the existing final-proof/import service.
It does not replace those paths manually with short test state roots. See
`environment-managed-state-evidence.json` for exact roots, revisions and results.

Reproduction uses the existing opt-in tests described in
[producer mutations](environment-producer-mutations.md) followed by
[import transaction](environment-import-transaction.md). Supply the mutation
result's Environment and state roots as `GGLAB_PROOF_ENVIRONMENT` and
`GGLAB_PROOF_STATE`, and a fresh `GGLAB_REGISTRATION_ROOT`. The clean Main revision
must match `tests/environment-producer-baseline.json`. If a retained test clone
belongs to another Windows account, a process-local Git `safe.directory` setting
for that exact clone can authorize provenance reads without changing global Git
configuration.

Workspace activation remains a separate implementation step. No Main source,
producer pin, native compiler policy or UI is changed here. Evidence is bound to
the Editor base revision and working-tree source hashes, not a clean commit replay.

Verification on 2026-09-10 passed: typecheck, 966 TypeScript tests (nine skipped),
lint, 93 Rust tests (three ignored), Editor web build and real producer discovery.
Debug/Release producer mutation and final import qualification passed using the
actual new 87-unit managed state roots: both backends and profile lines, including
fresh proof on duplicate import and lost commit acknowledgement recovery. The
original 117-unit state was retained and returned `path-too-long` before native
execution. The 90/91-unit and supplementary-Unicode boundary tests are unit tests,
not native evidence at those exact path lengths. A transient CLI Windows rename
`EPERM` disappeared when the unchanged complete test suite was rerun. Existing
web build and Rust fixture warnings remain. Main was neither modified nor rebuilt.

The next ownership transaction is implemented in
[Workspace Environment activation](environment-workspace-activation.md).
