(() => {
    "use strict";

    const $ = id => document.getElementById(id);
    const NS = "http://www.w3.org/2000/svg";
    const HISTORY = 40;   // 40 readings x 1.5 s = the last minute
    // Each gauge: its load sensor and the temperature shown under it.
    const GAUGES = [
        { key: "cpu", label: "CPU", load: "cpuLoad", temp: "cpuTemp" },
        { key: "gpu", label: "GPU", load: "gpuLoad", temp: "gpuTemp" },
        { key: "ram", label: "RAM", load: "ram" },
        { key: "vram", label: "VRAM", load: "vram" },
    ];
    const cards = {};

    function svg(tag, attrs, parent) {
        const n = document.createElementNS(NS, tag);
        for (const k in attrs) n.setAttribute(k, attrs[k]);
        if (parent) parent.append(n);
        return n;
    }
    function el(tag, cls, parent, text) {
        const n = document.createElement(tag);
        n.className = cls;
        if (text !== undefined) n.textContent = text;
        parent.append(n);
        return n;
    }

    for (const g of GAUGES) {
        const card = el("article", "g", $("gauges"));
        card.dataset.role = g.key;
        const ring = svg("svg", { class: "ring", viewBox: "0 0 120 120" }, card);
        svg("circle", { class: "track", cx: 60, cy: 60, r: 50, pathLength: 100 }, ring);
        const arc = svg("circle", { class: "arc", cx: 60, cy: 60, r: 50, pathLength: 100, "stroke-dasharray": "0 100" }, ring);
        const val = el("p", "val", card);
        const num = el("b", "", val, "--");
        el("small", "", val, "%");
        const text = el("div", "txt", card);
        el("p", "lbl", text, g.label);
        const temp = el("p", "tmp", text, g.temp ? "--" : "");
        const spark = svg("svg", { class: "spark", viewBox: "0 0 100 30", preserveAspectRatio: "none" }, card);
        const area = svg("path", { class: "area" }, spark);
        const line = svg("path", { class: "line" }, spark);
        cards[g.key] = { card, arc, num, temp, area, line, history: [] };
    }

    function heat(c) { return !Number.isFinite(c) ? "" : c >= 85 ? "bad" : c >= 72 ? "warn" : ""; }
    function celsius(t) {
        if (!t) return NaN;
        return /f/i.test(String(t.units).replace("°", "").trim()) && !/c/i.test(String(t.units)) ? (t.value - 32) * 5 / 9 : t.value;
    }

    function draw(c) {
        const h = c.history;
        if (h.length < 2) { c.line.setAttribute("d", ""); c.area.setAttribute("d", ""); return; }
        const pts = h.map((v, i) => `${(100 - (h.length - 1 - i) * (100 / (HISTORY - 1))).toFixed(1)},${(29 - v * 0.27).toFixed(1)}`);
        c.line.setAttribute("d", `M${pts.join("L")}`);
        c.area.setAttribute("d", `M${pts[0].split(",")[0]},30L${pts.join("L")}L100,30Z`);
    }

    function render(r) {
        if (r.plugin === false) {
            $("overlayTitle").textContent = "iCUE sensors not available";
            $("overlaySub").textContent = "This widget reads the iCUE Sensors plugin; it works on the XENEON EDGE inside iCUE.";
            $("overlay").classList.add("visible");
            return;
        }
        $("overlay").classList.remove("visible");
        let found = 0;
        for (const g of GAUGES) {
            const c = cards[g.key], load = r[g.load];
            const v = load ? Math.max(0, Math.min(100, load.value)) : NaN;
            c.card.classList.toggle("missing", !load);
            c.num.textContent = load ? String(Math.round(v)) : "--";
            c.arc.setAttribute("stroke-dasharray", `${load ? v.toFixed(1) : 0} 100`);
            if (load) { found++; c.history.push(v); if (c.history.length > HISTORY) c.history.shift(); }
            if (g.temp) {
                const t = r[g.temp];
                const deg = celsius(t);
                c.temp.textContent = t ? `${Math.round(t.value)} ${t.units || "°C"}`.replace(/\s+$/, "") : load ? "" : "Not in iCUE";
                c.card.dataset.heat = heat(deg);
            } else if (!load) c.temp.textContent = "Not in iCUE";
            draw(c);
        }
        $("status").textContent = found ? `${found} of 4 from iCUE sensors` : "No load sensor found in iCUE";
    }

    window.icueEvents = { onICUEInitialized: () => {}, onDataUpdated: () => {} };
    SensorReader.watch(render);
})();
