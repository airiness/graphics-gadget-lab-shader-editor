// Role: REGRESSION EVIDENCE — the close prompt's VISUAL contract
// (veil strength, topmost card on token elevation, title/body
// hierarchy). Behavior (the close state machine) is frozen and out of
// scope for this probe: it only injects the card markup and reads
// computed styles.
// CDP probe (Node's built-in WebSocket, no deps). Launch Edge headless
// with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9241;

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
    if (document.querySelector("#probe-prompt")) return JSON.stringify({ note: "already probed" });
    const wrap = document.createElement("div");
    wrap.id = "probe-prompt";
    wrap.className = "gglab-close-prompt";
    wrap.innerHTML = '<div class="gglab-close-prompt-card">' +
        '<h2 class="gglab-close-prompt-title">Unsaved changes</h2>' +
        '<p class="gglab-close-prompt-text">The current session has changes that are not saved as a file yet.</p>' +
        "<div></div></div>";
    document.body.appendChild(wrap);
    const card = wrap.querySelector(".gglab-close-prompt-card");
    const title = wrap.querySelector(".gglab-close-prompt-title");
    const text = wrap.querySelector(".gglab-close-prompt-text");
    const cs = getComputedStyle;
    const out = {
        veil: cs(wrap).backgroundColor,
        card: { background: cs(card).backgroundColor, border: cs(card).borderColor + " " + cs(card).borderTopWidth, radius: cs(card).borderRadius, shadow: cs(card).boxShadow.slice(0, 60), padding: cs(card).padding },
        title: { size: cs(title).fontSize, weight: cs(title).fontWeight, color: cs(title).color, marginBottom: cs(title).marginBottom },
        text: { size: cs(text).fontSize, color: cs(text).color, line: cs(text).lineHeight, marginBottom: cs(text).marginBottom },
    };
    wrap.remove();
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
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const reply = await send("Runtime.evaluate", { expression: EXPRESSION, returnByValue: true });
    console.log(reply.result && reply.result.value ? reply.result.value : JSON.stringify(reply, null, 1));
    ws.close();
    process.exit(0);
})().catch((e) => {
    console.error("ERR", e.message);
    process.exit(1);
});
