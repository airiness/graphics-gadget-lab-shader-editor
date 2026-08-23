// Role: REGRESSION EVIDENCE — edge SELECTION language: same-hue emphasis
// (thicker + glow), and a repeat click on the SAME edge is idempotent —
// the library's built-in selected-stroke (flat gray) must never hijack the
// semantic kind color.
// CDP probe (Node's built-in WebSocket, no deps). Launch Edge headless
// with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9243;

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
    const settle = () => new Promise((r) => setTimeout(r, 250));
    const readState = () => {
        const edge = document.querySelector(".react-flow__edge");
        const path = edge ? edge.querySelector(".react-flow__edge-path") : null;
        if (!edge || !path) return { error: "edge/path gone" };
        return {
            classes: edge.className.baseVal || edge.className,
            stroke: getComputedStyle(path).stroke,
            width: getComputedStyle(path).strokeWidth,
            filter: String(getComputedStyle(path).filter).slice(0, 60),
        };
    };
    const click = () => {
        const path = document.querySelector(".react-flow__edge .react-flow__edge-path");
        if (path) path.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };
    const before = readState();
    click();
    await settle();
    const afterFirst = readState();
    click();
    await settle();
    const afterSecond = readState();
    click();
    await settle();
    const afterThird = readState();
    return JSON.stringify({ before, afterFirst, afterSecond, afterThird }, null, 1);
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
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const reply = await send("Runtime.evaluate", { expression: EXPRESSION, returnByValue: true, awaitPromise: true });
    console.log(reply.result && reply.result.value ? reply.result.value : JSON.stringify(reply, null, 1));
    ws.close();
    process.exit(0);
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
