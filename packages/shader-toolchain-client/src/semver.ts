/**
 * The "semver" comparison rule — the only comparison rule the client
 * implements. Versions are strict MAJOR.MINOR.PATCH numeric triples
 * (leading zeros rejected, no pre-release or build suffixes): anything
 * else is explicitly unparseable, never guessed at or normalized.
 *
 * This rule judges the tool's reported version against the requirement's
 * minimum under the requirement's own declared rule; the client does not
 * import the descriptor and does not pick the rule itself.
 */

export interface SemverVersion {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
}

const SEMVER_TRIPLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/** Parses a strict numeric version triple, or `null` when the text is not
 *  one (leading zeros, suffixes, extra components, or blank text all
 *  refuse explicitly). */
export function parseSemver(text: string): SemverVersion | null {
    const match = SEMVER_TRIPLE.exec(text);
    if (match === null) {
        return null;
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (
        !Number.isSafeInteger(major) ||
        !Number.isSafeInteger(minor) ||
        !Number.isSafeInteger(patch)
    ) {
        return null;
    }
    return { major, minor, patch };
}

/** Orders two version triples; -1 below, 0 equal, 1 above. */
export function compareSemver(a: SemverVersion, b: SemverVersion): -1 | 0 | 1 {
    if (a.major !== b.major) {
        return a.major < b.major ? -1 : 1;
    }
    if (a.minor !== b.minor) {
        return a.minor < b.minor ? -1 : 1;
    }
    if (a.patch !== b.patch) {
        return a.patch < b.patch ? -1 : 1;
    }
    return 0;
}
