/**
 * The editor's native-build surface as a React hook — a THIN adapter
 * over the pure flow (native-build-flow), the session store
 * (native-build-session), the readiness composition (native-build-
 * readiness), and the inspector projection (build-inspector).
 *
 * All the RULES live in the pure modules (tested without React); this
 * hook only: creates the flow once a boundary exists (desktop shell —
 * the web shell reports the absence as the `HostUnavailable` capability
 * fact), wires the descriptor change into the flow's judgment, runs the
 * startup discovery + handshake (the tool's own events, not a UI
 * nicety), and recomposes the readiness on every input change (derived,
 * never remembered).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HlslEmission, SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import type { AttemptOutcome, BuildLineReport } from "@gglab/shader-toolchain-client";
import { createBuildTargetConfiguration, setBuildTarget, type BuildTargetConfiguration } from "./build-target-config.js";
import { projectBuildInspector, type BuildInspectorFacts } from "./build-inspector.js";
import { sessionReport } from "./native-build-session.js";
import { NativeBuildFlow } from "./native-build-flow.js";
import { type NativeBuildReadiness } from "./native-build-readiness.js";
import { createTauriToolBoundary, toolBoundaryAvailable } from "./toolchain-host.js";

const EMPTY_REQUIREMENT = { identity: "", minimumVersion: "", versionComparison: "semver" };

export interface UseNativeBuildInput {
    /** The loaded descriptor instance (null = not loaded — the core's
     *  reader's own fact). */
    readonly descriptor: SurfaceProfileDescriptor | null;
    /** The core's profile x descriptor compatibility verdict. */
    readonly descriptorCompatible: boolean;
    /** The core's own explanation of a failed verdict. */
    readonly descriptorDetail: string;
    /** The current emission (its identity is the inspector's build-side
     *  anchor). */
    readonly emission: HlslEmission | null;
}

export interface NativeBuildSurface {
    /** The composition's verdict, recomposed on every input change. */
    readonly readiness: NativeBuildReadiness;
    /** True only for a `Ready` composition — the compile gate. */
    readonly ready: boolean;
    /** The flow (null until a boundary exists; the web shell keeps
     *  reporting the absence, not the missing capability). */
    readonly flow: NativeBuildFlow | null;
    /** The true capability fact as the shell observes the service. */
    readonly hostAvailable: boolean;
    readonly target: BuildTargetConfiguration;
    readonly setTarget: (target: string) => void;
    /** The session's line projection against the current intent. */
    readonly lineReport: BuildLineReport | null;
    /** The latest attempt's outcome (the client's vocabulary). */
    readonly lastOutcome: AttemptOutcome | null;
    /** The inspector projection (one source of truth per field). */
    readonly inspector: BuildInspectorFacts | null;
    /** Whether a handshake is in progress (a fact, for the surface). */
    readonly handshakeInFlight: boolean;
    /** Whether a compile was issued and not yet settled. */
    readonly compileInFlight: boolean;
    readonly lastGateRefusal: readonly string[] | null;
    readonly discoverNow: () => Promise<void>;
    readonly handshakeNow: () => Promise<void>;
    readonly compileNow: (request: Parameters<NativeBuildFlow["compileGate"]>[0]) => Promise<{ admitted: boolean; buildId?: number; outcome?: AttemptOutcome }>;
    readonly cancelNow: (buildId: number) => Promise<void>;
    /** The operation note — structured one-liners (the surface states
     *  what happened and why; never prose-mined from tool output). */
    readonly notes: readonly { readonly level: "ok" | "info" | "refusal"; readonly text: string }[];
    readonly addNote: (level: "ok" | "info" | "refusal", text: string) => void;
}

