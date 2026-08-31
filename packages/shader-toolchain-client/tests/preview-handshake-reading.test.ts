import { describe, expect, it } from "vitest";
import {
    readPreviewHandshakeDocument,
    type PreviewHandshakeReadOutcome,
} from "../src/preview-handshake-document.js";
import {
    DESCRIBE_PREVIEW_SUCCESS,
    DESCRIBE_PREVIEW_USAGE_ERROR,
    PREVIEW_DESCRIPTOR_IDENTITY,
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

function expectRejected(outcome: PreviewHandshakeReadOutcome, reason: string): void {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
        expect(outcome.rejection.reason).toBe(reason);
        expect(outcome.rejection.detail).not.toBe("");
    }
}

describe("the strict Preview handshake reader", () => {
    it("reads every Preview compatibility fact from the published success shape", () => {
        const outcome = readPreviewHandshakeDocument(DESCRIBE_PREVIEW_SUCCESS);
        expect(outcome.status).toBe("read");
        if (outcome.status !== "read" || outcome.document.success !== true) {
            throw new Error("the Preview success golden must read as success");
        }
        expect(outcome.document).toMatchObject({
            processContractVersion: 2,
            previewBuildContractVersion: 1,
            compilePolicyRevision: 1,
            toolIdentity: "gglab-shaderc",
            toolVersion: "1.3.0",
            previewProgramDescriptorVersion: 1,
            previewProgramDescriptorIdentity: PREVIEW_DESCRIPTOR_IDENTITY,
            previewPublicationSchemaVersion: 1,
            previewActivePublicationSchemaVersion: 1,
            previewObservationSchemaVersion: 1,
        });
        expect(outcome.document.supportedTargets).toEqual(["gglab-dx12", "gglab-vulkan13"]);
        expect(outcome.document.supportedPreviewInputContracts).toEqual([
            {
                id: "gglab.preview-input.surface.numeric",
                profileId: "gglab.surface",
                profileVersion: 1,
            },
            {
                id: "gglab.preview-input.surface.texture2d",
                profileId: "gglab.surface",
                profileVersion: 2,
            },
        ]);
    });

    it("judges process support before Preview support or payload interpretation", () => {
        const futureProcess = withoutField(
            withField(DESCRIBE_PREVIEW_SUCCESS, "processContractVersion", 3),
            "previewBuildContractVersion",
        );
        const outcome = readPreviewHandshakeDocument(futureProcess);
        expect(outcome.status).toBe("unsupported-process-contract");
        if (outcome.status === "unsupported-process-contract") {
            expect(outcome.contract).toMatchObject({ observedVersion: 3, supported: false });
        }
    });

    it("judges Preview support before interpreting a future Preview payload", () => {
        const futurePreview = withField(
            withField(DESCRIBE_PREVIEW_SUCCESS, "previewBuildContractVersion", 2),
            "supportedPreviewInputContracts",
            "future-shape",
        );
        const outcome = readPreviewHandshakeDocument(futurePreview);
        expect(outcome.status).toBe("unsupported-preview-contract");
        if (outcome.status === "unsupported-preview-contract") {
            expect(outcome.contract).toMatchObject({ observedVersion: 2, supported: false });
        }
    });

    it("reads structured failures and forbids success-only Preview facts", () => {
        const outcome = readPreviewHandshakeDocument(DESCRIBE_PREVIEW_USAGE_ERROR);
        expect(outcome.status).toBe("read");
        if (outcome.status === "read") {
            expect(outcome.document).toMatchObject({ success: false, status: "usage-error", exitCode: 2 });
        }
        expectRejected(
            readPreviewHandshakeDocument(
                withField(DESCRIBE_PREVIEW_USAGE_ERROR, "previewProgramDescriptorIdentity", PREVIEW_DESCRIPTOR_IDENTITY),
            ),
            "forbidden-field",
        );
    });

    it("keeps required known fields strict and ignores unknown informational fields", () => {
        expectRejected(
            readPreviewHandshakeDocument(withoutField(DESCRIBE_PREVIEW_SUCCESS, "previewObservationSchemaVersion")),
            "missing-field",
        );
        expectRejected(
            readPreviewHandshakeDocument(withField(DESCRIBE_PREVIEW_SUCCESS, "previewProgramDescriptorIdentity", "A7".repeat(32))),
            "field-type-mismatch",
        );
        const extended = mutate(DESCRIBE_PREVIEW_SUCCESS, (base) => ({
            ...base,
            informationalFutureFact: { enabled: true },
            supportedPreviewInputContracts: (base.supportedPreviewInputContracts as Record<string, unknown>[]).map(
                (contract) => ({ ...contract, informationalLabel: "Preview input" }),
            ),
        }));
        expect(readPreviewHandshakeDocument(extended).status).toBe("read");
    });

    it("rejects malformed or ambiguous input-contract declarations", () => {
        expectRejected(
            readPreviewHandshakeDocument(
                withField(DESCRIBE_PREVIEW_SUCCESS, "supportedPreviewInputContracts", [
                    { id: "numeric", profileId: "gglab.surface", profileVersion: "1" },
                ]),
            ),
            "field-type-mismatch",
        );
        expectRejected(
            readPreviewHandshakeDocument(
                withField(DESCRIBE_PREVIEW_SUCCESS, "supportedPreviewInputContracts", [
                    { id: "same", profileId: "gglab.surface", profileVersion: 1 },
                    { id: "same", profileId: "gglab.surface", profileVersion: 2 },
                ]),
            ),
            "field-type-mismatch",
        );
    });
});
