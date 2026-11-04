(() => {
    "use strict";

    // Six faces for the round pump LCD (480 x 480, no touch), drawn on one canvas.
    // Data: iCUE sensors through shared/sensor-reader.js (liquid, pump, CPU, GPU, FPS) and, for Vinyl,
    // the playing track from iCUE Edge Companion. ?demo (or ?demo=hot / ?demo=game) gives made-up values;
    // ?face=<key> picks a face outside iCUE.
    const TAU = Math.PI * 2, C = 240;
    const ENDPOINT = document.body.dataset.endpoint;
    const params = new URLSearchParams(location.search);
    const g = document.getElementById("face").getContext("2d");
    const FACES = ["tank", "aquarium", "iris", "chrono", "vinyl", "sky", "hearth", "carousel"];
    const MASCOTS = ["clawd", "clippy", "xiaohei"];
    const ROTATION = ["tank", "chrono", "iris", "aquarium", "sky", "hearth", "vinyl"];

    const lerp = (a, b, k) => a + (b - a) * k;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const num = (name, def, lo, hi) => { const v = Number(typeof window[name] !== "undefined" ? window[name] : NaN); return Number.isFinite(v) ? clamp(v, lo, hi) : def; };
    const setting = {
        face: () => { const f = params.get("face") || (typeof pumpFace !== "undefined" ? String(pumpFace) : ""); return FACES.includes(f) ? f : "tank"; },
        mascot: () => { const m = typeof pumpMascot !== "undefined" ? String(pumpMascot) : ""; return MASCOTS.includes(m) ? m : "clawd"; },
        alert: () => num("pumpAlert", 42, 30, 60),
        room: () => num("pumpRoom", 24, 10, 40),
        every: () => num("pumpEvery", 8, 3, 60),
        game: () => typeof pumpGame === "undefined" || pumpGame !== false,
    };

    // ---------- Data ----------
    const toC = r => r && (/f/i.test(r.units) && !/c/i.test(r.units) ? (r.value - 32) * 5 / 9 : r.value);
    let sensors = { plugin: true };
    let shown = null; // eased values, so needles and waves glide between 1.5 s readings
    window.SensorReader.watch(r => { sensors = r; });

    function data() {
        const s = sensors, liquid = toC(s.liquid), cpuT = toC(s.cpuTemp), gpuT = toC(s.gpuTemp);
        const target = {
            main: liquid != null ? liquid : cpuT,
            mainLabel: liquid != null ? "LIQUID" : "CPU",
            air: s.air ? toC(s.air) : setting.room(),
            pump: s.pump ? s.pump.value : null,
            cpu: s.cpuLoad ? s.cpuLoad.value / 100 : null,
            cpuT, gpuT, liquid,
            fps: s.fps && s.fps.value > 0 ? s.fps.value : null,
        };
        if (!shown) shown = { ...target };
        for (const k of Object.keys(target)) {
            const v = target[k];
            shown[k] = typeof v === "number" && typeof shown[k] === "number" ? lerp(shown[k], v, 0.08) : v;
        }
        shown.plugin = s.plugin !== false;
        return shown;
    }

    // ---------- Colours ----------
    let palette = { text: "#f2f3ed", accent: "#ff9a3c", bg: "#080a0b" };
    function readPalette() {
        const css = getComputedStyle(document.documentElement);
        const pick = (token, def) => (css.getPropertyValue(token) || "").trim() || def;
        palette = { text: pick("--x-text", "#f2f3ed"), accent: pick("--x-accent", "#ff9a3c"), bg: pick("--x-bg", "#080a0b") };
    }
    readPalette();
    setInterval(readPalette, 1000);
    // Cold blue to hot red through violet, never green.
    function tempColor(v, lo, hi) {
        if (v == null) return "rgb(110,120,130)";
        return `hsl(${lerp(205, 360, clamp((v - lo) / (hi - lo), 0, 1))} 85% 55%)`;
    }

    // ---------- Drawing helpers ----------
    function begin(fill) {
        g.save(); g.beginPath(); g.arc(C, C, 240, 0, TAU); g.clip();
        if (fill) { g.fillStyle = fill; g.fillRect(0, 0, 480, 480); }
    }
    function text(s, x, y, size, alpha = 1, weight = 700, color = palette.text) {
        g.globalAlpha = alpha; g.fillStyle = color; g.font = `${weight} ${size}px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif`;
        g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(s, x, y); g.globalAlpha = 1;
    }
    const fmt = (v, digits = 0) => (v == null ? "--" : v.toFixed(digits));
    function alertRing(d, t) {
        if (d.main == null || d.main < setting.alert()) return;
        g.strokeStyle = `rgba(255,40,40,${0.45 + 0.45 * Math.sin(t * 6)})`; g.lineWidth = 18;
        g.beginPath(); g.arc(C, C, 231, 0, TAU); g.stroke();
    }
    function wave(level, t, color, amp, alpha) {
        g.globalAlpha = alpha; g.fillStyle = color; g.beginPath(); g.moveTo(0, 480);
        for (let x = 0; x <= 480; x += 8) g.lineTo(x, level + amp * Math.sin(x / 55 + t * 2) + amp * 0.5 * Math.sin(x / 23 - t * 3));
        g.lineTo(480, 480); g.fill(); g.globalAlpha = 1;
    }
    const bubbles = Array.from({ length: 26 }, () => ({ x: 60 + Math.random() * 360, y: Math.random() * 480, r: 2 + Math.random() * 5, s: 0.5 + Math.random() }));
    function drawBubbles(speed, top) {
        g.fillStyle = "rgba(255,255,255,.35)";
        for (const b of bubbles) {
            b.y -= b.s * speed;
            if (b.y < top) { b.y = 480 + b.r; b.x = 60 + Math.random() * 360; }
            g.beginPath(); g.arc(b.x + 3 * Math.sin(b.y / 20), b.y, b.r, 0, TAU); g.fill();
        }
    }
    const pumpSpeed = d => (d.pump != null ? clamp(d.pump / 1000, 0.5, 4) : 1.5);

    // ---------- Faces ----------
    function tank(t, d) {
        begin(palette.bg);
        const col = tempColor(d.main, 28, setting.alert() + 4), level = 175;
        wave(level + 8, t + 1, col, 9, 0.35);
        wave(level, t, col, 10, 0.75);
        drawBubbles(pumpSpeed(d), level);
        text(d.main == null ? "--" : d.main.toFixed(1) + "°", C, 250, 104);
        text(d.mainLabel, C, 312, 20, 0.75, 600);
        const parts = [];
        if (d.liquid != null) parts.push(`Δ air +${fmt(d.liquid - d.air, 1)}°`);
        if (d.pump != null) parts.push(`${Math.round(d.pump)} rpm`);
        text(parts.join("   ·   ") || (d.plugin ? "" : "Sensors plugin missing"), C, 360, 22, 0.85, 600);
        text(d.main != null && d.main >= setting.alert() ? "TOO HOT" : "PUMP", C, 110, 20, 0.6, 600);
        alertRing(d, t); g.restore();
    }

    // Every mascot is loaded and decoded at start: decoding a sheet on the first Aquarium frame left the tank empty for a while.
    const sheets = {};
    for (const name of MASCOTS) {
        const img = new Image();
        img.src = `./pet-${name}.webp`;
        if (img.decode) img.decode().catch(() => {});
        sheets[name] = img;
    }
    const sheet = name => sheets[name];
    function aquarium(t, d) {
        begin();
        const grad = g.createLinearGradient(0, 0, 0, 480);
        grad.addColorStop(0, "#0a3a5a"); grad.addColorStop(1, "#021320");
        g.fillStyle = grad; g.fillRect(0, 0, 480, 480);
        wave(40, t, "rgba(255,255,255,.08)", 6, 1);
        drawBubbles(pumpSpeed(d) * 0.7, 30);
        const name = setting.mascot(), img = sheet(name);
        const hot = d.main != null && d.main >= setting.alert() - 2;
        const y = 205 + 12 * Math.sin(t * 1.5);
        if (img.complete && img.naturalWidth) {
            const cw = img.naturalWidth / 8, ch = cw * 208 / 192, row = 0, frames = 6;
            const f = Math.floor(t * 6) % frames, w = 230, h = w * 208 / 192;
            g.imageSmoothingEnabled = name !== "clawd";
            g.drawImage(img, f * cw, row * ch, cw, ch, C - w / 2, y - h / 2, w, h);
        }
        if (hot) {
            g.fillStyle = "#7fd4ff";
            for (let i = 0; i < 3; i++) { const k = (t * 1.2 + i / 3) % 1; g.beginPath(); g.arc(C + 70 + i * 12, y - 80 + k * 60, 6, 0, TAU); g.fill(); }
        }
        text(d.main == null ? "--" : `${d.main.toFixed(1)}° ${d.mainLabel.toLowerCase()}`, C, 400, 30, 0.95);
        alertRing(d, t); g.restore();
    }

    function iris(t, d) {
        begin(palette.bg);
        const col = tempColor(d.gpuT, 40, 85);
        g.strokeStyle = col; g.lineWidth = 3;
        for (let i = 0; i < 60; i++) {
            const a = i / 60 * TAU + t * 0.05;
            g.globalAlpha = 0.25 + 0.35 * ((i * 7) % 5) / 5;
            g.beginPath(); g.moveTo(C + Math.cos(a) * 80, C + Math.sin(a) * 80); g.lineTo(C + Math.cos(a) * 200, C + Math.sin(a) * 200); g.stroke();
        }
        g.globalAlpha = 1; g.lineWidth = 6; g.beginPath(); g.arc(C, C, 204, 0, TAU); g.stroke();
        const pr = lerp(40, 150, clamp(d.cpu == null ? 0.3 : d.cpu, 0, 1));
        const pg = g.createRadialGradient(C, C, pr * 0.6, C, C, pr);
        pg.addColorStop(0, "#000"); pg.addColorStop(1, "rgba(0,0,0,.85)");
        g.fillStyle = pg; g.beginPath(); g.arc(C, C, pr, 0, TAU); g.fill();
        g.fillStyle = "rgba(255,255,255,.7)"; g.beginPath(); g.arc(C - pr * 0.35, C - pr * 0.35, Math.max(6, pr * 0.12), 0, TAU); g.fill();
        text(d.cpu == null ? "--" : Math.round(d.cpu * 100) + "%", C, C + 4, 40, 0.9);
        text(`CPU · GPU ${fmt(d.gpuT)}°`, C, C + 40, 16, 0.7, 600);
        g.restore();
    }

    function dial(x, y, r, k, label, value, color) {
        g.lineWidth = 8; g.lineCap = "butt";
        g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.arc(x, y, r, 0.75 * Math.PI, 2.25 * Math.PI); g.stroke();
        g.strokeStyle = color; g.beginPath(); g.arc(x, y, r, 0.75 * Math.PI, (0.75 + 1.5 * clamp(k, 0, 1)) * Math.PI); g.stroke();
        text(value, x, y + 2, 26); text(label, x, y + r + 4, 14, 0.6, 600);
    }
    function chrono(t, d) {
        begin(palette.bg);
        for (let i = 0; i < 60; i++) {
            const a = i / 60 * TAU, big = i % 5 === 0;
            g.strokeStyle = big ? palette.text : "rgba(255,255,255,.3)"; g.lineWidth = big ? 4 : 2;
            g.beginPath(); g.moveTo(C + Math.cos(a) * (big ? 200 : 210), C + Math.sin(a) * (big ? 200 : 210)); g.lineTo(C + Math.cos(a) * 222, C + Math.sin(a) * 222); g.stroke();
        }
        const deg = v => (v == null ? "--" : Math.round(v) + "°");
        dial(C, 135, 46, ((d.cpuT || 30) - 30) / 60, "CPU", deg(d.cpuT), tempColor(d.cpuT, 40, 85));
        dial(140, 290, 46, ((d.gpuT || 30) - 30) / 60, "GPU", deg(d.gpuT), tempColor(d.gpuT, 40, 85));
        dial(340, 290, 46, ((d.liquid || 25) - 25) / 25, "LIQUID", deg(d.liquid), tempColor(d.liquid, 28, setting.alert() + 4));
        const now = new Date(), s = now.getSeconds() + now.getMilliseconds() / 1000, m = now.getMinutes() + s / 60, h = now.getHours() % 12 + m / 60;
        const hand = (a, len, w, c) => { g.strokeStyle = c; g.lineWidth = w; g.lineCap = "round"; g.beginPath(); g.moveTo(C, C); g.lineTo(C + Math.sin(a) * len, C - Math.cos(a) * len); g.stroke(); };
        hand(h / 12 * TAU, 110, 10, palette.text); hand(m / 60 * TAU, 170, 6, palette.text); hand(s / 60 * TAU, 190, 2, palette.accent);
        g.fillStyle = palette.accent; g.beginPath(); g.arc(C, C, 8, 0, TAU); g.fill();
        alertRing(d, t); g.restore();
    }

    let angle = 0, lastT = 0;
    function vinyl(t) {
        begin(palette.bg);
        const m = media.now;
        if (m && m.playing) angle += (t - lastT) * 0.9;
        lastT = t;
        g.save(); g.translate(C, C); g.rotate(angle);
        g.fillStyle = "#16171a"; g.beginPath(); g.arc(0, 0, 225, 0, TAU); g.fill();
        g.lineWidth = 1;
        for (let r = 120; r < 222; r += 5) { g.strokeStyle = `rgba(255,255,255,${0.03 + 0.03 * (r % 3)})`; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke(); }
        g.save(); g.beginPath(); g.arc(0, 0, 110, 0, TAU); g.clip();
        if (media.art && media.art.complete && media.art.naturalWidth) g.drawImage(media.art, -110, -110, 220, 220);
        else { const c = g.createLinearGradient(-110, -110, 110, 110); c.addColorStop(0, palette.accent); c.addColorStop(1, "#5b3cc4"); g.fillStyle = c; g.fillRect(-110, -110, 220, 220); }
        g.restore();
        g.fillStyle = palette.bg; g.beginPath(); g.arc(0, 0, 12, 0, TAU); g.fill();
        g.restore();
        const sheen = g.createLinearGradient(0, 0, 480, 480);
        sheen.addColorStop(0.3, "rgba(255,255,255,0)"); sheen.addColorStop(0.5, "rgba(255,255,255,.07)"); sheen.addColorStop(0.7, "rgba(255,255,255,0)");
        g.fillStyle = sheen; g.fillRect(0, 0, 480, 480);
        g.fillStyle = "rgba(0,0,0,.65)"; g.fillRect(0, 368, 480, 112);
        const title = m ? m.title : media.reason, artist = m ? m.artist : "";
        g.save(); g.beginPath(); g.rect(70, 370, 340, 110); g.clip();
        text(title.length > 26 ? title.slice(0, 25) + "…" : title, C, 398, 26);
        if (artist) text(artist.length > 34 ? artist.slice(0, 33) + "…" : artist, C, 430, 18, 0.7, 600);
        g.restore();
        g.restore();
    }

    function fpsFace(t, d) {
        begin(palette.bg);
        g.lineCap = "round"; g.lineWidth = 22;
        g.strokeStyle = "rgba(255,255,255,.1)"; g.beginPath(); g.arc(C, C, 190, 0.75 * Math.PI, 2.25 * Math.PI); g.stroke();
        g.strokeStyle = palette.accent; g.beginPath(); g.arc(C, C, 190, 0.75 * Math.PI, (0.75 + 1.5 * clamp(d.fps / 240, 0.01, 1)) * Math.PI); g.stroke();
        text(Math.round(d.fps), C, 230, 120); text("FPS · GAME", C, 310, 20, 0.7, 600);
        g.restore();
    }

    // ---------- Sky: an astrolabe of the day ----------
    // Sunrise and sunset from the latitude and longitude (NOAA-style approximation, a few minutes off at most),
    // the moon's age from a known new moon. Computed here, nothing is fetched.
    function coord(name, def, lim) { const v = Number.parseFloat(String(typeof window[name] !== "undefined" ? window[name] : "").replace(",", ".")); return Number.isFinite(v) && Math.abs(v) <= lim ? v : def; }
    function sunTimes(now, lat, lon) {
        const start = Date.UTC(now.getUTCFullYear(), 0, 0), n = Math.floor((now - start) / 86400000);
        const b = 2 * Math.PI * (n - 81) / 364, eot = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
        const decl = -23.44 * Math.cos(2 * Math.PI * (n + 10) / 365) * Math.PI / 180, phi = lat * Math.PI / 180;
        const cosW = (Math.sin(-0.833 * Math.PI / 180) - Math.sin(phi) * Math.sin(decl)) / (Math.cos(phi) * Math.cos(decl));
        const noon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12) - (lon / 15) * 3600000 - eot * 60000;
        if (cosW >= 1) return { polar: "night", noon }; if (cosW <= -1) return { polar: "day", noon };
        const half = Math.acos(cosW) * 180 / Math.PI / 15 * 3600000;
        return { rise: noon - half, set: noon + half, noon };
    }
    const hourOf = ms => { const d = new Date(ms); return d.getHours() + d.getMinutes() / 60; };
    const hm = ms => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`; };
    function dialPoint(h, r) { const a = (h - 12) / 24 * TAU; return [C + r * Math.sin(a), C - r * Math.cos(a)]; }
    function sky(t) {
        const now = new Date(), s = sunTimes(now, coord("pumpLat", 48.85, 90), coord("pumpLon", 2.35, 180));
        begin();
        const brass = g.createLinearGradient(0, 0, 480, 480);
        brass.addColorStop(0, "#f3d68a"); brass.addColorStop(0.5, "#a87b2c"); brass.addColorStop(1, "#e8c06a");
        g.fillStyle = brass; g.fillRect(0, 0, 480, 480);
        g.fillStyle = "#0b1328"; g.beginPath(); g.arc(C, C, 212, 0, TAU); g.fill();
        // Daylight wedge from sunrise to sunset.
        if (s.polar !== "night") {
            const a0 = s.polar === "day" ? 0 : (hourOf(s.rise) - 12) / 24 * TAU - Math.PI / 2, a1 = s.polar === "day" ? TAU : (hourOf(s.set) - 12) / 24 * TAU - Math.PI / 2;
            const sk = g.createRadialGradient(C, C - 60, 20, C, C, 212);
            sk.addColorStop(0, "#9fd4ff"); sk.addColorStop(1, "#2f6fb3");
            g.fillStyle = sk; g.beginPath(); g.moveTo(C, C); g.arc(C, C, 212, a0, a1); g.closePath(); g.fill();
        }
        g.fillStyle = "#3a2808"; g.font = "700 16px Bahnschrift, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
        for (let h = 0; h < 24; h += 3) { const [x, y] = dialPoint(h, 226); g.fillText(String(h), x, y); }
        const h = now.getHours() + now.getMinutes() / 60, isDay = s.polar === "day" || (s.rise && now >= s.rise && now < s.set);
        const [bx, by] = dialPoint(h, 168);
        if (isDay) {
            g.fillStyle = "rgba(255,211,77,.25)"; g.beginPath(); g.arc(bx, by, 34, 0, TAU); g.fill();
            g.fillStyle = "#ffd34d"; g.beginPath(); g.arc(bx, by, 22, 0, TAU); g.fill();
        } else {
            // Moon: age in days since a known new moon (6 Jan 2000, 18:14 UTC), drawn lit by its phase.
            const age = (((now - Date.UTC(2000, 0, 6, 18, 14)) / 86400000) % 29.530588 + 29.530588) % 29.530588, k = age / 29.530588;
            // Lit fraction; the shadow disc slides off the lit side as the moon fills (left while waxing).
            const lit = (1 - Math.cos(k * TAU)) / 2;
            g.save(); g.beginPath(); g.arc(bx, by, 20, 0, TAU); g.clip();
            g.fillStyle = "#e9eef8"; g.fillRect(bx - 20, by - 20, 40, 40);
            g.fillStyle = "#0b1328"; g.beginPath(); g.arc(bx + (k < 0.5 ? -1 : 1) * 40 * lit, by, 20, 0, TAU); g.fill();
            g.restore();
            g.strokeStyle = "rgba(233,238,248,.35)"; g.lineWidth = 1; g.beginPath(); g.arc(bx, by, 20, 0, TAU); g.stroke();
        }
        let big, small, foot;
        if (s.polar === "day") { big = "24 h"; small = "MIDNIGHT SUN"; foot = ""; }
        else if (s.polar === "night") { big = "0 h"; small = "POLAR NIGHT"; foot = ""; }
        else if (isDay) { big = dur(s.set - now); small = "DAYLIGHT LEFT"; foot = `GOLDEN HOUR ${hm(s.set - 3600000)} · SUNSET ${hm(s.set)}`; }
        else { const next = now < s.rise ? s.rise : s.rise + 86400000; big = dur(next - now); small = "UNTIL SUNRISE"; foot = `SUNRISE ${hm(next)}`; }
        text(big, C, C - 6, 64, 1, 700, "#fff");
        text(small, C, C + 34, 18, 0.9, 700, "#dbe7ff");
        if (foot) text(foot, C, C + 76, 16, 0.95, 600, "#ffd98a");
        g.restore();
    }

    // ---------- Hearth: a stove window ----------
    // Flame height follows CPU load, the embers redden with GPU heat; under 8 % load only banked coals glow.
    const tongues = Array.from({ length: 9 }, (_, i) => ({ x: 150 + i * 22.5, ph: Math.random() * 10, sp: 0.8 + Math.random() * 0.8 }));
    function hearth(t, d) {
        begin("#070302");
        const load = clamp(d.cpu == null ? 0.3 : d.cpu, 0, 1), heat = clamp(((d.gpuT || 45) - 35) / 50, 0, 1);
        const base = 330, idle = load < 0.08;
        const coal = g.createRadialGradient(C, base + 10, 10, C, base + 10, 170);
        coal.addColorStop(0, `rgba(255,${Math.round(lerp(140, 60, heat))},20,${idle ? 0.8 : 0.95})`); coal.addColorStop(0.5, "rgba(120,20,4,.7)"); coal.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = coal; g.fillRect(0, 0, 480, 480);
        if (!idle) {
            g.globalCompositeOperation = "lighter";
            for (const f of tongues) {
                const h = (90 + 170 * load) * (0.65 + 0.35 * Math.sin(t * 3 * f.sp + f.ph)), w = 34 + 10 * Math.sin(t * 2 + f.ph);
                const sway = 14 * Math.sin(t * 2.2 * f.sp + f.ph);
                const gr = g.createLinearGradient(0, base, 0, base - h);
                gr.addColorStop(0, `rgba(255,${Math.round(lerp(200, 120, heat))},60,.55)`); gr.addColorStop(0.5, "rgba(255,110,20,.35)"); gr.addColorStop(1, "rgba(255,60,0,0)");
                g.fillStyle = gr; g.beginPath(); g.moveTo(f.x - w, base);
                g.bezierCurveTo(f.x - w, base - h * 0.5, f.x + sway - w * 0.3, base - h * 0.8, f.x + sway, base - h);
                g.bezierCurveTo(f.x + sway + w * 0.3, base - h * 0.8, f.x + w, base - h * 0.5, f.x + w, base); g.fill();
            }
            g.globalCompositeOperation = "source-over";
        }
        g.fillStyle = "#2b2b2e"; for (let x = 96; x < 384; x += 26) g.fillRect(x, base + 4, 14, 18);
        g.strokeStyle = "#3a3b3e"; g.lineWidth = 22; g.beginPath(); g.arc(C, C, 229, 0, TAU); g.stroke();
        text(idle ? "IDLE · BANKED COALS" : `CPU ${Math.round(load * 100)} % · GPU ${fmt(d.gpuT)} °C`, C, 400, 19, 0.95, 700, "#f2c08a");
        g.restore();
    }

    const DRAW = { tank, aquarium, iris, chrono, vinyl, sky, hearth };
    function carouselFace(t, d) {
        const list = ROTATION.filter(f => f !== "vinyl" || (media.now && media.now.playing));
        const every = setting.every(), slot = Math.floor(t / every) % list.length;
        DRAW[list[slot]](t, d);
        begin();
        for (let i = 0; i < list.length; i++) {
            g.fillStyle = i === slot ? palette.text : "rgba(255,255,255,.3)";
            g.beginPath(); g.arc(C - (list.length - 1) * 12 + i * 24, 452, 6, 0, TAU); g.fill();
        }
        g.restore();
    }

    // ---------- Media (Vinyl): iCUE Edge Companion, read only while Vinyl may show ----------
    // On the pump, iCUE renders widgets in a process that cannot reach 127.0.0.1 (the companion refuses it):
    // the companion writes live/state.js (a call to pumpRelay) and the artwork next to this page instead.
    // The editor preview can reach the server, so HTTP stays as the second source.
    const media = { now: null, art: null, artKey: "", artUrl: "", reason: "Connecting…", busy: false, relayAt: 0, relayTag: null };
    const RELAY_MS = 8000;

    function show(s, artSrc) {
        if (!s) { media.now = null; media.reason = "Nothing playing"; return; }
        media.now = { title: s.title || "Untitled", artist: s.artist || "", playing: s.playback === "playing" };
        const art = s.art && s.art.sessionId === s.id && s.art.rev === s.rev ? s.art : null;
        const key = art ? `${s.id}|${s.rev}` : "";
        if (key === media.artKey) return null;
        media.artKey = key; media.art = null;
        if (media.artUrl) { URL.revokeObjectURL(media.artUrl); media.artUrl = ""; }
        return art;
    }

    window.pumpRelay = wire => {
        if (!wire || wire.schema !== "media/1" || !wire.source || Date.now() - wire.source.lastSeen > RELAY_MS) return;
        media.relayAt = Date.now();
        const art = show(wire.session);
        // The relay's artwork is a local file next to this page (live/art-….jpg).
        if (art && /^live\/art-[\w-]+\.(png|jpg|gif|bmp|webp)$/.test(art.url)) { media.art = new Image(); media.art.src = art.url; }
    };

    async function pollMedia() {
        const face = setting.face();
        if (media.busy || (face !== "vinyl" && face !== "carousel")) return;
        if (/[?&]demo\b/.test(location.search)) { media.now = { title: "Midnight City", artist: "M83", playing: true }; return; }
        if (media.relayTag) media.relayTag.remove();
        media.relayTag = document.createElement("script");
        media.relayTag.src = `live/state.js?t=${Date.now()}`;
        media.relayTag.onerror = () => {};
        document.body.appendChild(media.relayTag);
        if (Date.now() - media.relayAt < RELAY_MS) return;
        media.busy = true;
        try {
            const res = await fetch(ENDPOINT + "/api/media/state", { cache: "no-store", credentials: "omit" });
            if (Date.now() - media.relayAt < RELAY_MS) return;
            if (!res.ok) { media.now = null; media.reason = res.status === 401 ? "Update iCUE Edge Companion" : "Companion not running"; return; }
            const wire = await res.json(), key0 = media.artKey;
            const art = show(wire && wire.session);
            if (art) {
                const r = await fetch(ENDPOINT + art.url, { cache: "no-store", credentials: "omit" });
                const blob = r.ok ? await r.blob() : null;
                if (blob && /^image\//.test(blob.type) && blob.size <= 4 * 1024 * 1024 && media.artKey !== key0) {
                    media.artUrl = URL.createObjectURL(blob);
                    media.art = new Image(); media.art.src = media.artUrl;
                }
            }
        } catch (_) {
            if (Date.now() - media.relayAt >= RELAY_MS) { media.now = null; media.reason = "Companion not running"; }
        } finally { media.busy = false; }
    }
    setInterval(pollMedia, 2000);
    setTimeout(pollMedia, 200);

    // ---------- Loop ----------
    const t0 = performance.now();
    let drawn = 0;
    function frame(now) {
        requestAnimationFrame(frame);
        // ~30 fps is what iCUE shows; drawing more only loads the CPU.
        if (now - drawn < 32) return;
        drawn = now;
        const t = (now - t0) / 1000, d = data();
        g.clearRect(0, 0, 480, 480);
        const face = setting.face();
        if (setting.game() && d.fps != null) fpsFace(t, d);
        else if (face === "carousel") carouselFace(t, d);
        else DRAW[face](t, d);
    }
    requestAnimationFrame(frame);

    window.icueEvents = { onICUEInitialized: readPalette, onDataUpdated: readPalette };
    window.PumpFaces = { tempColor, faces: FACES };
})();
