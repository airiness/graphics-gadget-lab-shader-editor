import { describe, expect, it } from "vitest";
import {
    FakeHostBoundary,
    reportBuildLine,
    type AttemptOutcome,
    type BoundaryResult,
    type BuildId,
    type CompatibilityJudgment,
    type HostToolBoundary,
    type ToolCandidate,
    type ToolFacts,
    utf8Encode,
} from "@gglab/shader-toolchain-client";
import { NativeBuildFlow, type CompileRequestFacts } from "../src/native-build-flow.js";

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
    processContractVersion: 2,
    compilePolicyRevision: 1,
    producerKind: "dxc",
    producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
    supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
};

const PRODUCEA = "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)";
const PRODUCERB = "Microsoft Direct3D 12 Shader Compiler 10.0.26100.99 (dxc)";

/** The handshake (describe) machine document — the published v2 shape
 *  (the currently consumed contract: axis 2 + the required
 *  compilePolicyRevision). */
function describeDocument(facts: ToolFacts): string {
    return JSON.stringify({
        command: "describe",
        success: true,
        status: "ok",
        exitCode: 0,
        processContractVersion: facts.processContractVersion,
        compilePolicyRevision: facts.compilePolicyRevision,
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

/** The caller's request FACTS — every request field EXCEPT the target,
 *  which is not the caller's to provide: the configured target (passed
 *  through the gate input) is the target's one authority, and the flow
 *  composes it into the request value it judges and issues. */
function facts(): CompileRequestFacts {
    return {
        source: utf8Encode("/* generated */\nvoid GenerateSurface() { }"),
        sourceIdentity: "cd".repeat(32),
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

/** The product path — the flow's ONE compile entry (design section 6:
 *  only a `Ready` composition issues; the public API has no other
 *  issuer). This helper stands in for the tests that expect the gate to
 *  admit; the refusal leg reads the gate's value directly. */
async function issue(
    flow: NativeBuildFlow,
    requestFacts: CompileRequestFacts,
    input: Parameters<NativeBuildFlow["compile"]>[1],
): Promise<{ buildId: BuildId; outcome: Promise<AttemptOutcome> }> {
    const admission = await flow.compile(requestFacts, input);
    if (admission.admitted !== true) {
        const reasons =
            admission.gate.readiness.status === "NotReady"
                ? admission.gate.readiness.reasons.map((reason) => reason.reason).join(", ")
                : "the request is not well-formed";
        throw new Error(`test setup: the gate must admit (refused: ${reasons})`);
    }
    return { buildId: admission.buildId, outcome: admission.outcome };
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
        const gate = flow.compileGate(facts(), readinessInput("gglab-dx12"));
        expect(gate.admitted).toBe(true);
        const attempt = await issue(flow, facts(), readinessInput("gglab-dx12"));
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
        const gate = flow.compileGate(facts(), readinessInput("gglab-dx12"));
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
        const gate = flow.compileGate(facts(), readinessInput("gglab-dx12"));
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
        const gate = flowA.compileGate(facts(), readinessInput("gglab-dx12"));
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
        const gateB = flowB.compileGate(facts(), readinessInput("gglab-dx12"));
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
        expect(flow.compileGate(facts(), readinessInput("gglab-dx12")).admitted).toBe(true);
        const attempt1 = await issue(flow, facts(), readinessInput("gglab-dx12")); // in flight (world pending)
        // The target configuration changes — a DIFFERENT intent over the
        // same source bytes — and the gate admits the new one.
        expect(flow.compileGate(facts(), readinessInput("gglab-vulkan13")).admitted).toBe(true);
        const attempt2 = await issue(flow, facts(), readinessInput("gglab-vulkan13")); // in flight
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
        const first = await (await issue(flow, facts(), readinessInput("gglab-dx12"))).outcome;
        expect(first.kind).toBe("succeeded");
        const failure = await (await issue(flow, facts(), readinessInput("gglab-dx12"))).outcome;
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
        const attempt1 = await issue(flow, facts(), readinessInput("gglab-dx12"));
        fake.releasePending({ sequence: attempt1.buildId.sequence }); // the safe result lands first
        await attempt1.outcome;
        const attempt2 = await issue(flow, facts(), readinessInput("gglab-dx12")); // in flight
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
        const attempt = await issue(flow, facts(), readinessInput("gglab-dx12"));
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
        const attempt1 = await issue(flow, facts(), readinessInput("gglab-dx12"));
        const attempt2 = await issue(flow, facts(), readinessInput("gglab-dx12"));
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
        const vulkanOnly: ToolFacts = { ...FACTS_OK, supportedTargets: ["gglab-vulkan13"] };
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(vulkanOnly), exitCode: 0 },
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
        const gate = flow.compileGate(facts(), readinessInput("gglab-dx12"));
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
        const attempt1 = await issue(flow, facts(), readinessInput("gglab-dx12")); // in flight under producer A
        // The same path now proves the NEW producer (a re-handshake —
        // legal on any resolved candidate):
        await flow.handshake();
        expect(flow.provenFacts?.producerIdentity, "the fresh proof carries producer B").toContain("10.0.26100.99");
        const attempt2 = await issue(flow, facts(), readinessInput("gglab-dx12")); // in flight under producer B
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

/* Scenario 12 — the NEWER attempt settles first: the anchor never moves
 *  backwards, and the late old attempt can only be stale evidence.
 *  (The mirror of scenario 5's order — the "slow old completion cannot
 *  become current" rule under the settlement order §5's test could not
 *  produce.) */
describe("12 · the newer intent settles first: current stays with it; the late old attempt is stale", () => {
    it("both in flight (different intents) → the newer settles first and is current; the old lands late as stale, the newer remains current", async () => {
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
        const attempt1 = await issue(flow, facts(), readinessInput("gglab-dx12")); // old intent, in flight
        const attempt2 = await issue(flow, facts(), readinessInput("gglab-vulkan13")); // new intent, in flight
        // The NEWER one settles first — while the old one is still in
        // flight. Its intent must already be the current one.
        fake.releasePending({ sequence: attempt2.buildId.sequence });
        const newestOutcome = await attempt2.outcome;
        expect(newestOutcome.kind).toBe("succeeded");
        const whileOldStillInFlight = reportOf(flow);
        expect(
            whileOldStillInFlight.current?.buildId.sequence,
            "the newer attempt is current the moment it settles — no older in-flight attempt displaces it",
        ).toBe(attempt2.buildId.sequence);
        expect(whileOldStillInFlight.current?.intent.target).toBe("gglab-vulkan13");
        // The OLD one lands LATE: retained evidence, stale under the
        // current intent — and it must not drag the anchor back to its
        // own intent, nor take the current's place.
        fake.releasePending({ sequence: attempt1.buildId.sequence });
        const lateOutcome = await attempt1.outcome;
        expect(lateOutcome.kind).toBe("succeeded");
        const report = reportOf(flow);
        const oldEntry = report.states.find((entry) => entry.buildId.sequence === attempt1.buildId.sequence);
        const newEntry = report.states.find((entry) => entry.buildId.sequence === attempt2.buildId.sequence);
        expect(oldEntry, "the late old attempt RETAINED as evidence").toBeDefined();
        expect(oldEntry?.state, "the slow old completion cannot become current, however late it lands").toBe("stale");
        expect(newEntry?.state, "the newer attempt REMAINS current").toBe("current");
        expect(report.current?.buildId.sequence, "current is still the newer attempt").toBe(attempt2.buildId.sequence);
        expect(
            flow.buildSession.lastIssued?.buildId.sequence,
            "the anchor is the LAST ISSUED attempt — no settlement has ever moved it backwards",
        ).toBe(attempt2.buildId.sequence);
        expect(flow.buildSession.lastIssued?.intent.target, "the anchor's intent is the newer one").toBe("gglab-vulkan13");
    });
});

/* Scenario 13 — the BuildIntent of an attempt is bound to the proof
 *  ADMISSION was taken under. A candidate-invalidation settlement that
 *  lands inside the second admission's window is a lifecycle event for
 *  the CURRENT state: it must not mis-bind the new attempt's identity
 *  (and must not crash it against a state that no longer carries
 *  proven facts). */
describe("13 · an attempt's intent binds to the proof of its admission, never to a later state", () => {
    it("an invalidation settling inside the admission window drops the tool state, but the new attempt keeps its own intent and settles cleanly", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [
                { stdout: compileOk("gglab-dx12"), exitCode: 0 },
                { stdout: compileOk("gglab-dx12"), exitCode: 0 },
            ],
            keepCompilePending: true,
        });
        const worldInvalidation: BoundaryResult = {
            kind: "candidate-invalidated",
            candidate: CANDIDATE,
            observation: "missing",
            observedIdentity: null,
        };
        const boundary: HostToolBoundary = {
            discover: (req) => fake.discover(req),
            handshake: (candidate) => fake.handshake(candidate),
            compile: async (candidate, request) => {
                const admission = await fake.compile(candidate, request);
                // The world moves in the SECOND attempt's admission window:
                // the first attempt settles with the host's provenance
                // refutation — a candidate-lifecycle event that drops the
                // tool state to `unavailable` (no proven facts left).
                if (admission.buildId.sequence === 2) {
                    fake.releasePending({ sequence: 1 }, worldInvalidation);
                }
                return admission;
            },
            cancel: (buildId) => fake.cancel(buildId),
        };
        const flow = makeFlow(boundary);
        await bringUp(flow);
        expect(flow.tool.status).toBe("compatible");

        const attempt1 = await issue(flow, facts(), readinessInput("gglab-dx12")); // in flight
        // The admission of #2 runs WHILE #1 settles as invalidated:
        // the world has no proven facts by the time #2 is admitted.
        const attempt2 = await issue(flow, facts(), readinessInput("gglab-dx12"));
        expect(flow.tool.status, "the late invalidation IS a lifecycle event for the current state").toBe("unavailable");
        expect(flow.buildSession.inFlight.map((attempt) => attempt.buildId.sequence), "only the new attempt is in flight").toEqual([
            attempt2.buildId.sequence,
        ]);

        // #2's intent is bound to the proof THAT ADMISSION was taken under
        // (the proven facts of attempt #1's world) — never to whatever
        // the state became afterwards (here: nothing at all).
        const inFlightSecond = flow.buildSession.inFlight.find((attempt) => attempt.buildId.sequence === attempt2.buildId.sequence);
        expect(inFlightSecond, "the new attempt is in flight with a fixed intent").toBeDefined();
        if (inFlightSecond !== undefined) {
            expect(inFlightSecond.intent.sourceIdentity).toBe("cd".repeat(32));
            expect(inFlightSecond.intent.target).toBe("gglab-dx12");
            expect(inFlightSecond.intent.tool.identity).toBe("gglab-shaderc");
            expect(inFlightSecond.intent.tool.version).toBe(FACTS_OK.toolVersion);
            expect(inFlightSecond.intent.tool.producerIdentity).toBe(FACTS_OK.producerIdentity);
        }

        // #1 settles as an explicit failure with the host's own facts…
        const firstOutcome = await attempt1.outcome;
        expect(firstOutcome.kind).toBe("failed");
        if (firstOutcome.kind === "failed" && "termination" in firstOutcome) {
            expect(firstOutcome.termination).toMatchObject({ kind: "candidate-invalidated", observation: "missing" });
        }
        // …and #2 still settles under ITS OWN admission bound.
        fake.releasePending({ sequence: 2 });
        const secondOutcome = await attempt2.outcome;
        expect(secondOutcome.kind).toBe("succeeded");
        const report = reportOf(flow);
        expect(report.states.map((entry) => entry.buildId.sequence).sort((a, b) => a - b)).toEqual([
            attempt1.buildId.sequence,
            attempt2.buildId.sequence,
        ]);
        expect(report.states.find((entry) => entry.buildId.sequence === 1)?.state).toBe("failed");
        expect(report.states.find((entry) => entry.buildId.sequence === attempt2.buildId.sequence)?.state).toBe("current");
        expect(report.states.find((entry) => entry.buildId.sequence === attempt2.buildId.sequence)?.intent.tool.version, "its intent carries the admitted proof").toBe(FACTS_OK.toolVersion);
    });
});

/* Scenario 14 — a requirement change is a tool-side event: the verdict
 *  taken under the old requirement is void (the candidate observation is
 *  still a fact), and a fresh handshake re-proves it under the new one —
 *  never an editor-side version comparison, never a stale Compatible. */
describe("14 · a re-stated requirement voids the old verdict; the handshake re-proves under the new one", () => {
    it("a compatible proof under the old requirement is NOT a verdict under the new one: discovered, NotReady, and the client's own fresh judgment", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.tool.status).toBe("compatible");
        expect(flow.compileGate(facts(), readinessInput("gglab-dx12")).admitted).toBe(true);

        // The descriptor re-states its requirement (minimum 2.0.0): the
        // tool (1.2.0) does not meet it — a fact only the client's
        // judgment can state, on a FRESH handshake.
        const invalidated = flow.updateJudgment({ identity: "gglab-shaderc", minimumVersion: "2.0.0", versionComparison: "semver" });
        expect(invalidated, "a proven verdict stood under the old requirement").toBe(true);
        expect(flow.tool, "the verdict and its proof dissolve; the candidate observation stays a fact").toEqual({
            status: "discovered",
            candidate: CANDIDATE,
        });
        const admission = await flow.compile(facts(), readinessInput("gglab-dx12"));
        expect(admission.admitted, "no compile issues while the verdict is void").toBe(false);
        if (admission.admitted === false) {
            expect(admission.gate.readiness.status).toBe("NotReady");
            if (admission.gate.readiness.status === "NotReady") {
                expect(admission.gate.readiness.reasons.map((reason) => reason.reason)).toContain("ToolDiscovered");
            }
        }

        // The fresh handshake is judged under the NEW requirement: the
        // tool's own facts fail it, structured and visible.
        await flow.handshake();
        expect(flow.tool.status, "the fresh judgment contradicts the raised minimum").toBe("incompatible");
        if (flow.tool.status === "incompatible") {
            expect(flow.tool.mismatches.map((mismatch) => mismatch.kind)).toEqual(["version"]);
            expect(flow.tool.mismatches[0]).toMatchObject({ kind: "version", version: { status: "below-minimum" } });
        }
        expect(fake.compileCalls, "nothing was issued across the change").toBe(0);
    });

    it("a requirement the tool already satisfies still re-enters through a fresh handshake — and then compiles", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.tool.status).toBe("compatible");

        const invalidated = flow.updateJudgment({ identity: "gglab-shaderc", minimumVersion: "0.5.0", versionComparison: "semver" });
        expect(invalidated).toBe(true);
        expect(flow.tool).toEqual({ status: "discovered", candidate: CANDIDATE });

        await flow.handshake();
        expect(flow.tool.status, "the fresh proof stands under the new requirement").toBe("compatible");
        const admission = await flow.compile(facts(), readinessInput("gglab-dx12"));
        expect(admission.admitted, "under the new requirement the gate admits again").toBe(true);
        if (admission.admitted === true) {
            expect(await admission.outcome).toMatchObject({ kind: "succeeded" });
        }
        expect(fake.compileCalls).toBe(1);
    });

    it("re-stating the SAME requirement changes nothing: no invalidation, no re-handshake needed", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.tool.status).toBe("compatible");
        const before = flow.handshakeRecord;
        expect(before, "a proof attempt was recorded").not.toBeNull();
        expect(flow.updateJudgment({ identity: "gglab-shaderc", minimumVersion: "1.0.0", versionComparison: "semver" }), "a re-statement with the same value is a no-op").toBe(false);
        expect(flow.tool.status, "the verdict stands").toBe("compatible");
        expect(flow.handshakeRecord, "the proof record stands").toBe(before);
        expect(flow.compileGate(facts(), readinessInput("gglab-dx12")).admitted).toBe(true);
        expect(fake.handshakeCalls, "no re-handshake was forced").toBe(1);
    });
});

