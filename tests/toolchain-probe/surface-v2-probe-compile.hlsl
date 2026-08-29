// Native compile probe — gglab.surface profileVersion 2.
//
// The included bytes are the exact ShaderGraphCore emission for
// hlsl-emitter.test.ts::textureDocument(). This main-repository-shaped
// wrapper owns the pixel entry semantics and supplies the generated
// function's graph parameters in stable-id order, followed by uv0.

#include <generated-surface-function-v2.hlsl>

StructuredBuffer<float> g_ProbeScalarFactors;
StructuredBuffer<uint2> g_ProbeTextureBindings;

float4 PSMain() : SV_Target
{
	const float roughnessFactor = g_ProbeScalarFactors[0];
	const uint2 textureSamplerBinding = g_ProbeTextureBindings[0];
	const float2 uv0 = float2(0.5, 0.5);

	const SurfaceData surface = EvaluateSurface(
		roughnessFactor, textureSamplerBinding, uv0);

	// Keep every profile output observable, matching the permanent
	// contract-test pattern in the main repository.
	const float checksum = dot(surface.BaseColor, 1.0.xxx) +
		dot(surface.Emissive, 1.0.xxx) +
		surface.Metallic + surface.Roughness + surface.Opacity;

	return float4(surface.BaseColor + float3(checksum, 0.0, 0.0), surface.Opacity);
}
