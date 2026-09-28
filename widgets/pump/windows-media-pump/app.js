(() => {
    "use strict";

    // Pump LCD view of one MediaSnapshot (schema media/1). No touch: display only.
    // Sources, in order of preference:
    //  - iCUE Edge Companion on 127.0.0.1 (artwork, state, timeline);
    //  - the native iCUE Media plugin (title and artist only), shown as "Native mode";
    //  - the preview page, only with ?source=preview inside a frame.
    const STALE_MS = 10000;
    const NATIVE_AFTER_MS = 8000;
    const MAX_ART_BYTES = 4 * 1024 * 1024;
    const RING = 2 * Math.PI * 48.5;
    const STATE = { playing: "Playing", paused: "Paused", stopped: "Stopped" };
    const ENDPOINT = document.body.dataset.endpoint;
    const $ = id => document.getElementById(id);
    const root = $("widget");

    let snap = null;
    let empty = ["Connecting…", "Looking for iCUE Edge Companion."];
    let artKey = null;
    let artToken = 0;

    const setText = (el, value) => { if (el.textContent !== value) el.textContent = value; };
    const finite = n => typeof n === "number" && Number.isFinite(n);
    const isStale = s => !s.source.connected || Date.now() - s.source.lastSeen > STALE_MS;

    function fmt(sec) {
        sec = Math.max(0, Math.floor(sec));
        const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, "0");
        return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
    }

    // ---------- Artwork ----------
    function renderArt(s, session) {
        const art = session.art;
        // Artwork is shown only when it belongs to this exact session and metadata revision.
        const valid = !!art && art.sessionId === session.id && art.rev === session.rev;
        const key = `${s.source.instance}|${session.id}|${session.rev}|${valid ? art.url : "-"}`;
        if (key === artKey) return;
        artKey = key;
        const token = ++artToken;
        const img = $("art");
        img.hidden = true;
        img.removeAttribute("src");
        if (!valid) return;
        const probe = new Image();
        probe.onload = () => { if (token === artToken) { img.src = art.url; img.hidden = false; } };
        probe.src = art.url;
    }

    // ---------- Timeline ----------
    function renderTimeline(s, session) {
        const t = session.timeline;
        const dur = t && finite(t.duration) && t.duration > 0 ? t.duration : null;
        let pos = t && finite(t.position) ? t.position : null;
        if (pos !== null && session.playback === "playing") {
            // Stale data must not keep extrapolating: freeze at the last moment the source was seen.
            const until = isStale(s) ? Math.min(Date.now(), s.source.lastSeen) : Date.now();
            pos += Math.max(0, until - t.updatedAt) / 1000;
        }
        if (pos !== null && dur !== null) pos = Math.min(pos, dur);
        const times = $("times");
        if (t && t.live) times.innerHTML = '<span class="live">LIVE</span>';
        else if (pos !== null && dur !== null) setText(times, `${fmt(pos)} / ${fmt(dur)}`);
        else setText(times, "");
        times.hidden = !times.textContent;
        const pct = !t || t.live || pos === null || dur === null ? 0 : pos / dur;
        $("prog").style.strokeDasharray = `${(RING * pct).toFixed(2)} ${RING.toFixed(2)}`;
        $("bar").style.width = `${(pct * 100).toFixed(2)}%`;
    }

    // ---------- Main render ----------
    function showEmpty(title, sub) {
        root.dataset.view = "empty";
        root.removeAttribute("data-stale");
        artKey = null;
        setText($("emptyTitle"), title);
        setText($("emptySub"), sub);
        $("empty").hidden = false;
    }

    function render() {
        const s = snap;
        if (!s) return showEmpty(empty[0], empty[1]);
        const session = s.session;
        if (!session) {
            if (s.error) return showEmpty("Media sessions unavailable", s.error);
            if (!s.source.connected) return showEmpty("Media source offline", "Title and artwork return when it reconnects.");
            return showEmpty("Nothing playing", "Start playback in any media app.");
        }
        const stale = isStale(s);
        $("empty").hidden = true;
        root.dataset.view = "content";
        root.toggleAttribute("data-stale", stale);
        // An alert replaces the playback label, which is unreliable at that moment.
        const alert = !s.source.connected ? "Reconnecting…"
            : stale ? `Stale ${Math.round((Date.now() - s.source.lastSeen) / 1000)} s`
            : s.source.kind === "native" ? "Native mode" : "";
        const chip = $("chip");
        chip.className = alert ? "chip warn" : session.playback === "playing" ? "chip" : "chip idle";
        setText($("chipText"), alert || [session.app && session.app.name, STATE[session.playback]].filter(Boolean).join(" · "));
        setText($("title"), session.title || "Untitled");
        setText($("artist"), session.artist || "");
        $("artist").hidden = !session.artist;
        renderArt(s, session);
        renderTimeline(s, session);
    }

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
                    choose();
                })
                .catch(() => {});
        }
        return { ...wire, session: { ...s, art: entry.url ? { ...art, url: entry.url } : null } };
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
                const lines = buf.slice(0, i).split("\n");
                buf = buf.slice(i + 2);
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
        if (native.connected !== plugin) {
            // A replaced provider must never answer for the new one.
            const old = native.connected;
            if (old && old.asyncResponse && old.asyncResponse.disconnect) old.asyncResponse.disconnect(nativeResponse);
            for (const entry of native.pending.values()) { clearTimeout(entry.timeout); entry.resolve(""); }
            native.pending.clear();
            if (plugin.asyncResponse && plugin.asyncResponse.connect) plugin.asyncResponse.connect(nativeResponse);
            native.connected = plugin;
        }
        let title = String(plugin.songName || "").trim();
        let artist = String(plugin.artist || "").trim();
        if (!title && !artist) [title, artist] = (await Promise.all([nativeRequest(plugin, "getSongName"), nativeRequest(plugin, "getArtist")])).map(v => v.trim());
        if (plugin !== nativePlugin()) return;
        const key = `${title}\n${artist}`;
        if (key !== native.key) { native.key = key; native.rev++; }
        // The plugin exposes neither the playback state nor the player: left out, never guessed.
        native.wire = {
            v: 1,
            source: { kind: "native", connected: true, instance: "native", lastSeen: Date.now() },
            session: title || artist ? { id: "icue-media", rev: native.rev, app: null, title, artist, playback: "unknown", timeline: null, art: null } : null,
        };
        choose();
    }

    function setNative(on) {
        if (on && !native.timer) { pollNative(); native.timer = setInterval(pollNative, 1500); }
        if (!on && native.timer) { clearInterval(native.timer); native.timer = null; native.wire = null; }
    }

    // ---------- Source: file relay (pump LCD) ----------
    // iCUE renders pump widgets in a process that cannot reach 127.0.0.1. The companion writes
    // live/state.js (a call to pumpRelay) and the artwork next to this page; both are reloaded here.
    const relay = { wire: null, tag: null };
    window.pumpRelay = wire => {
        if (!wire || wire.schema !== "media/1") return;
        relay.wire = wire;
        choose();
    };
    function pollRelay() {
        if (relay.tag) relay.tag.remove();
        relay.tag = document.createElement("script");
        relay.tag.src = `live/state.js?t=${Date.now()}`;
        relay.tag.onerror = () => {};
        document.body.appendChild(relay.tag);
    }
    const relayLive = () => !!relay.wire && Date.now() - relay.wire.source.lastSeen < NATIVE_AFTER_MS;

    // ---------- Source selection ----------
    // A short companion outage keeps its last data as stale; a longer one falls back to the
    // native plugin, labelled "Native mode".
    function choose() {
        const down = !companion.live && !relayLive() && Date.now() - companion.downSince > NATIVE_AFTER_MS;
        setNative(down && !!nativePlugin());
        if (companion.live && companion.wire) {
            snap = withArt(companion.wire);
        } else if (relayLive()) {
            snap = relay.wire;
        } else if (native.timer) {
            snap = native.wire;
            empty = ["Waiting for iCUE media", "Start playback in any media app."];
        } else if (companion.wire && !down) {
            snap = { ...withArt(companion.wire), source: { ...companion.wire.source, connected: false } };
        } else {
            snap = null;
            empty = !companion.tried ? ["Connecting…", "Looking for iCUE Edge Companion."]
                : companion.refused ? ["Access refused", "iCUE Edge Companion only answers iCUE."]
                : ["Companion not running", "Start iCUE Edge Companion for artwork and progress."];
        }
        render();
    }

    // ---------- Source: preview page (browser only) ----------
    if (new URLSearchParams(location.search).get("source") === "preview" && window.parent !== window) {
        empty = ["Waiting for the preview", "Open this widget from the preview page."];
        window.addEventListener("message", e => {
            if (e.source !== window.parent || !e.data || e.data.type !== "media-snapshot") return;
            snap = e.data.snapshot || null;
            render();
        });
    } else {
        window.pluginMediadataproviderEvents = { onInitialized: choose };
        runCompanion();
        setInterval(() => { pollRelay(); choose(); }, 1000);
    }

    render();
    // The widget checks freshness on its own clock, so a silent source still turns stale.
    setInterval(render, 500);
})();
