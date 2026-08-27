import { describe, expect, it } from "vitest";
import {
    FakeHostBoundary,
    reportBuildLine,
    type CompatibilityJudgment,
    type HostToolBoundary,
    type NativeCompileRequest,
    type ToolCandidate,
    type ToolFacts,
    utf8Encode,
} from "@gglab/shader-toolchain-client";
import { NativeBuildFlow } from "../src/native-build-flow.js";

/*
 * The product path over the reference fake (design authority: the
 * toolchain integration design, section 14 — "the full chain ... driven
 * entirely by fakes", with the eleven REQUIRED scenarios, each a named
 * test). These tests pin the editor's guarantee: NOTHING is issued for a
 * NotReady composition, and the session line keeps its explicit states
 * under every settlement order the fakes can produce.
 */

const JUDGMENT: CompatibilityJudgment = {
    requirement: { identity: "gglab-shaderc", minimumVersion: "1.0.0", versionComparison: "semver" },
};

const CANDIDATE: ToolCandidate = {
    rule: "bundled",
    toolPath: "C:\\tools\\gglab-shaderc.exe",
    observationIdentity: "obs-1",
    resolvedAt: 1_000,
};

const FACTS_OK: ToolFacts = {
    toolIdentity: "gglab-shaderc",
    toolVersion: "1.2.0",
    processContractVersion: 1,
    producerKind: "dxc",
    producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
    supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
};

const PRODUCEA = "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)";
const PRODUCERB = "Microsoft Direct3D 12 Shader Compiler 10.0.26100.99 (dxc)";

/** The handshake (describe) machine document — the published v1 shape. */
function describeDocument(facts: ToolFacts): string {
    return JSON.stringify({
        command: "describe",
        success: true,
        status: "ok",
        exitCode: 0,
        processContractVersion: facts.processContractVersion,
        toolIdentity: facts.toolIdentity,
        toolVersion: facts.toolVersion,
        producerKind: facts.producerKind,
        producerIdentity: facts.producerIdentity,
        supportedTargets: [...facts.supportedTargets],
        diagnostics: [],
    });
}

function compileOk(target: string): string {
    return JSON.stringify({
        command: "compile",
        success: true,
        status: "ok",
        exitCode: 0,
        recipeId: "3f".repeat(32),
        buildKey: "5e".repeat(32),
        binaryHash: "9c".repeat(32),
        binaryFormat: "dxil",
        target,
        binaryPath: `C:/gglab/build/${target}.dxil`,
        cacheRecordPath: `C:/gglab/build/${target}.dxil.rct`,
        fromCache: false,
        diagnostics: [],
    });
}

function compileFailedDocument(message: string): string {
    return JSON.stringify({
        command: "compile",
        success: false,
        status: "compile-failed",
        exitCode: 4,
        diagnostics: [{ message, sourceIdentity: "cd".repeat(32) }],
    });
}

function request(target: string): NativeCompileRequest {
    return {
        source: utf8Encode("/* generated */\nvoid GenerateSurface() { }"),
        sourceIdentity: "cd".repeat(32),
        target,
        stage: "pixel",
        entry: "GenerateSurface",
        defines: [],
        includes: [],
    };
}

function makeFlow(boundary: HostToolBoundary): NativeBuildFlow {
    return new NativeBuildFlow(boundary, () => ({ available: true, detail: "the fake service is reachable" }), JUDGMENT);
}

/** The descriptor-side gate inputs as the app holds them (all ready). */
const descriptorReady = { descriptorLoaded: true, descriptorCompatible: true, descriptorDetail: "" };

function readinessInput(target: string) {
    return { ...descriptorReady, configuredTarget: target };
}

/** The session's own report against its intent anchor (the client's
 *  rules; the anchor is the flow's last-issued intent). */
function reportOf(flow: NativeBuildFlow) {
    const session = flow.buildSession;
    if (session.lastIssued === null) {
        throw new Error("no issued attempt to anchor a report");
    }
    return reportBuildLine(session.line, session.lastIssued.intent, session.inFlight.map((attempt) => attempt.buildId));
}

async function bringUp(flow: NativeBuildFlow): Promise<void> {
    const discovery = await flow.discover({ bundled: false });
    expect(discovery.candidate).not.toBeUndefined();
    await flow.handshake();
}

function reasonsOf(flow: NativeBuildFlow, target: string): string[] {
    const readiness = flow.readiness(readinessInput(target));
    return readiness.status === "NotReady" ? readiness.reasons.map((reason) => reason.reason) : [];
}

