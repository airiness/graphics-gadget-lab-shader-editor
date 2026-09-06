/**
 * The Build and Preview bottom-panel views — PRESENTATION over the panel
 * vocabulary's projections (the frozen vocabulary boundary): each view
 * takes the
 * OWNER'S session value (the editor's build-line session / the Preview
 * build session), projects it through the vocabulary's chronology
 * functions, and renders the rows. The rendering layer never re-judges:
 * a build row's state is the owner's own attempt-state assignment (or
 * `in-flight` for an issued-and-not-settled row), a preview row's state
 * and outcome are the owner record's own fields, and the outcome facts
 * (status, diagnostics, termination structure, binary evidence) are
 * rendered verbatim from the owners' records that the rows carry by
 * reference.
 *
 * The views are props-only presentation components (no hooks, no owner
 * access) so they render and test over any session value of the owner's
 * type. What they deliberately do NOT own: the sessions themselves
 * (sealed ownership), the projections' rules (the vocabulary), and any
 * Build / Preview state beyond what the rows already state.
 */
import type { ReactNode } from "react";
import type { AttemptOutcome, PreviewAttemptOutcome } from "@gglab/shader-toolchain-client";
import type { NativeBuildSession } from "./native-build-session.js";
import type { PreviewBuildSession } from "./preview-build-session.js";
import { buildChronology, type BuildRow } from "./panel-vocabulary.js";
import { previewChronology, type PreviewRow } from "./panel-vocabulary.js";
import { describePreviewAttemptOutcome } from "./preview-attempt-summary.js";

/** One surface operation note (both surfaces share this note shape). */
export interface PanelNote {
    readonly level: "ok" | "info" | "refusal";
    readonly text: string;
}

/**
 * A stable one-line description of the owner's build outcome vocabulary —
 * a rendering helper, not a judgment: it names exactly what the outcome
 * says (succeeded / canceled / failed with the tool's status, a rejection
 * reason, a channel violation, an invalidation) and nothing more.
 */
export function describeBuildOutcome(outcome: AttemptOutcome): string {
    switch (outcome.kind) {
        case "succeeded":
            return "succeeded — artifact produced";
        case "canceled":
            return "canceled (explicit, never lost)";
        case "failed": {
            if ("envelope" in outcome) {
                const count = outcome.envelope.diagnostics.length;
                return `failed (tool status "${outcome.envelope.status}", ${count} diagnostic${count === 1 ? "" : "s"}${count > 0 ? " — the diagnostics follow as their own rows" : ""})`;
            }
            switch (outcome.termination.kind) {
                case "timed-out":
                    return "failed — timed out (the tool never reported)";
                case "launch-failed":
                    return "failed — the candidate could not be launched";
                case "channel-violated":
                    return `failed — channel violated (${outcome.termination.violation.reason})`;
                case "machine-document-rejected":
                    return `failed — the output was rejected as a machine document (${outcome.termination.rejection.reason})`;
                case "candidate-invalidated":
                    return `failed — candidate invalidated (${outcome.termination.observation})`;
            }
        }
    }
}

/** The structured detail a build outcome carries, rendered verbatim from
 *  the owner's record: the diagnostics (message + location fact when the
 *  tool reports one, or exactly "no structured diagnostic"), the
 *  termination's own structure, or the succeeded envelope's binary
 *  evidence. Rendering only — every value is lifted from the record. */
