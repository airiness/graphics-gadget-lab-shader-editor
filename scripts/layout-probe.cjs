// Role: REGRESSION EVIDENCE — the canvas flow geometry (node size, port
// row rhythm, fitView zoom clamp over the viewport).
// Layout probe over CDP (Node's built-in WebSocket, no dependencies):
// verifies the library section computes to a vertical stack (the
// flex-col regression) and reports the action-group gap.
// Usage: launch Edge headless with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9223;

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
    const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const root = document.querySelector("[data-slot='collapsible-section']");
    const head = document.querySelector("button.gglab-section-head");
    const content = root ? root.querySelectorAll("div")[0] : null;
    const body = document.querySelector(".gglab-section-body");
    const entry = document.querySelector("button.gglab-palette-entry");
    const bulk = document.querySelector(".gglab-library-bulk");
    return JSON.stringify({
        rootDisplay: root ? getComputedStyle(root).display : null,
        rootFlexDirection: root ? getComputedStyle(root).flexDirection : null,
        headRect: rect(head),
        contentRect: content ? rect(content) : null,
        bodyRect: body ? rect(body) : null,
        entryRect: entry ? rect(entry) : null,
        contentBelowHeadBy: content && head ? Math.round(content.getBoundingClientRect().top - head.getBoundingClientRect().bottom) : null,
        bulkGap: bulk ? getComputedStyle(bulk).gap : null,
    }, null, 1);
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