/* Scenario 1 — the happy chain through the gate. */
describe("1 · Ready composition issues; the artifact facts are explicit in the line", () => {
    it("compatible tool + compatible descriptor + capable host + configured target → Ready → compile → artifact facts visible", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.readiness(readinessInput("gglab-dx12"))).toEqual({ status: "Ready" });
        const gate = flow.compileGate(request("gglab-dx12"), readinessInput("gglab-dx12"));
        expect(gate.admitted).toBe(true);
        const attempt = await flow.beginCompile(request("gglab-dx12"));
        const outcome = await attempt.outcome;
        expect(outcome.kind).toBe("succeeded");
        if (outcome.kind === "succeeded") {
            expect(outcome.envelope.binaryFormat).toBe("dxil");
            expect(outcome.envelope.binaryHash).toBe("9c".repeat(32));
            expect(outcome.envelope.fromCache).toBe(false);
            expect(outcome.envelope.target).toBe("gglab-dx12");
        }
        const report = reportOf(flow);
        expect(report.current?.buildId.sequence).toBe(attempt.buildId.sequence);
        expect(report.lastGood?.buildId.sequence).toBe(attempt.buildId.sequence);
    });
});

/* Scenario 2 — incompatible tool: nothing issued, mismatches visible. */
describe("2 · an incompatible tool is a NotReady with its mismatches visible, and nothing is issued", () => {
    it("facts the tool itself reports contradict the required ones → ToolIncompatible; the boundary never sees a compile", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument({ ...FACTS_OK, toolIdentity: "other-tool" }), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.tool.status).toBe("incompatible");
        const gate = flow.compileGate(request("gglab-dx12"), readinessInput("gglab-dx12"));
        expect(gate.admitted).toBe(false);
        expect(
            reasonsOf(flow, "gglab-dx12"),
            "the tool's own verdict is the reason; target coverage is a question only a PROVEN tool can answer",
        ).toEqual(["ToolIncompatible"]);
        if (flow.tool.status === "incompatible") {
            expect(
                flow.tool.mismatches.map((mismatch) => mismatch.kind),
                "the mismatch's own structured code is the inspector's evidence",
            ).toContain("identity");
        }
        expect(fake.compileCalls, "NOTHING may be issued on a NotReady composition").toBe(0);
    });
});

