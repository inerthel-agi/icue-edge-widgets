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

    function render(data) {
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
            $("overlay").classList.remove("visible");
        } catch (error) {
            if (error && error.name === "AbortError") return;
            if (!failed && !last) show("Companion offline", "Start iCUE Edge Companion; it reads Claude Code's activity on this PC.");
            failed = true;
        }
    }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.AgentActivity = { start, render };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: () => { if (last) render(last); } };
    WidgetRuntime.onResume(update);
    start();
})();
