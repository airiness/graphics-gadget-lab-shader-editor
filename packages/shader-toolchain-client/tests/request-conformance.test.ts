import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
    isWellFormedRequest,
    type CompileDefine,
    type NativeCompileRequest,
} from "../src/native-compile-request.js";

// Cross-language conformance against the SHARED fixture
// `tests/toolchain-boundary-requests.json` (repository root). THIS side
// is the authority — `isWellFormedRequest` — and the host service
// (Rust, apps/editor/src-tauri) mirrors these exact verdicts, field for
// field. Two rules, neither of which is a matter of taste:
//
// - a case is well-formed on BOTH sides, or refused on BOTH, naming the
//   SAME field;
// - if a new rule is wanted, the client's declaration changes first,
//   the fixture grows, and only then does the host mirror it.

interface FixtureCase {
    readonly name: string;
    readonly request: {
        readonly source: readonly number[];
        readonly sourceIdentity: string;
        readonly target: string;
        readonly stage: string;
        readonly entry: string;
        readonly defines: ReadonlyArray<Readonly<CompileDefine>>;
        readonly includes: readonly string[];
    };
    readonly expectWellFormed: boolean;
    readonly expectReason?: string;
}

interface Fixture {
    readonly name: string;
    readonly cases: readonly FixtureCase[];
}

async function loadFixture(): Promise<Fixture> {
    const rootDir = dirname(fileURLToPath(import.meta.url));
    const path = resolve(rootDir, "../../../tests/toolchain-boundary-requests.json");
    const text = await readFile(path, "utf8");
    return JSON.parse(text) as Fixture;
}

const fixture = await loadFixture();

describe(`request-shape conformance: ${fixture.name}`, () => {
    for (const caseRecord of fixture.cases) {
        it(`judges "${caseRecord.name}" as the declaration says`, () => {
            const request = {
                ...caseRecord.request,
                source: new Uint8Array(caseRecord.request.source),
                defines: [...(caseRecord.request.defines ?? [])],
                includes: [...(caseRecord.request.includes ?? [])],
            } as NativeCompileRequest;
            const result = isWellFormedRequest(request);
            expect(result.ok === true).toBe(caseRecord.expectWellFormed);
            if (caseRecord.expectWellFormed) {
                return;
            }
            // A refusal names its side — and the fixture pins WHICH side:
            // the host mirror is held to the same field.
            expect(result).toMatchObject({ ok: false, reason: caseRecord.expectReason });
        });
    }
});