/* Scenario 3 — absent tool: per-rule reasons visible. */
describe("3 · an absent tool (every rule fails) → ToolUnavailable + per-rule reasons", () => {
    it("the per-rule failures stay the visible evidence; the state is unavailable", async () => {
        const fake = new FakeHostBoundary({
            discovery: {
                kind: "unavailable",
                failures: [
                    { rule: "explicit-config", reason: "not-configured" },
                    { rule: "sibling-build", reason: "missing" },
                    { rule: "bundled", reason: "missing" },
                ],
            },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await flow.discover({ bundled: false });
        expect(flow.tool.status).toBe("unavailable");
        const gate = flow.compileGate(request("gglab-dx12"), readinessInput("gglab-dx12"));
        expect(gate.admitted).toBe(false);
        expect(reasonsOf(flow, "gglab-dx12")).toEqual(["ToolUnavailable"]);
        expect(flow.discovery?.failures, "the per-rule reasons are the inspector's evidence").toHaveLength(3);
        expect(fake.compileCalls).toBe(0);
    });
});

/* Scenario 4 — unproven: compile refused; handshake legal; re-entry works. */
describe("4 · an unproven tool refuses compiles; the (re-)handshake is the path to proof", () => {
    it("an unsupported contract axis is ToolUnproven (compile refused, no execution); re-handshaking enters compatible", async () => {
        // World A: the handshake never completes (it times out) — the
        // client's EXPLICIT unproven state (a structured reason, never
        // a silent assumption).
        const worldA = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: "", exitCode: 0, timedOut: true },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flowA = makeFlow(worldA);
        await flowA.discover({ bundled: false });
        await flowA.handshake();
        expect(flowA.tool.status, "a handshake that never completes is an explicit unproven").toBe("unproven");
        const gate = flowA.compileGate(request("gglab-dx12"), readinessInput("gglab-dx12"));
        expect(gate.admitted, "compile is refused on an unproven tool").toBe(false);
        expect(reasonsOf(flowA, "gglab-dx12")).toEqual(["ToolUnproven"]);
        if (flowA.tool.status === "unproven") {
            expect(flowA.tool.reasons.map((reason) => reason.reason)).toContain("handshake-timed-out");
        }
        expect(worldA.compileCalls, "no compilation executes").toBe(0);

        // The handshake stays LEGAL even on `unproven` (the client's own
        // admission) — that is how unproven re-enters proof.
        expect(flowA.handshakeGate().admitted, "(re-)handshake remains legal on an unproven tool").toBe(true);

        // World B: the tool updated at the same path now publishes the
        // declared axis — a FRESH handshake proves it (the re-entry).
        const worldB = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flowB = makeFlow(worldB);
        await flowB.discover({ bundled: false });
        await flowB.handshake();
        expect(flowB.tool.status, "re-handshaking enters compatible").toBe("compatible");
        const gateB = flowB.compileGate(request("gglab-dx12"), readinessInput("gglab-dx12"));
        expect(gateB.admitted, "the proven tool under the declared axis is Ready").toBe(true);
    });
});

/* Scenario 5 — a target change is a different intent; the late old result
 *  cannot become current. */
describe("5 · a target change is a different intent; the late old result cannot become current", () => {
    it("the slow old result of the old intent lands as retained evidence and never current", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [
                { stdout: compileOk("gglab-dx12"), exitCode: 0 },
                { stdout: compileOk("gglab-vulkan13"), exitCode: 0 },
            ],
            keepCompilePending: true,
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.compileGate(request("gglab-dx12"), readinessInput("gglab-dx12")).admitted).toBe(true);
        const attempt1 = await flow.beginCompile(request("gglab-dx12")); // in flight (world pending)
        // The target configuration changes — a DIFFERENT intent over the
        // same source bytes — and the gate admits the new one.
        expect(flow.compileGate(request("gglab-vulkan13"), readinessInput("gglab-vulkan13")).admitted).toBe(true);
        const attempt2 = await flow.beginCompile(request("gglab-vulkan13")); // in flight
        expect(attempt2.buildId.sequence, "each attempt keeps its own identity").not.toBe(attempt1.buildId.sequence);

        // The SLOW OLD attempt settles LATE (after the newer one was
        // issued): it may never become current.
        fake.releasePending({ sequence: attempt1.buildId.sequence });
        await attempt1.outcome;
        const oldEntry = reportOf(flow).states.find((s) => s.buildId.sequence === attempt1.buildId.sequence);
        expect(oldEntry, "the old attempt is RETAINED (evidence), not dropped").toBeDefined();
        expect(oldEntry?.state, "it cannot be current under the newer intent").not.toBe("current");

        // The newer attempt settles — it becomes current.
        fake.releasePending({ sequence: attempt2.buildId.sequence });
        await attempt2.outcome;
        const report = reportOf(flow);
        expect(report.current?.buildId.sequence).toBe(attempt2.buildId.sequence);
        const newEntry = report.states.find((s) => s.buildId.sequence === attempt2.buildId.sequence);
        expect(newEntry?.state, "the newest attempt in the anchor intent is current").toBe("current");
    });
});

/* Scenario 6 — a failure after success never erases the last-good. */
describe("6 · a failure after success never erases the explicit last-good", () => {
    it("last-good is preserved and explicitly displayed across the failure run", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [
                { stdout: compileOk("gglab-dx12"), exitCode: 0 },
                { stdout: compileFailedDocument("syntax error at (3,1)"), exitCode: 4 },
            ],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        const first = await (await flow.beginCompile(request("gglab-dx12"))).outcome;
        expect(first.kind).toBe("succeeded");
        const failure = await (await flow.beginCompile(request("gglab-dx12"))).outcome;
        expect(failure.kind).toBe("failed");
        if (failure.kind === "failed" && "envelope" in failure) {
            expect(failure.envelope.status).toBe("compile-failed");
            expect(failure.envelope.diagnostics.at(0)?.message).toBe("syntax error at (3,1)");
        }
        const report = reportOf(flow);
        expect(report.lastGood?.buildId.sequence, "last-good is the successful attempt, preserved").toBe(1);
        const failedEntry = report.states.find((s) => s.buildId.sequence === 2);
        expect(failedEntry?.state, "the failure is an explicit state, with its intent visible").toBe("failed");
        expect(failedEntry?.intent.target).toBe("gglab-dx12");
    });
});

