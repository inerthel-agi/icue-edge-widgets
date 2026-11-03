(() => {
    "use strict";

    const POLL_MS = 15 * 60 * 1000;
    const $ = id => document.getElementById(id);
    const canvas = $("scene"), ctx = canvas.getContext("2d");
    const params = new URLSearchParams(location.search);
    const DEMO = params.get("demo");
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const setting = (name, fallback) => (typeof window[name] === "string" && window[name].trim() ? window[name].trim() : fallback);

    // Open-Meteo weather codes to a scene.
    function sceneFor(code) {
        if (code >= 95) return ["storm", "Thunderstorm"];
        if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ["snow", "Snow"];
        if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return ["rain", code >= 63 && code !== 80 ? "Heavy rain" : code >= 61 || code >= 80 ? "Rain" : "Drizzle"];
        if (code === 45 || code === 48) return ["fog", "Fog"];
        if (code === 2 || code === 3) return ["cloudy", code === 3 ? "Overcast" : "Partly cloudy"];
        return ["clear", code === 1 ? "Mainly clear" : "Clear"];
    }

    let W = 0, H = 0, dpr = 1;
    let scene = "rain", night = false;
    let beads = [], falls = [], flakes = [], stars = [], clouds = [], flash = 0;
    const rnd = (a, b) => a + Math.random() * (b - a);

    function resize() {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        W = canvas.clientWidth; H = canvas.clientHeight;
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        populate();
    }

    function populate() {
        const area = W * H / 100000;
        const heavy = scene === "storm" ? 1.6 : 1;
        beads = scene === "rain" || scene === "storm" ? Array.from({ length: Math.round(area * 26 * heavy) }, bead) : [];
        falls = scene === "rain" || scene === "storm" ? Array.from({ length: Math.round(area * 40 * heavy) }, () => ({ x: rnd(0, W), y: rnd(0, H), l: rnd(10, 26), v: rnd(9, 15) })) : [];
        flakes = scene === "snow" ? Array.from({ length: Math.round(area * 40) }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(1, 3.6), v: rnd(0.4, 1.3), p: rnd(0, 6) })) : [];
        stars = night ? Array.from({ length: Math.round(area * 30) }, () => ({ x: rnd(0, W), y: rnd(0, H * 0.7), r: rnd(0.4, 1.4), p: rnd(0, 6) })) : [];
        clouds = Array.from({ length: scene === "clear" ? 2 : scene === "cloudy" ? 7 : 5 }, () => ({ x: rnd(-0.2, 1) * W, y: rnd(0.05, 0.45) * H, s: rnd(0.6, 1.3), v: rnd(0.05, 0.18) }));
    }

    function bead() { const k = Math.max(1, Math.min(W, H) / 500); return { x: rnd(0, W), y: rnd(0, H), r: rnd(2, 6.5) * k, slide: 0, trail: [] }; }

    const SKY = {
        day: { clear: ["#3f8fd8", "#a9d4f5"], cloudy: ["#7d8c9c", "#c3ccd5"], rain: ["#4b5866", "#8b97a3"], storm: ["#2c333d", "#5b6470"], snow: ["#9aa6b2", "#dfe5ea"], fog: ["#9ba3a8", "#cfd4d6"] },
        night: { clear: ["#050a1a", "#1b2950"], cloudy: ["#0d1119", "#252c38"], rain: ["#0a0e14", "#1f2630"], storm: ["#05070b", "#161b24"], snow: ["#141a26", "#323b4c"], fog: ["#151719", "#2b2f33"] },
    };

    function backdrop(t) {
        const [a, b] = SKY[night ? "night" : "day"][scene];
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, a); g.addColorStop(1, b);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        for (const s of stars) { ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t / 900 + s.p); ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill(); }
        ctx.globalAlpha = 1;
        if (scene === "clear") {
            const x = W * 0.78, y = H * 0.24, r = Math.min(W, H) * (night ? 0.07 : 0.09);
            const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 4);
            glow.addColorStop(0, night ? "rgba(230,236,255,.35)" : "rgba(255,240,190,.7)"); glow.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = night ? "#eef1ff" : "#fff6d8"; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
            if (night) { ctx.fillStyle = SKY.night.clear[0]; ctx.beginPath(); ctx.arc(x + r * 0.45, y - r * 0.2, r * 0.9, 0, 7); ctx.fill(); }
        }
        // Each cloud is one soft shape: its puffs are filled together so they do not darken where they overlap.
        const k = Math.min(W, H) / 700;
        ctx.filter = `blur(${Math.round(6 * k + 2)}px)`;
        ctx.fillStyle = night ? "rgba(70,80,96,.5)" : scene === "clear" ? "rgba(255,255,255,.8)" : "rgba(214,220,228,.5)";
        for (const c of clouds) {
            c.x += c.v; if (c.x > W + 300 * k) c.x = -300 * k;
            ctx.beginPath();
            for (const [dx, dy, r] of [[0, 0, 60], [55, -22, 50], [105, 2, 54], [48, 16, 52]]) { ctx.moveTo(c.x + (dx + r * 1.5) * c.s * k, c.y + dy * c.s * k); ctx.ellipse(c.x + dx * c.s * k, c.y + dy * c.s * k, r * c.s * k * 1.5, r * c.s * k, 0, 0, 7); }
            ctx.fill();
        }
        ctx.filter = "none";
        // Rooftops on the horizon, with a few lit windows at night.
        ctx.fillStyle = night ? "#06080c" : "rgba(30,38,48,.85)";
        ctx.beginPath(); ctx.moveTo(0, H);
        let x = 0; const seed = 7;
        for (let i = 0; x < W; i++) { const w = ((i * seed) % 5 + 3) * W / 60, h = ((i * 13) % 7 + 4) * H / 60; ctx.lineTo(x, H - h); ctx.lineTo(x + w, H - h); x += w; }
        ctx.lineTo(W, H); ctx.fill();
        if (night) { ctx.fillStyle = "rgba(255,200,120,.75)"; for (let i = 0; i < 30; i++) ctx.fillRect(((i * 97) % 100) / 100 * W, H - (((i * 31) % 6) + 2) * H / 70, W / 260, H / 160); }
        if (scene === "fog") { const f = ctx.createLinearGradient(0, H * 0.3, 0, H); f.addColorStop(0, "rgba(220,224,226,0)"); f.addColorStop(1, night ? "rgba(90,96,100,.85)" : "rgba(225,228,230,.9)"); ctx.fillStyle = f; ctx.fillRect(0, 0, W, H); }
    }

    function frame(t) {
        backdrop(t);
        if (falls.length) {
            ctx.strokeStyle = night ? "rgba(170,190,215,.35)" : "rgba(235,242,250,.45)"; ctx.lineWidth = 1;
            ctx.beginPath();
            for (const f of falls) { f.y += f.v; f.x -= f.v * 0.12; if (f.y > H) { f.y = -f.l; f.x = rnd(0, W * 1.1); } ctx.moveTo(f.x, f.y); ctx.lineTo(f.x + f.l * 0.12, f.y - f.l); }
            ctx.stroke();
        }
        for (const b of beads) {
            // Now and then a bead runs down the glass and leaves a short wet trail.
            if (!b.slide && Math.random() < 0.0009 * b.r) b.slide = rnd(1.5, 4);
            if (b.slide) { b.trail.push([b.x, b.y]); if (b.trail.length > 18) b.trail.shift(); b.y += b.slide; b.x += rnd(-0.6, 0.6); if (b.y > H + 10) Object.assign(b, bead(), { y: rnd(-20, H * 0.3) }); }
            if (b.trail.length > 1) { ctx.strokeStyle = "rgba(255,255,255,.12)"; ctx.lineWidth = b.r * 0.9; ctx.beginPath(); ctx.moveTo(...b.trail[0]); for (const p of b.trail) ctx.lineTo(...p); ctx.stroke(); }
            const g = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.4, 0, b.x, b.y, b.r);
            g.addColorStop(0, "rgba(255,255,255,.8)"); g.addColorStop(0.4, "rgba(255,255,255,.18)"); g.addColorStop(1, "rgba(0,0,0,.28)");
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
        }
        if (flakes.length) {
            ctx.fillStyle = "rgba(255,255,255,.9)";
            for (const f of flakes) { f.y += f.v; f.x += Math.sin(t / 1400 + f.p) * 0.5; if (f.y > H) { f.y = -4; f.x = rnd(0, W); } ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, 7); ctx.fill(); }
        }
        if (scene === "storm") {
            if (flash <= 0 && Math.random() < 0.004) flash = 1;
            if (flash > 0) { ctx.fillStyle = `rgba(230,236,255,${flash * 0.55})`; ctx.fillRect(0, 0, W, H); flash -= 0.06; }
        }
    }

    let lastDraw = 0;
    function loop(t) {
        // About 30 frames a second is enough for rain and halves the work.
        if (t - lastDraw > 30) { lastDraw = t; frame(t); }
        if (!still) requestAnimationFrame(loop);
    }

    function setScene(next, isNight) {
        if (next === scene && isNight === night && beads.length + falls.length + flakes.length + clouds.length) return;
        scene = next; night = isNight;
        $("widget").dataset.sky = night ? "night" : "day";
        populate();
        if (still) frame(0);
    }

    function clock() {
        $("time").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    }

    function show(title, sub) { $("overlayTitle").textContent = title; $("overlaySub").textContent = sub; $("overlay").classList.add("visible"); }

    let request = null, failures = 0, retry = 0;
    async function update() {
        const skyParam = params.get("sky");
        if (DEMO && DEMO !== "live") {
            const sc = ["rain", "storm", "snow", "clear", "cloudy", "fog"].includes(DEMO) ? DEMO : "rain";
            const isNight = skyParam ? skyParam === "night" : new Date().getHours() < 7 || new Date().getHours() >= 20;
            setScene(sc, isNight);
            $("temp").textContent = { rain: 11, storm: 17, snow: -2, clear: 22, cloudy: 14, fog: 6 }[sc];
            $("cond").textContent = { rain: "Rain", storm: "Thunderstorm", snow: "Snow", clear: "Clear", cloudy: "Overcast", fog: "Fog" }[sc];
            $("place").textContent = "Paris, FR";
            return;
        }
        const city = setting("weatherCity", "Paris"), fahrenheit = setting("weatherUnits", "celsius") === "fahrenheit";
        if (request) request.abort();
        request = new AbortController();
        clearTimeout(retry);
        try {
            const geo = (await WidgetRuntime.requestJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`, { signal: request.signal })).data;
            const loc = geo.results && geo.results[0];
            if (!loc) { show("City not found", city); return; }
            const url = new URL("https://api.open-meteo.com/v1/forecast");
            url.searchParams.set("latitude", loc.latitude); url.searchParams.set("longitude", loc.longitude);
            url.searchParams.set("timezone", "auto"); url.searchParams.set("current", "temperature_2m,weather_code,is_day");
            url.searchParams.set("temperature_unit", fahrenheit ? "fahrenheit" : "celsius");
            const cur = (await WidgetRuntime.requestJson(url, { signal: request.signal })).data.current;
            if (!cur || !Number.isFinite(cur.temperature_2m)) throw new Error("invalid_weather");
            const [sc, label] = sceneFor(cur.weather_code);
            setScene(sc, skyParam ? skyParam === "night" : cur.is_day === 0);
            $("temp").textContent = Math.round(cur.temperature_2m);
            $("unit").textContent = fahrenheit ? "°F" : "°C";
            $("cond").textContent = label;
            $("place").textContent = `${loc.name}${loc.country_code ? `, ${loc.country_code}` : ""}`;
            $("overlay").classList.remove("visible");
            failures = 0;
        } catch (error) {
            if (error && error.name === "AbortError") return;
            failures++;
            retry = setTimeout(update, Math.min(300000, 15000 * 2 ** Math.min(failures - 1, 4)));
            if (!$("place").textContent) show("Weather offline", "Retrying automatically.");
        }
    }

    window.icueEvents = { onICUEInitialized: update, onDataUpdated: update };
    new ResizeObserver(resize).observe(canvas);
    WidgetRuntime.onResume(update);
    resize();
    clock();
    setInterval(clock, 5000);
    setInterval(update, POLL_MS);
    update();
    requestAnimationFrame(loop);
})();
