/**
 * Dependency-free SHA-256 (FIPS 180-4) over byte arrays, plus a minimal
 * UTF-8 encoder, so the core can compute `generatedSourceIdentity` — the
 * SHA-256 of the exact generated HLSL bytes (architecture §24) — while
 * remaining headless: no Node crypto, no DOM/Web API, no runtime
 * dependencies.
 *
 * The implementation is verified in tests against published NIST vectors
 * and vectors produced by an independent implementation.
 */

// Fractional parts of the cube roots of the first 64 primes.
const K: readonly number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// Fractional parts of the cube roots of the first 8 primes (initial hash).
const INITIAL_HASH: readonly number[] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(value: number, bits: number): number {
    return (value >>> bits) | (value << (32 - bits));
}

/** Read a fixed-structure index; undefined means a logic error, not data. */
function cell(value: number | undefined): number {
    if (value === undefined) {
        throw new Error("sha256Hex: unreachable index");
    }
    return value;
}

/** Encode text as UTF-8 bytes without platform APIs. */
export function utf8Encode(text: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) {
        let code = text.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                i++;
            }
        }
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            bytes.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
        }
    }
    return new Uint8Array(bytes);
}

/** SHA-256 of the exact bytes, lowercase hex. Input length must stay below 2^41 bytes. */
export function sha256Hex(input: Uint8Array): string {
    if (K.length !== 64 || INITIAL_HASH.length !== 8) {
        throw new Error("sha256Hex: constant tables damaged");
    }
    const byteLength = input.length;
    if (byteLength >= 2 ** 41) {
        throw new Error("sha256Hex: input exceeds the supported length");
    }

    // Padded message: original, 0x80, zeros, then the 64-bit big-endian
    // length in bits; total length is a multiple of 64 with the length
    // field ending the final block.
    const remainder = byteLength % 64;
    const padLength = (remainder < 56 ? 56 : 120) - remainder;
    const total = byteLength + padLength + 8;
    const data = new Uint8Array(total);
    data.set(input);
    data[byteLength] = 0x80;
    const bitLengthHigh = byteLength >>> 29;
    const bitLengthLow = (byteLength << 3) >>> 0;
    const view = new DataView(data.buffer);
    view.setUint32(total - 8, bitLengthHigh, false);
    view.setUint32(total - 4, bitLengthLow, false);

    const hash = INITIAL_HASH.map((value) => value);
    const words = new Uint32Array(64);

    for (let block = 0; block < total; block += 64) {
        for (let t = 0; t < 16; t++) {
            words[t] = view.getUint32(block + t * 4, false);
        }
        for (let t = 16; t < 64; t++) {
            const w15 = cell(words[t - 15] as number | undefined);
            const w2 = cell(words[t - 2] as number | undefined);
            const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
            const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
            words[t] = (cell(words[t - 16] as number | undefined) + s0 + cell(words[t - 7] as number | undefined) + s1) >>> 0;
        }

        let a = cell(hash[0]);
        let b = cell(hash[1]);
        let c = cell(hash[2]);
        let d = cell(hash[3]);
        let e = cell(hash[4]);
        let f = cell(hash[5]);
        let g = cell(hash[6]);
        let h = cell(hash[7]);

        for (let t = 0; t < 64; t++) {
            const ch = (e & f) ^ (~e & g);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            // T1 = h + Σ1(e) + Ch(e,f,g) + K[t] + W[t]
            const sum1 = (h + s1 + ch + cell(K[t]) + cell(words[t] as number | undefined)) >>> 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const sum0 = (s0 + maj) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + sum1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (sum1 + sum0) >>> 0;
        }

        hash[0] = (cell(hash[0]) + a) >>> 0;
        hash[1] = (cell(hash[1]) + b) >>> 0;
        hash[2] = (cell(hash[2]) + c) >>> 0;
        hash[3] = (cell(hash[3]) + d) >>> 0;
        hash[4] = (cell(hash[4]) + e) >>> 0;
        hash[5] = (cell(hash[5]) + f) >>> 0;
        hash[6] = (cell(hash[6]) + g) >>> 0;
        hash[7] = (cell(hash[7]) + h) >>> 0;
    }

    return hash.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
}