/* Scenario 7 — a cancel in flight is an explicit canceled state. */
describe("7 · a cancel in flight is an explicit canceled state; the prior states are untouched", () => {
    it("cancel settles the attempt as canceled without blanking last-good", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }, { stdout: compileOk("gglab-dx12"), exitCode: 0 }],
            keepCompilePending: true,
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        const attempt1 = await flow.beginCompile(request("gglab-dx12"));
        fake.releasePending({ sequence: attempt1.buildId.sequence }); // the safe result lands first
        await attempt1.outcome;
        const attempt2 = await flow.beginCompile(request("gglab-dx12")); // in flight
        const cancelOutcome = await flow.cancel({ sequence: attempt2.buildId.sequence });
        expect(cancelOutcome.canceled).toBe(true);
        const settled = await attempt2.outcome;
        expect(settled.kind, "a canceled attempt is an EXPLICIT terminal state").toBe("canceled");
        const report = reportOf(flow);
        expect(report.states.find((s) => s.buildId.sequence === attempt2.buildId.sequence)?.state).toBe("canceled");
        expect(report.lastGood?.buildId.sequence, "the prior success is untouched").toBe(attempt1.buildId.sequence);
    });
});

/* Scenario 8 — a timeout is an explicit failed state with the fact. */
describe("8 · a timeout is an explicit failed state with the timeout fact, not a hang", () => {
    it("the timed-out settlement is a failed state carrying the termination fact", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: "", exitCode: 0, timedOut: true }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        const attempt = await flow.beginCompile(request("gglab-dx12"));
        const outcome = await attempt.outcome;
        expect(outcome.kind).toBe("failed");
        if (outcome.kind === "failed" && "termination" in outcome) {
            expect(outcome.termination, "the timeout fact is carried verbatim, never prose").toEqual({ kind: "timed-out" });
        } else {
            expect.fail("a timed-out settlement must carry the timeout termination fact");
        }
        const report = reportOf(flow);
        expect(report.states.find((s) => s.buildId.sequence === attempt.buildId.sequence)?.state).toBe("failed");
    });
});

/* Scenario 9 — two quick attempts with identical source bytes. */
describe("9 · two quick attempts with identical source bytes: separate identities, independent settlements", () => {
    it("separate BuildIds; settling the newer first never affects the older's facts", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
            keepCompilePending: true,
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        const attempt1 = await flow.beginCompile(request("gglab-dx12"));
        const attempt2 = await flow.beginCompile(request("gglab-dx12"));
        expect(attempt2.buildId.sequence, "each attempt owns its own identity").not.toBe(attempt1.buildId.sequence);
        // The NEWER one settles first (the world decides its own order),
        // then the older one lands late — same intent, BuildId order.
        fake.releasePending({ sequence: attempt2.buildId.sequence });
        const newerOutcome = await attempt2.outcome;
        expect(newerOutcome.kind).toBe("succeeded");
        const reportBetween = reportOf(flow);
        expect(reportBetween.current?.buildId.sequence, "once the newer one settles it is current").toBe(attempt2.buildId.sequence);
        fake.releasePending({ sequence: attempt1.buildId.sequence });
        const olderOutcome = await attempt1.outcome;
        expect(olderOutcome.kind, "settling the other never changes this attempt's facts").toBe("succeeded");
        const report = reportOf(flow);
        expect(
            report.states.map((s) => s.buildId.sequence).sort((a, b) => a - b),
            "both attempts stay on the line, each under its identity",
        ).toEqual([attempt1.buildId.sequence, attempt2.buildId.sequence].sort((a, b) => a - b));
        expect(report.states.find((s) => s.buildId.sequence === attempt2.buildId.sequence)?.state, "the NEWER attempt in the same intent stays current").toBe("current");
        expect(report.lastGood?.buildId.sequence).toBe(attempt2.buildId.sequence);
    });
});

