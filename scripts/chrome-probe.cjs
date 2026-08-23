// Role: REGRESSION EVIDENCE — the chrome ladder (canvas < frame < raised
// content), AA-legible faint text, and the slim scrollbar in the live app.
// CDP probe (Node's built-in WebSocket, no deps). Launch Edge headless
// with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9233;

function get(url) {
    return new Promise((resolve, reject) => {
        http
            .get(url, (r) => {
                let d = "";
                r.on("data", (c) => {
                    d += c;
                });
                r.on("end", () => resolve(d));
            })
            .on("error", reject);
    });
}

const EXPRESSION = `(() => {
    const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.background.slice(0, 40), color: cs.color };
    };
    const diag = document.querySelector(".gglab-diagnostics-item");
    const diagSecond = document.querySelectorAll(".gglab-diagnostics-item")[1];
    const severity = document.querySelector(".gglab-diagnostics-severity");
    const code = document.querySelector(".gglab-diagnostics-code");
    const side = document.querySelector(".gglab-side-left");
    const sb = document.createElement("div");
    return JSON.stringify({
        viewport: pick(".gglab-viewport"),
        header: pick(".gglab-header"),
        side: side ? getComputedStyle(side).backgroundColor : null,
        panel: pick(".gglab-panel"),
        statusbar: pick(".gglab-statusbar"),
        faintSample: pick(".gglab-brand-sub"),
        factDd: pick(".gglab-fact dd"),
        diag: diag ? {
            padding: getComputedStyle(diag).padding,
            secondBorderTop: diagSecond ? getComputedStyle(diagSecond).borderTopWidth + " " + getComputedStyle(diagSecond).borderTopColor : "(single item)",
            severity: severity ? getComputedStyle(severity).color + " / " + getComputedStyle(severity).fontSize : null,
            code: code ? getComputedStyle(code).color + " / " + getComputedStyle(code).fontFamily.slice(0, 20) : null,
        } : "(no diagnostic items — seed is clean)",
        scrollbar: side ? (() => {
            const cs = getComputedStyle(side, "::-webkit-scrollbar");
            return cs ? cs.width : "n/a";
        })() : null,
    }, null, 1);
})()`;

(async () => {
    const targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json`));
    const page = targets.find((t) => t.type === "page");
    if (!page) {
        console.error("no page target");
        process.exit(1);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let nextId = 0;
    const pending = new Map();
    const send = (method, params = {}) =>
        new Promise((resolve) => {
            const id = ++nextId;
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method, params }));
        });
    ws.addEventListener("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
        }
    });
    await new Promise((resolve) => {
        ws.addEventListener("open", resolve, { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const reply = await send("Runtime.evaluate", { expression: EXPRESSION, returnByValue: true });
    console.log(reply.result && reply.result.value ? reply.result.value : JSON.stringify(reply, null, 1));
    ws.close();
    process.exit(0);
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
