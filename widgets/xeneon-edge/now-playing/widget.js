(() => {
    "use strict";

    // Renders one MediaSnapshot (schema media/1). Sources, in order of preference:
    //  - iCUE Edge Companion on 127.0.0.1 (artwork, state, timeline, commands);
    //  - the native iCUE Media plugin (title and artist only), shown as "Native mode";
    //  - the preview page simulator, only with ?source=preview inside a frame.
    const STALE_MS = 10000;
    const NATIVE_AFTER_MS = 8000;
    const MAX_ART_BYTES = 4 * 1024 * 1024;
    const PLAYBACK_LABEL = { playing: "Playing", paused: "Paused", stopped: "Stopped", unknown: "State unknown" };
    const ENDPOINT = document.body.dataset.endpoint;
    const $ = id => document.getElementById(id);
    const player = $("player");

    let snap = null;
    let empty = ["Connecting…", "Looking for iCUE Edge Companion."];
    let send = () => {};
    let artKey = null;
    let artToken = 0;
    let dragging = false;

    const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
    const finite = n => typeof n === "number" && Number.isFinite(n);

    function fmt(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, "0");
        return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
    }

    function ago(ms) {
        const s = Math.round(ms / 1000);
        return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
    }

    function isStale(s) {
        return !s.source.connected || Date.now() - s.source.lastSeen > STALE_MS;
    }

    // ---------- iCUE personalization ----------
    function theme() {
        const css = document.documentElement.style;
        const color = (name, v) => { if (typeof v === "string" && CSS.supports("color", v)) css.setProperty(name, v); };
        color("--x-text", typeof textColor !== "undefined" ? textColor : null);
        color("--accent", typeof accentColor !== "undefined" ? accentColor : null);
        color("--x-bg", typeof backgroundColor !== "undefined" ? backgroundColor : null);
        const t = Number(typeof transparency !== "undefined" ? transparency : NaN);
        if (Number.isFinite(t)) css.setProperty("--bg-opacity", String(Math.max(0, Math.min(1, t / 100))));
    }

    // ---------- Cover colors ----------
    // The accent parts (progress, equalizer, lyric line, glow) take the cover's dominant colour
    // unless the iCUE setting "Cover colors" is Off. Grey or empty covers keep the chosen accent.
    function coverColor(img) {
        const c = document.createElement("canvas");
        c.width = c.height = 24;
        const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, 24, 24);
        const px = g.getImageData(0, 0, 24, 24).data;
        const buckets = new Map();
        for (let i = 0; i < px.length; i += 4) {
            if (px[i + 3] < 128) continue;
            const r = px[i] / 255, gr = px[i + 1] / 255, b = px[i + 2] / 255;
            const max = Math.max(r, gr, b), min = Math.min(r, gr, b), l = (max + min) / 2;
            const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
            const w = s * (1 - Math.abs(2 * l - 1));
            if (w < 0.08) continue;
            const key = (px[i] >> 5) << 6 | (px[i + 1] >> 5) << 3 | px[i + 2] >> 5;
            const e = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
            e.w += w; e.r += r * w; e.g += gr * w; e.b += b * w;
            buckets.set(key, e);
        }
        let best = null;
        for (const e of buckets.values()) if (!best || e.w > best.w) best = e;
        if (!best || best.w < 1) return null;
        const r = best.r / best.w, g2 = best.g / best.w, b2 = best.b / best.w;
        const max = Math.max(r, g2, b2), min = Math.min(r, g2, b2), d = max - min;
        let h = 0;
        if (d) h = max === r ? ((g2 - b2) / d + 6) % 6 : max === g2 ? (b2 - r) / d + 2 : (r - g2) / d + 4;
        const l = Math.min(0.72, Math.max(0.58, (max + min) / 2));
        return `hsl(${Math.round(h * 60)} ${Math.round(Math.max(0.55, Math.min(0.9, d ? d / (1 - Math.abs(2 * ((max + min) / 2) - 1)) : 0)) * 100)}% ${Math.round(l * 100)}%)`;
    }

    // Follows the "Cover colors" setting live (the render loop calls it), not only when a cover loads.
    let coverFor = null;
    function syncCoverColor() {
        const off = typeof coverColors !== "undefined" && coverColors === "off";
        const img = $("art");
        const want = !off && !img.hidden && img.complete && img.naturalWidth > 0 ? img.src : null;
        if (want === coverFor) return;
        coverFor = want;
        player.style.removeProperty("--art-color");
        player.removeAttribute("data-cover");
        if (!want) return;
        try {
            const color = coverColor(img);
            if (color) {
                player.style.setProperty("--art-color", color);
                player.setAttribute("data-cover", "");
            }
        } catch (_) { /* a cover that cannot be read keeps the chosen accent */ }
    }

    // ---------- Artwork ----------
    function clearArt() {
        const img = $("art");
        img.hidden = true;
        img.removeAttribute("src");
        player.dataset.art = "none";
        player.style.removeProperty("--art-color");
        player.removeAttribute("data-cover");
    }

    function artNote(text) {
        setText($("artNote"), text);
        $("artNote").hidden = !text;
    }

    function renderArt(s, session) {
        const art = session.art;
        // Artwork is shown only when it belongs to this exact session and metadata revision.
        const valid = !!art && art.sessionId === session.id && art.rev === session.rev;
        const key = `${s.source.instance}|${session.id}|${session.rev}|${valid ? art.url : "-"}|${session.artState}`;
        if (key === artKey) return;
        artKey = key;
        const token = ++artToken;
        clearArt();
        if (!valid) {
            artNote(session.artState === "pending" ? "Loading artwork…" : session.artState === "error" ? "Artwork unavailable" : "");
            return;
        }
        artNote("Loading artwork…");
        const probe = new Image();
        probe.onload = () => {
            if (token !== artToken) return;
            $("art").src = art.url;
            $("art").hidden = false;
            player.dataset.art = "ready";
            artNote("");
        };
        probe.onerror = () => { if (token === artToken) artNote("Artwork unavailable"); };
        probe.src = art.url;
    }

    // ---------- Timeline ----------
    function currentPos(t, playing) {
        if (!finite(t.position)) return null;
        // Stale data must not keep extrapolating: freeze at the last moment the source was seen.
        const until = isStale(snap) ? Math.min(Date.now(), snap.source.lastSeen) : Date.now();
        let p = t.position;
        if (playing) p += Math.max(0, until - t.updatedAt) / 1000;
        return finite(t.duration) ? Math.min(p, t.duration) : p;
    }

    // A tap on the length switches it to the time left.
    let remaining = false;
    $("dur").addEventListener("click", () => { remaining = !remaining; if (snap && snap.session) renderTimeline(snap.session); });

    function renderTimeline(session) {
        const t = session.timeline;
        const box = $("timeline");
        const dur = t && finite(t.duration) && t.duration > 0 ? t.duration : null;
        if (!t || (!t.live && dur === null && !finite(t.position))) { box.hidden = true; return; }
        box.hidden = false;
        const live = !!t.live;
        const pos = currentPos(t, session.playback === "playing");
        const seek = $("seek");
        $("live").hidden = !live;
        $("pos").hidden = live || pos === null;
        $("dur").hidden = live;
        seek.hidden = live || dur === null;
        if (pos !== null) setText($("pos"), fmt(pos));
        setText($("dur"), dur === null ? "Length unknown" : remaining && pos !== null ? `-${fmt(dur - pos)}` : fmt(dur));
        // A drag cut short by a track without a length must not freeze the slider for the next tracks.
        if (seek.hidden) dragging = false;
        if (seek.hidden || dragging) return;
        seek.max = String(Math.round(dur));
        seek.value = String(Math.round(pos || 0));
        seek.style.setProperty("--pct", `${((pos || 0) / dur * 100).toFixed(2)}%`);
        seek.disabled = !(session.caps && session.caps.seek) || isStale(snap);
        seek.setAttribute("aria-valuetext", `${fmt(pos || 0)} of ${fmt(dur)}`);
    }

    // ---------- Main render ----------
    function renderPill(s, stale) {
        const parts = [];
        if (s.source.kind === "simulated") parts.push("Demo");
        if (!s.source.connected) parts.push("Reconnecting…");
        else if (stale) parts.push(`Stale ${ago(Date.now() - s.source.lastSeen)}`);
        else if (s.source.kind === "native") parts.push("Native mode");
        const pill = $("statusPill");
        const demoOnly = parts.length === 1 && s.source.kind === "simulated";
        pill.hidden = !parts.length;
        pill.className = demoOnly ? "pill demo" : "pill";
        setText(pill, parts.join(" · "));
        // An alert makes the playback label unreliable, so the alert takes its place.
        player.toggleAttribute("data-alert", parts.length > 0 && !demoOnly);
    }

    // ---------- Motion ----------
    let logoKey = null;
    function renderLogo(name) {
        if (name === logoKey) return;
        logoKey = name;
        const box = $("appLogo");
        const logo = typeof window.brandLogo === "function" ? window.brandLogo(name) : null;
        box.innerHTML = logo || "";
        box.classList.toggle("logo", !!logo);
    }

    // A new track slides its text and artwork in; the same track updating (progress, state) does not.
    let trackKey = null;
    function animateTrackChange(session) {
        const key = `${session.id}|${session.title}|${session.artist}`;
        if (key === trackKey) return;
        const first = trackKey === null;
        trackKey = key;
        if (first) return;
        for (const el of [document.querySelector(".meta"), document.querySelector(".art-frame")]) {
            el.classList.remove("enter");
            void el.offsetWidth;
            el.classList.add("enter");
        }
    }

    // ---------- Lyrics (synced, from LRCLIB through the companion) ----------
    let lyricAt = -2;
    let lyricKey = null;
    function renderLyrics(session) {
        const box = $("lyrics");
        const lyr = session.lyrics;
        const lines = lyr && lyr.state === "ready" && Array.isArray(lyr.lines) ? lyr.lines : null;
        const t = session.timeline;
        const pos = lines && t ? currentPos(t, session.playback === "playing") : null;
        box.hidden = pos === null;
        player.toggleAttribute("data-lyrics", pos !== null);
        if (pos === null) { lyricKey = null; return; }
        const key = `${session.id}|${session.rev}`;
        if (key !== lyricKey) { lyricKey = key; lyricAt = -2; }
        // Timestamps mark the start of a line; showing it a quarter second early reads better than late.
        const ms = pos * 1000 + 250;
        let i = -1;
        for (let a = 0, b = lines.length - 1; a <= b;) {
            const m = (a + b) >> 1;
            if (lines[m].timeMs <= ms) { i = m; a = m + 1; } else b = m - 1;
        }
        if (i === lyricAt) return;
        lyricAt = i;
        // One line behind, the current one and three ahead; a tap on a line jumps there.
        const rows = [];
        const row = (text, n, cls) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = `lyric-line ${cls}`;
            b.style.setProperty("--d", String(Math.abs(n - i)));
            b.textContent = text || "♪";
            if (n >= 0) b.dataset.ms = String(lines[n].timeMs);
            rows.push(b);
        };
        if (i < 0) row("♪", -1, "now enter");
        for (let n = Math.max(0, i - 1); n <= Math.min(lines.length - 1, i + 3); n++) row(lines[n].text, n, n === i ? "now enter" : n < i ? "past" : "next");
        $("lyricList").replaceChildren(...rows);
    }

    $("lyricList").addEventListener("click", e => {
        const b = e.target.closest(".lyric-line");
        const session = snap && snap.session;
        if (!b || !b.dataset.ms || !session || !session.caps || !session.caps.seek || isStale(snap)) return;
        command("seek", Number(b.dataset.ms) / 1000);
    });

    // ---------- Shuffle, repeat, volume, sleep timer, visualiser ----------
    const REPEAT_NEXT = { 0: 2, 2: 1, 1: 0 };
    $("shuffle").addEventListener("click", () => {
        const s = snap && snap.session;
        if (s) command("shuffle", !(s.modes && s.modes.shuffle));
    });
    $("repeat").addEventListener("click", () => {
        const s = snap && snap.session;
        if (s) command("repeat", REPEAT_NEXT[(s.modes && s.modes.repeat) || 0]);
    });

    let volDragging = false, volSentAt = 0;
    const setVolPct = v => $("vol").style.setProperty("--pct", `${v}%`);
    $("vol").addEventListener("input", () => {
        volDragging = true;
        const v = Number($("vol").value);
        setVolPct(v);
        // A drag sends about 8 updates a second; the last value goes with the release.
        if (Date.now() - volSentAt > 120) { volSentAt = Date.now(); send({ type: "command", cmd: "volume", value: v }); }
    });
    $("vol").addEventListener("change", () => { volDragging = false; send({ type: "command", cmd: "volume", value: Number($("vol").value) }); });
    $("vol").addEventListener("pointercancel", () => { volDragging = false; });
    $("mute").addEventListener("click", () => send({ type: "command", cmd: "mute", value: !(snap && snap.system && snap.system.muted) }));

    const SLEEP_STEPS = [15, 30, 60, 0];
    let sleepStep = -1;
    $("sleep").addEventListener("click", () => {
        const active = snap && snap.system && snap.system.sleepUntil;
        sleepStep = active ? Math.min(sleepStep + 1, SLEEP_STEPS.length - 1) : 0;
        send({ type: "command", cmd: "sleep", value: SLEEP_STEPS[sleepStep] });
    });

    function renderSystem(s, session) {
        const sys = s.system;
        $("tools").hidden = !sys;
        const caps = (session && session.caps) || {}, modes = (session && session.modes) || {};
        const sh = $("shuffle"), rp = $("repeat");
        sh.hidden = !caps.shuffle;
        rp.hidden = !caps.repeat;
        sh.toggleAttribute("data-on", !!modes.shuffle);
        sh.setAttribute("aria-pressed", String(!!modes.shuffle));
        rp.toggleAttribute("data-on", !!modes.repeat);
        rp.dataset.mode = String(modes.repeat || 0);
        rp.setAttribute("aria-label", modes.repeat === 1 ? "Repeat track" : modes.repeat === 2 ? "Repeat all" : "Repeat off");
        if (!sys) return;
        if (!volDragging) { $("vol").value = String(sys.volume); setVolPct(sys.volume); }
        $("mute").toggleAttribute("data-on", !!sys.muted);
        $("mute").setAttribute("aria-label", sys.muted ? "Unmute" : "Mute");
        const left = sys.sleepUntil ? Math.max(0, sys.sleepUntil - Date.now()) : 0;
        if (!sys.sleepUntil) sleepStep = -1;
        setText($("sleepLabel"), sys.sleepUntil ? `${Math.max(1, Math.ceil(left / 60000))} min` : "Sleep");
        $("sleep").toggleAttribute("data-on", !!sys.sleepUntil);
    }

    // Visualiser: the companion sends 24 levels about 30 times a second, only while this stream is open;
    // it is opened only when the bars are on screen and something plays.
    const VIZ_BARS = 24;
    const vizEl = $("viz");
    for (let i = 0; i < VIZ_BARS; i++) vizEl.append(document.createElement("i"));
    const vizBars = [...vizEl.children];
    let vizLevels = new Array(VIZ_BARS).fill(0), vizFrame = 0;
    const vizWanted = () => vizEl.offsetParent !== null && $("stage").dataset.view === "viz" && !!snap && !!snap.session && snap.session.playback === "playing" && !isStale(snap);
    function vizDraw() {
        vizFrame = 0;
        for (let i = 0; i < VIZ_BARS; i++) vizBars[i].style.transform = `scaleY(${Math.max(0.03, vizLevels[i] / 255).toFixed(3)})`;
    }
    function vizSet(levels) {
        vizLevels = levels;
        if (!vizFrame) vizFrame = requestAnimationFrame(vizDraw);
    }
    async function vizStream() {
        const res = await fetch(ENDPOINT + "/api/media/viz", { cache: "no-store", credentials: "omit" });
        if (!res.ok || !res.body || !res.body.getReader) return;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buf += dec.decode(value, { stream: true });
            if (buf.length > 65536) buf = "";
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
                const data = buf.slice(0, i).split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("");
                buf = buf.slice(i + 2);
                if (!data) continue;
                try { const b = JSON.parse(data).b; if (Array.isArray(b) && b.length === VIZ_BARS) vizSet(b); } catch (_) { /* wait for the next frame */ }
            }
            if (!vizWanted()) { reader.cancel(); return; }
        }
    }
    async function runViz() {
        for (;;) {
            if (vizWanted() && companion.live) {
                try { await vizStream(); } catch (_) { /* companion gone: retried below */ }
                vizSet(new Array(VIZ_BARS).fill(0));
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // ---------- Up next (Spotify only): the same stage as the visualiser, switched by a tap ----------
    // The companion sends the queue only when Spotify is the shown player and its API answers.
    let stageView = "viz";
    const queueBlobs = new Map();
    let queueKey = null;

    function queueImage(url, img) {
        // The preview passes ready-made image URLs; the companion's covers come over the authorised connection.
        if (/^(data:|blob:)/.test(url)) { img.src = url; return; }
        let entry = queueBlobs.get(url);
        if (!entry) {
            entry = { url: null, waiting: [] };
            queueBlobs.set(url, entry);
            fetch(ENDPOINT + url, { cache: "no-store", credentials: "omit" })
                .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
                .then(blob => {
                    if (!/^image\/(png|jpeg|gif|bmp|webp)$/.test(blob.type) || blob.size > MAX_ART_BYTES) throw new Error("type");
                    if (queueBlobs.get(url) !== entry) return;
                    entry.url = URL.createObjectURL(blob);
                    for (const el of entry.waiting) el.src = entry.url;
                    entry.waiting = [];
                })
                .catch(() => { entry.waiting = []; });
        }
        if (entry.url) img.src = entry.url; else entry.waiting.push(img);
    }

    function renderQueue(s) {
        const q = s.queue && Array.isArray(s.queue.items) && s.queue.items.length ? s.queue : null;
        const stage = $("stage"), tab = $("stageTab");
        if (!q) {
            stageView = "viz";
            queueKey = null;
            stage.dataset.view = "viz";
            tab.hidden = true;
            return;
        }
        stage.dataset.view = stageView;
        tab.hidden = false;
        setText(tab, stageView === "viz" ? "Up next" : "Visualiser");
        const key = `${s.source.instance}|${q.rev}`;
        if (key === queueKey) return;
        queueKey = key;
        // Covers of an older queue are released at once.
        const keep = new Set(q.items.map(i => i.art && i.art.url));
        for (const [url, entry] of queueBlobs) {
            if (keep.has(url)) continue;
            if (entry.url) URL.revokeObjectURL(entry.url);
            queueBlobs.delete(url);
        }
        const rows = q.items.map(item => {
            const li = document.createElement("li");
            const img = document.createElement("img");
            img.alt = "";
            if (item.art && item.art.url) queueImage(item.art.url, img);
            const text = document.createElement("span");
            const t = document.createElement("b");
            const a = document.createElement("i");
            t.textContent = item.title || "";
            a.textContent = item.artist || "";
            text.append(t, a);
            li.append(img, text);
            return li;
        });
        $("queue").replaceChildren(...rows);
    }

    $("stage").addEventListener("click", () => {
        if ($("stageTab").hidden) return;
        stageView = stageView === "viz" ? "queue" : "viz";
        if (snap) renderQueue(snap);
    });

    function renderControls(session, stale) {
        const caps = session.caps || {};
        for (const [id, cap] of [["prev", "prev"], ["play", "playPause"], ["next", "next"]]) {
            const btn = $(id);
            btn.disabled = stale || !caps[cap];
            btn.title = !caps[cap] ? "Not supported by this player" : stale ? "Unavailable while data is stale" : "";
        }
        $("play").setAttribute("aria-label", session.playback === "playing" ? "Pause" : session.playback === "unknown" ? "Play or pause" : "Play");
    }

    function showEmpty(title, sub, actionLabel, action) {
        $("empty").classList.remove("idle");
        player.dataset.view = "empty";
        player.removeAttribute("data-stale");
        artKey = null;
        clearArt();
        setText($("emptyTitle"), title);
        setText($("emptySub"), sub);
        const btn = $("emptyAction");
        btn.hidden = !actionLabel;
        setText(btn, actionLabel || "");
        btn.onclick = action || null;
        $("empty").hidden = false;
    }

    // Nothing to show: the clock, so the screen still earns its place.
    function showIdle() {
        showEmpty("", "");
        const now = new Date();
        setText($("emptyTitle"), now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
        setText($("emptySub"), `${now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })} · Nothing playing`);
        $("empty").classList.add("idle");
    }

    function render() {
        theme();
        const s = snap;
        if (!s) return showEmpty(empty[0], empty[1]);
        const session = s.session;
        if (!session) {
            if (s.error) return showEmpty("Media sessions unavailable", s.error);
            if (!s.source.connected) return showEmpty("Media source offline", "Title, artwork and controls return when it reconnects.");
            if (s.selection && s.selection.missing) {
                return showEmpty(`${s.selection.missingName || "Player"} closed`, "The player you picked is no longer available.",
                    "Follow active player", () => send({ type: "select", mode: "auto" }));
            }
            return showIdle();
        }
        const stale = isStale(s);
        $("empty").hidden = true;
        player.dataset.view = "content";
        player.toggleAttribute("data-stale", stale);
        player.dataset.playback = PLAYBACK_LABEL[session.playback] ? session.playback : "unknown";
        setText($("appName"), session.app.name);
        renderLogo(session.app.name);
        animateTrackChange(session);
        setText($("playState"), PLAYBACK_LABEL[player.dataset.playback]);
        setText($("title"), session.title || "Untitled");
        setText($("artist"), session.artist || "");
        setText($("album"), session.album || "");
        $("artist").hidden = !session.artist;
        $("album").hidden = !session.album;
        renderPill(s, stale);
        renderControls(session, stale);
        renderArt(s, session);
        syncCoverColor();
        renderTimeline(session);
        renderLyrics(session);
        renderSystem(s, session);
        renderQueue(s);
    }

    // ---------- Actions ----------
    function command(cmd, value) {
        const session = snap && snap.session;
        if (!session) return;
        // sessionId + rev let the source refuse a command aimed at a track that already changed.
        send({ type: "command", cmd, sessionId: session.id, rev: session.rev, value });
    }

    $("play").addEventListener("click", () => command("playPause"));
    $("prev").addEventListener("click", () => command("prev"));
    $("next").addEventListener("click", () => command("next"));

    const seek = $("seek");
    seek.addEventListener("input", () => {
        dragging = true;
        seek.style.setProperty("--pct", `${(Number(seek.value) / Number(seek.max) * 100).toFixed(2)}%`);
        setText($("pos"), fmt(Number(seek.value)));
    });
    seek.addEventListener("change", () => {
        dragging = false;
        command("seek", Number(seek.value));
    });
    seek.addEventListener("pointercancel", () => { dragging = false; });

    // Swipe on the artwork complements the visible buttons; it never replaces them.
    let swipeX = null;
    // Captured, so a swipe ending outside the artwork still ends here and never leaves a stale start point.
    $("artZone").addEventListener("pointerdown", e => { swipeX = e.clientX; e.currentTarget.setPointerCapture(e.pointerId); });
    $("artZone").addEventListener("pointercancel", () => { swipeX = null; });
    $("artZone").addEventListener("pointerup", e => {
        if (swipeX === null) return;
        const dx = e.clientX - swipeX;
        swipeX = null;
        const id = dx < 0 ? "next" : "prev";
        if (Math.abs(dx) > 60 && !$(id).disabled) command(id);
    });

    // ---------- Source picker ----------
    function closeSheet() {
        $("sheet").hidden = true;
        $("sourceBtn").focus();
    }

    function sheetItem(label, sub, pressed, onPick) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sheet-item";
        btn.setAttribute("aria-pressed", String(pressed));
        const b = document.createElement("b");
        const span = document.createElement("span");
        b.textContent = label;
        span.textContent = sub;
        btn.append(b, span);
        btn.addEventListener("click", () => { onPick(); closeSheet(); });
        return btn;
    }

    $("sourceBtn").addEventListener("click", () => {
        if (!snap || !snap.selection) return;
        const sel = snap.selection;
        const list = $("sheetList");
        list.replaceChildren(sheetItem("Automatic", "Follows the active player", sel.mode === "auto", () => send({ type: "select", mode: "auto" })));
        for (const item of snap.sessions || []) {
            list.append(sheetItem(item.app.name, `${item.title || "No title"} · ${PLAYBACK_LABEL[item.playback] || "State unknown"}`,
                sel.mode === "manual" && sel.sessionId === item.id, () => send({ type: "select", mode: "manual", sessionId: item.id })));
        }
        $("sheet").hidden = false;
        list.firstElementChild.focus();
    });
    $("sheetClose").addEventListener("click", closeSheet);
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

    // ---------- Source: iCUE Edge Companion ----------
    const companion = { wire: null, live: false, tried: false, downSince: Date.now(), refused: false };
    const blobs = new Map();

    // Artwork is fetched with the same connection rules as the data, then shown from a blob URL.
    // Only the image of the snapshot on screen is kept; replaced ones are released at once.
    function withArt(wire) {
        const s = wire.session;
        const art = s && s.art;
        const key = art ? `${wire.source.instance}|${art.sessionId}|${art.rev}` : null;
        for (const [k, entry] of blobs) {
            if (k === key) continue;
            entry.controller.abort();
            if (entry.url) URL.revokeObjectURL(entry.url);
            blobs.delete(k);
        }
        if (!key) return wire;
        let entry = blobs.get(key);
        if (!entry) {
            entry = { state: "pending", url: null, controller: new AbortController() };
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
                    entry.state = "ready";
                    choose();
                })
                .catch(() => { if (blobs.get(key) === entry) { entry.state = "error"; choose(); } });
        }
        const shown = { ...s, art: entry.url ? { ...art, url: entry.url } : null, artState: entry.state };
        return { ...wire, session: shown };
    }

    function companionSend(msg) {
        const path = msg.type === "command" ? "/api/media/command" : msg.type === "select" ? "/api/media/select" : null;
        if (!path) return;
        const body = msg.type === "command"
            ? { cmd: msg.cmd, sessionId: msg.sessionId, rev: msg.rev, value: msg.value }
            : { mode: msg.mode, sessionId: msg.sessionId };
        // text/plain keeps it a simple request (no preflight); the companion parses the JSON body.
        fetch(ENDPOINT + path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), credentials: "omit", cache: "no-store" })
            .catch(() => {});
    }

    function receive(wire) {
        if (!wire || wire.schema !== "media/1") return;
        companion.wire = wire;
        companion.live = companion.tried = true;
        companion.refused = false;
        choose();
    }

    async function streamOnce() {
        const res = await fetch(ENDPOINT + "/api/media/events", { cache: "no-store", credentials: "omit" });
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
            if (companion.live) companion.downSince = Date.now();
            companion.live = false;
            companion.tried = true;
            companion.refused = result === "unauthorized";
            choose();
            await new Promise(r => setTimeout(r, companion.refused ? 30000 : backoff));
            backoff = result === "closed" ? 2000 : Math.min(backoff * 2, 15000);
        }
    }

    // ---------- Source: native iCUE Media plugin (fallback) ----------
    const native = { wire: null, rev: 0, key: "", timer: null, requestId: 1, pending: new Map(), connected: null };
    const nativePlugin = () => window.plugins && window.plugins.Mediadataprovider;

    function nativeRequest(plugin, method) {
        return new Promise(resolve => {
            if (typeof plugin[method] !== "function") return resolve("");
            const id = native.requestId++;
            const timeout = setTimeout(() => { native.pending.delete(id); resolve(""); }, 900);
            native.pending.set(id, { resolve, timeout });
            try { plugin[method](id); } catch (_) { clearTimeout(timeout); native.pending.delete(id); resolve(""); }
        });
    }

    function nativeResponse(id, value) {
        const entry = native.pending.get(id);
        if (!entry) return;
        native.pending.delete(id);
        clearTimeout(entry.timeout);
        entry.resolve(String(value || ""));
    }

    async function pollNative() {
        const plugin = nativePlugin();
        if (!plugin) return;
        if (native.connected !== plugin && plugin.asyncResponse && plugin.asyncResponse.connect) {
            plugin.asyncResponse.connect(nativeResponse);
            native.connected = plugin;
        }
        let title = String(plugin.songName || "").trim();
        let artist = String(plugin.artist || "").trim();
        if (!title && !artist) [title, artist] = (await Promise.all([nativeRequest(plugin, "getSongName"), nativeRequest(plugin, "getArtist")])).map(v => v.trim());
        const key = `${title}\n${artist}`;
        if (key !== native.key) { native.key = key; native.rev++; }
        // The plugin exposes neither the playback state nor the player: shown as unknown, never guessed.
        native.wire = {
            v: 1,
            source: { kind: "native", connected: true, instance: "native", lastSeen: Date.now() },
            selection: { mode: "auto" },
            sessions: [],
            session: title || artist ? {
                id: "icue-media", rev: native.rev, app: { name: "Windows media" }, title, artist, album: "",
                playback: "unknown", timeline: null, caps: { playPause: true, next: true, prev: true, seek: false },
                art: null, artState: "none",
            } : null,
        };
        choose();
    }

    function nativeSend(msg) {
        const plugin = nativePlugin();
        if (!plugin || msg.type !== "command") return;
        const method = { playPause: "triggerPlayPause", next: "triggerNextTrack", prev: "triggerPreviousTrack" }[msg.cmd];
        if (method && typeof plugin[method] === "function") plugin[method]();
    }

    function setNative(on) {
        if (on && !native.timer) { pollNative(); native.timer = setInterval(pollNative, 1500); }
        if (!on && native.timer) { clearInterval(native.timer); native.timer = null; native.wire = null; }
    }

    // ---------- Source selection ----------
    // A short companion outage keeps its last data as stale; a longer one falls back to the
    // native plugin, labelled "Native mode". Demo data is never used outside the preview page.
    function choose() {
        const down = !companion.live && Date.now() - companion.downSince > NATIVE_AFTER_MS;
        setNative(down && !!nativePlugin());
        if (companion.live && companion.wire) {
            snap = withArt(companion.wire);
            send = companionSend;
        } else if (native.timer) {
            snap = native.wire;
            send = nativeSend;
            empty = ["Waiting for iCUE media", "Start playback in a media app."];
        } else if (companion.wire && !down) {
            snap = { ...withArt(companion.wire), source: { ...companion.wire.source, connected: false } };
            send = () => {};
        } else {
            snap = null;
            send = () => {};
            empty = !companion.tried ? ["Connecting…", "Looking for iCUE Edge Companion."]
                : companion.refused ? ["Access refused", "iCUE Edge Companion only answers iCUE."]
                : ["Companion not running", "Start iCUE Edge Companion to show artwork and controls."];
        }
        render();
    }

    // ---------- Source: preview page simulator (browser only) ----------
    // ponytail: postMessage with "*" because the preview may run from file://.
    const params = new URLSearchParams(location.search);
    if (params.get("source") === "preview" && window.parent !== window) {
        empty = ["Waiting for the simulator", "Open this widget from the preview page."];
        window.addEventListener("message", e => {
            if (e.source !== window.parent || !e.data || typeof e.data !== "object") return;
            if (e.data.type === "media-snapshot" && e.data.snapshot && e.data.snapshot.v === 1) {
                snap = e.data.snapshot;
                render();
            }
        });
        send = msg => window.parent.postMessage({ ...msg, type: `media-${msg.type}` }, "*");
        send({ type: "ready" });
        // The preview has no audio: a made-up spectrum stands in for the companion's stream.
        setInterval(() => {
            if (!vizWanted()) return;
            const t = Date.now() / 1000;
            vizSet(vizLevels.map((_, i) => Math.round(255 * Math.max(0, 0.55 + 0.4 * Math.sin(t * 3 + i * 0.7) * Math.sin(t * 1.3 + i * 0.3) - i * 0.012))));
        }, 60);
    } else {
        window.icueEvents = { onICUEInitialized: render, onDataUpdated: render };
        window.pluginMediadataproviderEvents = { onInitialized: choose };
        runCompanion();
        runViz();
        setInterval(choose, 1000);
    }

    render();
    // The widget checks freshness on its own clock, so a silent source still turns stale.
    setInterval(render, 500);
})();
