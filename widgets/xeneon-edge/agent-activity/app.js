(() => {
    "use strict";

    const ENDPOINT = "http://127.0.0.1:47821";
    const POLL_MS = 3000;
    const $ = id => document.getElementById(id);

    let timer = null, request = null, last = null, failed = false, shownKeys = null, shownOnce = false;

    const clock = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const compact = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
    const since = t => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };

    function make(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    // Claude Code waiting on the user (needs the Notification hook, see the companion README): the whole
    // widget turns into one card, so it reads from across the room.
    const ASK = { permission: ["Permission needed", "Claude Code needs your OK"], reply: ["Your turn", "Claude Code is waiting for your reply"], question: ["Question", "Claude Code has a question for you"] };
    function renderAsk(a) {
        $("ask").hidden = !a;
        $("widget").classList.toggle("asking", !!a);
        if (!a) return;
        const [kind, title] = ASK[a.kind] || ASK.reply;
        $("widget").dataset.ask = a.kind;
        $("askKind").textContent = kind;
        $("askTitle").textContent = title;
        $("askMsg").textContent = a.message || "";
        $("askProject").textContent = a.project || "";
        const s = Math.max(0, Math.round((Date.now() - a.since) / 1000));
        $("askSince").textContent = `waiting ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }

    function render(data) {
        renderAsk(data.attention || null);
        const active = !!data.active;
        $("widget").dataset.state = active ? "active" : "idle";
        $("badge").textContent = active ? `Working · ${since(data.since || Date.now())}` : data.lastEventAt ? `Idle · last ${clock(data.lastEventAt)}` : "Idle";
        $("state").textContent = active ? "Now" : "Last step";
        const step = data.step;
        $("step").textContent = step ? step.verb : active ? "Thinking" : "Waiting for Claude Code";
        $("target").textContent = step ? step.target || step.tool : "";
        $("tpm").textContent = active ? compact(data.tokensPerMin || 0) : "0";
        $("tools").textContent = String(data.toolsToday || 0);
        // Rebuilt only when the list changes; only calls not shown before slide in.
        const recent = data.recent || [];
        const keyOf = r => `${r.at}|${r.tool}|${r.target}`;
        const keys = recent.map(keyOf).join("\n");
        if (keys !== shownKeys) {
            const before = new Set((shownKeys || "").split("\n"));
            shownKeys = keys;
            $("feed").replaceChildren(...recent.map(r => {
                const li = make("li", shownOnce && !before.has(keyOf(r)) ? "new" : "");
                li.append(make("span", "t", clock(r.at)), make("b", "", r.tool), make("em", "", r.target || ""));
                return li;
            }));
            shownOnce = true;
            if (!recent.length) $("feed").append(make("li", "empty", "No tool call in the last 30 minutes."));
        }
    }

    function show(title, sub) {
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    async function update() {
        if (request) request.abort();
        request = new AbortController();
        try {
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/agent/state`, { signal: request.signal });
            if (!data || data.schema !== "agent/1") throw new Error("unknown_version");
            last = data;
            failed = false;
            if (!data.detected) { show("Claude Code not detected", "Its logs appear in your user folder (.claude) once you use it on this PC."); return; }
            render(data);
            $("status").textContent = "Tool names and file names only: no prompt or file content.";
            $("overlay").classList.remove("visible");
        } catch (error) {
            if (error && error.name === "AbortError") return;
            if (!failed && !last) show("Companion not running", "Start iCUE Edge Companion; it reads Claude Code's activity on this PC.");
            else if (last) {
                // The last reading stays visible but no longer claims Claude Code is working or waiting.
                renderAsk(null);
                $("widget").dataset.state = "idle";
                $("badge").textContent = "Offline";
                $("status").textContent = "Companion not running · showing the last data";
            }
            failed = true;
        }
    }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    if (/[?&]demo\b/.test(location.search) && !/demo=ask/.test(location.search)) {
        const t = Date.now(), m = 60000;
        WidgetRuntime.requestJson = () => Promise.resolve({ data: { schema: "agent/1", detected: true, active: true, since: t - 42 * m, lastEventAt: t, tokensPerMin: 18400, toolsToday: 214,
            step: { at: t, tool: "Edit", verb: "Editing", target: "widgets/xeneon-edge/ci-radar/style.css" },
            recent: [["Edit", "ci-radar/style.css"], ["Bash", "node tests/widgets.test.cjs"], ["Read", "ci-radar/app.js"], ["Write", "patch-radar/app.js"], ["Bash", "cargo test --release --lib"], ["Grep", "widgetStyle"], ["Read", "README.md"]]
                .map(([tool, target], i) => ({ at: t - i * 47000, tool, target })) } });
    }
    if (/[?&]demo=ask\b/.test(location.search)) {
        WidgetRuntime.requestJson = () => Promise.resolve({ data: { schema: "agent/1", detected: true, active: false, lastEventAt: Date.now() - 42000, recent: [], toolsToday: 37,
            attention: { kind: "permission", message: "Claude needs your permission to use Bash", project: "icue-edge-widgets", since: Date.now() - 42000 } } });
    }
    window.AgentActivity = { start, render };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: () => { if (last && !failed) render(last); } };
    WidgetRuntime.onResume(update);
    start();
})();
