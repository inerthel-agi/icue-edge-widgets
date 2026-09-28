// Shared by the companion window, the tray card and the iCUE widgets.
// Converts the `ai-usage/1` snapshot into plain-language view data and keeps the connection alive.
// Nothing is invented: ages follow the clock, values change only when the companion sends new ones.
(function () {
    "use strict";

    // No browser context menu (Back, Refresh, Print…) in the window, tray card or widgets.
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    const cfg = document.body.dataset;
    const ENDPOINT = cfg.endpoint || "";
    const MODE = cfg.auth || "http"; // "tauri" (window, tray card) or "http" (iCUE widgets)
    const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";

    // ---------- formatting ----------
    const nf = new Intl.NumberFormat("en-US");
    const now = () => Date.now();
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    function big(v) {
        if (v == null) return "—";
        if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
        if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
        if (v >= 1e4) return Math.round(v / 1e3) + "k";
        return nf.format(v);
    }
    function dur(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        if (s < 60) return s + " s";
        const m = Math.round(s / 60);
        if (m < 60) return m + " min";
        const h = Math.floor(m / 60);
        if (h < 24) return h + " h " + String(m % 60).padStart(2, "0") + " min";
        return Math.floor(h / 24) + " d " + (h % 24) + " h";
    }
    const clock = (t) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(t);
    const dayClock = (t) => new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }).format(t);
    function resetText(t) {
        if (!t) return "reset time unknown";
        if (t <= now()) return "due " + clock(t) + ", waiting for a new reading";
        return (t - now() < 20 * 3600e3 ? "at " + clock(t) : dayClock(t)) + " · in " + dur(t - now());
    }
    const ago = (t) => (t ? dur(now() - t) + " ago" : "never");
    const level = (u) => (u >= 90 ? "danger" : u >= 75 ? "warn" : "");

    // ---------- wire (ai-usage/1) → view ----------
    // Brand marks from Simple Icons (CC0): Claude, the OpenAI mark for Codex, and Spotify.
    const svg = (d) => '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
    const LOGO = {
        claude: svg("m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"),
        codex: svg("M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"),
        spotify: svg("M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"),
    };

    const LEFT = { codex: true };

    function status(w, paused) {
        if (paused) return { state: "warn", text: "Paused", reason: "Collection is paused." };
        switch (w.status.state) {
            case "available": return { state: "live", text: "Active", reason: null };
            case "error": return { state: "danger", text: "Error", reason: w.status.label };
            case "stale": return { state: "warn", text: "Check", reason: w.status.label };
            case "unavailable": return { state: "idle", text: "Not detected", reason: w.name + " is not installed on this computer, or has not written anything yet." };
            default: return { state: "idle", text: "Idle", reason: null };
        }
    }

    function provider(w, paused) {
        const st = status(w, paused);
        const subset = w.tokenModel === "subset-cache";
        const dayStart = new Date(now()).setHours(0, 0, 0, 0);
        const sum = (k) => w.hours.filter((h) => h.start >= dayStart).reduce((a, h) => a + (h[k] || 0), 0);
        const t = { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), reasoning: sum("reasoning") };
        // Claude: cache is separate from input. Codex: cache is part of input. Never double-count.
        t.total = w.detected ? (subset ? t.input + t.output : t.input + t.output + t.cacheRead + t.cacheWrite) : null;
        t.cacheIncluded = subset;

        // Codex limits read as what is left (like the Codex app); `used` still drives ordering and colours.
        const left = LEFT[w.provider];
        const limits = w.quotas.filter((q) => q.used && q.used.v != null).map((q) => {
            const used = Math.round(q.used.v);
            return {
                name: q.label, used, pct: left ? 100 - used : used, word: left ? "left" : "used",
                resetAt: q.resetsAt, stale: q.used.state !== "available", reason: q.used.reason, at: q.used.at, history: q.history || null,
            };
        });
        const limitsAt = limits.length ? Math.max(...limits.map((l) => l.at || 0)) : null;
        let limitsError = null;
        if (!limits.length) limitsError = w.quotaError ? w.quotaError.reason : w.detected ? "No limits reported yet." : null;

        const sessions = w.sessions.map((s) => ({
            id: s.id, client: s.client, model: s.model || "unknown model", active: s.active, last: s.lastEventAt,
            tokens: subset ? s.tokens.input + s.tokens.output : s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite,
            context: s.context,
        }));
        const live = sessions.find((s) => s.active && s.context.used != null);
        const active = w.clients.filter((c) => c.active).map((c) => c.label);

        return {
            id: w.provider, name: w.name, letter: LOGO[w.provider] || "?", detected: w.detected,
            state: st.state, stateText: st.text, reason: st.reason,
            refreshing: w.refreshing,
            clients: !w.detected ? w.name + " not detected" : active.length ? active.join(" + ") : "No app open",
            model: w.model ? w.model.v : null,
            limits, limitsAt, limitsError,
            tokens: t,
            context: live ? { used: live.context.used, capacity: live.context.capacity, estimate: w.src.contextKind === "estimate" } : null,
            sessions,
            events: w.events,
            src: w.src,
            lastEventAt: w.lastEventAt,
        };
    }

    function toView(wire) {
        const claude = provider(wire.providers.claude, wire.paused);
        const codex = provider(wire.providers.codex, wire.paused);
        return { paused: wire.paused, claude, codex };
    }

    // The reported limit closest to being reached is the headline figure.
    const tightest = (p) => (p.limits.length ? p.limits.reduce((a, l) => (l.used > a.used ? l : a)) : null);

    // Bar for a limit: width follows the displayed figure, colour follows the share used.
    const limitBar = (l, cls) => '<div class="bar ' + level(l.used) + (cls ? " " + cls : "") + '"><i data-w="' + l.pct + '"></i></div>';

    // WCAG contrast ratio of two CSS colours (any syntax the browser accepts); 21 when unknown.
    const ctx2d = document.createElement("canvas").getContext("2d");
    function rgb(c) {
        ctx2d.fillStyle = "#000"; ctx2d.fillStyle = String(c).trim() || "#000";
        ctx2d.fillRect(0, 0, 1, 1);
        return ctx2d.getImageData(0, 0, 1, 1).data;
    }
    function contrast(a, b) {
        const lum = (c) => { const [r, g, bl] = [...rgb(c)].slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
        try { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); } catch (_) { return 21; }
    }

    // ---------- 24 h trend (reported readings only; gaps stay gaps) ----------
    function trend(l) {
        const h = l && l.history;
        if (!h || h.v.filter((v) => v != null).length < 2) return null;
        // Until 24 h of readings exist, the x axis starts at the first reading so a short history stays readable.
        const first = h.v.findIndex((v) => v != null), n = h.v.length - 1, W = 144, H = 40;
        const X = (i) => ((i - first) / Math.max(1, n - first) * W).toFixed(1), Y = (v) => (H - Math.min(100, v) / 100 * (H - 2)).toFixed(1);
        let line = "", area = "", seg = [];
        const flush = () => {
            if (!seg.length) return;
            line += "M" + seg.map(([i, v]) => X(i) + " " + Y(v)).join("L") + (seg.length === 1 ? "h0.8" : "");
            area += "M" + X(seg[0][0]) + " " + H + "L" + seg.map(([i, v]) => X(i) + " " + Y(v)).join("L") + "L" + X(seg[seg.length - 1][0]) + " " + H + "Z";
            seg = [];
        };
        h.v.forEach((v, i) => (v == null ? flush() : seg.push([i, v])));
        flush();
        const svgHtml = '<svg class="spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="' + area + '"/><path class="line" d="' + line + '"/></svg>';
        const span = first === 0 ? "Last 24 h" : "Since " + clock(h.start + first * h.step);
        return { svg: svgHtml, peak: Math.max(...h.v.filter((v) => v != null)), span };
    }

    // When the limit would reach 100% if the last hour's pace continued. An estimate, labelled as such.
    function forecast(l) {
        const h = l && l.history;
        if (!h || !l.at || l.stale) return null;
        if (l.used >= 100) return { text: "Limit reached", warn: true };
        let pts = [];
        h.v.forEach((v, i) => {
            if (v == null) return;
            if (pts.length && v < pts[pts.length - 1].v - 5) pts = []; // reset: start over
            pts.push({ t: h.start + i * h.step + h.step / 2, v });
        });
        const base = pts.find((p) => p.t >= l.at - 70 * 60e3 && p.t < l.at);
        if (!base || l.at - base.t < 20 * 60e3) return null;
        const slope = (l.used - base.v) / (l.at - base.t);
        if (slope <= 0) return { text: "Flat over the last hour", warn: false };
        const eta = l.at + (100 - l.used) / slope;
        if (l.resetAt && eta >= l.resetAt) return { text: "At this pace, stays under 100% until the reset", warn: false };
        return { text: "At this pace, 100% " + (eta - now() < 20 * 3600e3 ? "around " + clock(eta) : dayClock(eta)) + " (estimate)", warn: true };
    }

    // ---------- connection ----------
    const link = { state: "connecting", message: "" };
    let onUpdate = () => {};
    let latest = null;
    let generation = 0;

    function setLink(state, message) {
        link.state = state;
        link.message = message || "";
        onUpdate();
    }
    function receive(wire) {
        if (!wire || wire.schema !== "ai-usage/1") return setLink("error", "Unknown data version: update iCUE Edge Companion.");
        latest = toView(wire);
        setLink("live");
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function runTauri() {
        const T = window.__TAURI__;
        await T.event.listen("usage-state", (e) => receive(e.payload));
        receive(await T.core.invoke("usage_state"));
    }

    // Widgets: SSE read through fetch(). No token: the companion recognises iCUE by the process behind the connection.
    async function streamOnce(gen, headers) {
        const res = await fetch(ENDPOINT + "/api/usage/events", { headers, cache: "no-store", credentials: "omit" });
        if (res.status === 401) return "unauthorized";
        if (!res.ok) return "error";
        if (!res.body || !res.body.getReader) return "no-stream";
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (gen === generation) {
            // The companion sends at least a ping every 15 s: 45 s of silence means a dead link, not a quiet one.
            let timer;
            const silent = new Promise((resolve) => { timer = setTimeout(() => resolve({ silent: true }), 45000); });
            const chunk = await Promise.race([reader.read(), silent]);
            clearTimeout(timer);
            if (chunk.silent) {
                try { reader.cancel(); } catch (_) {}
                return "error";
            }
            const { value, done } = chunk;
            if (done) break;
            buf += dec.decode(value, { stream: true });
            if (buf.length > 1024 * 1024) buf = "";
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
                const block = buf.slice(0, i);
                buf = buf.slice(i + 2);
                const lines = block.split("\n");
                const ev = (lines.find((l) => l.startsWith("event:")) || "").slice(6).trim();
                const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
                if (ev === "state" && data) {
                    try { receive(JSON.parse(data)); } catch (_) { /* malformed event: wait for the next one */ }
                }
            }
        }
        try { reader.cancel(); } catch (_) {}
        return "closed";
    }

    // Fallback when the host cannot stream a fetch body.
    async function poll(gen, headers) {
        while (gen === generation) {
            try {
                const res = await fetch(ENDPOINT + "/api/usage/state", { headers, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(10000) });
                if (res.status === 401) return "unauthorized";
                if (res.ok) receive(await res.json());
            } catch (_) { setLink("reconnecting"); }
            await sleep(10000);
        }
        return "closed";
    }

    async function run() {
        if (MODE === "tauri") {
            try { await runTauri(); } catch (_) { setLink("error", "Cannot reach the companion."); }
            return;
        }
        const gen = ++generation;
        let backoff = 2000;
        const headers = {};
        while (gen === generation) {
            let result;
            try {
                result = await streamOnce(gen, headers);
                if (result === "no-stream") result = await poll(gen, headers);
            } catch (_) { result = "error"; }
            if (gen !== generation) return;
            if (result === "unauthorized") {
                setLink("unauthorized", "iCUE Edge Companion refused the connection: only iCUE may read this data.");
                await sleep(30000);
                continue;
            }
            setLink("reconnecting", "iCUE Edge Companion is unreachable. Retrying automatically.");
            await sleep(backoff);
            backoff = result === "closed" ? 2000 : Math.min(backoff * 2, 30000);
        }
    }

    const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);

    function refresh() {
        if (MODE === "tauri") return invoke("usage_refresh");
        return fetch(ENDPOINT + "/api/usage/refresh", { method: "POST", credentials: "omit" }).then((r) => r.ok);
    }

    function start(callback) {
        onUpdate = callback;
        // iCUE widgets: settings changes only restyle, the connection stays open.
        if (MODE === "http") window.icueEvents = { onICUEInitialized: () => onUpdate(), onDataUpdated: () => onUpdate() };
        run();
        setInterval(() => onUpdate(), 10000); // ages only; values never move on their own
        window.addEventListener("online", () => { if (MODE === "http" && link.state !== "live") run(); });
    }

    // CSP forbids inline style attributes: bar widths are applied through the CSSOM after rendering.
    function applyWidths(root) {
        root.querySelectorAll("[data-w]").forEach((el) => { el.style.width = Math.max(0, Math.min(100, Number(el.dataset.w))) + "%"; });
    }

    window.Usage = {
        start, refresh, invoke, applyWidths, LOGO, limitBar, trend, forecast, contrast, get view() { return latest; }, link, TZ,
        esc, big, dur, resetText, ago, level, tightest, nf,
    };
})();
