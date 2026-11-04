(() => {
    "use strict";

    const ENDPOINT = "http://127.0.0.1:47821";
    const POLL_MS = 800;
    const MAX_APPS = 8;
    const $ = id => document.getElementById(id);

    let timer = null, request = null, last = null, failed = false;
    let dragging = null;          // channel name while a fader is held: its value is not overwritten
    const channels = new Map();   // name -> { el, fill, knob, lvl, val, mute }

    const ICON_OK = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

    function make(tag, cls, text) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    async function send(body) {
        try {
            await WidgetRuntime.requestJson(`${ENDPOINT}/api/mixer/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        } catch (_) { /* the next reading shows the real state */ }
    }

    // Fader: a touch target along its long side; the value follows the finger, sent at most every 80 ms.
    function fader(name, app) {
        const track = make("div", "fader");
        const fill = make("i", "fill"), knob = make("b", "knob"), lvl = make("span", "lvl");
        track.append(fill, lvl, knob);
        let lastSent = 0, pending = null;
        const valueAt = e => {
            const r = track.getBoundingClientRect();
            const vertical = r.height >= r.width;
            const t = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
            return Math.round(Math.max(0, Math.min(1, t)) * 100);
        };
        const push = v => {
            const now = Date.now();
            const body = app === null ? { cmd: "volume", value: v } : { cmd: "volume", app, value: v };
            if (now - lastSent > 80) { lastSent = now; send(body); }
            else { clearTimeout(pending); pending = setTimeout(() => { lastSent = Date.now(); send(body); }, 90); }
        };
        track.addEventListener("pointerdown", e => {
            dragging = name;
            track.setPointerCapture(e.pointerId);
            const v = valueAt(e); paint(channels.get(name), v); push(v);
        });
        track.addEventListener("pointermove", e => {
            if (dragging !== name) return;
            const v = valueAt(e); paint(channels.get(name), v); push(v);
        });
        const end = () => { if (dragging === name) setTimeout(() => { dragging = null; }, 600); };
        track.addEventListener("pointerup", end);
        track.addEventListener("pointercancel", end);
        return { track, fill, knob, lvl };
    }

    function paint(ch, volume) {
        if (!ch) return;
        ch.fill.style.setProperty("--v", `${volume}%`);
        ch.knob.style.setProperty("--v", `${volume}%`);
        ch.volume = volume;
        ch.val.textContent = ch.muted ? "Muted" : `${volume} %`;
    }

    function channel(name, app, iconUrl) {
        const el = make("div", "ch");
        const icon = make("button", "ico");
        icon.type = "button";
        icon.setAttribute("aria-label", `Mute ${name}`);
        if (iconUrl && ICON_OK.test(iconUrl)) { const img = make("img"); img.src = iconUrl; img.alt = ""; icon.append(img); }
        else icon.textContent = app === null ? "♪" : name.charAt(0).toUpperCase();
        const { track, fill, knob, lvl } = fader(name, app);
        const label = make("span", "name", name), val = make("small", "val", "");
        const key = make("button", "mkey", "M");
        key.type = "button";
        key.setAttribute("aria-label", `Mute ${name}`);
        el.append(icon, track, label, val, key);
        const ch = { el, fill, knob, lvl, val, muted: false, app };
        key.addEventListener("click", () => icon.click());
        icon.addEventListener("click", () => {
            ch.muted = !ch.muted;
            el.classList.toggle("muted", ch.muted);
            key.setAttribute("aria-pressed", String(ch.muted));
            paint(ch, ch.volume || 0);
            send(app === null ? { cmd: "mute", value: ch.muted } : { cmd: "mute", app, value: ch.muted });
        });
        return ch;
    }

    function render(data) {
        const rows = [{ name: "Output", app: null, volume: data.device.volume, muted: data.device.muted, level: Math.max(0, ...data.apps.map(a => a.level)) },
            ...data.apps.slice(0, MAX_APPS - 1).map(a => ({ name: a.name, app: a.name, volume: a.volume, muted: a.muted, level: a.level, icon: a.icon }))];
        const names = rows.map(r => r.name);
        // Rebuild only when the set of apps changes, so a finger on a fader is never interrupted.
        if (names.join("|") !== [...channels.keys()].join("|")) {
            channels.clear();
            $("mix").replaceChildren(...rows.map(r => { const ch = channel(r.name, r.app, r.icon); channels.set(r.name, ch); return ch.el; }));
        }
        for (const r of rows) {
            const ch = channels.get(r.name);
            ch.lvl.style.setProperty("--l", `${r.muted ? 0 : Math.min(100, r.level)}%`);
            if (dragging === r.name) continue;
            ch.muted = r.muted;
            ch.el.classList.toggle("muted", r.muted);
            paint(ch, r.volume);
        }
        $("device").textContent = data.device.name;
    }

    function show(title, sub) {
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    async function update() {
        if (/[?&]demo\b/.test(location.search)) {
            const t = Date.now() / 300, lv = (b, a) => Math.max(0, Math.min(100, b + a * Math.sin(t) + a * 0.6 * Math.sin(t * 2.7)));
            render({ device: { name: "Speakers (Realtek)", volume: 62, muted: false }, apps: [
                { name: "Spotify", volume: 70, muted: false, level: lv(60, 18) }, { name: "Discord", volume: 55, muted: false, level: lv(30, 20) },
                { name: "GTA V", volume: 85, muted: false, level: lv(78, 14) }, { name: "Chrome", volume: 40, muted: true, level: 0 }] });
            $("status").textContent = "4 apps playing sound · tap M to mute";
            return;
        }
        if (request) request.abort();
        request = new AbortController();
        try {
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/mixer/state`, { signal: request.signal });
            if (!data || data.schema !== "mixer/1") throw new Error("unknown_version");
            if (!data.available) { show("No audio device", "Windows reports no default output device."); return; }
            last = data;
            failed = false;
            render(data);
            $("overlay").classList.remove("visible");
            $("status").textContent = `${data.apps.length} ${data.apps.length === 1 ? "app" : "apps"} playing sound · tap an icon to mute`;
        } catch (error) {
            if (error && error.name === "AbortError") return;
            if (!failed) show("Companion not running", "Start iCUE Edge Companion; it reads the Windows audio sessions on this PC.");
            failed = true;
        }
    }

    $("device").addEventListener("click", () => {
        const out = channels.get("Output");
        if (out) out.el.querySelector(".ico").click();
    });

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.AudioMixer = { start, render };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: () => { if (last) render(last); } };
    WidgetRuntime.onResume(update);
    start();
})();
