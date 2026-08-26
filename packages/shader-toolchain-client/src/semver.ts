/**
 * The "semver" comparison rule — the only comparison rule the client
 * implements. Versions follow SemVer 2.0.0 exactly: MAJOR.MINOR.PATCH
 * core (no leading zeros), an optional pre-release (dot identifiers;
 * numeric identifiers carry no leading zeros), an optional build
 * metadata tail.
 *
 * Precedence per SemVer 2.0.0 section 11: the numeric core first; a
 * pre-release sorts BEFORE the release of the same core; pre-release
 * identifiers are compared left to right with numeric identifiers
 * sorting below alphanumeric ones; a shorter identifier list sorts below
 * a longer one sharing the same prefix. Build metadata never affects
 * precedence (1.2.0+build.7 and 1.2.0 are equal).
 *
 * Anything outside the grammar is explicitly unparseable, never guessed
 * at or normalized. Unknown comparison rules on the requirement side are
 * rejected as a verdict (they never fall back to this one).
 *
 * This rule judges the tool's reported version against the requirement's
 * minimum under the requirement's own declared rule; the client does not
 * import the descriptor and does not pick the rule itself.
 */

interface NumericPreRelease {
    readonly kind: "numeric";
    readonly value: number;
}

interface AlphanumericPreRelease {
    readonly kind: "alphanumeric";
    readonly value: string;
}

export type PreReleaseIdentifier = NumericPreRelease | AlphanumericPreRelease;

export interface SemverVersion {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    /** `null` when the version has no pre-release (a release version). */
    readonly preRelease: readonly PreReleaseIdentifier[] | null;
    /** Build metadata identifiers; carried for identity, never for
     *  precedence. */
    readonly build: readonly string[] | null;
}

const SEMVER =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

function parsePreRelease(text: string | undefined): readonly PreReleaseIdentifier[] | null {
    if (text === undefined) {
        return null;
    }
    const identifiers: PreReleaseIdentifier[] = [];
    for (const part of text.split(".")) {
        if (/^\d+$/.test(part)) {
            const value = Number(part);
            if (!Number.isSafeInteger(value)) {
                return null;
            }
            identifiers.push({ kind: "numeric", value });
        } else {
            identifiers.push({ kind: "alphanumeric", value: part });
        }
    }
    return identifiers;
}

/** Parses a SemVer 2.0.0 version. Returns `null` when the text is outside
 *  the grammar — leading zeros, a pre-release with a leading-zero numeric
 *  identifier, a bare hyphen or plus, extra components, or blank text all
 *  refuse explicitly. */
export function parseSemver(text: string): SemverVersion | null {
    // Grammar check first so malformed tails are rejected before any
    // interpretation; the alphanumeric-identifier shape is verified per
    // part (the grammar enforces it, but a non-matching part fails the
    // whole parse).
    const match = SEMVER.exec(text);
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
    const preRelease = parsePreRelease(match[4]);
    if (match[4] !== undefined && preRelease === null) {
        return null;
    }
    // Build identifiers are plain [0-9a-zA-Z-]+ (numeric and leading
    // zeros allowed UNLIKE pre-release identifiers) — the grammar already
    // guarantees each part is non-empty, so no further shaping happens.
    let build: readonly string[] | null = null;
    if (match[5] !== undefined) {
        build = match[5].split(".");
    }
    return { major, minor, patch, preRelease, build };
}

function comparePreRelease(
    a: readonly PreReleaseIdentifier[] | null,
    b: readonly PreReleaseIdentifier[] | null,
): -1 | 0 | 1 {
    if (a === null && b === null) {
        return 0;
    }
    // A release version takes precedence over any of its pre-releases.
    if (a === null) {
        return 1;
    }
    if (b === null) {
        return -1;
    }
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        const left = a[index];
        const right = b[index];
        if (left === undefined || right === undefined) {
            return 0;
        }
        if (left.kind !== right.kind) {
            // Numeric identifiers always have lower precedence than
            // alphanumeric ones.
            return left.kind === "numeric" ? -1 : 1;
        }
        if (left.kind === "numeric" && right.kind === "numeric") {
            if (left.value !== right.value) {
                return left.value < right.value ? -1 : 1;
            }
        } else if (left.value !== right.value) {
            // Alphanumeric identifiers compare by ASCII (code unit) value.
            return left.value < right.value ? -1 : 1;
        }
    }
    // All shared identifiers equal: the shorter set has lower precedence.
    if (a.length !== b.length) {
        return a.length < b.length ? -1 : 1;
    }
    return 0;
}

/** Orders two versions by SemVer 2.0.0 precedence; -1 below, 0 equal, 1
 *  above. Build metadata never changes the order. */
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
    return comparePreRelease(a.preRelease, b.preRelease);
}
