import { describe, expect, it } from "vitest";
import type { ToolCandidate } from "../src/host-boundary.js";
import {
    admitPreviewBuild,
    judgePreviewEligibility,
    type PreviewEligibilityRequirement,
} from "../src/preview-compatibility.js";
import { readPreviewHandshakeDocument } from "../src/preview-handshake-document.js";
import type { PreviewHandshakeProcessOutcome } from "../src/process-output.js";
import type { ToolCompatibilityState } from "../src/tool-compatibility.js";
import {
    DESCRIBE_PREVIEW_SUCCESS,
    DESCRIBE_PREVIEW_USAGE_ERROR,
    PREVIEW_DESCRIPTOR_IDENTITY,
} from "./fixtures/preview-envelope-goldens.js";

const CANDIDATE: ToolCandidate = {
    rule: "explicit-config",
    toolPath: "C:/tools/gglab-shaderc.exe",
    observationIdentity: "candidate-a",
    resolvedAt: 1,
};

const REQUIREMENT: PreviewEligibilityRequirement = {
    targetProfile: "gglab-dx12",
    previewProgramDescriptorIdentity: PREVIEW_DESCRIPTOR_IDENTITY,
    inputContract: {
        id: "gglab.preview-input.surface.texture2d",
        profileId: "gglab.surface",
        profileVersion: 2,
    },
};

const TOOL: ToolCompatibilityState = {
    status: "compatible",
    candidate: CANDIDATE,
    provenFacts: {
        toolIdentity: "gglab-shaderc",
        toolVersion: "1.3.0",
        processContractVersion: 2,
        compilePolicyRevision: 1,
        producerKind: "dxc",
        producerIdentity: "Microsoft Direct3D 12 Shader Compiler 10.0.26100.2 (dxc)",
        supportedTargets: ["gglab-dx12", "gglab-vulkan13"],
    },
    proof: { processContractVersion: 2, compilePolicyRevision: 1 },
};

function processFrom(text: string): PreviewHandshakeProcessOutcome {
    const read = readPreviewHandshakeDocument(text);
    if (read.status === "read") {
        return { kind: "read", document: read.document };
    }
    if (read.status === "unsupported-process-contract") {
        return { kind: "unsupported-process-contract", contract: read.contract };
    }
    if (read.status === "unsupported-preview-contract") {
        return { kind: "unsupported-preview-contract", contract: read.contract };
    }
    return { kind: "rejected", rejection: read.rejection };
}

function mutate(change: Record<string, unknown>): string {
    return JSON.stringify({
        ...(JSON.parse(DESCRIBE_PREVIEW_SUCCESS) as Record<string, unknown>),
        ...change,
    });
}

describe("Preview eligibility", () => {
    it("admits only the exact target, descriptor, input contract, schemas, and continuous producer proof", () => {
        const eligibility = judgePreviewEligibility(
            TOOL,
            CANDIDATE,
            processFrom(DESCRIBE_PREVIEW_SUCCESS),
            REQUIREMENT,
        );
        expect(eligibility.status).toBe("eligible");
        expect(admitPreviewBuild(eligibility)).toBe(true);
    });

    it("requires ordinary proof for the exact candidate observation", () => {
        expect(
            judgePreviewEligibility(
                { status: "discovered", candidate: CANDIDATE },
                CANDIDATE,
                processFrom(DESCRIBE_PREVIEW_SUCCESS),
                REQUIREMENT,
            ),
        ).toMatchObject({
            status: "unproven",
            reasons: [{ reason: "ordinary-tool-not-proven", toolStatus: "discovered" }],
        });
        expect(
            judgePreviewEligibility(
                TOOL,
                { ...CANDIDATE, observationIdentity: "candidate-b" },
                processFrom(DESCRIBE_PREVIEW_SUCCESS),
                REQUIREMENT,
            ),
        ).toMatchObject({ status: "unproven", reasons: [{ reason: "proof-not-for-this-candidate" }] });
    });

    it("rejects producer discontinuity between ordinary and Preview handshakes", () => {
        const eligibility = judgePreviewEligibility(
            TOOL,
            CANDIDATE,
            processFrom(mutate({ producerIdentity: "different dxc" })),
            REQUIREMENT,
        );
        expect(eligibility).toMatchObject({
            status: "incompatible",
            mismatches: [
                {
                    kind: "ordinary-fact-discontinuity",
                    field: "producerIdentity",
                    ordinary: TOOL.status === "compatible" ? TOOL.provenFacts.producerIdentity : "",
                    preview: "different dxc",
                },
            ],
        });
    });

    it("reports each Preview-specific eligibility mismatch without collapsing them", () => {
        const eligibility = judgePreviewEligibility(
            TOOL,
            CANDIDATE,
            processFrom(
                mutate({
                    supportedTargets: ["gglab-vulkan13"],
                    previewProgramDescriptorVersion: 2,
                    previewProgramDescriptorIdentity: "11".repeat(32),
                    supportedPreviewInputContracts: [],
                    previewObservationSchemaVersion: 2,
                }),
            ),
            REQUIREMENT,
        );
        expect(eligibility.status).toBe("incompatible");
        if (eligibility.status === "incompatible") {
            expect(eligibility.mismatches.map((mismatch) => mismatch.kind)).toEqual([
                "target-unsupported",
                "descriptor-schema-unsupported",
                "descriptor-identity-mismatch",
                "input-contract-unsupported",
                "publication-schema-unsupported",
            ]);
        }
    });

    it("keeps failure, timeout, and no-declaration worlds unproven", () => {
        expect(
            judgePreviewEligibility(
                TOOL,
                CANDIDATE,
                processFrom(DESCRIBE_PREVIEW_USAGE_ERROR),
                REQUIREMENT,
            ),
        ).toMatchObject({
            status: "unproven",
            reasons: [{ reason: "preview-handshake-facts-absent", status: "usage-error" }],
        });
        expect(
            judgePreviewEligibility(TOOL, CANDIDATE, { kind: "timed-out" }, REQUIREMENT),
        ).toMatchObject({ status: "unproven", reasons: [{ reason: "preview-handshake-timed-out" }] });

        const unsupported = readPreviewHandshakeDocument(DESCRIBE_PREVIEW_SUCCESS, { minimum: 2, maximum: 2 }, null);
        if (unsupported.status !== "unsupported-preview-contract") {
            throw new Error("test setup must reach the no-declaration Preview axis");
        }
        expect(
            judgePreviewEligibility(
                TOOL,
                CANDIDATE,
                { kind: "unsupported-preview-contract", contract: unsupported.contract },
                REQUIREMENT,
            ),
        ).toMatchObject({
            status: "unproven",
            reasons: [{ reason: "no-supported-contract-declared", axis: "preview" }],
        });
    });
});
