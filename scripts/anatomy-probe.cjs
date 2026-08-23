// CDP probe (Node's built-in WebSocket, no deps): reads the live node
// anatomy in the rendered app — card rect, category rail rect, header
// divider, port row rhythm, and socket tangency — for the first two
// nodes. Launch Edge headless with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9231;

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
    const cards = [...document.querySelectorAll(".react-flow__node")];
    const out = cards.slice(0, 2).map((host) => {
        const card = host.querySelector(".gglab-node");
        const cs = getComputedStyle(card);
        const cr = card.getBoundingClientRect();
        const rail = getComputedStyle(card, "::before");
        const railR = { top: rail.top, bottom: rail.bottom, width: rail.width, radius: rail.borderRadius };
        const header = card.querySelector(".gglab-node-header");
        const hcs = getComputedStyle(header);
        const rows = [...card.querySelectorAll(".gglab-port-row")].slice(0, 2).map((row) => row.getBoundingClientRect().height);
        const sockets = [...host.querySelectorAll(".react-flow__handle")].slice(0, 2).map((s) => {
            const sr = s.getBoundingClientRect();
            return { left: Math.round(sr.left * 10) / 10, right: Math.round(sr.right * 10) / 10, top: Math.round(sr.top * 10) / 10, bottom: Math.round(sr.bottom * 10) / 10 };
        });
        return {
            title: (card.querySelector(".gglab-node-title") || {}).textContent,
            card: { h: Math.round(cr.height * 10) / 10, w: Math.round(cr.width * 10) / 10, left: Math.round(cr.left * 10) / 10, right: Math.round(cr.right * 10) / 10, top: Math.round(cr.top * 10) / 10, bottom: Math.round(cr.bottom * 10) / 10, widthCss: cs.width },
            rail: railR,
            header: { height: hcs.height, borderBottom: hcs.borderBottomWidth + " " + hcs.borderBottomColor, gap: hcs.gap, paddingTop: hcs.paddingTop },
            rows: rows.map((r) => Math.round(r * 10) / 10),
            sockets,
        };
    });
    return JSON.stringify(out, null, 1);
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
