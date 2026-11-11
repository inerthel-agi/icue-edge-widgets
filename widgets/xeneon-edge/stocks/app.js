(() => {
    "use strict";

    const ENDPOINT = "http://127.0.0.1:47821";
    const POLL_MS = 30 * 1000;   // the companion refreshes each symbol at most once a minute
    const DEFAULT = "AAPL,NVDA,MSFT,TSLA,CRSR,^GSPC";
    const $ = id => document.getElementById(id);

    let timer = null, request = null, last = null, failed = false;
    const shown = new Map();     // symbol -> last price shown, for the green / red flash

    function symbols() {
        try { if (typeof stockSymbols !== "undefined" && String(stockSymbols).trim()) return String(stockSymbols); } catch (_) {}
        return DEFAULT;
    }

    const fmt = v => (typeof v !== "number" || !isFinite(v) ? "--" : Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) : v.toFixed(Math.abs(v) < 1 ? 4 : 2));
    const signed = (v, d = 2) => (typeof v !== "number" ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}`);
    const big = n => (typeof n !== "number" ? "--" : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
    const dir = q => (typeof q.change !== "number" ? "" : q.change >= 0 ? "up" : "down");
    const svgNS = "http://www.w3.org/2000/svg";

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function spark(points, up) {
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("viewBox", "0 0 110 26");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("class", "sp");
        if (points && points.length > 1) {
            const mn = Math.min(...points), mx = Math.max(...points);
            const line = document.createElementNS(svgNS, "polyline");
            line.setAttribute("points", points.map((v, i) => `${(i / (points.length - 1) * 110).toFixed(1)},${(24 - (v - mn) / (mx - mn || 1) * 22).toFixed(1)}`).join(" "));
            line.setAttribute("class", up ? "up" : "down");
            svg.append(line);
        }
        return svg;
    }

    function row(q) {
        const tr = el("tr");
        const sym = el("td", "sym", q.symbol);
        sym.append(el("small", "", q.name || ""));
        const before = shown.get(q.symbol);
        const px = el("td", typeof before === "number" && typeof q.price === "number" && before !== q.price ? (q.price > before ? "flash-up" : "flash-down") : "", fmt(q.price));
        if (typeof q.price === "number") shown.set(q.symbol, q.price);
        const day = el("td", "day");
        day.append(spark(q.points, dir(q) === "up"));
        tr.append(sym, px, el("td", `net ${dir(q)}`, signed(q.change)), el("td", dir(q), typeof q.changePct === "number" ? `${signed(q.changePct)}%` : "--"), day);
        if (q.stale) tr.classList.add("stale");
        return tr;
    }

    function chart(q) {
        const svg = $("chart");
        svg.replaceChildren();
        const pts = q.points || [];
        if (pts.length < 2) return;
        const all = [...pts, q.prevClose].filter(v => typeof v === "number");
        const mn = Math.min(...all) * 0.999, mx = Math.max(...all) * 1.001;
        const Y = v => (295 - (v - mn) / (mx - mn || 1) * 285).toFixed(1);
        // A full trading day is 78 five-minute bars: the line stops where the day has got to.
        const X = i => (i / Math.max(77, pts.length - 1) * 440).toFixed(1);
        const add = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); svg.append(n); return n; };
        for (let k = 0; k <= 4; k++) {
            const v = mn + (mx - mn) * k / 4;
            add("line", { x1: 0, x2: 440, y1: Y(v), y2: Y(v), class: "grid" });
            add("text", { x: 446, y: Number(Y(v)) + 4, class: "ax" }).textContent = fmt(v);
        }
        if (typeof q.prevClose === "number") add("line", { x1: 0, x2: 440, y1: Y(q.prevClose), y2: Y(q.prevClose), class: "prev" });
        const line = pts.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
        add("polygon", { points: `0,300 ${line} ${X(pts.length - 1)},300`, class: `area ${dir(q)}` });
        add("polyline", { points: line, class: `line ${dir(q)}` });
    }

    function render(data) {
        const quotes = data.quotes || [];
        $("rows").replaceChildren(...quotes.map(row));
        setTimeout(() => document.querySelectorAll("#rows td[class^='flash']").forEach(td => { td.className = ""; }), 600);
        const f = quotes[0];
        $("widget").dataset.empty = String(!f);
        if (f) {
            $("title").textContent = `${f.symbol} ${f.exchange || ""}`.trim();
            $("fTk").textContent = f.symbol;
            $("fNm").textContent = [f.name, f.currency].filter(Boolean).join(" · ");
            $("fPx").textContent = fmt(f.price);
            $("fCh").textContent = typeof f.change === "number" ? `${signed(f.change)}  ${signed(f.changePct)}%` : "";
            $("fCh").className = `ch num ${dir(f)}`;
            $("fO").textContent = fmt(f.open); $("fH").textContent = fmt(f.high); $("fL").textContent = fmt(f.low);
            $("fP").textContent = fmt(f.prevClose); $("fV").textContent = big(f.volume);
            chart(f);
            $("market").textContent = typeof f.price !== "number" ? "" : f.marketOpen ? "MARKET OPEN" : "MARKET CLOSED";
            $("market").className = f.marketOpen ? "open" : "";
        }
        const tape = quotes.map(q => `${q.symbol} ${fmt(q.price)} ${dir(q) === "up" ? "▲" : dir(q) === "down" ? "▼" : ""} ${typeof q.changePct === "number" ? Math.abs(q.changePct).toFixed(2) + "%" : ""}`);
        $("roll").replaceChildren(...[...tape, ...tape].map((t, i) => { const s = el("span", dir(quotes[i % quotes.length])); s.textContent = t; return s; }));
        const stale = quotes.some(q => q.stale);
        $("updated").textContent = stale ? "Some quotes are not up to date" : `Updated ${new Date().toTimeString().slice(0, 5)}`;
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
            const url = `${ENDPOINT}/api/stocks/state?s=${encodeURIComponent(symbols())}`;
            const { data } = await WidgetRuntime.requestJson(url, { signal: request.signal });
            if (!data || data.schema !== "stocks/1") throw new Error("unknown_version");
            last = data;
            failed = false;
            if (!(data.quotes || []).length) { show("No valid symbol", "Set Yahoo Finance symbols in iCUE, separated by commas (AAPL, MC.PA, ^GSPC)."); return; }
            render(data);
            $("overlay").classList.remove("visible");
        } catch (error) {
            if (error && error.name === "AbortError") return;
            if (!last) show("Companion not running", "Start iCUE Edge Companion; it fetches the quotes from Yahoo Finance.");
            else $("updated").textContent = "Companion not running · last quotes shown";
            failed = true;
        }
    }

    function tick() { $("clock").textContent = new Date().toTimeString().slice(0, 8); }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.Stocks = { start, render };
    let key = symbols();
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: () => { const k = symbols(); if (k !== key) { key = k; last = null; update(); } } };
    WidgetRuntime.onResume(update);
    tick();
    setInterval(tick, 1000);
    start();
})();
