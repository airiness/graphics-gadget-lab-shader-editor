/**
 * Native-build SURFACE tests (the React hook over the pure modules),
 * driven against the reference fake boundary — the desktop shape, with
 * the Tauri host module mocked to the fake.
 *
 * The surfaces these pin (Preview Program design v1.0: the
 * generated-function-only surface has NO native production path — no
 * test here admits a compile): the mechanism brings up fully ready
 * (tool proven, descriptor compatible, host available, target
 * supported) while the SURFACE verdict stays NotReady
 * [ProgramCompositionUnavailable] and the gate refuses structurally —
 * no request issued, no BuildId created, no Shader Artifact claim
 * produced — plus the discovery/handshake single-flight windows observed
 * open-then-closed by the surface, and the discovery configuration
 * pass-through.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeHostBoundary } from "@gglab/shader-toolchain-client";
import { parseSurfaceProfileDescriptor, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { useNativeBuild } from "../src/useNativeBuild.js";

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
        processContractVersion: 2,
        compilePolicyRevision: 1,
        toolIdentity: "gglab-shaderc",
        toolVersion: "1.2.0",
        producerKind: "dxc",
        producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
        diagnostics: [],
    });
    // The boundary contract carries six capabilities; this ordinary-flow fake
    // provides its compile world while the Preview scripts remain dormant.
    // The compile path is dormant in these tests: the surface
    // no longer offers the native production path (2026-08-30 amendment),
    // so nothing here ever issues one.
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

/** Renders the surface over the fake world and brings it up: the
 *  boundary exists and the tool is discovered + proven (the startup
 *  handshake) — the mechanism's inputs fully ready, while the surface's
 *  program-composition fact keeps the verdict NotReady. */
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
    it("brings the MECHANISM up fully ready — and the generated-function-only verdict stays NotReady [ProgramCompositionUnavailable]", async () => {
        const { hook, fake } = bringUpSurface();
        await waitFor(async () => {
            expect(hook.result.current.flow).not.toBeNull();
        });
        await waitFor(async () => {
            expect(hook.result.current.flow?.tool.status).toBe("compatible");
        });
        expect(fake.handshakeCalls, "the startup handshake is the tool's own event").toBe(1);
        // The mechanism's inputs are all ready (tool compatible — the
        // handshake proved it; descriptor compatible; host available;
        // target supported) — yet the SURFACE's own program-composition
        // fact is false, and THAT alone keeps the verdict NotReady.
        expect(hook.result.current.readiness).toEqual({
            status: "NotReady",
            reasons: [expect.objectContaining({ reason: "ProgramCompositionUnavailable" })],
        });
        expect(
            hook.result.current.readiness.status === "NotReady" ? hook.result.current.readiness.reasons.length : -1,
            "ONE visible reason — the surface's product fact (the mechanism's are all ready)",
        ).toBe(1);
        expect(hook.result.current.ready, "the generated-function-only surface NEVER is Ready").toBe(false);
        expect(hook.result.current.handshakeInFlight, "the startup handshake has closed its lane").toBe(false);
        expect(hook.result.current.discoveryInFlight, "the startup discovery has closed its lane").toBe(false);
    });

    it("the gate refuses structurally — no request issued, no BuildId created, no Shader Artifact claim produced", async () => {
        const { hook, fake } = bringUpSurface();
        await waitFor(async () => {
            expect(hook.result.current.flow).not.toBeNull();
            expect(hook.result.current.flow?.tool.status).toBe("compatible");
        });
        const flow = hook.result.current.flow;
        if (flow === null) {
            throw new Error("the flow is constructed before the handshake settles");
        }
        // The well-formed request value the caller would offer — the
        // test composes it (a fixture; the surface no longer composes
        // one). The gate below must refuse it BEFORE any issuance.
        const facts = {
            source: new Uint8Array([47, 42, 43]),
            sourceIdentity: "cd".repeat(32),
            stage: "pixel",
            entry: "PSMain",
            defines: [],
            includes: [],
        };
        const input = { descriptorLoaded: true, descriptorCompatible: true, descriptorDetail: "", configuredTarget: "gglab-dx12" };
        let admission: Awaited<ReturnType<typeof flow.compile>> | undefined;
        await act(async () => {
            admission = await flow.compile(facts, input);
        });
        expect(admission, "the compile call was issued over the flow's single public entry").toBeDefined();
        if (admission === undefined) {
            throw new Error("the gate returned no admission value");
        }
        expect(admission.admitted).toBe(false);
        if (admission.admitted === false) {
            expect(admission.gate.readiness.status, "the refusal carries the surface's product fact").toBe("NotReady");
            if (admission.gate.readiness.status === "NotReady") {
                expect(admission.gate.readiness.reasons.map((reason) => reason.reason)).toContain("ProgramCompositionUnavailable");
            }
        }
        // ① No native compile request issued — against a LIVE, scripted
        //    boundary (the world's compile script is dormant; a surface
        //    that issued would be caught by its own fake).
        expect(fake.compileCalls, "NOTHING may be issued for the generated-function-only surface").toBe(0);
        // ② No BuildId created — the session's line is empty (a BuildId
        //    only ever exists on the line of an admitted attempt).
        expect(flow.buildSession.lastIssued).toBeNull();
        expect(flow.buildSession.inFlight).toEqual([]);
        // ③ No Shader Artifact claim — nothing settled on the line,
        //    nothing current, no outcome anywhere on the surface.
        expect(hook.result.current.lineReport?.current, "no attempt succeeded — the line has no current artifact").toBeUndefined();
        expect(hook.result.current.lastOutcome, "the surface carries no attempt outcome").toBeNull();
    });

    // THE IN-FLIGHT WINDOW TESTS: the flow's lanes are the authority;
    // the surface's in-flight flags must OBSERVE a lane the moment it
    // opens (the Re-discover / Handshake buttons render their disabled
    // state from that observation). Stale flags through the window are
    // the same class of bug as a button staying enabled across the whole
    // window it should guard.

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