/* Scenario 15 — the gate record stays GATE-ONLY: a late older settlement
 *  never stamps an attempt onto it (that would forge "gate #N + outcome
 *  of attempt #M"), and the surface's "newest issued outcome" is the
 *  ANCHOR's own line record — read from the session line, its single
 *  authority — never a different attempt's outcome in its place. */
/** The surface's own read (as the hook computes it): the newest ISSUED
 *  attempt's outcome, from the session line — settled, or the honest
 *  "not yet" while in flight. */
function newestIssuedOutcome(flow: NativeBuildFlow): AttemptOutcome | null {
    const session = flow.buildSession;
    const anchor = session.lastIssued;
    if (anchor === null) {
        return null;
    }
    const record = session.line.attempts.find((entry) => entry.buildId.sequence === anchor.buildId.sequence);
    return record?.outcome ?? null;
}

describe("15 · the gate record is gate facts only; the line is the newest-outcome authority", () => {
    it("#1 and #2 in flight; #2 settles; #1 SETTLES LATE — the gate record never carries an attempt; the newest read is #2's, never #1's", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }, { stdout: compileOk("gglab-vulkan13"), exitCode: 0 }],
            keepCompilePending: true,
        });
        const flow = makeFlow(fake);
        await bringUp(flow);

        const attempt1 = await issue(flow, facts(), readinessInput("gglab-dx12")); // #1 in flight (old intent)
        const attempt2 = await issue(flow, facts(), readinessInput("gglab-vulkan13")); // #2 in flight (new intent)

        // The newest GATE invocation's record: gate facts ONLY — no
        // attempt buildId, no outcome. That shape is the whole point.
        expect(flow.lastGate?.admitted, "the newest gate admitted").toBe(true);
        expect(flow.lastGate, "the gate record carries no attempt identity").not.toHaveProperty("buildId");
        expect(flow.lastGate, "the gate record carries no outcome").not.toHaveProperty("outcome");

        // #2 settles first; the anchor is #2.
        fake.releasePending({ sequence: 2 });
        await attempt2.outcome;
        expect(newestIssuedOutcome(flow)).toMatchObject({ kind: "succeeded", envelope: { target: "gglab-vulkan13" } });

        // #1 settles LATE: its outcome lands in its OWN line record.
        fake.releasePending({ sequence: 1 });
        const late1 = await attempt1.outcome;
        expect(late1).toMatchObject({ kind: "succeeded", envelope: { target: "gglab-dx12" } });

        // The gate record is UNCHANGED by either settlement — it cannot
        // mix a gate with someone else's outcome, in either order.
        expect(flow.lastGate, "settlements never mutate the gate record").not.toHaveProperty("buildId");
        expect(flow.lastGate, "settlements never mutate the gate record").not.toHaveProperty("outcome");
        expect(flow.lastGate?.admitted).toBe(true);

        // And the surface's "newest issued attempt outcome" — read
        // through the anchor — is STILL #2's outcome, never the late #1's.
        expect(flow.buildSession.lastIssued?.buildId.sequence, "the anchor stays with the newest issued attempt").toBe(2);
        expect(newestIssuedOutcome(flow), "the newest read is #2's own record").toMatchObject({ kind: "succeeded", envelope: { target: "gglab-vulkan13" } });

        // Each attempt keeps its own line record (their single authority),
        // readable by its own BuildId.
        const record1 = flow.buildSession.line.attempts.find((entry) => entry.buildId.sequence === 1);
        expect(record1?.outcome).toMatchObject({ kind: "succeeded", envelope: { target: "gglab-dx12" } });
    });
});

