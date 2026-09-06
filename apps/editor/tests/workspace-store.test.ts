/**
 * The Workspace's synchronous external store authority — the frozen
 * contract, pinned one-for-one:
 *
 *   - apply is synchronous and calls reduce exactly once;
 *   - next !== current -> snapshot replaced FIRST, subscribers notified
 *     AFTER (subscribers see the committed state);
 *   - next === current -> result returned, NO new snapshot / notification;
 *   - getSnapshot returns the same object identity while unchanged;
 *   - a thrown reduce leaves the snapshot unchanged, publishes nothing,
 *     and propagates (strong exception safety);
 *   - a nested apply while reducing OR publishing is an invariant
 *     violation and is rejected.
 */
import { parseShaderGraphDocument, type HlslEmission, type ShaderGraphDocument, type SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { describe, expect, it } from "vitest";
import { createSession, provenanceFromImport, type DocumentSession } from "../src/document-session.js";
import { createDocumentSessionId } from "../src/workspace-session.js";
import { WorkspaceStore, descriptorCommit, type WorkspaceAuthoringState } from "../src/workspace-store.js";

interface TinyState {
    readonly counter: number;
    readonly log: readonly string[];
}

const TINY0: TinyState = { counter: 0, log: [] };

describe("WorkspaceStore — the synchronous authoring-store authority", () => {
    it("commits a changed snapshot before notifying, and returns the structured result", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        const observed: string[] = [];
        const unsubscribe = store.subscribe(() => {
            // A subscriber must observe the COMMITTED state, never an
            // in-flight one.
            observed.push(store.getSnapshot().counter.toString());
        });

        const result = store.apply((current) => ({
            next: { counter: current.counter + 1, log: [...current.log, "bumped"] },
            result: { bumped: true, previous: current.counter } as const,
        }));

        expect(result).toEqual({ bumped: true, previous: 0 });
        expect(observed).toEqual(["1"]); // notified exactly once, after publish
        expect(store.getSnapshot()).toEqual({ counter: 1, log: ["bumped"] });
        unsubscribe();
        store.apply((current) => ({ next: { ...current, counter: current.counter + 1 }, result: null }));
        expect(observed).toEqual(["1"]); // unsubscribed — no further notification
    });

    it("returns the result with NO new snapshot and NO notification when next === current", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        let notified = 0;
        const before = store.getSnapshot();
        store.subscribe(() => {
            notified += 1;
        });

        const result = store.apply((current) => ({ next: current, result: { changed: false } as const }));

        expect(result).toEqual({ changed: false });
        expect(notified).toBe(0);
        expect(store.getSnapshot()).toBe(before); // SAME object identity
    });

    it("holds one stable snapshot identity across unchanged reads", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        expect(store.getSnapshot()).toBe(store.getSnapshot());
        expect(store.getSnapshot()).toBe(TINY0);
    });

    it("calls reduce exactly once, synchronously, with the current snapshot", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        let calls = 0;
        let sawCurrent: TinyState | null = null;
        store.apply((current) => {
            calls += 1;
            sawCurrent = current;
            return { next: { ...current, counter: 7 }, result: null };
        });
        expect(calls).toBe(1);
        expect(sawCurrent).toBe(TINY0);
        expect(store.getSnapshot().counter).toBe(7);
    });

    it("propagates a reduce failure, leaves the snapshot unchanged, and stays usable (strong exception safety)", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        let notified = 0;
        store.subscribe(() => {
            notified += 1;
        });

        expect(() =>
            store.apply(() => {
                throw new Error("reduce failure");
            }),
        ).toThrow("reduce failure");

        expect(store.getSnapshot()).toBe(TINY0);
        expect(notified).toBe(0);
        // The guard released — the store remains fully functional:
        const after = store.apply((current) => ({ next: { ...current, counter: current.counter + 1 }, result: "ok" as const }));
        expect(after).toBe("ok");
        expect(notified).toBe(1);
    });

    it("propagates a subscriber exception WITHOUT rolling back the committed snapshot (propagate and stop)", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        const notifiedA: number[] = [];
        const notifiedB: number[] = [];
        const unsubscribeA = store.subscribe(() => {
            notifiedA.push(store.getSnapshot().counter);
            throw new Error("subscriber A failure");
        });
        const unsubscribeB = store.subscribe(() => {
            notifiedB.push(store.getSnapshot().counter);
        });

        expect(() => store.apply((current) => ({ next: { ...current, counter: 5 }, result: null }))).toThrow(
            "subscriber A failure",
        );

        // The commit is DURABLE from the moment next differs: the snapshot
        // was assigned before any subscriber ran and is not rolled back by a
        // subscriber exception.
        expect(store.getSnapshot().counter).toBe(5);
        // A subscriber that ran observed the COMMITTED state...
        expect(notifiedA).toEqual([5]);
        // ...and no subscriber after the failure was notified.
        expect(notifiedB).toEqual([]);
        // The guard released — the store remains fully usable.
        unsubscribeA();
        unsubscribeB();
        const again = store.apply((current) => ({ next: { ...current, counter: current.counter + 1 }, result: null }));
        expect(again).toBeNull();
        expect(store.getSnapshot().counter).toBe(6);
    });

    it("rejects a nested apply issued DURING a reduce (invariant violation)", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        expect(() =>
            store.apply((current) => {
                store.apply((inner) => ({ next: { ...inner, counter: 9 }, result: null }));
                return { next: { ...current, counter: 1 }, result: null };
            }),
        ).toThrow(/nested apply/);
        // Strong exception safety: the outer reduce failed, so nothing
        // committed — snapshot unchanged, no notification.
        expect(store.getSnapshot()).toBe(TINY0);
    });

    it("rejects a nested apply issued FROM a subscriber during publishing (invariant violation)", () => {
        const store = new WorkspaceStore<TinyState>(TINY0);
        let nestedRejected = false;
        store.subscribe(() => {
            try {
                store.apply((current) => ({ next: { ...current, counter: 9 }, result: null }));
            } catch (error) {
                nestedRejected = error instanceof Error && /nested apply/.test(error.message);
            }
        });
        const result = store.apply((current) => ({ next: { ...current, counter: 1 }, result: 42 }));
        expect(result).toBe(42);
        expect(nestedRejected).toBe(true);
        // The nested write was rejected, not interleaved: the subscriber saw
        // the committed state and its state did not move elsewhere.
        expect(store.getSnapshot().counter).toBe(1);
    });

    it("projects the Workspace authoring state shape (session + the single descriptor fact)", () => {
        const state: WorkspaceAuthoringState = {
            session: {
                workspaceRoot: null,
                documents: [],
                activeDocumentId: null,
                preview: { targetDocumentId: null },
            },
            profileDescriptor: null,
        };
        const store = new WorkspaceStore<WorkspaceAuthoringState>(state);
        const documentSessionId = createDocumentSessionId("session-1");
        const result = store.apply((current) => ({
            next: { ...current, session: { ...current.session, activeDocumentId: documentSessionId } },
            result: { moved: true } as const,
        }));
        expect(result).toEqual({ moved: true });
        expect(store.getSnapshot().session.activeDocumentId).toBe(documentSessionId);
        expect(store.getSnapshot().profileDescriptor).toBeNull();
    });
});

