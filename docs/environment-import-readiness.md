# Environment import readiness and publisher handoff

Status: prerequisite assessment, 2026-09-07. Environment import is not
implemented. This document records consumer requirements and inspected
evidence; it does not define an approved publication protocol or manifest.

## Authority and inspected baseline

The authoring architecture remains
[`GGLab_Shader_Graph_Editor_Architecture.md`](GGLab_Shader_Graph_Editor_Architecture.md).
Process integration remains
[`GGLab_Shader_Toolchain_Integration_Design.md`](GGLab_Shader_Toolchain_Integration_Design.md).
The workspace guidance is owned by the sibling docs repository:
`../../GraphicsGadgetLabDocs/GGLab_Shader_Editor_Workspace_And_UX_Evolution_Guidance.md`,
especially sections 5.3-5.6, 14, and 16. It explicitly leaves the manifest
schema and publisher mechanism open, and requires main-repository approval
of the publication contract before Editor import implementation.

Inspected repository revisions:

| Repository | Revision | Relevant evidence |
| --- | --- | --- |
| Shader Editor | `9ed9e9c` | Shared GUI/CLI semantic edit commands; existing deployment-path-based Preview integration |
| Main GGLab | `ad40b36f` | Shader compiler commands, Runtime packaging script, deployment junction targets |
| GGLab docs | `9518201` | Workspace guidance and existing toolchain contract documentation |

These revisions describe the assessment, not a permanent readiness claim.
Recheck the producer implementation and contract before resuming import work.

## Current boundary and missing prerequisite

No approved Environment publication protocol, manifest instance, or publisher
was found in the inspected first-party sources, tracked scripts, build targets,
and design documents.

- Main `Sources/Tools/ShaderCompiler/ShaderCompilerCommandLine.h` and `.cpp`
  expose compile, build-runtime, build-preview, targets, version, help,
  describe, and describe-preview. They provide no Environment publication
  operation. A future publisher need not be a shader compiler command.
- Main `Scripts/BuildArtifactOnlyRuntimePackage.ps1` creates an artifact-only
  Runtime package. Its validation explicitly forbids `gglab-shaderc.exe`,
  DXC dependencies, and shader source files. That package cannot provide the
  authoring and Preview build closure requested by the workspace guidance.
- Main `PropertySheets/LinkShaderDirectory.targets` and
  `PropertySheets/LinkAssetDirectory.targets` create deployment junctions to
  source resources. A development output directory therefore does not, by
  itself, establish independence from the source checkout.
- Editor `apps/editor/src/discovery-config.ts` and native
  `apps/editor/src-tauri/src/shader_tool/discovery.rs` discover an exact
  executable from configured locations. They do not enumerate published
  Environments or verify an immutable closure.
- Editor `apps/editor/src-tauri/src/shader_tool/service.rs` derives Preview
  shader, cache, artifact, and Runtime locations from the deployment root.
  Those existing development-layout assumptions must be replaced by
  publisher-owned roles for Environment operations.

Existing ShaderArtifact and Preview publication contracts establish their
own products. They do not establish the closure of an Environment containing
executables, dependencies, profile resources, composition inputs, and
designated writable state.

Consequently, the next dependency is the GGLab-owned publication contract
and implementation. Adding an Editor directory copier, guessed manifest
reader, or placeholder registry would not satisfy this dependency.

## Requested producer deliverables

The following are consumer acceptance needs for main-repository review.
Field names, version values, identity encoding, file layout, command names,
and copy membership remain producer decisions.

| Deliverable | What the Editor needs to consume |
| --- | --- |
| Bootstrap discovery | A bounded way to identify eligible deployments and the publisher; ambiguous candidates can be presented for selection without assuming a single Debug/Release path |
| Publication process | An explicit invocation contract with structured outcomes, supported-version behavior, cancellation/failure semantics, and an unambiguous finalized destination |
| Immutable closure | A versioned, bounded manifest with membership, roles, relative locators, hashes, provenance, and an authoritative Environment identity rule |
| Locator rules | Containment, path normalization, duplicate/collision handling, and link/reparse-point policy that prevent hidden dependencies on the source checkout |
| Writable state | Designated cache, produced artifact, Preview publication/pointer, observation, and log locations; their mutation cannot change immutable identity or replace contract truth |
| Finalization | Atomic visibility of a complete publication, defined existing-destination behavior, and interrupted-publication handling |
| Runtime integration | A supported way to resolve immutable inputs and writable outputs at the final location, including required base registries and Preview resources |
| Compatibility and fixtures | Explicit consumer version rejection, positive and negative manifest/process fixtures, and producer-owned evidence for relocation and source-independent operation |

The manifest locates facts; it does not supersede their authorities. Exact
executable observations remain host-owned, tool capabilities remain
handshake-owned, profile semantics remain descriptor/core-owned, and loaded
Preview publication state remains Runtime-observation-owned.

## Editor implementation sequence after producer delivery

1. Read the approved producer specification and fixtures. Add strict readers
   and a narrow host adapter for that actual contract. Keep path derivation,
   filesystem access, executable observation, and process invocation in the
   host; expose bounded operations and host-issued identities to the WebView.
2. Implement import as bootstrap/preflight, producer-owned staging and
   finalization, final-location verification, then registration. Source
   candidate proof must never be transferred to the destination candidate,
   even if executable hashes match. Cancellation or failure must leave the
   current registration and active configuration unchanged.
3. Verify the finalized manifest and immutable closure, observe the final
   executables, obtain fresh ordinary and Preview handshakes, and resolve
   required descriptors through core. Register only a verified result;
   retain structured failure evidence for unsuccessful imports.
4. Integrate the Environment registry and workspace selection. Registration
   must not implicitly launch or retarget Runtime. Active switching follows
   the existing Preview coordinator's stop/await/revalidate discipline;
   unproven termination prevents the switch. Keep Loose Development
   Configuration explicit and separate from Environment role resolution.
5. Resolve each document's persisted profile request within the active
   Environment without upgrading its profile line. Project verified facts
   into the GUI and preserve exact executable checks at every use boundary.

This is a consumer work order, not a serialized state-machine specification.
Final transaction details depend on the approved producer contract.

## Acceptance evidence required before claiming completion

- Unknown manifest/process versions, malformed roles, escaped paths,
  missing members, hash mismatches, and incompatible handshakes/descriptors
  produce explicit rejection and cannot create an active registration.
- Failed or cancelled staging, finalization, verification, and registration
  preserve the previous usable Environment. Concurrent imports and retries
  follow the producer's finalized-destination semantics.
- A copied executable with identical bytes still receives fresh proof at
  its final path. Executable replacement after verification is refused by
  the existing launch/use provenance boundary.
- Cache/artifact/Preview activity changes only designated writable state;
  the immutable closure and Environment identity remain intact.
- Switching while Runtime is attached respects confirmed termination,
  revalidates current workspace state, and rejects stale results from the
  previous Environment.
- With the source checkout unavailable, a finalized Environment can perform
  the supported authoring-to-native-Preview workflow. DX12/Vulkan evidence
  must come from main-owned native qualification for the supported targets;
  Editor unit tests alone cannot establish that claim.

The assessment did not run the publisher, relocate a deployment, or execute
native Preview qualification. There is no Environment publisher to consume
at the inspected baseline, and the sibling repositories were read-only.
