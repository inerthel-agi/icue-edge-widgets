(() => {
    "use strict";

    // Energy Cost: CPU + GPU power from iCUE sensors plus a fixed "rest of the PC", integrated over time
    // into watt-hours per hour of today and per day (last 62 days), then priced at the user's rate.
    const $ = id => document.getElementById(id);
    const NS = "http://www.w3.org/2000/svg";
    const MAX_GAP_MS = 10000;   // a longer gap (sleep, widget hidden) is not counted: nothing measured it
    const store = window.WidgetRuntime ? window.WidgetRuntime.storage("energy-cost", "energy-cost") : null;

    const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

    /** Adds `watts` measured since state.last to the hour and day it fell in. Pure: returns the new state. */
    function account(state, watts, now) {
        const s = state && state.day ? { ...state, hours: state.hours.slice(), days: { ...state.days } } : { day: dayKey(now), hours: Array(24).fill(0), days: {}, last: 0 };
        if (s.day !== dayKey(now)) { s.day = dayKey(now); s.hours = Array(24).fill(0); }
        const gap = s.last ? now - s.last : 0;
        if (gap > 0 && gap <= MAX_GAP_MS && Number.isFinite(watts) && watts > 0) {
            const wh = watts * gap / 3600000;
            s.hours[new Date(now).getHours()] += wh;
            s.days[s.day] = (s.days[s.day] || 0) + wh;
        }
        s.last = now;
        const keep = Object.keys(s.days).sort().slice(-62);
        s.days = Object.fromEntries(keep.map(k => [k, s.days[k]]));
        return s;
    }

    /** Today's, this month's and the projected month's cost, from watt-hours and a price per kWh. */
    function costs(state, price, now) {
        const d = new Date(now), month = dayKey(now).slice(0, 7);
        const todayWh = state.days[dayKey(now)] || 0;
        const monthWh = Object.entries(state.days).filter(([k]) => k.startsWith(month)).reduce((a, [, v]) => a + v, 0);
        const daysIn = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        // Days actually measured this month (today as its elapsed fraction), not calendar days since the 1st.
        const measured = Object.keys(state.days).filter(k => k.startsWith(month))
            .reduce((n, k) => n + (k === dayKey(now) ? (d.getHours() * 60 + d.getMinutes()) / 1440 : 1), 0);
        const projected = measured > 0.5 ? monthWh / measured * daysIn : null;
        const eur = wh => wh / 1000 * price;
        return { today: eur(todayWh), todayKwh: todayWh / 1000, month: eur(monthWh), projected: projected === null ? null : eur(projected) };
    }

    const setting = (name, def) => (typeof window[name] !== "undefined" && window[name] !== null && window[name] !== "" ? window[name] : def);
    function price() {
        const p = Number.parseFloat(String(setting("energyPrice", "0.25")).replace(",", "."));
        return Number.isFinite(p) && p >= 0 && p < 10 ? p : 0.25;
    }
    const base = () => { const b = Number(setting("energyBase", 60)); return Number.isFinite(b) ? Math.max(0, Math.min(300, b)) : 60; };
    const currency = () => { const c = String(setting("energyCurrency", "€")); return ["€", "$", "£", "CHF"].includes(c) ? c : "€"; };
    function money(v) {
        const c = currency(), n = v < 10 ? v.toFixed(2) : v.toFixed(1);
        return c === "€" || c === "CHF" ? `${n} ${c}` : `${c}${n}`;
    }

    let state = (() => { try { const s = store && store.read(); return s && s.day && Array.isArray(s.hours) ? { ...s, last: 0 } : null; } catch (_) { return null; } })();
    let lastSave = 0;
    // ?demo: a made-up day and month so the preview shows bars and a projection.
    if (/[?&]demo\b/.test(location.search)) {
        const now = Date.now(), d = new Date(now), days = {};
        for (let i = 1; i < d.getDate(); i++) days[dayKey(new Date(d.getFullYear(), d.getMonth(), i))] = 1400 + (i * 397) % 900;
        const hours = Array.from({ length: 24 }, (_, h) => (h <= d.getHours() ? [0, 0, 0, 0, 0, 0, 0, 0, 40, 90, 110, 120, 80, 95, 130, 140, 150, 210, 320, 360, 380, 300, 180, 60][h] : 0));
        days[dayKey(now)] = hours.reduce((a, b) => a + b, 0);
        state = { day: dayKey(now), hours, days, last: 0 };
    }

    const bars = [];
    for (let i = 0; i < 24; i++) {
        const r = document.createElementNS(NS, "rect");
        r.setAttribute("x", String(i * 10 + 1)); r.setAttribute("width", "8");
        $("bars").append(r);
        bars.push(r);
    }

    // Mechanical counter: five drums, the last two (hundredths) in red as on a real meter.
    const drums = [];
    for (let i = 0; i < 5; i++) {
        const d = document.createElement("span");
        d.className = "drum" + (i >= 3 ? " frac" : "");
        const reel = document.createElement("span");
        reel.className = "reel";
        reel.textContent = "0 1 2 3 4 5 6 7 8 9 0";
        d.append(reel);
        $("odo").append(d);
        if (i === 2) { const dot = document.createElement("span"); dot.className = "dot"; dot.textContent = ","; $("odo").append(dot); }
        drums.push(reel);
    }
    function odometer(kwh) {
        const v = Math.min(99999, Math.max(0, kwh * 100));   // hundredths of a kWh
        drums.forEach((reel, i) => {
            const place = 10 ** (4 - i), digit = Math.floor(v / place) % 10;
            const pos = digit;   // snapped: a drum caught between two digits is unreadable at a glance
            reel.style.transform = `translateY(${(-pos * 10 / 11 * 100 / 10).toFixed(3)}%)`;
        });
    }

    function render(r) {
        const now = Date.now();
        if (r.plugin === false) {
            $("overlayTitle").textContent = "iCUE sensors not available";
            $("overlaySub").textContent = "This widget reads the iCUE Sensors plugin; it works inside iCUE.";
            $("overlay").classList.add("visible");
            return;
        }
        $("overlay").classList.remove("visible");
        const cpu = r.cpuPower ? r.cpuPower.value : null, gpu = r.gpuPower ? r.gpuPower.value : null;
        const measured = cpu !== null || gpu !== null;
        const watts = measured ? (cpu || 0) + (gpu || 0) + base() : NaN;
        state = account(state, watts, now);
        if (store && now - lastSave > 30000) { store.write(state); lastSave = now; }
        const c = costs(state, price(), now);
        $("today").textContent = money(c.today);
        $("todaySub").textContent = "spent today";
        odometer(c.todayKwh);
        // The disc turns like a real meter's: faster with more watts (one turn per 4 s at 300 W).
        document.documentElement.style.setProperty("--turn", measured && watts > 0 ? `${Math.min(60, 1200 / watts).toFixed(2)}s` : "0s");
        document.documentElement.classList.toggle("idle", !measured);
        $("watts").textContent = measured ? String(Math.round(watts)) : "--";
        $("parts").textContent = measured ? [cpu !== null && `CPU ${Math.round(cpu)}`, gpu !== null && `GPU ${Math.round(gpu)}`, `rest ${base()}`].filter(Boolean).join(" · ") : "No power sensor in iCUE";
        $("month").textContent = `${money(c.month)} this month` + (c.projected !== null ? ` · ≈ ${money(c.projected)} by the end` : "");
        $("status").textContent = `${price()} ${currency()}/kWh`;
        const max = Math.max(...state.hours, 1), hour = new Date(now).getHours();
        bars.forEach((b, i) => {
            const h = Math.max(state.hours[i] ? 1.5 : 0.6, state.hours[i] / max * 58);
            b.setAttribute("y", (60 - h).toFixed(1)); b.setAttribute("height", h.toFixed(1));
            b.setAttribute("class", i === hour ? "now" : state.hours[i] ? "on" : "");
        });
    }

    window.addEventListener("pagehide", () => { if (store && state) store.write(state); });
    window.EnergyCost = { account, costs };
    window.icueEvents = { onICUEInitialized: () => {}, onDataUpdated: () => {} };
    if (window.SensorReader) SensorReader.watch(render);
})();
