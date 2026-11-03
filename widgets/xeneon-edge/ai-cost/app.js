(() => {
    "use strict";

    const ENDPOINT = "http://127.0.0.1:47821";
    const POLL_MS = 30 * 1000;
    const HOUR = 3600 * 1000;
    const DAY = 24 * HOUR;
    const $ = id => document.getElementById(id);

    // USD per million tokens: input, output, cache read, cache write (5 min). From the Anthropic and OpenAI pricing pages,
    // checked on 3 Nov 2026; kept here so they are easy to correct. Long-context surcharges are not counted.
    const PRICES = {
        claude: {
            fable: [10, 50, 0.25, 12.5], opus55: [4, 20, 0.2, 5], opus5: [5, 25, 0.5, 6.25], opus41: [15, 75, 1.5, 18.75],
            sonnet55: [2, 10, 0.1, 2.5], sonnet46: [3, 15, 0.3, 3.75], haiku55: [0.1, 0.5, 0.01, 0.125], haiku45: [1, 5, 0.1, 1.25], haiku35: [0.8, 4, 0.08, 1]
        },
        codex: {
            gpt56sol: [4, 20, 0.4, 0], gpt56terra: [2, 12, 0.2, 0], gpt56luna: [0.2, 1.2, 0.02, 0], gpt55: [5, 30, 0.5, 0], gpt54: [2.5, 15, 0.25, 0],
            gpt53codex: [1.75, 14, 0.175, 0], gpt5: [1.25, 10, 0.125, 0], gpt5mini: [0.25, 2, 0.025, 0]
        }
    };

    /** Price class of a model name, for the "Automatic" setting. */
    function tierOf(provider, model) {
        const m = String(model || "").toLowerCase().replace(/[_\s]+/g, "-");
        if (provider === "claude") {
            if (/fable|mythos/.test(m)) return "fable";
            if (/opus/.test(m)) return /opus-?5-?5|opus-5\.5/.test(m) ? "opus55" : /opus-4(-1)?(-\d{8})?$/.test(m) ? "opus41" : "opus5";
            if (/haiku/.test(m)) return /haiku-?5/.test(m) ? "haiku55" : /3-?5/.test(m) ? "haiku35" : "haiku45";
            if (/sonnet/.test(m)) return /sonnet-?5/.test(m) ? "sonnet55" : "sonnet46";
            return "sonnet55";
        }
        if (/5\.6/.test(m)) return /luna/.test(m) ? "gpt56luna" : /terra/.test(m) ? "gpt56terra" : "gpt56sol";
        if (/5\.5/.test(m)) return "gpt55";
        if (/5\.4/.test(m)) return "gpt54";
        if (/5\.3/.test(m)) return "gpt53codex";
        if (/mini/.test(m)) return "gpt5mini";
        if (/gpt-?5/.test(m)) return "gpt5";
        return "gpt55";
    }

    let timer = null, request = null, lastData = null, lastOk = 0, failed = false;

    function setting(name, fallback) {
        try {
            if (name === "aiClaudePrice" && typeof aiClaudePrice !== "undefined") return aiClaudePrice || fallback;
            if (name === "aiCodexPrice" && typeof aiCodexPrice !== "undefined") return aiCodexPrice || fallback;
        } catch (_) {}
        return fallback;
    }

    function price(provider, model) {
        const table = PRICES[provider];
        const chosen = String(setting(provider === "claude" ? "aiClaudePrice" : "aiCodexPrice", "auto"));
        return table[chosen] || table[tierOf(provider, model)];
    }

    const num = v => (Number.isFinite(v) ? v : 0);
    function cost(tok, p) {
        return (num(tok.input) * p[0] + num(tok.output) * p[1] + num(tok.cacheRead) * p[2] + num(tok.cacheWrite) * p[3]) / 1e6;
    }
    const tokens = t => num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite);

    function money(v) {
        return `$${v < 10 ? v.toFixed(2) : v < 1000 ? v.toFixed(1) : Math.round(v)}`;
    }

    function compact(n) {
        if (n >= 1e9) return `${(n / 1e9).toFixed(1)} B`;
        if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
        if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
        return String(Math.round(n));
    }

    /** Costs and token counts from one `ai-usage/1` snapshot. `now` is injectable for tests. */
    function summarize(wire, now = Date.now()) {
        const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
        const todayStart = midnight.getTime();
        const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
        const monthDays = new Date(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 0).getDate();
        const out = { today: 0, yesterday: 0, month: null, tokensToday: 0, byProvider: {}, series: new Array(24).fill(0) };
        let haveDays = false;
        for (const id of ["claude", "codex"]) {
            const w = wire.providers && wire.providers[id];
            if (!w) continue;
            const p = price(id, w.model && w.model.v);
            let today = 0;
            for (const h of w.hours || []) {
                const c = cost(h, p);
                if (h.start >= todayStart) { today += c; out.tokensToday += tokens(h); }
                else if (h.start >= todayStart - DAY) out.yesterday += c;
                const age = Math.floor((now - h.start) / HOUR);
                if (age >= 0 && age < 24) out.series[23 - age] += c;
            }
            out.byProvider[id] = today;
            out.today += today;
            if (Array.isArray(w.days)) {
                haveDays = true;
                out.month = (out.month || 0) + w.days.filter(d => d.start >= monthStart).reduce((s, d) => s + cost(d, p), 0);
            }
        }
        out.pace = haveDays && out.month !== null ? out.month / Math.max(1, (now - monthStart) / DAY) * monthDays : null;
        return out;
    }

    function sparkPaths(series) {
        const max = Math.max(...series, 0.0001);
        const pts = series.map((v, i) => [i / 23 * 240, 54 - v / max * 48]);
        const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
        return { line, area: `${line} L240 58 L0 58 Z` };
    }

    function render(wire) {
        const s = summarize(wire);
        const whole = Math.floor(s.today);
        const cents = Math.round((s.today - whole) * 100);
        $("big").textContent = `$${whole}`;
        $("cents").textContent = s.today < 100 ? `.${String(cents).padStart(2, "0")}` : "";
        $("sub").textContent = `today · ${compact(s.tokensToday)} tokens`;
        const paths = sparkPaths(s.series);
        $("sparkLine").setAttribute("d", paths.line);
        $("sparkArea").setAttribute("d", paths.area);
        const total = Math.max(s.today, 0.0001);
        for (const id of ["claude", "codex"]) {
            const v = s.byProvider[id] || 0;
            $(`${id}Cost`).textContent = money(v);
            $(`${id}Bar`).style.width = `${Math.round(v / total * 100)}%`;
        }
        $("pace").textContent = s.pace === null ? "" : `Pace ${money(s.pace)} this month`;
        $("mYesterday").textContent = money(s.yesterday);
        $("mMonth").textContent = s.month === null ? "--" : money(s.month);
        $("mTokens").textContent = compact(s.tokensToday);
    }

    function show(title, sub) {
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    function renderStatus() {
        const text = failed ? "Companion offline · showing the last data" : lastOk ? `Updated ${new Date(lastOk).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · estimate from token counts and set prices` : "Waiting for the companion";
        if ($("status").textContent !== text) $("status").textContent = text;
        $("badge").textContent = failed ? "Offline" : "Estimate";
    }

    async function update() {
        if (request) request.abort();
        request = new AbortController();
        try {
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/usage/state`, { signal: request.signal });
            if (!data || data.schema !== "ai-usage/1") throw new Error("unknown_version");
            lastData = data;
            lastOk = Date.now();
            failed = false;
            render(data);
            $("overlay").classList.remove("visible");
        } catch (error) {
            if (error && error.name === "AbortError") return;
            failed = true;
            if (lastData) render(lastData);
            else show("Companion offline", "Start iCUE Edge Companion; it reads Claude and Codex usage on this PC.");
        }
        renderStatus();
    }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.AiCost = { start, summarize, cost, tierOf, PRICES };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: () => { if (lastData) render(lastData); } };
    WidgetRuntime.onResume(update);
    setInterval(renderStatus, 30000);
    start();
})();