/* Scenario 16 — the TARGET has exactly one authority (the design's
 *  target rule): the explicit build configuration. The caller's input
 *  has NO target field — `compile` composes the configured target into
 *  the request value, so the gate JUDGES the very value that is ISSUED:
 *  no call shape can judge one target and issue another. */
describe("16 · the target the gate judges is the target that gets issued", () => {
    it("a world that supports only the configured target: the gate admits it, and the issued intent carries exactly that value", async () => {
        const factsVulkanOnly: ToolFacts = { ...FACTS_OK, supportedTargets: ["gglab-vulkan13"] };
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(factsVulkanOnly), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-vulkan13"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        await bringUp(flow);
        expect(flow.tool.status).toBe("compatible");

        // The caller's facts carry no target — the only target in play
        // is the configured one, and the same facts are judged against
        // whatever it is.
        const refused = flow.compileGate(facts(), readinessInput("gglab-dx12"));
        expect(refused.admitted, "the unsupported configured target is refused").toBe(false);

        const admitted = flow.compileGate(facts(), readinessInput("gglab-vulkan13"));
        expect(admitted.admitted, "the same facts, a supported configured target: admitted").toBe(true);

        const attempt = await issue(flow, facts(), readinessInput("gglab-vulkan13"));
        expect(flow.buildSession.lastIssued?.intent.target, "the ISSUED intent carries exactly the configured target").toBe("gglab-vulkan13");
        const outcome = await attempt.outcome;
        expect(outcome).toMatchObject({ kind: "succeeded" });
    });
});