// ---- descriptorCommit: the workspace-global descriptor transaction ----

const GRAPH: ShaderGraphDocument = (() => {
    const parsed = parseShaderGraphDocument(
        JSON.stringify({
            schemaVersion: 1,
            graphId: "graph.test",
            profile: "gglab.surface",
            profileVersion: 1,
            parameters: [],
            nodes: [],
            connections: [],
            editorMetadata: { nodes: {} },
        }),
    );
    if (parsed.ok === false || parsed.value === null) {
        throw new Error("test graph must parse");
    }
    return parsed.value;
})();

const EMISSION_A_D1 = { ok: true, source: "hlsl(A under D1)" } as unknown as HlslEmission;
const EMISSION_B_D1 = { ok: true, source: "hlsl(B under D1)" } as unknown as HlslEmission;
const D1 = { profileId: "gglab.surface", profileVersion: 1 } as unknown as SurfaceProfileDescriptor;
const D2 = { profileId: "gglab.surface", profileVersion: 2 } as unknown as SurfaceProfileDescriptor;

function sessionWith(sessionId: string, emission: HlslEmission | null): DocumentSession {
    const base = createSession(createDocumentSessionId(sessionId), provenanceFromImport(), GRAPH);
    return { ...base, presentation: { ...base.presentation, emission } };
}

function twoDocumentState(): WorkspaceAuthoringState {
    const A = sessionWith("A", EMISSION_A_D1); // the Preview target — INACTIVE
    const B = sessionWith("B", EMISSION_B_D1); // the active tab
    return {
        session: {
            workspaceRoot: null,
            documents: [A, B],
            activeDocumentId: B.sessionId,
            preview: { targetDocumentId: A.sessionId },
        },
        profileDescriptor: D1,
    };
}

describe("descriptorCommit — one synchronous Workspace transaction", () => {
    it("invalidates EVERY open document's emission when the descriptor moves — including INACTIVE documents", () => {
        const state = twoDocumentState();
        const next = descriptorCommit(state, D2);

        expect(next.profileDescriptor).toBe(D2);
        const [a, b] = next.session.documents;
        // The stale scenario: target A (inactive) held a D1 emission. Under
        // D2 it must be GONE (null, not undefined) — never presented as
        // current.
        expect(a?.presentation.emission).toBeNull();
        expect(b?.presentation.emission).toBeNull();
        // Everything else in the per-document presentation is preserved:
        expect(a?.presentation.savedText).toBe(state.session.documents[0]?.presentation.savedText);
        expect(next.session.activeDocumentId).toBe(state.session.activeDocumentId);
        expect(next.session.preview.targetDocumentId).toBe(state.session.preview.targetDocumentId);
    });

    it("treats a descriptor UNLOAD (null) as an invalidation too", () => {
        const state = twoDocumentState();
        const next = descriptorCommit(state, null);
        expect(next.profileDescriptor).toBeNull();
        expect(next.session.documents.every((document) => document.presentation.emission === null)).toBe(true);
    });

    it("preserves snapshot identity when the same fact is re-set and nothing needs invalidating", () => {
        const single = sessionWith("A", null);
        const state: WorkspaceAuthoringState = {
            session: {
                workspaceRoot: null,
                documents: [single],
                activeDocumentId: single.sessionId,
                preview: { targetDocumentId: null },
            },
            profileDescriptor: D1,
        };
        expect(descriptorCommit(state, D1)).toBe(state);
    });

    it("commits BOTH facts in ONE store transaction (one notification, both moved)", () => {
        const store = new WorkspaceStore<WorkspaceAuthoringState>(twoDocumentState());
        const snapshots: WorkspaceAuthoringState[] = [];
        store.subscribe(() => {
            snapshots.push(store.getSnapshot());
        });
        const result = store.apply((current) => ({ next: descriptorCommit(current, D2), result: { done: true } as const }));
        expect(result).toEqual({ done: true });
        expect(snapshots).toHaveLength(1);
        const committed = snapshots[0];
        expect(committed?.profileDescriptor).toBe(D2);
        expect(committed?.session.documents.every((document) => document.presentation.emission === null)).toBe(true);
    });
});
