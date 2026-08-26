/**
 * UTF-8 byte handling for the client — pure TypeScript, no host APIs
 * (no TextEncoder/TextDecoder): the client reads the boundary's raw
 * bytes and must be able to judge channel validity (stdout must decode
 * as UTF-8 before it can be a machine document) without a runtime
 * dependency.
 *
 * `utf8Decode` is STRICT: a single invalid lead byte, an out-of-range
 * code point, an overlong encoding, or a truncated sequence is a
 * structured failure, never a partial text or a guess.
 * `utf8Encode` is byte-exact for the scripts the tests run.
 */

export type Utf8DecodeOutcome =
    | { readonly ok: true; readonly text: string }
    | { readonly ok: false; readonly detail: string };

export function utf8Decode(bytes: Uint8Array): Utf8DecodeOutcome {
    let text = "";
    let index = 0;
    while (index < bytes.length) {
        const lead = bytes[index];
        if (lead === undefined) {
            break;
        }
        let codePoint: number;
        let tail: number;
        if (lead < 0x80) {
            codePoint = lead;
            tail = 0;
        } else if ((lead & 0xe0) === 0xc0) {
            codePoint = lead & 0x1f;
            tail = 1;
        } else if ((lead & 0xf0) === 0xe0) {
            codePoint = lead & 0x0f;
            tail = 2;
        } else if ((lead & 0xf8) === 0xf0) {
            codePoint = lead & 0x07;
            tail = 3;
        } else {
            return {
                ok: false,
                detail: `invalid UTF-8 lead byte 0x${lead.toString(16)} at byte ${index}`,
            };
        }
        if (index + 1 + tail > bytes.length) {
            return { ok: false, detail: `truncated UTF-8 sequence at byte ${index}` };
        }
        for (let t = 0; t < tail; t += 1) {
            const continuation = bytes[index + 1 + t];
            if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
                return {
                    ok: false,
                    detail: `invalid UTF-8 continuation byte 0x${(continuation ?? -1).toString(16)} at byte ${index + 1 + t}`,
                };
            }
            codePoint = (codePoint << 6) | (continuation & 0x3f);
        }
        if (tail === 1 && codePoint < 0x80) {
            return { ok: false, detail: `overlong UTF-8 encoding at byte ${index}` };
        }
        if (tail === 2 && codePoint < 0x800) {
            return { ok: false, detail: `overlong UTF-8 encoding at byte ${index}` };
        }
        if (tail === 3 && codePoint < 0x10000) {
            return { ok: false, detail: `overlong UTF-8 encoding at byte ${index}` };
        }
        if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
            return { ok: false, detail: `UTF-8 code point out of range at byte ${index}` };
        }
        text += String.fromCodePoint(codePoint);
        index += 1 + tail;
    }
    return { ok: true, text };
}

export function utf8Encode(text: string): Uint8Array {
    const bytes: number[] = [];
    for (let index = 0; index < text.length; index += 1) {
        const codePoint = text.codePointAt(index);
        if (codePoint === undefined) {
            continue;
        }
        if (codePoint > 0xffff) {
            index += 1;
        }
        if (codePoint < 0x80) {
            bytes.push(codePoint);
        } else if (codePoint < 0x800) {
            bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        } else if (codePoint < 0x10000) {
            bytes.push(
                0xe0 | (codePoint >> 12),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        } else {
            bytes.push(
                0xf0 | (codePoint >> 18),
                0x80 | ((codePoint >> 12) & 0x3f),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f),
            );
        }
    }
    return Uint8Array.from(bytes);
}
