(() => {
    "use strict";

    // Game Session: the game in front (iCUE Edge Companion, /api/game/state) and, while it runs, the frame
    // rate and temperatures from iCUE sensors. A session's figures are kept until the next one starts, so the
    // screen shows a debrief once the game is closed. Without the companion, an FPS reading alone opens a session.
    const $ = id => document.getElementById(id);
    const ENDPOINT = document.body.dataset.endpoint;
    const DEMO = /[?&]demo\b/.test(location.search);
    const MAX_SAMPLES = 2400;           // 1 h at 1.5 s; older samples are thinned, not dropped
    const DEMO_T0 = Date.now() - 84 * 60000 - 7000;   // one start time for the whole demo, or keys differ
    const store = window.WidgetRuntime ? window.WidgetRuntime.storage("game-session", "game-session") : null;

    /** Average and 1 % low of a list of frame rates. */
    function summarize(samples) {
        if (!samples.length) return { avg: null, low: null };
        const sorted = samples.slice().sort((a, b) => a - b);
        const k = Math.max(1, Math.round(sorted.length * 0.01));
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        const low = sorted.slice(0, k).reduce((a, b) => a + b, 0) / k;
        return { avg, low };
    }
    const countsOf = samples => samples.reduce((c, v) => { const r = Math.round(v); c[r] = (c[r] || 0) + 1; return c; }, {});
    /** 1 % low from a count of samples per whole frame rate: exact however long the session, unlike thinned samples. */
    function lowOf(counts) {
        const rates = Object.keys(counts).map(Number).sort((a, b) => a - b);
        const k = Math.max(1, Math.round(rates.reduce((n, r) => n + counts[r], 0) * 0.01));
        let need = k, sum = 0;
        for (const r of rates) { const c = Math.min(counts[r], need); sum += c * r; need -= c; if (!need) break; }
        return sum / k;
    }
    /** Keeps at most MAX_SAMPLES by averaging pairs of the oldest half. */
    function thin(samples) {
        if (samples.length <= MAX_SAMPLES) return samples;
        const half = Math.floor(samples.length / 2), out = [];
        for (let i = 0; i + 1 < half; i += 2) out.push((samples[i] + samples[i + 1]) / 2);
        return out.concat(samples.slice(half));
    }
    const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
    const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} ago`; };
    const celsius = r => (r ? (/f/i.test(r.units) && !/c/i.test(r.units) ? (r.value - 32) * 5 / 9 : r.value) : null);

    // session: { key, name, startedAt, lastSeen, endedAt, fps: [], cpuPeak, gpuPeak }
    let session = (() => { try { const s = store && store.read(); return s && s.key ? s : null; } catch (_) { return null; } })();
    let companion = { game: null, foreground: false, ok: false };
    let sensors = {};
    let lastSave = 0;

    async function poll() {
        if (DEMO) {
            companion = { ok: true, foreground: !/demo=debrief/.test(location.search), game: /demo=debrief/.test(location.search) ? null : { name: "Grand Theft Auto V", startedAt: DEMO_T0 } };
            return;
        }
        try {
            const { data } = await window.WidgetRuntime.requestJson(ENDPOINT + "/api/game/state", { credentials: "omit" });
            companion = { ok: data && data.schema === "game/1", game: data.game || null, foreground: !!data.foreground, last: data.last || null };
        } catch (_) { companion = { ok: false, game: null, foreground: false }; }
    }

    function tick() {
        const now = Date.now();
        const fps = sensors.fps && sensors.fps.value > 0 ? sensors.fps.value : null;
        // The session: the companion's game, or "In game" from the FPS sensor alone.
        const live = companion.game ? { key: `${companion.game.name}|${companion.game.startedAt}`, name: companion.game.name, startedAt: companion.game.startedAt }
            : !companion.ok && fps !== null ? { key: `fps|${session && session.key.startsWith("fps|") && !session.endedAt ? session.startedAt : now}`, name: "In game", startedAt: session && session.key.startsWith("fps|") && !session.endedAt ? session.startedAt : now }
            : null;
        if (live && (!session || session.key !== live.key)) session = { ...live, lastSeen: now, endedAt: null, fps: [], cpuPeak: null, gpuPeak: null };
        if (live) {
            session.lastSeen = now;
            session.endedAt = null;
            if (fps !== null && (companion.foreground || !companion.ok)) {
                // A session saved before the histogram existed starts it from its samples, so earlier dips still count.
                const counts = session.counts = session.counts || countsOf(session.fps), r = Math.round(fps);
                session.fps.push(fps); session.fps = thin(session.fps);
                counts[r] = (counts[r] || 0) + 1;
            }
            const c = celsius(sensors.cpuTemp), g = celsius(sensors.gpuTemp);
            if (c !== null) session.cpuPeak = Math.max(session.cpuPeak || 0, c);
            if (g !== null) session.gpuPeak = Math.max(session.gpuPeak || 0, g);
        } else if (session && !session.endedAt) {
            // The companion keeps a game for 2 min after it leaves the foreground: its endedAt drops that grace.
            const last = companion.last;
            session.endedAt = (last && `${last.name}|${last.startedAt}` === session.key && last.endedAt) || session.lastSeen;
        }
        if (store && session && now - lastSave > 20000) { store.write(session); lastSave = now; }
        render(live ? "live" : session ? "debrief" : "idle", fps, now);
    }

    function trace(samples) {
        if (samples.length < 2) { $("line").setAttribute("d", ""); $("area").setAttribute("d", ""); return; }
        const pts = samples.slice(-200), max = Math.max(...pts, 60) * 1.1;
        const xy = pts.map((v, i) => `${(i / (pts.length - 1) * 300).toFixed(1)},${(80 - v / max * 76).toFixed(1)}`);
        $("line").setAttribute("d", "M" + xy.join("L"));
        $("area").setAttribute("d", `M0,80L${xy.join("L")}L300,80Z`);
    }

    function render(view, fps, now) {
        $("widget").dataset.view = view;
        const breakMin = Number(typeof sessionBreak !== "undefined" ? sessionBreak : 90);
        if (view === "idle") {
            $("kind").textContent = "STANDBY";
            $("game").textContent = "No game running";
            $("clock").textContent = "--:--";
            $("foot").textContent = companion.ok ? "Start a game: it shows up here" : "Start iCUE Edge Companion to name the game";
            return;
        }
        const s = session, { avg, low: sampled } = summarize(s.fps);
        const low = s.counts && Object.keys(s.counts).length ? lowOf(s.counts) : sampled;
        const dur = (view === "live" ? now : s.endedAt) - s.startedAt;
        $("kind").textContent = view === "live" ? "LIVE" : "DEBRIEF";
        $("game").textContent = s.name;
        $("clock").textContent = clock(dur);
        $("fps").textContent = view === "live" && fps !== null ? String(Math.round(fps)) : avg !== null ? String(Math.round(avg)) : "--";
        $("avg").textContent = avg !== null ? String(Math.round(avg)) : "--";
        $("low").textContent = low !== null ? String(Math.round(low)) : "--";
        $("cpu").textContent = s.cpuPeak !== null ? `${Math.round(s.cpuPeak)}°` : "--";
        $("gpu").textContent = s.gpuPeak !== null ? `${Math.round(s.gpuPeak)}°` : "--";
        trace(s.fps);
        // Break reminder: a bar that fills up to the chosen time, then asks for a break.
        const on = view === "live" && Number.isFinite(breakMin) && breakMin > 0;
        const left = on ? breakMin * 60000 - dur : 0;
        $("brk").textContent = !on ? "" : left > 0 ? `Break in ${Math.ceil(left / 60000)} min` : "Time for a break: stretch, drink some water";
        $("widget").classList.toggle("break", on && left <= 0);
        $("brk").style.setProperty("--done", on ? String(Math.min(1, dur / (breakMin * 60000))) : "0");
        $("foot").textContent = view === "live" ? (companion.foreground || !companion.ok ? "" : "Game in the background") : `Ended ${ago(now - s.endedAt)}`;
    }

    if (DEMO) {
        const t0 = DEMO_T0;
        sensors = { fps: { value: 141, units: "FPS" }, cpuTemp: { value: 68, units: "°C" }, gpuTemp: { value: 71, units: "°C" } };
        session = { key: `Grand Theft Auto V|${t0}`, name: "Grand Theft Auto V", startedAt: t0, lastSeen: Date.now(), endedAt: null, cpuPeak: 78, gpuPeak: 74,
            fps: Array.from({ length: 400 }, (_, i) => 132 + 18 * Math.sin(i / 23) + 9 * Math.sin(i / 5.3) - (i % 97 === 0 ? 55 : 0)) };
        if (/demo=debrief/.test(location.search)) session.endedAt = Date.now() - 12 * 60000;
    } else if (window.SensorReader) SensorReader.watch(r => { sensors = r; });

    window.GameSession = { summarize, thin, lowOf, countsOf };
    window.icueEvents = { onICUEInitialized: () => {}, onDataUpdated: () => {} };
    poll().then(tick);
    setInterval(poll, 3000);
    setInterval(tick, 1500);
    window.addEventListener("pagehide", () => { if (store && session) store.write(session); });
})();
