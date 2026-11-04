(() => {
    "use strict";
    const MAX_JSON_BYTES = 2 * 1024 * 1024;

    function storage(namespace, legacyKey) {
        function key() {
            return typeof uniqueId !== "undefined" && uniqueId ? String(uniqueId) : `icue-edge-widgets:${namespace}`;
        }
        function record() {
            const raw = localStorage.getItem(key());
            const value = raw ? JSON.parse(raw) : {};
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_storage");
            return value;
        }
        return {
            read() {
                try {
                    const value = record();
                    if (Object.prototype.hasOwnProperty.call(value, namespace)) return value[namespace];
                    const legacy = localStorage.getItem(legacyKey);
                    if (!legacy) return null;
                    try { return JSON.parse(legacy); } catch (_) { return legacy; }
                } catch (_) { return null; }
            },
            write(value) {
                try {
                    const data = record();
                    data[namespace] = value;
                    localStorage.setItem(key(), JSON.stringify(data));
                    return true;
                } catch (_) { return false; }
            }
        };
    }

    async function readJson(response, abort) {
        const announced = Number(response.headers.get("content-length"));
        if (Number.isFinite(announced) && announced > MAX_JSON_BYTES) {
            abort();
            throw new Error("response_too_large");
        }
        if (!response.body || !response.body.getReader) throw new Error("response_body_unavailable");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let total = 0, text = "";
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_JSON_BYTES) {
                abort();
                try { await reader.cancel(); } catch (_) { /* already closed */ }
                throw new Error("response_too_large");
            }
            text += decoder.decode(value, { stream: true });
        }
        return JSON.parse(text + decoder.decode());
    }

    async function requestJson(url, options = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const signal = options.signal;
        if (signal && signal.aborted) abort();
        signal && signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, 12000);
        try {
            const response = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}`);
                error.status = response.status;
                const retry = response.headers.get("retry-after");
                const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
                const retryAt = retry === null ? 0 : /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
                error.rateLimited = response.status === 429 || (response.status === 403 &&
                    (response.headers.get("x-ratelimit-remaining") === "0" || retry !== null));
                error.retryAt = Math.max(Number.isFinite(retryAt) ? retryAt : 0,
                    error.rateLimited && Number.isFinite(reset) ? reset : 0);
                throw error;
            }
            return { data: await readJson(response, abort), headers: response.headers };
        } finally {
            clearTimeout(timeout);
            signal && signal.removeEventListener("abort", abort);
        }
    }

    function onResume(callback) {
        window.addEventListener("online", callback);
        window.addEventListener("pageshow", callback);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) callback(); });
    }

    function freshness(timestamp, state = "ready", retryAt = 0) {
        const age = Math.max(0, Date.now() - timestamp);
        const minutes = Math.floor(age / 60000);
        const elapsed = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` :
            minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} d ago`;
        const parts = [];
        if (state !== "ready") parts.push(state);
        parts.push(Number.isFinite(timestamp) && timestamp > 0 ? `Updated ${elapsed}` : "No data yet");
        if (retryAt > Date.now()) parts.push(`Retry at ${new Date(retryAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false })}`);
        return parts.join(" · ");
    }

    const DEFAULT_COLORS = ["#080a0b", "#f2f3ed", "#a8d5ba"];
    const STYLES = ["signature", "instrument", "apple", "openai", "spacex", "nothing", "anthropic", "google", "terminal", "corsair", "aurora", "paper", "brutalist", "synthwave", "abyss", "sunset", "newsprint", "blueprint", "forest", "pastel", "amber", "hud", "bloomberg"];

    // iCUE "Widget Personalization" globals -> shared tokens. Invalid or missing values keep the CSS defaults.
    function personalize() {
        const css = document.documentElement.style;
        const color = (token, value) => {
            // The iCUE defaults are not a choice: leaving them out lets the Style palette show.
            if (typeof value === "string" && CSS.supports("color", value) && !DEFAULT_COLORS.includes(value.trim().toLowerCase())) css.setProperty(token, value);
            else css.removeProperty(token);
        };
        color("--x-text", typeof textColor !== "undefined" ? textColor : null);
        color("--x-accent", typeof accentColor !== "undefined" ? accentColor : null);
        color("--x-bg", typeof backgroundColor !== "undefined" ? backgroundColor : null);
        const style = typeof widgetStyle !== "undefined" ? String(widgetStyle) : "";
        if (STYLES.includes(style)) document.documentElement.dataset.style = style; else delete document.documentElement.dataset.style;
        const t = Number(typeof transparency !== "undefined" ? transparency : NaN);
        if (Number.isFinite(t)) css.setProperty("--x-bg-opacity", String(Math.max(0, Math.min(1, t / 100))));
    }

    // Applied on load and re-applied so edits in iCUE settings show without a reload.
    if (typeof CSS !== "undefined" && CSS.supports) {
        document.addEventListener("DOMContentLoaded", personalize);
        setInterval(personalize, 1000);
    }

    window.WidgetRuntime = { storage, requestJson, onResume, freshness, personalize };

    // ---------- iCUE editor preview: draw at the real screen size, then scale down ----------
    // The editor shows a widget in a frame much smaller than the screen (about 340 px wide for an 840 px
    // slot), so size-based layouts pick the wrong arrangement and fixed sizes overflow. When the frame is
    // smaller than any real slot, this page becomes a host: it loads itself in an inner frame at the
    // slot's real size, scales that frame to fit, and hands it iCUE's settings and plugins. The host's
    // own copy of the widget gets no data (its requests never answer), so nothing runs twice.
    // ponytail: an L slot (1688 x 696) has the S slot's shape, so the editor shows it with the S layout.
    const SLOTS = [[840, 344], [696, 416], [840, 696], [696, 840], [1688, 696], [696, 1688], [2536, 696], [696, 2536], [480, 480]];
    function slotFor(w, h) {
        const a = w / h;
        return SLOTS.reduce((best, s) => (Math.abs(Math.log(a / (s[0] / s[1]))) < Math.abs(Math.log(a / (best[0] / best[1]))) ? s : best));
    }
    const settingNames = () => [...document.querySelectorAll('meta[name="x-icue-property"]')].map(m => m.getAttribute("content")).filter(Boolean);
    const HANDED = ["plugins", "iCUE", "iCUE_initialized", "uniqueId"];

    let parentHost = false;
    try { parentHost = !!window.parent && window.parent !== window &&window.parent.__fitHost === location.pathname; } catch (_) { parentHost = false; }

    if (parentHost) {
        // Inner frame: iCUE's settings and plugins come from the host page.
        const P = window.parent;
        const copy = () => {
            let changed = false;
            for (const n of [...settingNames(), ...HANDED]) {
                try { if (n in P && window[n] !== P[n]) { window[n] = P[n]; changed = true; } } catch (_) { /* not readable */ }
            }
            return changed;
        };
        copy();
        setInterval(() => {
            if (copy()) {
                personalize();
                try { window.icueEvents && window.icueEvents.onDataUpdated && window.icueEvents.onDataUpdated(); } catch (_) {}
            }
        }, 700);
    } else if (window.parent && window.parent !== window && typeof window.innerWidth === "number" && (window.innerWidth < 470 || window.innerHeight < 300) &&!/[?&]nofit\b/.test(location.search)) {
        window.__fitHost = location.pathname;
        // The host's own widget code still runs (its script follows this one) but stays empty: no answers.
        window.fetch = () => new Promise(() => {});
        window.EventSource = function () { return { close() {}, addEventListener() {}, removeEventListener() {} }; };
        const frame = document.createElement("iframe");
        frame.title = "Widget";
        frame.setAttribute("scrolling", "no");
        frame.src = location.href;
        Object.assign(frame.style, { position: "fixed", left: "0", top: "0", border: "0", transformOrigin: "0 0", zIndex: "2147483647", background: "transparent" });
        const fit = () => {
            const [w, h] = slotFor(innerWidth, innerHeight);
            const k = Math.min(innerWidth / w, innerHeight / h);
            frame.width = String(w);
            frame.height = String(h);
            frame.style.transform = `translate(${(innerWidth - w * k) / 2}px, ${(innerHeight - h * k) / 2}px) scale(${k})`;
        };
        const mount = () => {
            fit();
            document.body.append(frame);
            for (const el of document.body.children) if (el !== frame) el.style.visibility = "hidden";
        };
        if (document.body) mount(); else document.addEventListener("DOMContentLoaded", mount);
        window.addEventListener("resize", fit);
        // iCUE calls the host's events: pass them on to the inner page.
        setTimeout(() => {
            const inner = () => { try { return frame.contentWindow.icueEvents; } catch (_) { return null; } };
            window.icueEvents = {
                onICUEInitialized: () => { const e = inner(); e && e.onICUEInitialized && e.onICUEInitialized(); },
                onDataUpdated: () => { const e = inner(); e && e.onDataUpdated && e.onDataUpdated(); },
            };
        }, 0);
    }
})();
