(() => {
    "use strict";

    // Grid Pulse: France's electricity mix and carbon intensity from RTE eco2mix real-time data (ODRE open
    // data, CORS-enabled, no key). The last 24 h of quarter-hours are fetched every 15 min.
    const $ = id => document.getElementById(id);
    const URL_BASE = "https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-national-tr/records";
    const FIELDS = "date_heure,taux_co2,nucleaire,hydraulique,eolien,solaire,bioenergies,gaz,charbon,fioul";
    const SOURCES = [
        ["nucleaire", "Nuclear", "#f2c230"], ["hydraulique", "Hydro", "#2f8fe0"], ["eolien", "Wind", "#3fd0b5"], ["solaire", "Solar", "#ff8a2b"],
        ["bioenergies", "Bio", "#8bc34a"], ["gaz", "Gas", "#e0503f"], ["charbon", "Coal", "#6d4c41"], ["fioul", "Oil", "#9e9e9e"],
    ];
    const NS = "http://www.w3.org/2000/svg";

    /** Verdict for a carbon intensity in g CO2 / kWh (French grid: usually 15 to 120). */
    function level(co2) {
        if (co2 < 35) return ["vlow", "VERY LOW CARBON · RUN IT NOW"];
        if (co2 < 70) return ["low", "LOW CARBON · GOOD TIME"];
        if (co2 < 130) return ["mid", "MODERATE · CAN WAIT"];
        return ["high", "HIGH CARBON · BETTER LATER"];
    }
    /** Shares of the positive production sources, largest first. */
    function shares(rec) {
        const parts = SOURCES.map(([k, name, color]) => ({ k, name, color, v: Math.max(0, Number(rec[k]) || 0) })).filter(p => p.v > 0);
        const total = parts.reduce((a, p) => a + p.v, 0) || 1;
        return parts.map(p => ({ ...p, pct: p.v / total * 100 })).sort((a, b) => b.pct - a.pct);
    }
    /** Share of the last 24 h quarter-hours dirtier than now, as "cleaner than N %". */
    function cleanerThan(series, co2) {
        return series.length ? Math.round(series.filter(v => v > co2).length / series.length * 100) : null;
    }

    function render(records) {
        const rows = records.filter(r => Number.isFinite(Number(r.taux_co2))).sort((a, b) => Date.parse(a.date_heure) - Date.parse(b.date_heure));
        if (!rows.length) throw new Error("no_data");
        const now = rows[rows.length - 1], co2 = Number(now.taux_co2);
        const [lv, verdict] = level(co2);
        $("widget").dataset.level = lv;
        $("verdict").textContent = verdict;
        $("co2").textContent = String(Math.round(co2));
        const series = rows.map(r => Number(r.taux_co2)), better = cleanerThan(series, co2);
        const at = new Date(now.date_heure).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        $("sub").textContent = `France, ${at}` + (better === null ? "" : ` · cleaner than ${better} % of the last 24 h`);
        const mix = shares(now);
        $("bar").replaceChildren(...mix.map(p => { const i = document.createElement("i"); i.style.width = `${p.pct.toFixed(1)}%`; i.style.background = p.color; i.title = p.name; return i; }));
        $("bar").setAttribute("aria-label", mix.map(p => `${p.name} ${Math.round(p.pct)} %`).join(", "));
        $("legend").replaceChildren(...mix.filter(p => p.pct >= 1).map(p => { const li = document.createElement("li"); li.style.setProperty("--c", p.color); li.textContent = `${p.name} ${Math.round(p.pct)} %`; return li; }));
        // Last 24 h: the curve, and the cleanest hour shaded.
        const max = Math.max(...series, 1), min = Math.min(...series);
        const pts = series.map((v, i) => `${(i / Math.max(1, series.length - 1) * 240).toFixed(1)},${(46 - (v - min) / Math.max(1, max - min) * 42).toFixed(1)}`);
        $("line").setAttribute("d", "M" + pts.join("L"));
        let bi = 0;
        for (let i = 0; i + 4 <= series.length; i++) if (series.slice(i, i + 4).reduce((a, b) => a + b) < series.slice(bi, bi + 4).reduce((a, b) => a + b)) bi = i;
        $("best").setAttribute("x", (bi / Math.max(1, series.length - 1) * 240).toFixed(1));
        $("best").setAttribute("width", (4 / Math.max(1, series.length - 1) * 240).toFixed(1));
        const bd = new Date(rows[bi].date_heure);
        const bt = (bd.toDateString() === new Date().toDateString() ? "" : "yesterday ") + bd.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        $("curveTitle").textContent = `LAST 24 H · cleanest hour from ${bt} (${Math.round(Math.min(...series.slice(bi, bi + 4)))} g)`;
        $("overlay").classList.remove("visible");
    }

    function demo() {
        const now = Date.now(), recs = [];
        for (let i = 95; i >= 0; i--) {
            const t = now - i * 900000, h = new Date(t).getHours() + new Date(t).getMinutes() / 60, sun = Math.max(0, Math.sin((h - 7) / 11 * Math.PI));
            recs.push({ date_heure: new Date(t).toISOString(), taux_co2: Math.round(30 + 26 * Math.cos((h - 3) / 24 * 2 * Math.PI) - 12 * sun), nucleaire: 41000, hydraulique: 6000 + 2000 * sun, eolien: 6000, solaire: 9000 * sun, bioenergies: 900, gaz: 3000 + 2500 * (1 - sun), charbon: 0, fioul: 40 });
        }
        render(recs);
    }

    let busy = false;
    async function update() {
        if (/[?&]demo\b/.test(location.search)) return demo();
        if (busy) return;
        busy = true;
        try {
            const url = `${URL_BASE}?select=${encodeURIComponent(FIELDS)}&where=${encodeURIComponent("taux_co2 is not null")}&order_by=${encodeURIComponent("date_heure desc")}&limit=96`;
            const { data } = await WidgetRuntime.requestJson(url, { credentials: "omit" });
            render((data && data.results) || []);
        } catch (_) {
            $("overlay").classList.add("visible");
        } finally { busy = false; }
    }

    window.GridPulse = { level, shares, cleanerThan };
    window.icueEvents = { onICUEInitialized: update, onDataUpdated: () => {} };
    update();
    setInterval(update, 15 * 60000);
    if (window.WidgetRuntime) WidgetRuntime.onResume(update);
})();
