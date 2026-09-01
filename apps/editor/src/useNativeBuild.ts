/**
 * The editor's native-build surface as a React hook — a THIN adapter
 * over the pure flow (native-build-flow), the session store
 * (native-build-session), the readiness composition (native-build-
 * readiness), and the inspector projection (build-inspector).
 *
 * All the RULES live in the pure modules (tested without React); this
 * hook only: creates the flow once a boundary exists (desktop shell —
 * the web shell reports the absence as the `HostUnavailable` capability
 * fact), wires the descriptor change into the flow's judgment (a
 * re-stated requirement invalidates any verdict taken under the old one),
 * runs the startup discovery + handshake (the tool's own events, not a
 * UI nicety), and recomposes the readiness on every input change
 * (derived, never remembered).
 *
 * The native production PATH is not offered by this surface (the
 * 2026-08-30 correctness amendment): the generated surface function is a
 * function contract, not a complete program entry, and no product path
 * composes or issues the function-only complete-program request. The
 * surface states that as its program-composition state; it discovers the
 * tool, establishes proof, and displays the readiness and generation
 * facts. The flow's orchestration over the host boundary stays as the
 * machinery the main-owned complete-program operation will drive.
 *
 * Discovery and handshake are single-flight in the flow itself: the
 * surface's in-flight facts are that same lane, observed — a tick
 * re-reads the flow the moment a lane opens or closes (no second state),
 * so a button's disabled state reflects the whole window, not only what
 * stood before or after it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HlslEmission, SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import type { AttemptOutcome, BuildLineReport } from "@gglab/shader-toolchain-client";
import { createBuildTargetConfiguration, setBuildTarget, type BuildTargetConfiguration } from "./build-target-config.js";
import {
    createDiscoveryConfiguration,
    discoveryRequestFor,
    setExplicitToolPath,
    setSiblingBuildOutput as applySiblingBuildOutput,
    type DiscoveryConfiguration,
} from "./discovery-config.js";
import { projectBuildInspector, type BuildInspectorFacts } from "./build-inspector.js";
import { sessionReport } from "./native-build-session.js";
import { NativeBuildFlow } from "./native-build-flow.js";
import { type NativeBuildReadiness } from "./native-build-readiness.js";
import { createTauriToolBoundary, toolBoundaryAvailable } from "./toolchain-host.js";

const EMPTY_REQUIREMENT = { identity: "", minimumVersion: "", versionComparison: "semver" };

/** The surface's OWN program-composition fact (one source for the whole
 *  editor surface): the generated function is a function contract, not a
 *  complete program entry (Preview Program design v1.0), and this editor
 *  owns no main-owned program. While it holds, the native production
 *  path is closed FOR THIS SURFACE at the readiness gate — no request,
 *  no BuildId, no artifact claim — while the generic flow/client mechanism
 *  stands ready for the caller that owns a complete program. */
