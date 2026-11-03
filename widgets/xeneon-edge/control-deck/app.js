(() => {
    "use strict";

    const ENDPOINT = "http://127.0.0.1:47821";
    const POLL_MS = 4000;
    const $ = id => document.getElementById(id);

    // Line icons per action id (24 x 24); the companion decides what each id does.
    const ICONS = {
        mic: "M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
        mute: "M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12",
        playPause: "M4 6v12l8-6zM15 6v12M20 6v12",
        next: "M5 5v14l10-7zM19 5v14",
        snip: "M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M9 12h6",
        lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
        calc: "M6 3h12v18H6zM9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01",
        explorer: "M3 7h7l2 2h9v10H3z",
        taskmgr: "M3 12h4l3-7 4 14 3-7h4",
        nightlight: "M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z",
    };
    const OFF_LABEL = { mic: "Mic off", mute: "Sound off" };

    let timer = null, request = null, last = null, failed = false;
    const svgNS = "http://www.w3.org/2000/svg";

    function key(a) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "key";
        b.dataset.id = a.id;
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", ICONS[a.id] || "M12 12h.01");
        svg.append(path);
        const label = document.createElement("span");
        b.append(svg, label);
        return b;
    }

    function render(data) {
        const deck = $("deck");
        const ids = data.actions.map(a => a.id).join("|");
        if (deck.dataset.ids !== ids) {
            deck.dataset.ids = ids;
            deck.replaceChildren(...data.actions.map(key));
        }
        for (const a of data.actions) {
            const b = deck.querySelector(`[data-id="${a.id}"]`);
            const off = a.kind === "toggle" && a.on === false;
            b.classList.toggle("off", off);
            b.querySelector("span").textContent = off ? OFF_LABEL[a.id] || a.label : a.label;
            b.setAttribute("aria-label", b.querySelector("span").textContent);
        }
    }

    async function run(id, button) {
        button.classList.add("press");
        setTimeout(() => button.classList.remove("press"), 180);
        try {
            await WidgetRuntime.requestJson(`${ENDPOINT}/api/deck/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
            button.classList.add("done");
            setTimeout(() => button.classList.remove("done"), 700);
        } catch (_) {
            button.classList.add("fail");
            setTimeout(() => button.classList.remove("fail"), 900);
        }
        setTimeout(update, 250);
    }

    $("deck").addEventListener("click", e => {
        const b = e.target.closest(".key");
        if (b) run(b.dataset.id, b);
    });

    function show(title, sub) {
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    async function update() {
        if (request) request.abort();
        request = new AbortController();
        try {
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/deck/state`, { signal: request.signal });
            if (!data || data.schema !== "deck/1") throw new Error("unknown_version");
            last = data;
            failed = false;
            render(data);
            $("overlay").classList.remove("visible");
        } catch (error) {
            if (error && error.name === "AbortError") return;
            if (!failed) show("Companion offline", "Start iCUE Edge Companion; it runs the deck's actions on this PC.");
            failed = true;
        }
    }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.ControlDeck = { start, render };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: () => { if (last) render(last); } };
    WidgetRuntime.onResume(update);
    start();
})();
