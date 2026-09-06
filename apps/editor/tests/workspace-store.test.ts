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
import { describe, expect, it } from "vitest";
import { createDocumentSessionId } from "../src/workspace-session.js";
import { WorkspaceStore, type WorkspaceAuthoringState } from "../src/workspace-store.js";

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