/* Scenario 17 — discovery is SINGLE-FLIGHT: a call made while one is in
 *  flight JOINS that exact execution (the same promise); the newest
 *  boundary call is the only one in flight by construction, so no late
 *  settlement of an older call can supersede a newer one. The lane
 *  closes on settlement; the next call is a fresh discovery. */
describe("17 · discovery is single-flight — overlapping calls share one execution", () => {
    it("the call in flight is shared (no second boundary call); the lane closes on settlement and the next call is fresh", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
            keepDiscoveryPending: true,
        });
        const flow = makeFlow(fake);
        const first = flow.discover({ bundled: false });
        expect(flow.discoveryInFlight, "the first discovery is in flight").toBe(true);
        const second = flow.discover({ bundled: false });
        expect(second, "a call made in flight JOINS the same execution (the same promise)").toBe(first);
        expect(fake.discoverCalls, "exactly ONE boundary discovery exists").toBe(1);

        fake.releaseDiscovery();
        const outcome = await first;
        await expect(second, "both callers observe the shared execution's outcome").resolves.toBe(outcome);
        expect(flow.discoveryInFlight, "the lane closed on settlement").toBe(false);
        expect(flow.discovery).toBe(outcome);

        const later = flow.discover({ bundled: false });
        expect(later, "a call after settlement is a FRESH execution").not.toBe(first);
        expect(fake.discoverCalls).toBe(2);
        fake.releaseDiscovery();
        await later;
        expect(flow.discoveryInFlight).toBe(false);
    });
});

