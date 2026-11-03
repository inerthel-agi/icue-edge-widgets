(() => {
    "use strict";

    const ENDPOINT = "http://127.0.0.1:47821";
    const POLL_MS = 1000;
    const HISTORY = 60;   // one reading a second: the last minute
    const TARGETS = ["cloudflare", "google", "quad9", "off"];
    const $ = id => document.getElementById(id);
    const setting = (name, fallback) => (typeof window[name] !== "undefined" && window[name] !== null && window[name] !== "" ? String(window[name]) : fallback);
    const down = [], up = [];
    let request = null, last = 0, demoT = 0;

    // Bytes per second to a short figure and its unit, in bits (Mbit/s) or bytes (MB/s).
    function fmt(bps, bits) {
        const v = bits ? bps * 8 : bps;
        const units = bits ? ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"] : ["B/s", "kB/s", "MB/s", "GB/s"];
        let i = 0, n = v;
        while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
        return [n >= 100 || i === 0 ? String(Math.round(n)) : n.toFixed(1), units[i]];
    }

    function path(values, max) {
        const pts = values.map((v, i) => `${(600 - (values.length - 1 - i) * (600 / (HISTORY - 1))).toFixed(1)},${(196 - v / max * 186).toFixed(1)}`);
        return pts.length < 2 ? ["", ""] : [`M${pts.join("L")}`, `M${pts[0].split(",")[0]},200L${pts.join("L")}L600,200Z`];
    }

    function render(s) {
        const bits = setting("netUnits", "bits") !== "bytes";
        for (const [list, v] of [[down, s.downBps], [up, s.upBps]]) { list.push(Number(v) || 0); if (list.length > HISTORY) list.shift(); }
        const [dv, du] = fmt(s.downBps || 0, bits), [uv, uu] = fmt(s.upBps || 0, bits);
        $("down").textContent = dv; $("downUnit").textContent = du;
        $("up").textContent = uv; $("upUnit").textContent = uu;
        $("adapter").textContent = s.adapter || "Network";
        // Both lines share one scale so their heights compare; never below 1 Mbit/s so idle noise stays flat.
        const max = Math.max(125000, ...down, ...up) * 1.15;
        const [ld, ad] = path(down, max), [lu, au] = path(up, max);
        $("lineDown").setAttribute("d", ld); $("areaDown").setAttribute("d", ad);
        $("lineUp").setAttribute("d", lu); $("areaUp").setAttribute("d", au);
        const ping = $("ping"), target = setting("pingTarget", "cloudflare");
        ping.hidden = target === "off";
        ping.textContent = typeof s.pingMs === "number" ? `Ping ${s.pingMs} ms` : s.pingLost ? "Ping lost" : "Ping --";
        ping.className = `x-badge ping ${typeof s.pingMs !== "number" ? (s.pingLost ? "bad" : "") : s.pingMs > 100 ? "bad" : s.pingMs > 40 ? "warn" : "ok"}`;
        const [mv, mu] = fmt(max / 1.15, bits);
        $("status").textContent = `Last minute · scale ${mv} ${mu}`;
    }

    function demo() {
        demoT += 1;
        const burst = Math.max(0, Math.sin(demoT / 7)) ** 3;
        return { schema: "net/1", available: true, adapter: "Ethernet", downBps: 180000 + burst * 9e6 + Math.random() * 90000, upBps: 40000 + Math.random() * 60000 + (demoT % 20 < 4 ? 1.8e6 : 0), pingMs: 12 + Math.round(Math.random() * 6) };
    }

    function show(title, sub) {
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    async function update() {
        if (/[?&]demo\b/.test(location.search)) {
            // The preview starts with a full minute so the chart is not empty.
            while (down.length < HISTORY - 1) { const s = demo(); down.push(s.downBps); up.push(s.upBps); }
            render(demo());
            return;
        }
        if (request) request.abort();
        request = new AbortController();
        const target = setting("pingTarget", "cloudflare");
        try {
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/net/state?ping=${TARGETS.includes(target) ? target : "off"}`, { signal: request.signal });
            if (!data || data.schema !== "net/1") throw new Error("unknown_version");
            if (!data.available) { show("No network counters", "Windows did not give the adapters' byte counters."); return; }
            last = Date.now();
            $("overlay").classList.remove("visible");
            render(data);
        } catch (error) {
            if (error && error.name === "AbortError") return;
            if (!last || Date.now() - last > 10000) show("Companion offline", "Start iCUE Edge Companion; it reads the network counters of this PC.");
        }
    }

    window.icueEvents = { onICUEInitialized: update, onDataUpdated: () => { down.length = 0; up.length = 0; update(); } };
    WidgetRuntime.onResume(update);
    setInterval(update, POLL_MS);
    update();
})();