const PRODUCT_PROGRAM_COMPOSITION = {
    available: false as const,
    detail:
        "This editor surface owns no complete-program composition for the generated function (a function contract, not a program entry). " +
        "The approved GGLab Preview Program design (v1.0) — the main-owned program and its Standalone Preview Lab — is the native production " +
        "path, pending implementation; function-level native qualification remains the main repository's permanent surface generated-function gate.",
};

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
    /** True only for a `Ready` composition (readiness is a fact the
     *  surface displays — the native production path itself is not
     *  offered by this surface; see the module's amendment note). */
    readonly ready: boolean;
    /** The flow (null until a boundary exists; the web shell keeps
     *  reporting the absence, not the missing capability). */
    readonly flow: NativeBuildFlow | null;
    /** The true capability fact as the shell observes the service. */
    readonly hostAvailable: boolean;
    readonly target: BuildTargetConfiguration;
    readonly setTarget: (target: string) => void;
    /** The discovery configuration (rule 1: an explicit tool path;
     *  rule 2: a sibling build-output location — empty means "not
     *  configured", and that rule records its own failure). */
    readonly discoveryConfig: DiscoveryConfiguration;
    readonly setToolPath: (path: string) => void;
    readonly setSiblingBuildOutput: (path: string) => void;
    /** The session's line projection against the current intent. */
    readonly lineReport: BuildLineReport | null;
    /** The NEWEST ISSUED attempt's outcome (the client's vocabulary) —
     *  read from the session line, its single authority: the anchor's
     *  own record once settled; null (an honest "not yet") while the
     *  anchor is still in flight. Under out-of-order settlements this
     *  can never be a different attempt's outcome. */
    readonly lastOutcome: AttemptOutcome | null;
    /** The inspector projection (one source of truth per field). */
    readonly inspector: BuildInspectorFacts | null;
    /** Whether a handshake is in flight — the flow's single-flight lane,
     *  observed (shared by the startup bring-up and this surface). */
    readonly handshakeInFlight: boolean;
    /** Whether a discovery is in flight — the flow's single-flight lane
     *  (Re-discover joins it; the button is disabled for the window). */
    readonly discoveryInFlight: boolean;
    readonly discoverNow: () => Promise<void>;
    readonly handshakeNow: () => Promise<void>;
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
    const [discoveryConfig, setDiscoveryConfig] = useState<DiscoveryConfiguration>(() => createDiscoveryConfiguration());
    const [, bump] = useState(0);
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
                    PRODUCT_PROGRAM_COMPOSITION,
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
    // against) — before any handshake that would read it. A genuinely
    // DIFFERENT requirement invalidates any verdict taken under the old
    // one (the candidate stays a fact; a fresh handshake re-proves it) —
    // a downgrade, and like every downgrade it is visible in a note.
    useEffect(() => {
        if (flow === null) {
            return;
        }
        const invalidated = flow.updateJudgment(
            input.descriptor !== null
                ? {
                      identity: input.descriptor.processContract.tool.identity,
                      minimumVersion: input.descriptor.processContract.tool.minimumVersion,
                      versionComparison: input.descriptor.processContract.tool.versionComparison,
                  }
                : EMPTY_REQUIREMENT,
        );
        if (invalidated) {
            note(
                "refusal",
                "The tool requirement changed: the previous verdict was judged under the old requirement and is void — the candidate is kept as a fact; a fresh handshake (re-)proves it and re-admits compiles.",
            );
        }
    }, [flow, input.descriptor, note]);

    // Startup: discovery, then the handshake (the proof operation, legal
    // for the resolved candidate). Both are the tool's OWN lifecycle
    // events — not UI state — and run once when the boundary exists.
    //
    // Each lane's open and close is a SURFACE FACT (the in-flight flags a
    // button renders against): the lane in the flow is the authority, and
    // a tick only makes the surface RE-READ the flow — before AND after
    // the await. Without the pre-await tick the flags would sit at their
    // stale value for the whole window (the flow moves false → true →
    // false while the surface only ever observes false).
    useEffect(() => {
        if (flow === null || startedRef.current) {
            return;
        }
        startedRef.current = true;
        void (async () => {
            // The discovery request is the configuration itself (rules 1
            // and 2, pass-through verbatim; `bundled` states the
            // development fact — no bundled deployment here).
            const discoveryPending = flow.discover(discoveryRequestFor(discoveryConfig));
            bump((n) => n + 1); // lane OPEN — the surface must observe "discovering"
            const discovery = await discoveryPending;
            bump((n) => n + 1); // lane CLOSED — the surface re-reads the tool state
            if (discovery.candidate !== undefined) {
                note("info", `Tool discovered (${discovery.candidate.rule}): ${discovery.candidate.toolPath}`);
                const handshakePending = flow.handshake();
                bump((n) => n + 1); // lane OPEN — the surface must observe "handshaking"
                await handshakePending;
                const tool = flow.tool;
                note("info", `Tool state after handshake: ${tool.status}`);
            } else {
                const failures = discovery.failures.map((failure) => `${failure.rule}: ${failure.reason}`).join("; ");
                note("refusal", `Tool unavailable — no candidate resolved (${failures})`);
            }
            bump((n) => n + 1);
        })();
    }, [flow, note, discoveryConfig]);

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

    // The attempt outcome is read from the session line — its single
    // authority ("BuildId → intent → outcome", one record per attempt).
    // The NEWEST ISSUED attempt is the anchor; read THAT record: settled
    // means its outcome, still in flight means the honest "not yet".
    // Under out-of-order settlements a late older settlement can never
    // masquerade as the newest one here.
    const lastOutcome: AttemptOutcome | null = (() => {
        if (flow === null) {
            return null;
        }
        const anchor = flow.buildSession.lastIssued;
        if (anchor === null) {
            return null;
        }
        const record = flow.buildSession.line.attempts.find((entry) => entry.buildId.sequence === anchor.buildId.sequence);
        return record?.outcome ?? null;
    })();

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
        // Open/join the flow's discovery lane, then make the surface
        // observe the OPEN lane before the window closes (the lane is the
        // authority; the tick only re-reads it — the Re-discover button's
        // disabled state and label render from this observation). The
        // request is the discovery configuration itself (pass-through).
        const pending = flow.discover(discoveryRequestFor(discoveryConfig));
        bump((n) => n + 1);
        const discovery = await pending;
        if (discovery.candidate !== undefined) {
            note("ok", `Tool resolved (${discovery.candidate.rule}): ${discovery.candidate.toolPath}`);
        } else {
            const failures = discovery.failures.map((failure) => `${failure.rule}: ${failure.reason}`).join("; ");
            note("refusal", `Tool unavailable — no candidate resolved (${failures})`);
        }
        bump((n) => n + 1);
    }, [flow, note, discoveryConfig]);

    const handshakeNow = useCallback(async (): Promise<void> => {
        if (flow === null) {
            note("refusal", "Handshake not available: no host boundary in this shell.");
            return;
        }
        // The flow's single-flight lane: if one is already in flight
        // (the startup bring-up, say), this call JOINS it — there is no
        // second concurrent handshake for the same candidate. Open/join,
        // then make the surface observe the OPEN lane before the window
        // closes (the button's disabled state renders from this).
        const pending = flow.handshake();
        bump((n) => n + 1);
        const record = await pending;
        const tool = flow.tool;
        if (record.admission.admitted === false) {
            note("refusal", `Handshake refused by the client gate: ${record.admission.reasons.map((reason) => reason.reason).join(", ")}`);
        } else if (record.candidateInvalidated) {
            note("refusal", "The host refuted the candidate's observation at spawn time; the state re-enters via discovery + handshake.");
        } else {
            note("info", `Handshake settled; tool state is now: ${tool.status}`);
        }
        bump((n) => n + 1);
    }, [flow, note]);

    const hostAvailable = flow !== null && toolBoundaryAvailable(globalThis);
    const handshakeInFlight = flow?.handshakeInFlight ?? false;
    const discoveryInFlight = flow?.discoveryInFlight ?? false;

    const setTarget = useCallback((next: string) => {
        setTargetConfig((previous) => setBuildTarget(previous, next));
        note("info", `Build target set to: ${next} (explicit configuration — the next BuildIntent carries it).`);
    }, [note]);

    // The discovery configuration (design section 5, rules 1 and 2):
    // explicit, visible, changeable session values — an empty value is
    // the honest "not configured", and that rule records its own
    // failure. Changing them changes the NEXT discovery (the operations
    // are explicit: the Re-discover button, never an automatic
    // re-resolution).
    const setToolPath = useCallback((path: string) => {
        setDiscoveryConfig((previous) => setExplicitToolPath(previous, path));
        note("info", `Tool path (explicit configuration) ${path === "" ? "cleared" : `set to: ${path}`} — the next discovery resolves over it.`);
    }, [note]);

    const setSiblingBuildOutput = useCallback((path: string) => {
        setDiscoveryConfig((previous) => applySiblingBuildOutput(previous, path));
        note("info", `Sibling build-output location ${path === "" ? "cleared" : `set to: ${path}`} — the next discovery resolves over it.`);
    }, [note]);

    return {
        readiness,
        ready,
        flow,
        hostAvailable,
        target,
        setTarget,
        discoveryConfig,
        setToolPath,
        setSiblingBuildOutput,
        lineReport,
        lastOutcome,
        inspector,
        handshakeInFlight,
        discoveryInFlight,
        discoverNow,
        handshakeNow,
        notes,
        addNote: note,
    };
}
