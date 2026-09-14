# Final portable release

The owner ended ShaderEditor maintenance on 2026-09-14. Release binaries live
in this repository's GitHub Release; generated packages are not Git objects.
The frozen gglab producer is `0151ae75c6e88bab17f58aeef8a7e3eee43521bc`.
Use that revision even after the main project removes Editor integration.
The Editor source revision and each member digest are recorded in the ZIP's
`release-manifest.json`. The final source tag is `v0.1.0-final`.

## Run

Extract all files to a short, writable local Windows x64 directory such as
`D:/GGLabEditor`, then run `ShaderEditor.exe`. In **GGLab Environment...**,
choose **Use bundled Environment**. This opens the adjacent Environment and
State through host-owned handles and runs the existing full activation proof.
Open the bundled Examples folder as a workspace, then build/preview a graph.
Node, pnpm, Rust, Python, Git, Visual Studio and Internet are not runtime
requirements. Compatible DX12/Vulkan GPU drivers remain platform requirements.

Environment is immutable; State is initialized from its BaseArtifacts during
packaging. UserData contains portable preferences, registrations and WebView2
data. Registration directories are scoped to the canonical extraction path,
so moving the whole package requires fresh registration and proof. No saved
readiness is shipped. Keep the State path within 90 UTF-16 code units.

The package uses Microsoft's fixed WebView2 152.0.4191.62 x64. Its files are
loaded through process-local WebView2 configuration before Tauri starts.
No system installation or global environment modification is performed.

## Rebuild

Check out the producer pin and the Editor release tag. Build gglab x64 Release
with its recorded dependencies. Ensure the deployment contains dxcompiler.dll
and dxil.dll from the pinned Microsoft.Direct3D.DXC 1.9.2607.13 x64 package.
The owner's initial Release output omitted these two DLLs; they were copied
from the pinned package without changing the executable bytes or source pin.

Run `pnpm install --frozen-lockfile`, the normal verification commands, then
`pnpm --filter @gglab/editor tauri:build`. Download/extract the official fixed
WebView2 CAB and run the following from a clean Editor checkout:

```powershell
python scripts/package-portable.py --main D:/src/gglab --editor D:/src/editor --webview D:/deps/WebView2 --destination D:/out/GGLabEditor
```

The destination must not exist. Build tooling is required only to reproduce
the package. ZIP the entire resulting directory, including empty State folders.
Record the ZIP SHA-256 externally. Never package a State used for qualification.

## Evidence

The main Environment suite passed 21 tests. Fresh Release native qualification
passed DX12/Vulkan with both Surface profiles, first production frames,
failed-build last-good preservation, recovery, and immutable closure checks.
Its disposable publication-source mirror was renamed before native execution.

The Editor candidate passed native import/activation with 16 proof Preview
runs and 10 authoring runs, including all three bundled sample graphs,
retargeting and registered workflow reuse. See final-release-native-evidence.json.
Typecheck, lint, the affected TypeScript suites and Rust tests were run; detailed
final artifact verification is recorded separately with the published release.

Computer Use and manual desktop interaction were excluded at the owner's
request. These automated checks do not claim clean-machine qualification,
OS-wide source access denial, or pixel-level UI acceptance. Existing Vite
chunk/directive warnings and one Rust test-fixture unused-field warning remain.

## Final archive acceptance

The published ZIP is `ShaderEditor-v0.1.0-final-win-x64.zip` (449,970,096 bytes).
SHA-256: `f5fd2d9828eeb1b1c0d47eaa41385f608e1f54080b941a38dc99e51f3dad1867`.
The exact packaged Editor commit is `404adbe60550ce37e6a4a3855a98a6e9b7c8a54f`.

All 1,969 members passed hash/size verification after extracting the final ZIP
to a new short local path. Native import/activation and sample authoring passed
again against that extracted Environment (16 proof runs and 10 authoring runs).
The immutable Environment was reverified after execution. A process-only desktop
smoke test started the extracted Editor with development tools removed from PATH
and confirmed it used the bundled WebView2 executable. No UI interaction occurred.
The ZIP downloaded again through the repository's authenticated release API had
exactly the same SHA-256. Repository access permissions were not changed.

Final checks passed: 1,048 TypeScript tests, 101 Rust tests, typecheck and lint.
Opt-in tests skipped in ordinary runs are qualified separately as described above.
See `final-release-verification.json` for the public summary. Raw machine paths,
process logs and full native transcripts remain in ignored local release outputs.
