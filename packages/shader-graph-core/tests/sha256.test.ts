import { describe, expect, it } from "vitest";
import { sha256Hex, utf8Encode } from "../src/index.js";

describe("sha256Hex", () => {
    it("matches published NIST vectors", () => {
        expect(sha256Hex(utf8Encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        expect(sha256Hex(utf8Encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        // 56-byte two-block vector (FIPS 180-4 examples).
        expect(sha256Hex(utf8Encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))).toBe(
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
        );
    });

    it("matches vectors computed by an independent implementation (.NET SHA256Managed)", () => {
        expect(sha256Hex(utf8Encode("a".repeat(55)))).toBe("9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318");
        expect(sha256Hex(utf8Encode("a".repeat(56)))).toBe("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
        expect(sha256Hex(utf8Encode("a".repeat(200)))).toBe("c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5");
        const text = "The quick brown fox jumps over the lazy dog. ".repeat(10) + "0123456789";
        expect(text.length).toBe(460);
        expect(sha256Hex(utf8Encode(text))).toBe("4c625dc04f070ec2baab56f8e9a9537d075f2d521d55cf55fa50bf9c46429388");
    });

    it("is deterministic and byte-sensitive", () => {
        const hash = sha256Hex(utf8Encode("hello"));
        expect(hash).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        expect(hash).toBe(sha256Hex(utf8Encode("hello")));
        expect(hash).not.toBe(sha256Hex(utf8Encode("hellO")));
    });
});

describe("utf8Encode", () => {
    it("encodes ASCII and multi-byte sequences", () => {
        expect([...utf8Encode("A")]).toEqual([0x41]);
        expect([...utf8Encode("\u00e9")]).toEqual([0xc3, 0xa9]);
        expect([...utf8Encode("\u2713")]).toEqual([0xe2, 0x9c, 0x93]);
        expect([...utf8Encode(String.fromCodePoint(0x1d306))]).toEqual([0xf0, 0x9d, 0x8c, 0x86]);
    });

    it("replaces lone surrogates with U+FFFD like a standard UTF-8 encoder", () => {
        // Unpaired high/low surrogates are invalid code points and must not
        // be encoded as surrogate-range bytes.
        expect([...utf8Encode("\ud800")]).toEqual([0xef, 0xbf, 0xbd]);
        expect([...utf8Encode("\udc00")]).toEqual([0xef, 0xbf, 0xbd]);
        // Neighboring characters are unaffected.
        expect([...utf8Encode("a\ud800b")]).toEqual([0x61, 0xef, 0xbf, 0xbd, 0x62]);
        // Valid pairs still encode to their code point, not U+FFFD.
        expect([...utf8Encode("\u2713")]).toEqual([0xe2, 0x9c, 0x93]);
    });

    it("round-trips mixed text through the same bytes twice", () => {
        const text = `x\u00e9\u2713${String.fromCodePoint(0x1d306)} 42`;
        expect([...utf8Encode(text)]).toEqual([...utf8Encode(text)]);
    });
});
