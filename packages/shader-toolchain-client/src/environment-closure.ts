import { environmentLocator, environmentRequire, readEnvironmentManifest, type EnvironmentHash } from "./environment-contract.js";
import type { VerifiedEnvironmentClosure } from "./environment-import.js";

export interface EnvironmentEntry {
    readonly path: string; readonly kind: "file" | "directory" | "other";
    readonly reparsePoint: boolean; readonly linkCount: number;
}
/** Host supplies a complete, bounded inventory including directories, and checks the root's ancestors before reads. */
export interface EnvironmentClosureHost {
    readonly hashAscii: EnvironmentHash;
    // Filesystem hosts return the canonical final path after rejecting reparse ancestors.
    // Synthetic hosts return their model path; they do not qualify filesystem aliases.
    assertOrdinaryRoot(root: string): string;
    entries(root: string): readonly EnvironmentEntry[];
    readManifest(root: string): string | null;
    hashMember(root: string, locator: string): { readonly size: number; readonly sha256: string };
}
export function verifyEnvironmentClosure(host: EnvironmentClosureHost, root: string): VerifiedEnvironmentClosure {
    root = host.assertOrdinaryRoot(root);
    // Windows case aliases must not turn an unfinished publication into a finalized one.
    environmentRequire(!root.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1)?.toLowerCase().startsWith(".staging-"), "incomplete-publication", "Staging is not a usable Environment");
    const entries = host.entries(root);
    const seen = new Set<string>(), files = new Set<string>();
    for (const entry of entries) {
        environmentLocator(entry.path, entry.path);
        environmentRequire(!entry.reparsePoint, "reparse-point", "Reparse point is forbidden", entry.path);
        environmentRequire(!seen.has(entry.path.toLowerCase()), "path-conflict", "Case-insensitive entry conflict", entry.path);
        seen.add(entry.path.toLowerCase());
        environmentRequire(entry.kind !== "other", "invalid-member", "Non-regular entry", entry.path);
        if (entry.kind === "file") {
            environmentRequire(entry.linkCount === 1, "hard-link", "Hard-linked file is forbidden", entry.path);
            files.add(entry.path);
            environmentRequire(files.size <= 20000, "limit-exceeded", "Too many files");
        }
    }
    const text = host.readManifest(root);
    environmentRequire(text !== null && files.has("environment.json"), "incomplete-publication", "Final manifest is absent", "environment.json");
    const manifest = readEnvironmentManifest(text, host.hashAscii);
    const expected = new Set(["environment.json", ...manifest.members.map(m => m.path)]);
    environmentRequire(files.size === expected.size && [...files].every(f => expected.has(f)), "membership-mismatch", "Missing or unlisted immutable files");
    for (const member of manifest.members) {
        const actual = host.hashMember(root, member.path);
        environmentRequire(actual.size === member.size && actual.sha256 === member.sha256, "hash-mismatch", "Member bytes do not match manifest", member.path);
    }
    return { root, manifest };
}
