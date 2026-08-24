// Role: REGRESSION EVIDENCE — the chipless type contract (no permanent
// type column; the type lives in the port's hover tooltip).
// CDP probe (Node's built-in WebSocket, no deps): verifies the live app
// renders NO permanent type chips (chipCount === 0) and that each
// populated port cell carries the hover `title = "name — type"`.
// Usage: launch Edge headless with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9228;

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
    const out = nodes.slice(0, 6).map((card) => {
        const title = (card.querySelector(".gglab-node-title") || {}).textContent;
        const chipCount = card.querySelectorAll(".gglab-port-type").length;
        const rows = [...card.querySelectorAll(".gglab-port-row")].slice(0, 8).map((row) => {
            const inp = row.querySelector(".gglab-port-in");
            const outp = row.querySelector(".gglab-port-out");
            const pick = (cell) => cell ? (cell.querySelector(".gglab-port-name")?.textContent || "").trim() + " | hover: " + (cell.getAttribute("title") || "(none)") : "(empty)";
            return { in: pick(inp), out: pick(outp) };
        });
        return { title, chipCount, rows };
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