function buildOutcomeDetail(outcome: AttemptOutcome): readonly ReactNode[] {
    if (outcome.kind === "succeeded") {
        const envelope = outcome.envelope;
        return [
            <p key="binary">
                binary {envelope.binaryFormat} {envelope.binaryHash.slice(0, 16)}… · target {envelope.target} · cache {envelope.fromCache ? "hit" : "miss"}
            </p>,
        ];
    }
    if (outcome.kind === "failed" && "envelope" in outcome) {
        const diagnostics = outcome.envelope.diagnostics;
        if (diagnostics.length === 0) {
            return [<p key="no-diagnostics">the tool reported the failure with no structured diagnostic</p>];
        }
        return diagnostics.map((diagnostic, index) => (
            <p key={`diagnostic-${index}`}>
                {diagnostic.sourceIdentity !== undefined ? `[${diagnostic.sourceIdentity}] ` : ""}
                {diagnostic.message}
            </p>
        ));
    }
    if (outcome.kind === "failed") {
        const termination = outcome.termination;
        switch (termination.kind) {
            case "timed-out":
                return [<p key="termination">bounded execution ended before the tool reported a result</p>];
            case "launch-failed":
                return [<p key="termination">bounded execution itself could not launch the candidate</p>];
            case "channel-violated": {
                const violation = termination.violation;
                const detail =
                    violation.reason === "stderr-non-empty"
                        ? `${violation.byteLength} bytes of stderr were reported in a channel the process contract keeps empty`
                        : violation.reason === "stdout-not-valid-utf8"
                          ? `stdout was not valid UTF-8${violation.detail !== undefined ? ` (${violation.detail})` : ""}`
                          : `document exit ${violation.documentExitCode} vs process exit ${violation.processExitCode}`;
                return [<p key="termination">{detail}</p>];
            }
            case "machine-document-rejected":
                return [
                    <p key="termination">
                        rejection: {termination.rejection.reason}{termination.rejection.detail !== undefined ? ` — ${termination.rejection.detail}` : ""}
                    </p>,
                ];
            case "candidate-invalidated":
                return [
                    <p key="termination">
                        the host's provenance check refused the launch ({termination.observation})
                        {termination.observedIdentity !== null ? ` — observed identity ${termination.observedIdentity}` : ""}
                    </p>,
                ];
        }
    }
    return [];
}

/** One build row's rendering: identity + the owner's state (verbatim) +
 *  the composed request + the row's outcome facts when settled. */
function BuildRowEntry(props: { readonly row: BuildRow }) {
    const { row } = props;
    const inFlight = row.state === "in-flight";
    return (
        <li className="gglab-bottom-view-row">
            <span className="gglab-bottom-view-head">
                <span className="mono">#{row.buildId.sequence}</span>
                <span className={`gglab-view-state gglab-view-state-${row.state}`}>{row.state}</span>
                <span className="gglab-bottom-view-intent mono">
                    {row.intent.target} · {row.intent.stage} · {row.intent.entry}
                </span>
            </span>
            <span className="gglab-bottom-view-identity mono">
                generated source {row.correlation.generatedSourceIdentity !== null ? row.correlation.generatedSourceIdentity.slice(0, 12) + "…" : "(none)"}
            </span>
            {inFlight ? (
                <p className="gglab-bottom-view-note">issued — not yet settled</p>
            ) : (
                <>
                    <p className="gglab-bottom-view-outcome">{describeBuildOutcome(row.outcome)}</p>
                    {buildOutcomeDetail(row.outcome)}
                </>
            )}
        </li>
    );
}

/** The BUILD view: the owner's build session projected into its
 *  chronology (settled AND in-flight, each with the owner's own state)
 *  plus the surface's operation notes. The view owns no state of its own
 *  beyond what its props name. */
export function BuildPanelView(props: { readonly session: NativeBuildSession | null; readonly notes: readonly PanelNote[] }) {
    const { session, notes } = props;
    if (session === null) {
        return (
            <div className="gglab-bottom-view" aria-label="Build chronology (no host)">
                <p className="gglab-bottom-view-empty">No desktop build host in this shell, so this session has no build line.</p>
                {renderNotes(notes)}
            </div>
        );
    }
    const rows = buildChronology(session);
    return (
        <div className="gglab-bottom-view" aria-label="Build chronology">
            {rows.length === 0 ? (
                <p className="gglab-bottom-view-empty">No build attempts yet — the line is empty.</p>
            ) : (
                <ul className="gglab-bottom-view-rows" aria-label="Build attempts">
                    {rows.map((row) => (
                        <BuildRowEntry key={row.buildId.sequence} row={row} />
                    ))}
                </ul>
            )}
            {renderNotes(notes)}
        </div>
    );
}

