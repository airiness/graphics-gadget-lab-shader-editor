/**
 * Native-build SURFACE tests (the React hook over the pure modules),
 * driven against the reference fake boundary — the product path in its
 * desktop shape, with the Tauri host module mocked to the fake.
 *
 * The invariant these pin: an ADMITTED attempt is IN FLIGHT on the
 * session line before its settlement is awaited — the surface observes
 * it (the in-flight row and its cancel target) for the WHOLE window.
 * The compile must not learn of its own attempt only when the attempt
 * has already settled: that would make the cancel invisible for the
 * entire compile, and Step 4's explicit compile/cancel surface would
 * not exist in the window it is for.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHostBoundary, utf8Encode } from "@gglab/shader-toolchain-client";
import { parseSurfaceProfileDescriptor, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { useNativeBuild } from "../src/useNativeBuild.js";
import type { CompileRequestFacts } from "../src/native-build-flow.js";

/** The fake boundary the (mocked) host module creates — reachable from
 *  the test side for its settlement controls (releasePending,
 *  releaseDiscovery, releaseHandshake). The pending knobs are read when
 *  the hook CREATES its boundary (i.e. per test), so each test gets its
 *  own world shape and its own counts. */
const surfaceWorld = vi.hoisted(() => ({
    boundary: null as unknown,
    holdDiscovered: false,
    holdHandshake: false,
}));

vi.mock("../src/toolchain-host.js", async () => {
    const { FakeHostBoundary: Boundary } = await import("@gglab/shader-toolchain-client");
    const candidate = {
        rule: "bundled" as const,
        toolPath: "C:\\tools\\gglab-shaderc.exe",
        observationIdentity: "obs-1",
        resolvedAt: 1_000,
    };
    const describeDocument = JSON.stringify({
        command: "describe",
        success: true,
        status: "ok",
        exitCode: 0,
        processContractVersion: 1,
        toolIdentity: "gglab-shaderc",
        toolVersion: "1.2.0",
        producerKind: "dxc",
        producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
        diagnostics: [],
    });
    const compileOk = JSON.stringify({
        command: "compile",
        success: true,
        status: "ok",
        exitCode: 0,
        recipeId: "3f".repeat(32),
        buildKey: "5e".repeat(32),
        binaryHash: "9c".repeat(32),
        binaryFormat: "dxil",
        target: "gglab-dx12",
        binaryPath: "C:/gglab/build/gglab-dx12.dxil",
        cacheRecordPath: "C:/gglab/build/gglab-dx12.dxil.rct",
        fromCache: false,
        diagnostics: [],
    });
    const createBoundary = () => {
        const fake = new Boundary({
            discovery: { kind: "resolved", candidate },
            handshake: { stdout: describeDocument, exitCode: 0 },
            compile: [{ stdout: compileOk, exitCode: 0 }],
            keepCompilePending: true,
            keepDiscoveryPending: surfaceWorld.holdDiscovered,
            keepHandshakePending: surfaceWorld.holdHandshake,
        });
        surfaceWorld.boundary = fake;
        return fake;
    };
    return {
        toolBoundaryAvailable: () => true,
        createTauriToolBoundary: async () => createBoundary(),
    };
});

/** The proven v1 descriptor shape (the same one the app's reader
 *  accepts): the process contract demands gglab-shaderc >= 1.0.0 —
 *  the fake tool (1.2.0) meets it. */
