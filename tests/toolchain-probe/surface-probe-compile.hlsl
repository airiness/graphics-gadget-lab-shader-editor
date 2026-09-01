// Native compile probe — gglab.surface profile line, profileVersion 1.
//
// What this proves: the graph-generated surface function (included below)
// is valid HLSL under the profile line's compile contract once composed
// into a full program the same way the canonical contract test composes
// it: a hand-authored `PSMain : SV_Target` entry supplies every semantic
// and CALLS the generated function with its contract signature (graph
// parameters in stable-id order, then the graph-visible `uv0` input).
//
// Contract references (read these before running):
//   - main repo Shaders/Profiles/GGLab.Surface/1/descriptor.json
//     (generatedFunction: the FUNCTION contract this probe exercises)
//   - main repo Shaders/Tests/SurfaceContractCompile.hlsl
//     (canonical v1 program shape: entry + generated-function call)
//   - main repo Shaders/Tests/SurfaceTextureContractCompile.hlsl
//     (the draw-time factor-buffer pattern used below)
//   - docs repo GGLab_Shader_Toochain_Extraction.md, section 21
//     (the compile CLI contract: --stage pixel --entry PSMain)
//
// Provenance: the included function is byte-exact GGLab ShaderGraphCore
// output for the v1 emitter fixture graph (identity in README.md). This
// wrapper is a throwaway verification fixture for the surface-program
// composition investigation (option A), not product content.

// Angle-bracket include, resolved against --source-root (the canonical
// main-repo pattern, e.g. `#include <Common/SurfaceEvaluation.hlsli>`).
#include <generated-surface-function.hlsl>

// Draw-time state for THIS material's graph parameters, one slot each,
// in the generated signature's order:
//   [0] gglab_p_metal (float)   [1] gglab_p_tint (float3)
StructuredBuffer<float>  g_ProbeScalarFactors;
StructuredBuffer<float3> g_ProbeVectorFactors;

float4 PSMain() : SV_Target
{
	const float  metal = g_ProbeScalarFactors[0];
	const float3 tint  = g_ProbeVectorFactors[0];

	const SurfaceData surface = EvaluateSurface(metal, tint, float2(0.5, 0.5));

	// Keep the profile fields observable so this probe cannot be dropped
	// wholesale by dead-code elimination (canonical probe pattern).
	const float checksum = dot(surface.BaseColor, 1.0.xxx) +
		dot(surface.Emissive, 1.0.xxx) +
		surface.Metallic + surface.Roughness + surface.Opacity;

	return float4(surface.BaseColor + float3(checksum, 0.0, 0.0), surface.Opacity);
}