/** The structured detail a preview outcome still carries beyond its
 *  summary line: the success envelope's structured notes, rendered as
 *  the tool's own lines (with no severity invented for them). A failure
 *  envelope's diagnostics already live IN the summary line itself; a
 *  termination's structure is complete there too — nothing to add. */
function previewOutcomeDetail(outcome: PreviewAttemptOutcome): readonly ReactNode[] {
    if (outcome.kind !== "published") {
        return [];
    }
    const diagnostics = outcome.envelope.diagnostics;
    return diagnostics.map((diagnostic, index) => (
        <p key={`diagnostic-${index}`}>
            {diagnostic.sourceIdentity !== undefined ? `[${diagnostic.sourceIdentity}] ` : ""}
            {diagnostic.message}
        </p>
    ));
}

/** One preview row's rendering: attempt identity + session identity +
 *  the owner record's own state/outcome fields, with the outcome's
 *  structured detail. */
function PreviewRowEntry(props: { readonly row: PreviewRow }) {
    const { row } = props;
    const record = row.record;
    const pending = record.state === "pending";
    return (
        <li className="gglab-bottom-view-row">
            <span className="gglab-bottom-view-head">
                <span className="mono">#{record.attemptSequence}</span>
                <span className={`gglab-view-state gglab-view-state-${pending ? "pending" : record.outcome.kind}`}>
                    {pending ? "pending" : record.outcome.kind}
                </span>
                <span className="gglab-bottom-view-intent mono">
                    {record.intent.targetProfile} · generated source {record.intent.generatedSourceIdentity.slice(0, 12)}…
                </span>
            </span>
            <span className="gglab-bottom-view-identity mono">
                session {row.correlation.previewSessionId}
                {row.correlation.publicationId !== null ? ` · publication ${row.correlation.publicationId}` : ""}
            </span>
            {pending ? (
                <p className="gglab-bottom-view-note">issued — not yet settled</p>
            ) : (
                <>
                    <p className="gglab-bottom-view-outcome">{describePreviewAttemptOutcome(record.attemptSequence, record.outcome)}</p>
                    {previewOutcomeDetail(record.outcome)}
                </>
            )}
        </li>
    );
}

/** The PREVIEW view: the owner's Preview build session projected into its
 *  chronology (every attempt, pending and settled, with the owner record's
 *  own state and outcome) plus the surface's operation notes. */
export function PreviewPanelView(props: { readonly session: PreviewBuildSession | null; readonly notes: readonly PanelNote[] }) {
    const { session, notes } = props;
    if (session === null) {
        return (
            <div className="gglab-bottom-view" aria-label="Preview chronology (no host)">
                <p className="gglab-bottom-view-empty">
                    No desktop Preview host in this shell, so there is no Preview session and no attempt line.
                </p>
                {renderNotes(notes)}
            </div>
        );
    }
    const rows = previewChronology(session);
    return (
        <div className="gglab-bottom-view" aria-label="Preview chronology">
            {rows.length === 0 ? (
                <p className="gglab-bottom-view-empty">No Preview attempts yet — the line is empty.</p>
            ) : (
                <ul className="gglab-bottom-view-rows" aria-label="Preview attempts">
                    {rows.map((row) => (
                        <PreviewRowEntry key={row.record.attemptSequence} row={row} />
                    ))}
                </ul>
            )}
            {renderNotes(notes)}
        </div>
    );
}

function renderNotes(notes: readonly PanelNote[]): ReactNode {
    if (notes.length === 0) {
        return null;
    }
    return (
        <ul className="gglab-native-notes" aria-label="Surface notes">
            {notes.map((note, index) => (
                <li key={`${note.text}-${index}`} className={`gglab-note-${note.level}`}>
                    {note.text}
                </li>
            ))}
        </ul>
    );
}