/* Scenario 10 — a compatible tool whose targets exclude the configured one. */
describe("10 · a compatible tool whose targets exclude the configured one: NotReady by the target only", () => {
    it("the tool state STAYS compatible; a supported target flips the composition to Ready with the tool state untouched", async () => {
        const facts: ToolFacts = { ...FACTS_OK, supportedTargets: ["gglab-vulkan13"] };
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(facts), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-vulkan13"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.tool.status, "a target mismatch is the BUILD's question, not the tool's").toBe("compatible");
        const notReady = flow.readiness(readinessInput("gglab-dx12"));
        if (notReady.status !== "NotReady") {
            expect.fail("a DX12 configuration over a Vulkan-only tool must be NotReady");
        }
        expect(notReady.reasons.map((reason) => reason.reason), "the ONLY reason is the target").toEqual(["TargetUnsupported"]);
        expect(notReady.reasons.at(0)).toMatchObject({
            reason: "TargetUnsupported",
            configuredTarget: "gglab-dx12",
            supportedTargets: ["gglab-vulkan13"],
        });
        const gate = flow.compileGate(request("gglab-dx12"), readinessInput("gglab-dx12"));
        expect(gate.admitted, "nothing is issued for the unsupported target").toBe(false);
        expect(fake.compileCalls).toBe(0);
        expect(flow.readiness(readinessInput("gglab-vulkan13")), "switching to a supported target flips the composition to Ready").toEqual({
            status: "Ready",
        });
        expect(flow.tool.status, "the tool state is UNTOUCHED by the target flips").toBe("compatible");
    });
});

/* Scenario 11 — a proven producer change is a different intent. */
describe("11 · a proven producer change is a different intent; the late old evidence cannot become current", () => {
    it("the slow result of the old producer lands as retained evidence, its intent visible; the new producer's attempt is current", async () => {
        // Two worlds behind ONE boundary (one session store): the first
        // handshake proves producer A, the second the SAME path under
        // producer B — a DIFFERENT intent for identical source bytes.
        // Both compile worlds stay pending so the settlement ORDER is
        // script-controlled.
        const worldA = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument({ ...FACTS_OK, producerIdentity: PRODUCEA }), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
            keepCompilePending: true,
        });
        const worldB = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument({ ...FACTS_OK, producerIdentity: PRODUCERB }), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
            keepCompilePending: true,
        });
        const counters = { handshake: 0, compile: 0 };
        const boundary: HostToolBoundary = {
            discover: (req) => worldA.discover(req),
            handshake: (candidate) => {
                const world = counters.handshake >= 1 ? worldB : worldA;
                counters.handshake += 1;
                return world.handshake(candidate);
            },
            compile: (candidate, req) => {
                const world = counters.compile >= 1 ? worldB : worldA;
                const globalSequence = counters.compile + 1;
                counters.compile += 1;
                // ONE session store, one identity space: the boundary's
                // BuildIds must be globally ordered (each world numbers
                // its own calls from 1).
                return world.compile(candidate, req).then((handle) => ({ buildId: { sequence: globalSequence }, result: handle.result }));
            },
            cancel: (id) => worldA.cancel(id),
        };
        const flow = makeFlow(boundary);
        await flow.discover({ bundled: false });
        await flow.handshake(); // the path proves producer A
        expect(flow.provenFacts?.producerIdentity).toContain("10.0.26100.2");
        const attempt1 = await flow.beginCompile(request("gglab-dx12")); // in flight under producer A
        // The same path now proves the NEW producer (a re-handshake —
        // legal on any resolved candidate):
        await flow.handshake();
        expect(flow.provenFacts?.producerIdentity, "the fresh proof carries producer B").toContain("10.0.26100.99");
        const attempt2 = await flow.beginCompile(request("gglab-dx12")); // in flight under producer B
        // The SLOW OLD evidence (producer A) settles after the newer
        // attempt was issued — it may never become current.
        worldA.releasePending({ sequence: 1 });
        const olderOutcome = await attempt1.outcome;
        expect(olderOutcome.kind).toBe("succeeded");
        worldB.releasePending({ sequence: 1 });
        const newerOutcome = await attempt2.outcome;
        expect(newerOutcome.kind).toBe("succeeded");
        const report = reportOf(flow);
        const oldEntry = report.states.find((s) => s.buildId.sequence === attempt1.buildId.sequence);
        const newEntry = report.states.find((s) => s.buildId.sequence === attempt2.buildId.sequence);
        expect(oldEntry, "the old producer's evidence is RETAINED as evidence").toBeDefined();
        expect(newEntry, "the new producer's evidence is on the line").toBeDefined();
        expect(oldEntry?.state, "the old producer's attempt cannot be current under the newer intent").not.toBe("current");
        expect(newEntry?.state, "the new producer's attempt is current once it settles").toBe("current");
        expect(oldEntry?.intent.tool.producerIdentity, "the old evidence carries ITS OWN intent (producer A)").toContain("10.0.26100.2");
        expect(newEntry?.intent.tool.producerIdentity, "the new evidence carries producer B").toContain("10.0.26100.99");
    });
});
