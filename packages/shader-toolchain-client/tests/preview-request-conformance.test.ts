import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    isWellFormedPreviewBuildRequest,
    type NativePreviewBuildRequest,
} from "../src/native-preview-build-request.js";

interface FixtureCase {
    readonly name: string;
    readonly request: Omit<NativePreviewBuildRequest, "generatedSourceBytes"> & {
        readonly generatedSourceBytes: readonly number[];
    };
    readonly expectWellFormed: boolean;
    readonly expectReason?: string;
}

interface Fixture {
    readonly name: string;
    readonly cases: readonly FixtureCase[];
}

const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../tests/preview-toolchain-boundary-requests.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Fixture;

describe(`Preview request-shape conformance: ${fixture.name}`, () => {
    for (const caseRecord of fixture.cases) {
        it(`judges "${caseRecord.name}" as the declaration says`, () => {
            const request: NativePreviewBuildRequest = {
                ...caseRecord.request,
                generatedSourceBytes: new Uint8Array(caseRecord.request.generatedSourceBytes),
            };
            const result = isWellFormedPreviewBuildRequest(request);
            expect(result.ok).toBe(caseRecord.expectWellFormed);
            if (!caseRecord.expectWellFormed) {
                expect(result).toMatchObject({ ok: false, reason: caseRecord.expectReason });
            }
        });
    }
});