const descriptor: SurfaceProfileDescriptor = (() => {
    const fixture = {
        descriptorVersion: 1,
        profileId: "gglab.surface",
        profileVersion: 1,
        language: "hlsl",
        generatedFunction: {
            name: "EvaluateSurface",
            stage: "pixel",
            returnValue: { objectName: "SurfaceData", fieldsSource: "requiredOutputs" },
            parameterContract: {
                ordering: "graphParametersThenGraphVisibleInputs",
                graphParameters: { source: "graphDocument", classConstraint: "parameterClasses" },
                graphVisibleInputs: { source: "graphVisibleInputs" },
            },
        },
        graphVisibleInputs: [{ id: "uv0", type: "float2", semantic: "primary texture coordinate supplied by the rendering pass" }],
        requiredOutputs: [
            { name: "BaseColor", type: "float3", required: true, semantic: "linear-RGB albedo contribution (pre-lighting)" },
            { name: "Roughness", type: "float", required: true, semantic: "perceived roughness factor" },
            { name: "Opacity", type: "float", required: true, semantic: "raw surface alpha" },
        ],
        outputFieldOrdering: "descriptorListOrder",
        parameterClasses: [{ class: "ScalarParameter", valueTypes: ["float"] }],
        resourceClasses: [],
        samplingContract: {
            policy: "reuseRuntimeTextureSamplerBinding",
            appliesToResourceClass: "Texture2D",
            samplerAuthoring: "deferred",
            samplerResolution: { owner: "materialBindingLayer", cardinality: "oneSamplerPerTexture2DBinding" },
            authorableFilterModes: [],
            authorableAddressModes: [],
            comparisonSamplerAuthoring: "deferred",
        },
        requiredIncludes: [],
        processContract: { tool: { identity: "gglab-shaderc", minimumVersion: "1.0.0", versionComparison: "semver" } },
        deferred: { parameterClasses: ["BoolParameter", "SamplerParameter"], surfaceOutputs: ["normalTangentSpaceAuthoring"] },
    };
    const parsed = parseSurfaceProfileDescriptor(JSON.stringify(fixture));
    if (!parsed.ok || parsed.value === null) {
        throw new Error("the descriptor fixture must parse (a proven v1 shape)");
    }
    return parsed.value;
})();

// The world's pending knobs are per-test: reset before every test so
// the suite's shape is order-independent.
beforeEach(() => {
    surfaceWorld.holdDiscovered = false;
    surfaceWorld.holdHandshake = false;
});

/** The caller's request FACTS — no target field: the composition's
 *  configuration (its default "gglab-dx12") is the target's one
 *  authority, and the flow composes it into the request value. */
const REQUEST_FACTS: CompileRequestFacts = {
    source: utf8Encode("/* generated */\nvoid EvaluateSurface() { }"),
    sourceIdentity: "cd".repeat(32),
    stage: "pixel",
    entry: "EvaluateSurface",
    defines: [],
    includes: [],
};

/** Renders the surface over the fake world and brings it up: the
 *  boundary exists, the tool is discovered + proven (the startup
 *  handshake), and the composition is Ready. */
function bringUpSurface() {
    const hook = renderHook(() =>
        useNativeBuild({
            descriptor,
            descriptorCompatible: true,
            descriptorDetail: "",
            emission: null,
        }),
    );
    const fake = surfaceWorld.boundary as InstanceType<typeof FakeHostBoundary>;
    return { hook, fake };
}

