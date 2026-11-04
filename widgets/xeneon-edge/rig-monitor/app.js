(() => {
    "use strict";

    const $ = id => document.getElementById(id);
    const N = 120;   // 120 readings x 1.5 s = the last 3 minutes
    // Each section: the sensors it shows. Series with graph:false only appear as a readout.
    const SECTIONS = [
        { key: "cpu", name: "CPU", flag: "showCpu", brand: ["cpuLoad", "cpuTemp"], series: [
            { role: "cpuLoad", label: "Load", units: "%", min: 0, max: 100 },
            { role: "cpuTemp", label: "Temp", units: "°C", min: 0, max: 100, dash: true, heat: true },
            { role: "cpuPower", label: "Power", units: "W", graph: false }] },
        { key: "gpu", name: "GPU", flag: "showGpu", brand: ["gpuLoad", "gpuTemp"], series: [
            { role: "gpuLoad", label: "Load", units: "%", min: 0, max: 100 },
            { role: "gpuTemp", label: "Temp", units: "°C", min: 0, max: 100, dash: true, heat: true },
            { role: "gpuPower", label: "Power", units: "W", graph: false }] },
        { key: "mem", name: "Memory", flag: "showMem", brand: ["ram"], series: [
            // RAM in GB comes from iCUE Edge Companion (iCUE has no RAM sensor); max becomes the installed amount.
            { role: "ram", label: "RAM", units: "GB", min: 0, max: 32 },
            { role: "vram", label: "VRAM", units: "GB", min: 0, max: 16, dash: true },
            { role: "commit", label: "Commit", units: "GB", graph: false }] },
        { key: "cool", name: "Cooling", flag: "showCool", brand: ["liquid", "pump"], series: [
            { role: "liquid", label: "Coolant", units: "°C", min: 20, max: 60, heat: true, warn: 40, bad: 50 },
            { role: "pump", label: "Pump", units: "RPM", min: 0, max: 5000, dash: true },
            { role: "air", label: "Room", units: "°C", graph: false }] },
    ];
    // History by sensor role, shared by the cards and kept in storage: switching iCUE pages, windows or sections
    // reloads the widget, and the graphs carry on from where they were instead of starting empty.
    const DEMO = /[?&]demo(=|&|$)/.test(location.search);
    const store = WidgetRuntime.storage("rig-monitor", "rig-monitor");
    const H = {};
    (function restore() {
        const saved = DEMO ? null : store.read();
        if (!saved || !saved.hist || !Number.isFinite(saved.at)) return;
        // Readings missed while the widget was away fall off the left edge.
        const lost = Math.floor(Math.max(0, Date.now() - saved.at) / 1500);
        for (const [role, h] of Object.entries(saved.hist)) {
            if (!Array.isArray(h)) continue;
            const keep = h.filter(Number.isFinite).slice(-N).slice(Math.min(lost, N));
            if (keep.length) H[role] = keep;
        }
    })();
    let savedAt = 0;
    function save() {
        if (DEMO || Date.now() - savedAt < 6000) return;
        savedAt = Date.now();
        store.write({ at: savedAt, hist: H });
    }
    window.addEventListener("pagehide", () => { savedAt = 0; save(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { savedAt = 0; save(); } });
    const secs = [];   // built sections: { def, el, canvas, rows: {role: {...}}, hist: {role: []} }

    function el(tag, cls, parent, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        if (parent) parent.append(n);
        return n;
    }

    function build() {
        $("secs").replaceChildren();
        secs.length = 0;
        const shown = SECTIONS.filter(d => window[d.flag] !== false && window[d.flag] !== "false");
        $("secs").dataset.count = Math.max(1, shown.length);
        for (const def of shown) {
            const card = el("article", "sec", $("secs"));
            card.dataset.sec = def.key;
            const head = el("header", "head", card);
            el("h2", "name", head, def.name);
            const dev = el("span", "dev", head, "");
            const reads = el("div", "reads", card);
            const rows = {}, hist = {};
            for (const s of def.series) {
                const r = el("p", "r", reads);
                r.dataset.role = s.role;
                if (s.dash) r.classList.add("alt");
                if (s.graph === false) r.classList.add("flat");
                el("span", "rl", r, s.label);
                const v = el("b", "rv", r, "--");
                el("small", "ru", r, s.units);
                rows[s.role] = { r, v, s };
                hist[s.role] = H[s.role] || (H[s.role] = []);
            }
            const canvas = el("canvas", "graph", card);
            canvas.setAttribute("role", "img");
            const stats = el("p", "stats", card);
            const sMin = el("span", "", stats), sAvg = el("span", "", stats), sPeak = el("span", "pk", stats);
            secs.push({ def, card, dev, canvas, rows, hist, sMin, sAvg, sPeak });
        }
        if (DEMO) prefill();
        requestAnimationFrame(() => secs.forEach(draw));
    }
    // Previews only: a made-up past so the graphs are full at once instead of after 3 minutes.
    function prefill() {
        for (const sec of secs) for (const s of sec.def.series) {
            if (s.graph === false) continue;
            const h = sec.hist[s.role];
            if (h.length) continue;
            const base = s.min + (s.max - s.min) * (s.units === "%" ? 0.22 : s.role === "pump" ? 0.52 : 0.35);
            for (let i = 0; i < N; i++) {
                const spike = Math.max(0, Math.sin(i * 0.19 + s.max) * Math.sin(i * 0.53)) * (s.max - s.min) * 0.5;
                h.push(Math.min(s.max, base + spike + Math.abs(Math.sin(i * 2.1 + s.min)) * (s.max - s.min) * 0.1 + (s.units === "%" && s.dash ? 20 : 0)));
            }
        }
    }

    function celsius(t) {
        if (!t) return NaN;
        return /f/i.test(String(t.units).replace("°", "").trim()) && !/c/i.test(String(t.units)) ? (t.value - 32) * 5 / 9 : t.value;
    }
    function state(s, v) {
        if (!Number.isFinite(v)) return "";
        if (s.heat) { const w = s.warn || 72, b = s.bad || 85; return v >= b ? "bad" : v >= w ? "warn" : ""; }
        return s.units === "%" && v >= 92 ? "warn" : "";
    }
    const fmt = (v, s) => !Number.isFinite(v) ? "--" : s.units === "GB" ? v.toFixed(1) : s.units === "RPM" ? String(Math.round(v)) : v >= 100 || s.units === "W" ? String(Math.round(v)) : v.toFixed(0);

    function draw(sec) {
        const c = sec.canvas, dpr = window.devicePixelRatio || 1;
        const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
        if (!w || !h) return;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const g = c.getContext("2d"), cs = getComputedStyle(document.documentElement);
        const ink = cs.getPropertyValue("--x-text").trim() || "#f2f3ed", acc = cs.getPropertyValue("--x-accent").trim() || "#a8d5ba", warn = cs.getPropertyValue("--x-warn").trim() || "#e8c477";
        const mix = (col, a) => { g.globalAlpha = a; return col; };
        g.clearRect(0, 0, w, h);
        const padR = 0, top = 4 * dpr, bot = h - 3 * dpr, H = bot - top, W = w - padR;
        // Grid: quarters, faint.
        g.lineWidth = dpr; g.strokeStyle = mix(ink, 0.1);
        for (const q of [0, 0.25, 0.5, 0.75, 1]) { const y = bot - H * q; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
        const graphed = sec.def.series.filter(s => s.graph !== false);
        // Draw the dashed secondary first so the primary sits on top.
        for (const s of [...graphed].reverse()) {
            const h0 = sec.hist[s.role];
            if (h0.length < 2) continue;
            const X = i => W - (h0.length - 1 - i) * (W / (N - 1)), Y = v => bot - H * Math.max(0, Math.min(1, (v - s.min) / (s.max - s.min)));
            g.beginPath();
            h0.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
            g.lineJoin = "round";
            if (s.dash) {
                g.setLineDash([6 * dpr, 4 * dpr]); g.lineWidth = 1.6 * dpr; g.strokeStyle = mix(ink, 0.8); g.stroke(); g.setLineDash([]);
            } else {
                g.lineWidth = 2.2 * dpr; g.strokeStyle = mix(acc, 1); g.stroke();
                g.lineTo(X(h0.length - 1), bot); g.lineTo(X(0), bot); g.closePath();
                const grad = g.createLinearGradient(0, top, 0, bot);
                grad.addColorStop(0, acc); grad.addColorStop(1, acc);
                g.globalAlpha = 0.22; g.fillStyle = grad; g.fill();
                // Peak: a dotted line across at the highest reading, and a ring on it.
                const pk = Math.max(...h0), pi = h0.lastIndexOf(pk), py = Y(pk);
                g.setLineDash([2 * dpr, 4 * dpr]); g.lineWidth = dpr * 1.4; g.strokeStyle = mix(warn, 0.9);
                g.beginPath(); g.moveTo(0, py); g.lineTo(W, py); g.stroke(); g.setLineDash([]);
                g.globalAlpha = 1; g.lineWidth = 2 * dpr; g.strokeStyle = warn;
                g.beginPath(); g.arc(X(pi), py, 4 * dpr, 0, 7); g.stroke();
            }
            // Latest value: a dot at the right edge.
            g.globalAlpha = 1; g.fillStyle = s.dash ? ink : acc;
            g.beginPath(); g.arc(X(h0.length - 1) - 3 * dpr, Y(h0[h0.length - 1]), 3.4 * dpr, 0, 7); g.fill();
        }
        g.globalAlpha = 1;
    }

    // ---------- Continuous history from iCUE Edge Companion ----------
    // The companion samples CPU and GPU load, RAM and VRAM every 1.5 s without pause, so these graphs stay
    // unbroken while iCUE hides or reloads the widget. RAM and VRAM in GB exist only there (iCUE has no RAM
    // sensor, and its GPU "Frame Buffer" is the memory controller's load). Temperatures stay on iCUE.
    const ENDPOINT = "http://127.0.0.1:47821";
    const FROM_SYS = { cpuLoad: "cpu", gpuLoad: "gpu", ram: "ramGB", vram: "vramGB" };
    let sys = null, sysBusy = false;
    async function pollSys() {
        if (sysBusy) return;
        if (DEMO) {
            const t = Date.now() / 1000, w = (b, a, k) => Array.from({ length: N }, (_, i) => b + a * Math.sin((t + i * 1.5) / k));
            sys = { cpu: w(25, 15, 5), gpu: w(55, 35, 7), ramGB: w(20.9, 1, 9), vramGB: w(9.2, 1, 7), ramTotalGB: 32, vramTotalGB: 16, commitGB: 28, got: Date.now() };
            return;
        }
        sysBusy = true;
        try {
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/system/history`);
            if (data && data.schema === "sys/1" && data.available) sys = { ...data, got: Date.now() };
        } catch (_) { /* companion not running: iCUE's readings fill the graphs while the widget is shown */ }
        sysBusy = false;
    }
    // The companion's series, gaps filled with the reading before them.
    function series(a) {
        const out = [];
        for (const v of a || []) { if (Number.isFinite(v)) out.push(v); else if (out.length) out.push(out[out.length - 1]); }
        return out;
    }
    function withSys(r) {
        const out = { ...r, ram: null, commit: null, vram: null, _sys: {} };
        if (!sys || Date.now() - sys.got > 6000) return out;
        for (const [role, key] of Object.entries(FROM_SYS)) {
            const h = series(sys[key]);
            if (!h.length) continue;
            out._sys[role] = h.slice(-N);
            const units = key.endsWith("GB") ? "GB" : "%";
            out[role] = { ...(r[role] || {}), value: h[h.length - 1], units };
        }
        for (const sec of secs) if (sec.def.key === "mem") {
            if (sys.ramTotalGB) sec.def.series[0].max = Math.max(1, Math.ceil(sys.ramTotalGB));
            if (sys.vramTotalGB) sec.def.series[1].max = Math.max(1, Math.ceil(sys.vramTotalGB));
        }
        if (out.ram) out.ram.device = `${Math.round(sys.ramTotalGB)} GB RAM${sys.vramTotalGB ? ` · ${Math.round(sys.vramTotalGB)} GB VRAM` : ""}`;
        if (Number.isFinite(sys.commitGB)) out.commit = { value: sys.commitGB, units: "GB" };
        return out;
    }

    function render(r) {
        r = withSys(r);
        if (r.plugin === false) {
            $("overlayTitle").textContent = "iCUE sensors not available";
            $("overlaySub").textContent = "This widget reads the iCUE Sensors plugin; it works on the XENEON EDGE inside iCUE.";
            $("overlay").classList.add("visible");
            return;
        }
        $("overlay").classList.remove("visible");
        let found = 0, total = 0, alerts = [];
        for (const sec of secs) {
            let top = "";
            sec.def.series.forEach((s, i) => {
                const row = sec.rows[s.role], m = r[s.role];
                total += s.graph === false ? 0 : 1;
                row.r.hidden = !m && i > 0 && s.graph === false;
                const v = m ? (s.units === "°C" ? celsius(m) : m.value) : NaN;
                row.v.textContent = fmt(v, s);
                row.r.dataset.state = state(s, v);
                if (!Number.isFinite(v)) return;
                if (s.graph !== false) found++;
                if (row.r.dataset.state && s.graph !== false) alerts.push(`${sec.def.name} ${s.heat ? "temp" : s.label.toLowerCase()}`);
                if (s.graph !== false) {
                    const h = sec.hist[s.role];
                    if (r._sys[s.role]) h.splice(0, h.length, ...r._sys[s.role]);
                    else { h.push(v); if (h.length > N) h.shift(); }
                }
            });
            const bm = sec.def.brand.map(k => r[k]).find(m => m && (m.device || m.name));
            if (bm) { sec.dev.textContent = bm.device || bm.name; sec.dev.title = sec.dev.textContent; }
            const p = sec.def.series[0], h = sec.hist[p.role];
            const has = h.length > 0 && Number.isFinite(parseFloat(sec.rows[p.role].v.textContent));
            sec.card.classList.toggle("missing", !has);
            if (h.length) {
                const mn = Math.min(...h), mx = Math.max(...h), av = h.reduce((a, b) => a + b, 0) / h.length;
                sec.sMin.textContent = `min ${fmt(mn, p)}`; sec.sAvg.textContent = `avg ${fmt(av, p)}`; sec.sPeak.textContent = `peak ${fmt(mx, p)}${p.units === "%" ? "%" : p.units === "GB" ? " GB" : ""}`;
            } else {
                sec.sMin.textContent = sec.sAvg.textContent = "";
                sec.sPeak.textContent = sec.def.key === "mem" ? "RAM needs iCUE Edge Companion" : "Not in iCUE";
            }
            sec.canvas.setAttribute("aria-label", `${sec.def.name} history, last 3 minutes`);
            draw(sec);
        }
        $("status").textContent = alerts.length ? `Attention: ${[...new Set(alerts)].join(", ")}` : found ? `${found} of ${total} from iCUE sensors · last 3 min` : "No sensor found in iCUE";
        $("status").classList.toggle("alert", alerts.length > 0);
    }

    let lastSections = null;
    function sync() {
        const k = SECTIONS.map(d => window[d.flag]).join();
        if (k !== lastSections) { lastSections = k; build(); }
    }
    window.icueEvents = { onICUEInitialized: sync, onDataUpdated: sync };
    new ResizeObserver(() => secs.forEach(draw)).observe($("secs"));
    build(); lastSections = SECTIONS.map(d => window[d.flag]).join();
    SensorReader.watch(r => { sync(); pollSys(); render(r); save(); });
})();
