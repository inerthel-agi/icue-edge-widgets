(() => {
    "use strict";

    // Spotify widget (original Spotify Visualizer design + legibility pass). Data comes from
    // iCUE Edge Companion (snapshot `spotify/1`), which holds the Spotify token: this widget never
    // asks for a token or a Client ID. With ?source=preview inside a frame it renders the preview
    // page's simulated snapshots instead.
    const ENDPOINT = document.body.dataset.endpoint;
    const STALE_MS = 10000;
    const MAX_ART_BYTES = 4 * 1024 * 1024;
    const $ = id => document.getElementById(id);
    const NS = "http://www.w3.org/2000/svg";
    const state = {
        theme: "dark", sizeClass: "", snap: null, trackKey: "", lyricsKey: "", lines: [], shownLine: -1,
        autoScroll: true, resumeTimer: null, volumeBeforeMute: 100, volumeDragging: false, volumeTimer: null, artUrl: "",
    };
    let send = () => {};
    const link = { live: false, tried: false, refused: false };

    const fmt = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
    const svgEl = (tag, attrs) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); return el; };

    // ---------- Theme (dark -> light -> blur), as in the original ----------
    function applyTheme(th) {
        state.theme = ["dark", "light", "blur"].includes(th) ? th : "dark";
        document.documentElement.setAttribute("data-theme", state.theme);
        $("themeToggle").textContent = state.theme.toUpperCase();
        refreshBgBlur();
    }
    function refreshBgBlur() {
        const bg = $("bgImg");
        bg.style.opacity = state.theme === "blur" && bg.getAttribute("src") && bg.complete && bg.naturalWidth > 0 ? "1" : "0";
    }
    $("themeToggle").addEventListener("click", () => {
        applyTheme({ dark: "light", light: "blur", blur: "dark" }[state.theme] || "dark");
        try { localStorage.setItem("pa_theme", state.theme); } catch (_) { /* storage may be blocked */ }
    });

    // ---------- Size classes from the widget width, as in the original ----------
    const sizeFor = w => (w < 1200 ? "sz-m" : w < 2000 ? "sz-l" : "sz-xl");
    function lyricsVisible() { return getComputedStyle($("colRight")).display !== "none"; }
    function applySize(sz) {
        if (state.sizeClass === sz) return;
        if (state.sizeClass) document.documentElement.classList.remove(state.sizeClass);
        document.documentElement.classList.add(sz);
        state.sizeClass = sz;
        renderLyrics();
    }

    // ---------- Overlay and toast ----------
    function overlay(icon, title, sub, label, action) {
        $("stateIcon").textContent = icon;
        $("stateTitle").textContent = title;
        $("stateSub").textContent = sub;
        $("stateAction").classList.toggle("ui-hidden", !label);
        $("stateAction").textContent = label || "";
        $("stateAction").onclick = action || null;
        $("stateOverlay").classList.remove("hidden");
    }
    function toast(msg) {
        const el = $("toast");
        if (el.textContent === msg && el.classList.contains("visible")) return;
        el.textContent = msg;
        el.classList.add("visible");
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove("visible"), 2500);
    }

    // ---------- Lyrics ----------
    function renderLyrics() {
        const scroll = $("lyricsScroll");
        const lyr = state.snap && state.snap.lyrics;
        const key = `${state.trackKey}|${lyr ? lyr.state : "-"}|${state.sizeClass}`;
        if (key === state.lyricsKey || !lyricsVisible()) return;
        state.lyricsKey = key;
        state.shownLine = -1;
        scroll.replaceChildren();
        if (lyr && lyr.state === "loading") {
            const wrap = document.createElement("div");
            wrap.className = "lyrics-loading";
            for (let i = 0; i < 8; i++) { const bar = document.createElement("div"); bar.className = "lyrics-loading-bar"; wrap.append(bar); }
            scroll.append(wrap);
            state.lines = [];
            return;
        }
        state.lines = lyr && lyr.state === "ready" && Array.isArray(lyr.lines) ? lyr.lines : [];
        if (!state.lines.length) {
            const nl = document.createElement("div");
            nl.className = "no-lyrics";
            const icon = document.createElement("div");
            icon.className = "icon";
            icon.textContent = "MUSIC";
            const msg = document.createElement("div");
            msg.textContent = lyr && lyr.state === "instrumental" ? "Instrumental" : state.snap && state.snap.item ? "No synced lyrics for this track" : "Play a song to see lyrics";
            nl.append(icon, msg);
            scroll.append(nl);
            return;
        }
        state.lines.forEach((line, i) => {
            const el = document.createElement("div");
            el.className = "lyric-line";
            el.dataset.idx = String(i);
            el.textContent = line.text || "·";
            scroll.append(el);
        });
    }

    function highlight(progressMs) {
        if (!state.lines.length) return;
        let active = 0;
        for (let i = 0; i < state.lines.length; i++) { if (state.lines[i].timeMs <= progressMs) active = i; else break; }
        const els = $("lyricsScroll").querySelectorAll(".lyric-line");
        els.forEach((el, i) => {
            const dist = Math.abs(i - active);
            el.classList.toggle("active", i === active);
            el.classList.toggle("near", dist > 0 && dist <= 2);
        });
        if (state.autoScroll && els[active] && state.shownLine !== active) {
            state.shownLine = active;
            els[active].scrollIntoView({ block: "center", behavior: "smooth" });
        }
    }

    function setAutoScroll(on) {
        state.autoScroll = on;
        $("lyricsAutoBtn").classList.toggle("active", on);
        if (on) state.shownLine = -1;
    }
    function pauseAutoScroll() {
        if (!state.autoScroll) return;
        setAutoScroll(false);
        clearTimeout(state.resumeTimer);
        state.resumeTimer = setTimeout(() => setAutoScroll(true), 4000);
    }
    $("lyricsAutoBtn").addEventListener("click", () => { clearTimeout(state.resumeTimer); setAutoScroll(!state.autoScroll); });
    $("lyricsScrollUp").addEventListener("click", () => { pauseAutoScroll(); $("lyricsScroll").scrollBy({ top: -80, behavior: "smooth" }); });
    $("lyricsScrollDown").addEventListener("click", () => { pauseAutoScroll(); $("lyricsScroll").scrollBy({ top: 80, behavior: "smooth" }); });
    $("lyricsScroll").addEventListener("wheel", pauseAutoScroll, { passive: true });
    $("lyricsScroll").addEventListener("touchstart", pauseAutoScroll, { passive: true });

    // ---------- Controls ----------
    const item = () => state.snap && state.snap.item;
    const cmd = (name, extra) => { const it = item(); if (it) send({ cmd: name, itemId: it.id, rev: it.rev, ...extra }); };
    $("playBtn").addEventListener("click", () => cmd("playPause"));
    $("prevBtn").addEventListener("click", () => cmd("prev"));
    $("nextBtn").addEventListener("click", () => cmd("next"));
    $("shuffleBtn").addEventListener("click", () => cmd("shuffle", { value: !state.snap.playback.shuffle }));
    $("repeatBtn").addEventListener("click", () => {
        cmd("repeat", { value: { off: "context", context: "track", track: "off" }[state.snap.playback.repeat] || "off" });
    });
    $("progressBar").addEventListener("click", e => {
        const it = item();
        if (!it || !it.duration || !state.snap.actions.seek || stale(state.snap)) return;
        const r = $("progressBar").getBoundingClientRect();
        cmd("seek", { value: Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * it.duration) });
    });

    function volumeIcon(vol) {
        const parts = [svgEl("polygon", { points: "11 5 6 9 2 9 2 15 6 15 11 19 11 5" })];
        if (vol === 0) parts.push(svgEl("line", { x1: 23, y1: 9, x2: 17, y2: 15 }), svgEl("line", { x1: 17, y1: 9, x2: 23, y2: 15 }));
        else {
            parts.push(svgEl("path", { d: "M15.54 8.46a5 5 0 0 1 0 7.07" }));
            if (vol >= 50) parts.push(svgEl("path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14" }));
        }
        $("volumeIcon").replaceChildren(...parts);
    }
    function sendVolume(vol) {
        clearTimeout(state.volumeTimer);
        state.volumeTimer = setTimeout(() => send({ cmd: "volume", value: vol }), 250);
    }
    $("volumeSlider").addEventListener("pointerdown", () => { state.volumeDragging = true; });
    window.addEventListener("pointerup", () => { state.volumeDragging = false; });
    $("volumeSlider").addEventListener("input", e => {
        const vol = parseInt(e.target.value, 10);
        if (vol > 0) state.volumeBeforeMute = vol;
        volumeIcon(vol);
        sendVolume(vol);
    });
    $("volumeBtn").addEventListener("click", () => {
        const dev = state.snap && state.snap.device;
        if (!dev || dev.volume == null) return;
        const vol = dev.volume > 0 ? 0 : state.volumeBeforeMute || 100;
        if (dev.volume > 0) state.volumeBeforeMute = dev.volume;
        $("volumeSlider").value = String(vol);
        volumeIcon(vol);
        sendVolume(vol);
    });

    function setPlayIcon(playing) {
        const shapes = playing
            ? [svgEl("rect", { x: 6, y: 4, width: 4, height: 16, rx: 1 }), svgEl("rect", { x: 14, y: 4, width: 4, height: 16, rx: 1 })]
            : [svgEl("polygon", { points: "5 3 19 12 5 21 5 3" })];
        $("playIcon").replaceChildren(...shapes);
        $("playBtn").setAttribute("aria-label", playing ? "Pause" : "Play");
        $("widget").classList.toggle("is-playing", playing);
    }

    // ---------- Render ----------
    function stale(s) {
        return !s.source.connected || Date.now() - s.source.lastSeen > STALE_MS || !!s.rateLimitedUntil;
    }

    function progressMs(s) {
        const p = s.playback;
        const until = stale(s) ? Math.min(Date.now(), s.source.lastSeen) : Date.now();
        const ms = p.position * 1000 + (p.playing ? Math.max(0, until - p.updatedAt) : 0);
        return Math.min(ms, (s.item.duration || 0) * 1000);
    }

    function render() {
        const s = state.snap;
        if (!s) {
            if (!link.tried) return overlay("SPOTIFY", "Connecting…", "Looking for iCUE Edge Companion.");
            if (link.refused) return overlay("SPOTIFY", "Access refused", "iCUE Edge Companion only answers iCUE.");
            return overlay("OFFLINE", "Companion not running", "Start iCUE Edge Companion to show Spotify.");
        }
        const acc = s.account.status;
        if (acc === "not_configured") return overlay("SPOTIFY", "Connect Spotify", "Open iCUE Edge Companion › Spotify to connect your account. Nothing to enter here.");
        if (acc === "connecting" && !s.item) return overlay("SPOTIFY", "Connecting to Spotify…", "Finish the sign-in in your browser if it is open.");
        if (acc === "needs_login") return overlay("SPOTIFY", "Sign in again", "Spotify ended the session. Reconnect in iCUE Edge Companion › Spotify.");
        if (acc === "premium_required") return overlay("SPOTIFY", "Spotify Premium required", "Spotify only allows playback control for Premium accounts.");
        if (!s.item) {
            const d = s.devices && s.devices[0];
            return overlay("SPOTIFY", "Nothing playing", "Start Spotify on a device" + (d ? ", or play on " + d.name + "." : "."), d ? "Play on " + d.name : "",
                () => send({ cmd: "transfer", deviceId: d.id }));
        }
        $("stateOverlay").classList.add("hidden");
        const it = s.item, pb = s.playback || { playing: false, position: 0, updatedAt: Date.now(), shuffle: false, repeat: "off" }, act = s.actions;
        s.playback = pb;

        const key = `${it.id}|${it.rev}`;
        if (key !== state.trackKey) {
            state.trackKey = key;
            $("lyricsScroll").scrollTop = 0;
        }
        $("trackName").textContent = it.title;
        $("trackArtist").textContent = it.artists;
        $("trackAlbum").textContent = it.album || "";

        const url = it.art ? it.art.url : "";
        if (url !== state.artUrl) {
            state.artUrl = url;
            const img = $("albumImg");
            img.classList.add("ui-hidden");
            $("noArt").classList.remove("ui-hidden");
            if (url) {
                img.onload = () => {
                    if (state.artUrl !== url) return;
                    img.classList.remove("ui-hidden");
                    $("noArt").classList.add("ui-hidden");
                    $("bgImg").onload = refreshBgBlur;
                    $("bgImg").src = url;
                };
                img.src = url;
            } else {
                img.removeAttribute("src");
                $("bgImg").removeAttribute("src");
                refreshBgBlur();
            }
        }

        const ms = progressMs(s);
        const dur = (it.duration || 0) * 1000;
        $("progressFill").style.width = (dur ? ms / dur * 100 : 0) + "%";
        $("timeElapsed").textContent = fmt(ms);
        $("timeTotal").textContent = dur ? fmt(dur) : "--:--";
        setPlayIcon(pb.playing);

        $("shuffleBtn").classList.toggle("shuffle-on", !!pb.shuffle);
        $("shuffleBtn").setAttribute("aria-pressed", String(!!pb.shuffle));
        $("repeatBtn").classList.toggle("repeat-on", pb.repeat !== "off");
        $("repeatBtn").dataset.mode = pb.repeat;
        $("repeatBtn").title = pb.repeat === "off" ? "Repeat: off" : pb.repeat === "context" ? "Repeat: all" : "Repeat: one";
        $("repeatBtn").setAttribute("aria-label", $("repeatBtn").title);
        const lock = stale(s);
        for (const [id, ok] of [["playBtn", act.playPause], ["prevBtn", act.prev], ["nextBtn", act.next], ["shuffleBtn", act.shuffle], ["repeatBtn", act.repeat]]) {
            $(id).disabled = lock || !ok;
        }
        const dev = s.device;
        const canVol = !!dev && dev.volume != null && act.volume && !lock;
        $("volumeSlider").disabled = !canVol;
        $("volumeBtn").disabled = !canVol;
        if (canVol && !state.volumeDragging && document.activeElement !== $("volumeSlider")) {
            $("volumeSlider").value = String(dev.volume);
            volumeIcon(dev.volume);
        }

        // Shown once when the status changes, not again on every 250 ms render.
        const status = s.rateLimitedUntil ? "Spotify busy, retrying…" : !s.source.connected ? "Companion reconnecting…"
            : Date.now() - s.source.lastSeen > STALE_MS ? "Data is not up to date" : "";
        if (status && status !== state.lastStatus) toast(status);
        state.lastStatus = status;

        renderLyrics();
        highlight(ms);
    }

    // ---------- Source: iCUE Edge Companion ----------
    const blobs = new Map();

    // Artwork is fetched with the same connection rules as the data and shown from a blob URL;
    // only the current revision's image is kept, replaced ones are released at once.
    function withArt(wire) {
        const it = wire.item;
        const art = it && it.art;
        const key = art ? `${it.id}|${it.rev}` : null;
        for (const [k, entry] of blobs) {
            if (k === key) continue;
            entry.controller.abort();
            if (entry.url) URL.revokeObjectURL(entry.url);
            blobs.delete(k);
        }
        if (!key) return wire;
        let entry = blobs.get(key);
        if (!entry) {
            entry = { url: null, controller: new AbortController() };
            blobs.set(key, entry);
            fetch(ENDPOINT + art.url, { cache: "no-store", credentials: "omit", signal: entry.controller.signal })
                .then(r => {
                    const raw = r.headers.get("content-length"), size = Number(raw);
                    if (!r.ok || raw === null || !Number.isFinite(size) || size > MAX_ART_BYTES) throw new Error(String(r.status));
                    return r.blob();
                })
                .then(blob => {
                    if (!/^image\/(png|jpeg|gif|bmp|webp)$/.test(blob.type) || blob.size > MAX_ART_BYTES) throw new Error("type");
                    if (blobs.get(key) !== entry) return;
                    entry.url = URL.createObjectURL(blob);
                    if (state.snap && state.snap.item && `${state.snap.item.id}|${state.snap.item.rev}` === key) {
                        // Artwork arriving after the stream dropped must not bring back a "connected" state.
                        const snap = withArt(link.wire);
                        state.snap = link.live ? snap : { ...snap, source: { ...snap.source, connected: false } };
                        render();
                    }
                })
                .catch(() => { /* no artwork: the placeholder stays */ });
        }
        return { ...wire, item: { ...it, art: entry.url ? { url: entry.url } : null } };
    }

    function companionSend(msg) {
        const body = { cmd: msg.cmd, rev: msg.rev, value: msg.value, deviceId: msg.deviceId };
        // text/plain keeps it a simple request (no preflight); the companion parses the JSON body.
        fetch(ENDPOINT + "/api/spotify/command", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), credentials: "omit", cache: "no-store" })
            .then(r => {
                if (r.status === 403) toast("Spotify refused this action");
                else if (r.status === 404) toast("No active Spotify device");
                else if (r.status === 429) toast("Spotify busy, retrying…");
                else if (r.status === 409) toast("Track changed, try again");
                else if (!r.ok) toast("Action refused");
            })
            .catch(() => toast("Companion unreachable"));
    }

    function receive(wire) {
        if (!wire || wire.schema !== "spotify/1") return;
        link.wire = wire;
        link.live = link.tried = true;
        link.refused = false;
        state.snap = withArt(wire);
        render();
    }

    async function streamOnce() {
        const res = await fetch(ENDPOINT + "/api/spotify/events", { cache: "no-store", credentials: "omit" });
        if (res.status === 401) return "unauthorized";
        if (!res.ok || !res.body || !res.body.getReader) return "error";
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            if (buf.length > 2 * 1024 * 1024) buf = "";
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const lines = block.split("\n");
                const ev = (lines.find(l => l.startsWith("event:")) || "").slice(6).trim();
                const data = lines.filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
                if (ev === "state" && data) {
                    try { receive(JSON.parse(data)); } catch (_) { /* malformed event: wait for the next one */ }
                }
            }
        }
        return "closed";
    }

    async function runCompanion() {
        let backoff = 2000;
        for (;;) {
            let result;
            try { result = await streamOnce(); } catch (_) { result = "error"; }
            link.live = false;
            link.tried = true;
            link.refused = result === "unauthorized";
            // Keep the last data, greyed out as stale, while reconnecting.
            if (link.wire) state.snap = { ...withArt(link.wire), source: { ...link.wire.source, connected: false } };
            render();
            await new Promise(r => setTimeout(r, link.refused ? 30000 : backoff));
            backoff = result === "closed" ? 2000 : Math.min(backoff * 2, 15000);
        }
    }

    // ---------- Start ----------
    new ResizeObserver(entries => applySize(sizeFor(entries[0].contentRect.width))).observe($("widget"));
    // Also sized at once: the observer only fires on a rendered frame.
    applySize(sizeFor($("widget").offsetWidth || window.innerWidth));
    let initialTheme = "dark";
    try { initialTheme = localStorage.getItem("pa_theme") || "dark"; } catch (_) { /* default */ }
    applyTheme(initialTheme);

    const params = new URLSearchParams(location.search);
    if (params.get("source") === "preview" && window.parent !== window) {
        // ponytail: postMessage with "*" because the preview may run from file://.
        window.addEventListener("message", e => {
            if (e.source !== window.parent || !e.data || e.data.type !== "sp-snapshot") return;
            link.tried = true;
            state.snap = e.data.snapshot;
            render();
        });
        send = msg => window.parent.postMessage({ type: "sp-command", ...msg }, "*");
        window.parent.postMessage({ type: "sp-ready" }, "*");
    } else {
        send = companionSend;
        window.icueEvents = { onICUEInitialized: render, onDataUpdated: render };
        runCompanion();
    }
    render();
    setInterval(render, 250);
})();
