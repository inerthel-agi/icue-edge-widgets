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

    window.WidgetRuntime = { storage, requestJson, onResume, freshness };
})();
