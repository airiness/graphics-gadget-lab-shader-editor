/**
 * The Workspace's synchronous external store authority.
 *
 * A Preview transition crosses an `await` while the Workspace may
 * legitimately change, so the commit shape must be
 *
 *     read CURRENT -> revalidate -> reduce(CURRENT) -> publish
 *
 * with one synchronous, structured result for the caller. React is a
 * PROJECTION of this store through `useSyncExternalStore`; there is no
 * React-state mirror that may later overwrite the store.
 *
 * The class is deliberately generic — no Preview vocabulary (no
 * TransitionIntent, refusal, Runtime, or build words) leaks into the
 * authority itself.
 */
import type { SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import type { DocumentSession } from "./document-session.js";
import type { WorkspaceSession } from "./workspace-session.js";

/** The store's single authoring-state fact (the Workspace-scoped inputs a
 * commit-time transition may read after any await). */
export interface WorkspaceAuthoringState {
    readonly session: WorkspaceSession<DocumentSession>;
    /** The single current workspace-scoped profile descriptor fact used by
     * the core's rules (`null` = no instance loaded). The exact UI
     * loading/error presentation stays outside this semantic fact. */
    readonly profileDescriptor: SurfaceProfileDescriptor | null;
}

/** The structured application the store commits (or refuses to commit). */
export interface StoreApply<TState, TResult> {
    readonly next: TState;
    readonly result: TResult;
}

export class WorkspaceStore<TState> {
    private snapshot: TState;
    private readonly subscribers = new Set<() => void>();
    /** Re-entrancy guard: an `apply` in flight (reducing OR publishing)
     * rejects any nested `apply` — subscribers observe committed state and
     * never start a nested transaction from the notification call stack. */
    private inFlight = false;

    constructor(initial: TState) {
        this.snapshot = initial;
    }

    /** Current snapshot. Same immutable object identity while the store has
     * not changed — the invariant `useSyncExternalStore` relies on. */
    readonly getSnapshot = (): TState => {
        return this.snapshot;
    };

    /** Subscribe to committed changes. Returns the unsubscribe function. */
    readonly subscribe = (listener: () => void): (() => void) => {
        this.subscribers.add(listener);
        return () => {
            this.subscribers.delete(listener);
        };
    };

    /**
     * Synchronously commit one reduce against the CURRENT snapshot.
     *
     * - `reduce` is called exactly once, with the current snapshot.
     * - `next !== current`  -> the snapshot is replaced FIRST and
     *   subscribers are notified AFTER (subscribers see the committed
     *   state, never an in-flight one).
     * - `next === current`  -> the result is returned with NO new snapshot
     *   and NO notification.
     *
     * Exception safety is asymmetric on purpose:
     *
     * - A REDUCER failure commits nothing: the current snapshot stays
     *   unchanged, no subscriber is ever notified, and the error
     *   propagates to the caller (strong exception safety; the guard
     *   always releases and the store stays usable).
     * - A successful commit is DURABLE the moment `next` differs from the
     *   current snapshot: the assignment happens before ANY subscriber
     *   runs. A subscriber exception is NOT a transaction rollback — the
     *   commit stands, the error propagates to the `apply` caller, and the
     *   subscribers after the throwing one are not notified (propagate and
     *   stop; never silently swallowed, never partially retried).
     */
    readonly apply = <TResult>(
        reduce: (current: TState) => StoreApply<TState, TResult>,
    ): TResult => {
        if (this.inFlight) {
            throw new Error(
                "Workspace store invariant: a nested apply was issued while another apply was reducing or publishing; the nested transaction is rejected.",
            );
        }
        this.inFlight = true;
        try {
            const applied = reduce(this.snapshot);
            if (applied.next !== this.snapshot) {
                this.snapshot = applied.next;
                for (const listener of Array.from(this.subscribers)) {
                    listener();
                }
            }
            return applied.result;
        } finally {
            this.inFlight = false;
        }
    };
}

/**
 * The Workspace-authoring transition for a DEScriptor commit — the
 * workspace-scoped rule the app composes inside ONE `authoringStore.apply`
 * (one synchronous transaction):
 *
 *   commit the new descriptor fact AND invalidate EVERY open document's
 *   `presentation.emission` snapshot.
 *
 * Every emission is f(document, D-old); when the descriptor moves, none may
 * survive the commit posing as current — including the emissions of INACTIVE
 * documents. This is a workspace-global invalidation, never an
 * active-document helper. The result preserves identity when nothing
 * actually changes (no manufactured snapshot, no notification).
 */
export function descriptorCommit(
    state: WorkspaceAuthoringState,
    descriptor: SurfaceProfileDescriptor | null,
): WorkspaceAuthoringState {
    // Legacy/manual descriptor completions carry no Environment binding.
    if (state.session.activeEnvironment !== null) return state;
    const documents = state.session.documents.map((document) =>
        document.presentation.emission !== null
            ? { ...document, presentation: { ...document.presentation, emission: null } }
            : document,
    );
    const invalidated = documents.some((updated, index) => updated !== state.session.documents[index]);
    const session = invalidated ? { ...state.session, documents } : state.session;
    if (descriptor === state.profileDescriptor && session === state.session) {
        return state;
    }
    return { ...state, session, profileDescriptor: descriptor };
}
