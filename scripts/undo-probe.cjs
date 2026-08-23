// Role: REGRESSION EVIDENCE — the undo/redo LIVE loop: an authored change
// enables Undo, Ctrl+Z reverts it, Ctrl+Y re-applies it; and Ctrl+Z while
// a text field is active leaves the document untouched (the field owns it).
// CDP probe (Node's built-in WebSocket, no deps). Launch Edge headless
// with --remote-debugging-port=PORT first.
/* eslint-disable */
const http = require("http");
const PORT = process.env.PROBE_PORT || 9247;

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
    const settle = () => new Promise((r) => setTimeout(r, 300));
    const nodes = () => document.querySelectorAll(".gglab-node").length;
    const undoBtn = () => document.querySelector('[aria-label="Undo"]');
    const redoBtn = () => document.querySelector('[aria-label="Redo"]');
    const key = (k, extra = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, ctrlKey: true, bubbles: true, ...extra }));
    const state = () => ({ nodes: nodes(), undoDisabled: undoBtn()?.disabled ?? null, redoDisabled: redoBtn()?.disabled ?? null });

    const t0 = state();
    // 1) author a change: click a palette node button (search the library)
    const buttons = [...document.querySelectorAll("aside button")].filter((b) => /Float/.test(b.textContent));
    const authorBtn = buttons.find((b) => !b.disabled) ?? buttons[buttons.length - 1];
    if (authorBtn) authorBtn.click();
    await settle();
    const afterAdd = state();
    // 2) undo it
    key("z");
    await settle();
    const afterUndo = state();
    // 3) redo it
    key("y");
    await settle();
    const afterRedo = state();
    // 4) the guard: focus the library search field, dispatch Ctrl+Z — the
    //    document must be untouched (the field's own editor owns it).
    const search = document.querySelector('aside input[placeholder]');
    let guarded = "n/a (no search field)";
    if (search) {
        const before = nodes();
        search.focus();
        // the app's window listener sees event.target = the input
        search.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
        await settle();
        guarded = before === nodes() ? "untouched" : "CHANGED " + before + " -> " + nodes() + " (FAIL)";
    }
    return JSON.stringify({ t0, afterAdd, afterUndo, afterRedo, guarded, authorBtn: authorBtn ? authorBtn.textContent : null }, null, 1);
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