export function useNativeBuild(input: UseNativeBuildInput): NativeBuildSurface {
    // A re-render tick: the flow's own facts (tool state, the session
    // line, the attempt records) change IN PLACE — the tick is what
    // makes the surface observe them, and it is the only state this
    // hook adds (no second copy of any fact the flow owns).
    const [target, setTargetConfig] = useState<BuildTargetConfiguration>(() => createBuildTargetConfiguration());
    const [, bump] = useState(0);
    const [handshakeInFlight, setHandshakeInFlight] = useState(false);
    const [notes, setNotes] = useState<{ level: "ok" | "info" | "refusal"; text: string }[]>([]);
    const flowRef = useRef<NativeBuildFlow | null>(null);
    const startedRef = useRef(false);

    const note = useCallback((level: "ok" | "info" | "refusal", text: string) => {
        setNotes((previous) => [...previous.slice(-23), { level, text }]);
    }, []);

    // Desktop only: the product boundary is code-split; the absence (web
    // shell) is a structured capability fact, not an exception.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            if (!toolBoundaryAvailable(globalThis)) {
                return;
            }
            const host = await createTauriToolBoundary();
            if (cancelled) {
                return;
            }
            if (flowRef.current === null) {
                flowRef.current = new NativeBuildFlow(
                    host,
                    () => {
                        const boundaryNow = flowRef.current;
                        if (boundaryNow === null) {
                            return { available: false, detail: "no host boundary in this shell" };
                        }
                        void boundaryNow;
                        return toolBoundaryAvailable(globalThis)
                            ? { available: true, detail: "the service's commands are invocable on this shell" }
                            : { available: false, detail: "no Tauri host in this shell (web build — the desktop service is the only execution host)" };
                    },
                    { requirement: EMPTY_REQUIREMENT },
                );
            }
            bump((n) => n + 1);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const flow = flowRef.current;

    // The descriptor change refreshes the flow's judgment input (the
    // single source of truth for the requirement the verdicts judge
    // against) — before any handshake that would read it.
    useEffect(() => {
        if (flow === null) {
            return;
        }
        flow.updateJudgment(
            input.descriptor !== null
                ? {
                      identity: input.descriptor.processContract.tool.identity,
                      minimumVersion: input.descriptor.processContract.tool.minimumVersion,
                      versionComparison: input.descriptor.processContract.tool.versionComparison,
                  }
                : EMPTY_REQUIREMENT,
        );
    }, [flow, input.descriptor]);

    // Startup: discovery, then the handshake (the proof operation, legal
    // for the resolved candidate). Both are the tool's OWN lifecycle
    // events — not UI state — and run once when the boundary exists.
    useEffect(() => {
        if (flow === null || startedRef.current) {
            return;
        }
        startedRef.current = true;
        void (async () => {
            const discovery = await flow.discover({ bundled: false });
            if (discovery.candidate !== undefined) {
                note("info", `Tool discovered (${discovery.candidate.rule}): ${discovery.candidate.toolPath}`);
                await flow.handshake();
                const tool = flow.tool;
                note("info", `Tool state after handshake: ${tool.status}`);
            } else {
                const failures = discovery.failures.map((failure) => `${failure.rule}: ${failure.reason}`).join("; ");
                note("refusal", `Tool unavailable — no candidate resolved (${failures})`);
            }
            bump((n) => n + 1);
        })();
    }, [flow, note]);

    // The readiness — recomposed from CURRENT facts on every render
    // (derived, never remembered; a downgrade reads like an upgrade).
    const readiness: NativeBuildReadiness =
        flow === null
            ? {
                  status: "NotReady",
                  reasons: [
                      {
                          reason: "HostUnavailable",
                          detail: "no Tauri host in this shell (web build — the desktop service is the only execution host)",
                      },
                  ],
              }
            : flow.readiness({
                  descriptorLoaded: input.descriptor !== null,
                  descriptorCompatible: input.descriptorCompatible,
                  descriptorDetail: input.descriptorDetail,
                  configuredTarget: target.target,
              });

    const ready = readiness.status === "Ready";

    // The line projection is derived on every render (the session store
    // is the flow's; a memo keyed on the wrong fact would go stale the
    // moment the session moves — derivation is the only safe shape).
    const lineReport =
        flow === null || flow.buildSession.lastIssued === null ? null : sessionReport(flow.buildSession, flow.buildSession.lastIssued.intent);

    const lastCompile = flow?.compile ?? null;
    const lastOutcome = lastCompile !== null && lastCompile.outcome !== undefined ? lastCompile.outcome : null;

    const inspector = useMemo(() => {
        if (flow === null) {
            return null;
        }
        return projectBuildInspector(flow, input.descriptor, { ok: input.descriptorCompatible, detail: input.descriptorDetail }, target, readiness, input.emission !== null && input.emission.ok === true && input.emission.sourceMap !== null ? { sourceIdentity: input.emission.sourceMap.generatedSourceIdentity } : null, lineReport, lastOutcome);
    }, [flow, input, target, readiness, lineReport, lastOutcome]);

    const discoverNow = useCallback(async (): Promise<void> => {
        if (flow === null) {
            note("refusal", "Discover not available: no host boundary in this shell.");
            return;
        }
        const discovery = await flow.discover({ bundled: false });
        if (discovery.candidate !== undefined) {
            note("ok", `Tool resolved (${discovery.candidate.rule}): ${discovery.candidate.toolPath}`);
        } else {
            const failures = discovery.failures.map((failure) => `${failure.rule}: ${failure.reason}`).join("; ");
            note("refusal", `Tool unavailable — no candidate resolved (${failures})`);
        }
        bump((n) => n + 1);
    }, [flow, note]);

    const handshakeNow = useCallback(async (): Promise<void> => {
        if (flow === null) {
            note("refusal", "Handshake not available: no host boundary in this shell.");
            return;
        }
        setHandshakeInFlight(true);
        try {
            const record = await flow.handshake();
            const tool = flow.tool;
            if (record.admission.admitted === false) {
                note("refusal", `Handshake refused by the client gate: ${record.admission.reasons.map((reason) => reason.reason).join(", ")}`);
            } else if (record.candidateInvalidated) {
                note("refusal", "The host refuted the candidate's observation at spawn time; the state re-enters via discovery + handshake.");
            } else {
                note("info", `Handshake settled; tool state is now: ${tool.status}`);
            }
        } finally {
            setHandshakeInFlight(false);
            bump((n) => n + 1);
        }
    }, [flow, note]);

    const compileNow = useCallback(
        async (request: Parameters<NativeBuildFlow["compileGate"]>[0]): Promise<{ admitted: boolean; buildId?: number; outcome?: AttemptOutcome }> => {
            if (flow === null) {
                note("refusal", "Compile not available: no host boundary in this shell.");
                return { admitted: false };
            }
            const gate = flow.compileGate(request, {
                descriptorLoaded: input.descriptor !== null,
                descriptorCompatible: input.descriptorCompatible,
                descriptorDetail: input.descriptorDetail,
                configuredTarget: target.target,
            });
            if (gate.admitted === false) {
                if (gate.readiness.status === "NotReady") {
                    note("refusal", `Compile refused by the readiness gate: ${gate.readiness.reasons.map((r) => r.reason).join(", ")}`);
                } else {
                    const wellFormed = gate.requestWellFormed;
                    note("refusal", `Compile refused: the request is not well-formed${wellFormed.ok === false ? ` (${wellFormed.reason}: ${wellFormed.detail})` : ""}`);
                }
                return { admitted: false };
            }
            bump((n) => n + 1);
            const attempt = await flow.beginCompile(request);
            const settledOutcome = await attempt.outcome;
            note("info", `Attempt #${attempt.buildId.sequence} settled: the line records the outcome.`);
            bump((n) => n + 1);
            return { admitted: true, buildId: attempt.buildId.sequence, outcome: settledOutcome };
        },
        [flow, note, input.descriptor, input.descriptorCompatible, input.descriptorDetail, target.target],
    );

    const cancelNow = useCallback(
        async (buildId: number): Promise<void> => {
            if (flow === null) {
                return;
            }
            const { alreadySettled } = await flow.cancel({ sequence: buildId });
            note("info", alreadySettled ? `Cancel reported: attempt #${buildId} had already settled (nothing changed).` : `Cancel reported for attempt #${buildId} (the settlement follows on the attempt's own promise).`);
            bump((n) => n + 1);
        },
        [flow, note],
    );

    const hostAvailable = flow !== null && toolBoundaryAvailable(globalThis);
    const compileInFlight = flow !== null && flow.buildSession.inFlight.length > 0;
    const lastGateRefusal = lastCompile !== null && lastCompile.admitted === false ? (lastCompile.readiness.status === "NotReady" ? lastCompile.readiness.reasons.map((reason) => reason.reason) : ["request-not-well-formed"]) : null;

    const setTarget = useCallback((next: string) => {
        setTargetConfig((previous) => setBuildTarget(previous, next));
        note("info", `Build target set to: ${next} (explicit configuration — the next BuildIntent carries it).`);
    }, [note]);

    return {
        readiness,
        ready,
        flow,
        hostAvailable,
        target,
        setTarget,
        lineReport,
        lastOutcome,
        inspector,
        handshakeInFlight,
        compileInFlight,
        lastGateRefusal,
        discoverNow,
        handshakeNow,
        compileNow,
        cancelNow,
        notes,
        addNote: note,
    };
}
