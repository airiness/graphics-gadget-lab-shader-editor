// Role: REGRESSION EVIDENCE — the socket contract (entirely outside the
// card, inner edge tangent to the border line; hollow ring = unconnected,
// solid = connected; category colors; size).
// CDP probe (Node's built-in WebSocket, no deps): verifies the socket
// geometry in the real renderer — the socket sits ENTIRELY OUTSIDE the
// card with its inner edge tangent to the card border line (measured as
// center offset minus half size), plus the size and hollow/solid state.
// Usage: launch Edge headless with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9226;

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
    const nodes = [...document.querySelectorAll(".react-flow__node")];
    const out = { nodeCount: nodes.length, samples: [], connectedSockets: document.querySelectorAll(".gglab-handle-connected").length, totalSockets: document.querySelectorAll(".react-flow__handle").length };
    for (const card of nodes.slice(0, 4)) {
        const cr = card.getBoundingClientRect();
        const inH = card.querySelector(".gglab-port-in .react-flow__handle");
        const outH = card.querySelector(".gglab-port-out .react-flow__handle");
        const sample = { nodeTitle: (card.querySelector(".gglab-node-title") || {}).textContent };
        if (inH) {
            const r = inH.getBoundingClientRect();
            const cs = getComputedStyle(inH);
            sample.input = { socketCenter: Math.round(r.left + r.width / 2), cardLeft: Math.round(cr.left), deltaFromCardLeft: Math.round(r.left + r.width / 2 - cr.left), size: Math.round(r.width), border: cs.borderColor, bg: cs.backgroundColor, connected: inH.classList.contains("gglab-handle-connected") };
        }
        if (outH) {
            const r = outH.getBoundingClientRect();
            sample.output = { socketCenter: Math.round(r.left + r.width / 2), cardRight: Math.round(cr.right), deltaFromCardRight: Math.round(r.left + r.width / 2 - cr.right), size: Math.round(r.width), connected: outH.classList.contains("gglab-handle-connected") };
        }
        out.samples.push(sample);
    }
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
    await new Promise((resolve) => setTimeout(resolve, 4000)); // canvas + edges settle
    const reply = await send("Runtime.evaluate", { expression: EXPRESSION, returnByValue: true });
    console.log(reply.result && reply.result.value ? reply.result.value : JSON.stringify(reply, null, 1));
    ws.close();
    process.exit(0);
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
