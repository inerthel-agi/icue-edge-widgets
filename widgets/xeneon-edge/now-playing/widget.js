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

    // ---------- Artwork ----------
    function clearArt() {
        const img = $("art");
        img.hidden = true;
        img.removeAttribute("src");
        player.dataset.art = "none";
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
        setText($("dur"), dur === null ? "Length unknown" : fmt(dur));
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
            return showEmpty("Nothing playing", "Start playback in a media app.");
        }
        const stale = isStale(s);
        $("empty").hidden = true;
        player.dataset.view = "content";
        player.toggleAttribute("data-stale", stale);
        player.dataset.playback = PLAYBACK_LABEL[session.playback] ? session.playback : "unknown";
        setText($("appName"), session.app.name);
        setText($("playState"), PLAYBACK_LABEL[player.dataset.playback]);
        setText($("title"), session.title || "Untitled");
        setText($("artist"), session.artist || "");
        setText($("album"), session.album || "");
        $("artist").hidden = !session.artist;
        $("album").hidden = !session.album;
        renderPill(s, stale);
        renderControls(session, stale);
        renderArt(s, session);
        renderTimeline(session);
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
    } else {
        window.icueEvents = { onICUEInitialized: render, onDataUpdated: render };
        window.pluginMediadataproviderEvents = { onInitialized: choose };
        runCompanion();
        setInterval(choose, 1000);
    }

    render();
    // The widget checks freshness on its own clock, so a silent source still turns stale.
    setInterval(render, 500);
})();
