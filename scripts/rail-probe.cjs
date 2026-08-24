// Role: REGRESSION EVIDENCE — both side rails live: inspector collapse
// toggles the 48px rail, library and inspector compose, re-open works.
// CDP probe (Node's built-in WebSocket, no deps). Launch Edge headless
// with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9235;

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

const EXPRESSION = `(async () => {
    const settle = () => new Promise((r) => setTimeout(r, 200));
    const body = document.querySelector(".gglab-body");
    const state = () => ({
        bodyClass: body.className,
        grid: getComputedStyle(body).gridTemplateColumns,
        rightWidth: Math.round(document.querySelector(".gglab-side-right").getBoundingClientRect().width),
        headText: (document.querySelector(".gglab-side-right .gglab-library-title") || {}).textContent || null,
        collapseBtn: !!document.querySelector('[aria-label="Collapse the inspector"]'),
        railBtn: (document.querySelector(".gglab-side-right .gglab-rail-btn") || {}).textContent || null,
    });
    const before = state();
    const btn = document.querySelector('[aria-label="Collapse the inspector"]');
    if (btn) btn.click();
    await settle(); // let React flush the state update into the DOM
    const afterCollapse = state();
    const rail = document.querySelector(".gglab-side-right .gglab-rail-btn");
    if (rail) rail.click();
    await settle();
    const afterExpand = state();
    // both rails together: collapse the library too
    const lib = document.querySelector('[aria-label="Collapse the node library"]');
    if (lib) lib.click();
    await settle();
    const bothCollapsed = state();
    const leftRail = document.querySelector(".gglab-side-left .gglab-rail-btn");
    if (leftRail) leftRail.click();
    await settle();
    const restored = state();
    return JSON.stringify({ before, afterCollapse, afterExpand, bothCollapsed, restored }, null, 1);
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
    const reply = await send("Runtime.evaluate", { expression: EXPRESSION, returnByValue: true, awaitPromise: true });
    console.log(reply.result && reply.result.value ? reply.result.value : JSON.stringify(reply, null, 1));
    ws.close();
    process.exit(0);
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
