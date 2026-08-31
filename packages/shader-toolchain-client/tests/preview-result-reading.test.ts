import { describe, expect, it } from "vitest";
import {
    readPreviewBuildDocument,
    type PreviewBuildReadOutcome,
} from "../src/preview-result-envelope.js";
import {
    BUILD_PREVIEW_SUCCESS,
    BUILD_PREVIEW_USAGE_ERROR,
    PREVIEW_BUILD_FAILURE_VOCABULARY,
    PREVIEW_PUBLICATION_ID,
    previewBuildFailureDocument,
} from "./fixtures/preview-envelope-goldens.js";

function mutate(
    golden: string,
    change: (base: Record<string, unknown>) => Record<string, unknown>,
): string {
    return JSON.stringify(change(JSON.parse(golden) as Record<string, unknown>));
}

function withoutField(golden: string, field: string): string {
    return mutate(golden, (base) => {
        const copy = { ...base };
        delete copy[field];
        return copy;
    });
}

function withField(golden: string, field: string, value: unknown): string {
    return mutate(golden, (base) => ({ ...base, [field]: value }));
}

function expectRejected(outcome: PreviewBuildReadOutcome, reason: string): void {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
        expect(outcome.rejection.reason).toBe(reason);
    }
}

describe("the strict Preview build result reader", () => {
    it("reads successful immutable publication evidence", () => {
        const outcome = readPreviewBuildDocument(BUILD_PREVIEW_SUCCESS);
        expect(outcome.status).toBe("read");
        if (outcome.status !== "read" || outcome.document.success !== true) {
            throw new Error("the Preview build success golden must read as success");
        }
        expect(outcome.document).toMatchObject({
            attemptSequence: 7,
            publicationId: PREVIEW_PUBLICATION_ID,
        });
        expect(outcome.document.diagnostics).toEqual([]);
    });

    it("reads every preview-build-v1 execution failure status", () => {
        for (const item of PREVIEW_BUILD_FAILURE_VOCABULARY) {
            const text = previewBuildFailureDocument(item.status, item.exitCode);
            const outcome = readPreviewBuildDocument(text);
            expect(outcome.status, text).toBe("read");
            if (outcome.status === "read") {
                expect(outcome.document).toMatchObject({
                    success: false,
                    status: item.status,
                    exitCode: item.exitCode,
                    attemptSequence: 7,
                });
            }
        }
    });

    it("models command-line usage failure before an attempt sequence exists", () => {
        const outcome = readPreviewBuildDocument(BUILD_PREVIEW_USAGE_ERROR);
        expect(outcome.status).toBe("read");
        if (outcome.status === "read") {
            expect(outcome.document).toMatchObject({ success: false, status: "usage-error" });
            expect(outcome.document.attemptSequence).toBeUndefined();
        }
    });

    it("requires execution failures to identify the observed attempt", () => {
        expectRejected(
            readPreviewBuildDocument(
                withoutField(previewBuildFailureDocument("compile-failed", 4), "attemptSequence"),
            ),
            "missing-field",
        );
        const invalidBeforeRequest = previewBuildFailureDocument("invalid-request", 3, 0);
        expect(readPreviewBuildDocument(invalidBeforeRequest).status).toBe("read");
    });

    it("freezes canonical lowercase product identities and failure separation", () => {
        expectRejected(
            readPreviewBuildDocument(withField(BUILD_PREVIEW_SUCCESS, "publicationId", "B1".repeat(32))),
            "field-type-mismatch",
        );
        expectRejected(
            readPreviewBuildDocument(
                withField(previewBuildFailureDocument("compile-failed", 4), "publicationId", PREVIEW_PUBLICATION_ID),
            ),
            "forbidden-field",
        );
    });

    it("keeps known fields strict, rejects unknown statuses, and ignores informational extensions", () => {
        expectRejected(
            readPreviewBuildDocument(withoutField(BUILD_PREVIEW_SUCCESS, "previewRegistryId")),
            "missing-field",
        );
        expectRejected(
            readPreviewBuildDocument(previewBuildFailureDocument("future-failure", 5)),
            "status-outside-vocabulary",
        );
        expect(readPreviewBuildDocument(withField(BUILD_PREVIEW_SUCCESS, "elapsedMilliseconds", 12)).status).toBe("read");
    });
});