/* Scenario 18 — handshake is SINGLE-FLIGHT, like discovery: a call made
 *  while one is in flight (the startup bring-up, say) JOINS that
 *  execution — there is no second concurrent handshake for the same
 *  candidate, so no two-attempt "last one settles" question can even
 *  arise. Every entry point (startup and the button) shares the lane. */
describe("18 · handshake is single-flight — one lane for every entry point", () => {
    it("a handshake made while another is in flight shares the execution; exactly one boundary handshake exists", async () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [],
            keepHandshakePending: true,
        });
        const flow = makeFlow(fake);
        const discovery = await flow.discover({ bundled: false });
        expect(discovery.candidate, "the candidate resolves ahead of the lane test").not.toBeUndefined();

        const first = flow.handshake();
        expect(flow.handshakeInFlight, "the first handshake is in flight").toBe(true);
        const second = flow.handshake();
        expect(second, "a call made in flight JOINS the same execution").toBe(first);
        expect(fake.handshakeCalls, "exactly ONE boundary handshake exists").toBe(1);

        fake.releaseHandshake();
        const record = await first;
        expect(await second, "both callers get the shared execution's record").toBe(record);
        expect(flow.handshakeInFlight, "the lane closed on settlement").toBe(false);
        expect(flow.tool.status, "the single execution's proof landed").toBe("compatible");
    });
});

