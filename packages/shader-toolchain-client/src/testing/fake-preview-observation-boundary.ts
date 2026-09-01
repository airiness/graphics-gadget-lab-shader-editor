/** Deterministic reference fake for the separate compiler-free Preview
 * observation boundary. It scripts host read outcomes and can hold one read
 * pending so orchestration tests prove single-flight without timers. */
import type {
    PreviewObservationBoundary,
    PreviewObservationHostReadResult,
} from "../preview-observation-boundary.js";
import type { ToolCandidate } from "../host-boundary.js";

export interface FakePreviewObservationSpec {
    readonly reads: readonly PreviewObservationHostReadResult[];
    readonly keepPending?: boolean | undefined;
}

export class FakePreviewObservationBoundary implements PreviewObservationBoundary {
    private callCount = 0;
    private lastReadRecord: { readonly candidate: ToolCandidate; readonly sessionId: string } | null = null;
    private pending: {
        readonly result: PreviewObservationHostReadResult;
        readonly resolve: (result: PreviewObservationHostReadResult) => void;
    } | null = null;

    constructor(private readonly spec: FakePreviewObservationSpec) {}

    get readCalls(): number {
        return this.callCount;
    }

    get lastRead(): { readonly candidate: ToolCandidate; readonly sessionId: string } | null {
        return this.lastReadRecord;
    }

    async readPreviewObservation(
        candidate: ToolCandidate,
        sessionId: string,
    ): Promise<PreviewObservationHostReadResult> {
        this.callCount += 1;
        this.lastReadRecord = { candidate, sessionId };
        const result = this.resultFor(this.callCount);
        if (this.spec.keepPending === true) {
            return new Promise<PreviewObservationHostReadResult>((resolve) => {
                this.pending = { result, resolve };
            });
        }
        return result;
    }

    releasePending(): boolean {
        const pending = this.pending;
        if (pending === null) {
            return false;
        }
        this.pending = null;
        pending.resolve(pending.result);
        return true;
    }

    private resultFor(call: number): PreviewObservationHostReadResult {
        if (this.spec.reads.length === 0) {
            throw new Error("the fake Preview observation boundary needs at least one scripted read");
        }
        const index = Math.min(call - 1, this.spec.reads.length - 1);
        const result = this.spec.reads[index];
        if (result === undefined) {
            throw new Error(`the fake Preview observation boundary ran past read ${call}`);
        }
        return result;
    }
}
