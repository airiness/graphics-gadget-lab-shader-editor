// Font line-metric probe — empirically locates the (ascent, descent,
// x-height, cap-height) metric set inside each candidate font's OS/2
// table (no hardcoded offsets): it requires a ratio-sane ascent/descent
// pair (2 bytes apart) with an x-height (~0.45-0.65 x ascent) and a
// cap-height (~0.6-0.8 x ascent) nearby, and reports how a flex-centered
// natural line box misplaces the Latin cap band — the button-label
// correction.
//
// Windows renders CJK-family line metrics from the OS/2 win metrics, so
// these ARE the numbers WebView2 uses.
/* global console */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FONTS = "C:\\Windows\\Fonts";
const FILES = ["NotoSansJP-VF.ttf", "NotoSansSC-VF.ttf", "BIZ-UDGothicR.ttc", "segoeui.ttf", "msyh.ttc", "BIZ-UDGothicB.ttc"];

const u16 = (b, o) => b.readUInt16BE(o);

const head = (b) => {
    const numTables = u16(b, 4);
    const tables = {};
    for (let i = 0; i < numTables; i += 1) {
        const o = 12 + i * 16;
        tables[b.subarray(o, o + 4).toString("latin1")] = b.readUInt32BE(o + 8);
    }
    return { upm: u16(b, tables.head + 18), os2: tables["OS/2"], names(b) {
        const nm = tables.name;
        const count = u16(b, nm + 2);
        const out = [];
        for (let i = 0; i < count; i += 1) {
            const ro = nm + 4 + i * 12;
            if (u16(b, ro) === 3 && u16(b, ro + 2) === 1 && (u16(b, ro + 6) === 1 || u16(b, ro + 6) === 16)) {
                const len = u16(b, ro + 8);
                const so = u16(b, ro + 10);
                out.push(b.subarray(nm + so, nm + so + len).toString("utf16le"));
            }
        }
        return [...new Set(out)].join(" / ");
    } };
};

function probe(raw) {
    const { upm, os2, names } = head(raw);
    if (os2 === undefined) {
        return null;
    }
    const end = raw.byteLength - (raw.byteOffset ?? 0);
    const table = raw.subarray(raw.byteOffset + os2, raw.byteOffset + os2 + Math.min(128, end - os2));
    // scan for ratio-sane (ascent, descent) pairs with supporting metrics
    for (let o = 0; o + 2 < table.length - 1; o += 2) {
        const a = table.readUInt16BE(o);
        const d = table.readUInt16BE(o + 2);
        const af = a / upm;
        const df = d / upm;
        if (af < 0.8 || af > 1.5 || df < 0.08 || df > 0.55 || (af + df) * upm > upm * 1.7 || (af + df) < 1.0) {
            continue;
        }
        // look for x-height / cap-height within +/- 12 bytes, both ratio-sane
        let xh = null;
        let cap = null;
        for (let ro = Math.max(0, o - 12); ro <= o + 12; ro += 2) {
            if (ro === o || ro === o + 2) {
                continue;
            }
            const v = table.readUInt16BE(ro);
            const vf = v / upm;
            if (xh === null && vf >= 0.4 * af && vf <= 0.65 * af) {
                xh = vf;
            } else if (cap === null && vf >= 0.6 * af && vf <= 0.85 * af && (xh === null || vf !== xh)) {
                if (vf > (xh ?? 0)) {
                    cap = vf;
                }
            }
        }
        if (cap === null) {
            continue; // require both supporting metrics — disambiguates from the typo/win pair confusion
        }
        // natural line box (Windows): height af+df, baseline at af from top.
        // cap band [af-cap, af] center vs box center:
        const delta = af - cap / 2 - (af + df) / 2; // negative = band ABOVE center = reads high
        return {
            name: names(raw),
            upm,
            A: af,
            D: df,
            xh,
            cap,
            px: (Math.abs(delta) * 12).toFixed(2),
            dir: delta < 0 ? "band reads HIGH -> nudge DOWN" : "band reads low -> nudge up",
        };
    }
    return null;
}

for (const file of FILES) {
    let raw;
    try {
        raw = readFileSync(join(FONTS, file));
    } catch {
        console.log(`${file}: unreadable`);
        continue;
    }
    if (raw.subarray(0, 4).toString("latin1") === "ttcf") {
        raw = raw.subarray(raw.readUInt32BE(12));
    }
    const p = probe(raw);
    console.log(file, p ? `| ${p.name} | upm=${p.upm} A=${p.A.toFixed(3)} D=${p.D.toFixed(3)} xh=${p.xh?.toFixed(3)} cap=${p.cap.toFixed(3)} | ${p.dir} ${p.px}px @12px` : "| no sane metric pair found");
}