/* Scenario 19 — the discovery request travels VERBATIM: the flow
 *  passes the caller's request configuration to the boundary unchanged
 *  (no copy, no mutation, no stripping of the configured fields) — what
 *  was configured is what the service is asked to resolve (design
 *  section 5: the rule walk belongs to the service; the value only
 *  supplies its input). */
describe("19 · the discovery request reaches the boundary unchanged", () => {
    it("the request the flow was given is the request the boundary received — same reference, same values", () => {
        const fake = new FakeHostBoundary({
            discovery: { kind: "resolved", candidate: CANDIDATE },
            handshake: { stdout: describeDocument(FACTS_OK), exitCode: 0 },
            compile: [{ stdout: compileOk("gglab-dx12"), exitCode: 0 }],
        });
        const flow = makeFlow(fake);
        const request = { bundled: false, explicitConfig: "C:\\tools\\gglab-shaderc.exe", siblingBuildOutput: "C:\\GGLab\\Build\\Output" };
        flow.discover(request);
        expect(fake.lastDiscoveryRequest, "the boundary received exactly the request it was given (same reference — no clone, no mutation)").toBe(request);
        expect(fake.lastDiscoveryRequest).toEqual({
            bundled: false,
            explicitConfig: "C:\\tools\\gglab-shaderc.exe",
            siblingBuildOutput: "C:\\GGLab\\Build\\Output",
        });
    });
});
