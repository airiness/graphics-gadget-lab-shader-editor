// Role: REGRESSION EVIDENCE — the button kit's computed language
// (size, radius, border, shared surface, label tone, state set).
// CDP probe (Node's built-in WebSocket, no deps): verifies the kit
// button optics in the real renderer — label/icon optical transform and
// the computed background of every variant.
// Usage: launch Edge headless with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9225;

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
    const out = { buttons: [] };
    const rootStyle = getComputedStyle(document.documentElement);
    out.tokens = { bg: rootStyle.getPropertyValue('--bg').trim(), panel: rootStyle.getPropertyValue('--panel').trim(), panelHi: rootStyle.getPropertyValue('--panel-hi').trim(), accent: rootStyle.getPropertyValue('--accent').trim() };
    out.appBodyBg = getComputedStyle(document.querySelector('[class*="gglab-body"]')).backgroundColor;
    const find = (titleText) => [...document.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '').includes(titleText));
    for (const titleText of ['Save document', 'Don', 'Auto-layout', 'Collapse all']) {
        const b = find(titleText);
        if (!b) continue;
        const span = b.querySelector('span');
        out.buttons.push({
            title: (b.getAttribute('title') || b.textContent || '').trim().slice(0, 24),
            bg: getComputedStyle(b).backgroundColor,
            labelTransform: span ? getComputedStyle(span).transform : null,
        });
    }
    return JSON.stringify(out, null, 1);
})()`;

(async () => {
    const targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json`));
    const page = targets.find((t) => t.type === "page");
    if (!page) {
        console.error("no page target", targets.map((t) => t.type));
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
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const reply = await send("Runtime.evaluate", { expression: EXPRESSION, returnByValue: true });
    console.log(reply.result && reply.result.value ? reply.result.value : JSON.stringify(reply, null, 1));
    ws.close();
    process.exit(0);
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