describe("the native-build surface (hook over the fake world)", () => {
    it("brings up to a Ready composition — tool proven, descriptor compatible, host available, target supported", async () => {
        const { hook, fake } = bringUpSurface();
        await waitFor(async () => {
            expect(hook.result.current.flow).not.toBeNull();
        });
        await waitFor(async () => {
            expect(hook.result.current.flow?.tool.status).toBe("compatible");
        });
        expect(fake.handshakeCalls, "the startup handshake is the tool's own event").toBe(1);
        expect(hook.result.current.readiness).toEqual({ status: "Ready" });
        expect(hook.result.current.ready).toBe(true);
        expect(hook.result.current.compileInFlight).toBe(false);
        expect(hook.result.current.handshakeInFlight, "the startup handshake has closed its lane").toBe(false);
        expect(hook.result.current.discoveryInFlight, "the startup discovery has closed its lane").toBe(false);
    });

    it("shows an admitted attempt IN FLIGHT before it settles — the cancel target is visible for the whole window", async () => {
        const { hook, fake } = bringUpSurface();
        await waitFor(async () => {
            expect(hook.result.current.flow?.tool.status).toBe("compatible");
        });
        expect(hook.result.current.ready).toBe(true);
        expect(hook.result.current.compileInFlight, "nothing is in flight before the compile").toBe(false);

        // Issue the compile. The call suspends on the attempt's OWN
        // settlement (the fake keeps it pending) — nothing settles.
        let compilePromise: Promise<{ admitted: boolean; buildId?: number }> | undefined;
        await act(async () => {
            compilePromise = hook.result.current.compileNow(REQUEST_FACTS);
        });
        expect(compilePromise, "the compile call was issued").toBeDefined();

        // The window: admitted, not yet settled. The surface must already
        // see the attempt IN FLIGHT — that is what the cancel button
        // renders against (its sequence is the session's in-flight set).
        expect(hook.result.current.compileInFlight, "the admitted attempt is visible IN FLIGHT, before any settlement").toBe(true);
        const inFlight = hook.result.current.flow?.buildSession.inFlight ?? [];
        expect(inFlight.length, "exactly one attempt in flight").toBe(1);
        const sequence = inFlight[0]?.buildId.sequence;
        expect(sequence, "the cancel target is the session's in-flight attempt").not.toBeNull();
        expect(hook.result.current.lineReport?.inFlight.map((id) => id.sequence)).toEqual([sequence]);
        // The line still has no settled attempt — the window is not over:
        // no current, no last-good yet.
        expect(hook.result.current.lineReport?.current).toBeUndefined();
        // The anchor's own outcome is not settled either — the surface's
        // "newest issued attempt outcome" is the honest "not yet" (and it
        // can never be a different attempt's outcome in its place).
        expect(hook.result.current.lastOutcome, "the anchor is in flight: no outcome yet, and no other attempt's in its place").toBeNull();
        // And readiness has not changed in the meantime — the window is
        // an in-flight fact, not a readiness change.
        expect(hook.result.current.ready).toBe(true);

        // The window ends: the world settles the attempt; the surface
        // learns of it, and the in-flight row closes.
        const promise = compilePromise as Promise<{ admitted: boolean; buildId?: number }>;
        let settled: { admitted: boolean; buildId?: number } | undefined;
        fake.releasePending({ sequence: 1 });
        await act(async () => {
            settled = await promise;
        });
        expect(settled, "the compile call resolves once the attempt settles").toBeDefined();
        expect(settled?.admitted).toBe(true);
        expect(hook.result.current.compileInFlight).toBe(false);
        expect(hook.result.current.lineReport?.current?.buildId.sequence).toBe(1);
        expect(hook.result.current.lineReport?.states.find((entry) => entry.buildId.sequence === 1)?.state).toBe("current");
        // The surface's "newest issued attempt outcome" is now the
        // ANCHOR's own record from the session line — its single
        // authority (not a second copy stamped anywhere else).
        expect(hook.result.current.lastOutcome?.kind, "the anchor's settled outcome, read from the line").toBe("succeeded");
    });

    // THE IN-FLIGHT WINDOW TESTS: the flow's lanes are the authority;
    // the surface's in-flight flags must OBSERVE a lane the moment it
    // opens (the Re-discover / Handshake buttons render their disabled
    // state from that observation). Stale flags through the window are
    // the same class of bug as the cancel being invisible.

    it("shows the STARTUP discovery in flight in its window — true before release, false after (and the click's window too)", async () => {
        surfaceWorld.holdDiscovered = true;
        const { hook, fake } = bringUpSurface();
        // The startup lane opens (the world holds it): the surface must
        // already observe "in flight" — this is the assertion a stale-
        // flag surface fails on.
        await waitFor(async () => {
            expect(hook.result.current.discoveryInFlight, "startup's discovery lane is observed by the surface").toBe(true);
            expect(hook.result.current.handshakeInFlight).toBe(false);
        });

        await act(async () => {
            fake.releaseDiscovery();
        });
        await waitFor(async () => {
            expect(hook.result.current.flow?.tool.status, "startup continues: the handshake settles").toBe("compatible");
        });
        expect(hook.result.current.discoveryInFlight, "closed on settlement").toBe(false);
        expect(hook.result.current.handshakeInFlight, "closed on settlement").toBe(false);

        // The Re-discover CLICK opens its own lane: observed open, then
        // closed by its own settlement.
        await act(async () => {
            void hook.result.current.discoverNow();
        });
        expect(hook.result.current.discoveryInFlight, "the click's discovery is in flight, observed").toBe(true);
        await act(async () => {
            fake.releaseDiscovery();
        });
        expect(hook.result.current.discoveryInFlight, "closed on its settlement").toBe(false);
    });

    it("shows the STARTUP handshake in flight in its window — true before release, false after (and the click's window too)", async () => {
        surfaceWorld.holdHandshake = true;
        const { hook, fake } = bringUpSurface();
        // Startup: the discovery resolves; the handshake lane opens
        // (the world holds it) — observed open by the surface.
        await waitFor(async () => {
            expect(hook.result.current.handshakeInFlight, "startup's handshake lane is observed by the surface").toBe(true);
        });
        expect(hook.result.current.discoveryInFlight).toBe(false);

        await act(async () => {
            fake.releaseHandshake();
        });
        await waitFor(async () => {
            expect(hook.result.current.flow?.tool.status, "the handshake's proof settles at release").toBe("compatible");
        });
        expect(hook.result.current.handshakeInFlight, "closed on settlement").toBe(false);

        // The button CLICK opens its own lane: observed open, then
        // closed by its own settlement — one handshake per lane.
        await act(async () => {
            void hook.result.current.handshakeNow();
        });
        expect(hook.result.current.handshakeInFlight, "the click's handshake is in flight, observed").toBe(true);
        await act(async () => {
            fake.releaseHandshake();
        });
        expect(hook.result.current.handshakeInFlight, "closed on its settlement").toBe(false);
        expect(fake.handshakeCalls, "one boundary handshake per lane").toBe(2);
    });

    // THE CONFIGURATION PASS-THROUGH: the discovery configuration (rule
    // 1 / rule 2 values, design section 5) reaches the boundary EXACTLY
    // as configured — absent when unset (an honest failure of that rule,
    // never a smuggled default), verbatim when set — and the `bundled`
    // world fact is stated explicitly, not hidden.

    it("passes the discovery configuration to the boundary — absent when unset, verbatim when set", async () => {
        const { hook, fake } = bringUpSurface();
        await waitFor(async () => {
            expect(hook.result.current.flow?.tool.status).toBe("compatible");
        });
        // The startup discovery was configured by NOBODY yet: the
        // request is honest about it.
        expect(fake.lastDiscoveryRequest, "the startup's request: nothing set, nothing smuggled").toEqual({
            bundled: false,
            explicitConfig: undefined,
            siblingBuildOutput: undefined,
        });

        await act(async () => {
            hook.result.current.setToolPath("C:\\tools\\gglab-shaderc.exe");
        });
        await act(async () => {
            await hook.result.current.discoverNow();
        });
        expect(fake.lastDiscoveryRequest, "the explicit tool path arrives verbatim; the other rule stays absent").toEqual({
            bundled: false,
            explicitConfig: "C:\\tools\\gglab-shaderc.exe",
            siblingBuildOutput: undefined,
        });

        await act(async () => {
            hook.result.current.setSiblingBuildOutput("C:\\GGLab\\Build\\Output");
        });
        await act(async () => {
            await hook.result.current.discoverNow();
        });
        expect(fake.lastDiscoveryRequest, "both configured values arrive together").toEqual({
            bundled: false,
            explicitConfig: "C:\\tools\\gglab-shaderc.exe",
            siblingBuildOutput: "C:\\GGLab\\Build\\Output",
        });
    });
});
