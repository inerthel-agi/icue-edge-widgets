(() => {
    "use strict";

    const $ = id => document.getElementById(id);
    const slots = Array.from(document.querySelectorAll(".clock-card"));
    let timer = null;

    function setting(name, fallback) {
        try {
            if (name === "clockTz1" && typeof clockTz1 !== "undefined") return clockTz1 || fallback;
            if (name === "clockTz2" && typeof clockTz2 !== "undefined") return clockTz2 || fallback;
            if (name === "clockTz3" && typeof clockTz3 !== "undefined") return clockTz3 || fallback;
            if (name === "clockTz4" && typeof clockTz4 !== "undefined") return clockTz4 || fallback;
            if (name === "clockFormat" && typeof clockFormat !== "undefined") return clockFormat || fallback;
        } catch (_) {}
        return fallback;
    }

    function safeFormat(date, options) {
        try {
            return new Intl.DateTimeFormat([], options).format(date);
        } catch (_) {
            return "--";
        }
    }

    function tzCity(tz) {
        if (!tz) return "--";
        const part = String(tz).split("/").pop() || tz;
        return part.replace(/_/g, " ");
    }

    function localHour(tz) {
        try {
            const parts = new Intl.DateTimeFormat([], { timeZone: tz, hour: "2-digit", hour12: false }).formatToParts(new Date());
            const h = parts.find(p => p.type === "hour");
            return h ? Number(h.value) : NaN;
        } catch (_) {
            return NaN;
        }
    }

    function tick() {
        const now = new Date();
        const hour12 = setting("clockFormat", "24h") === "12h";
        const timeOpts = { hour: "2-digit", minute: "2-digit", hour12 };
        const dateOpts = { weekday: "short", day: "2-digit", month: "short" };

        $("local").textContent = safeFormat(now, { ...timeOpts, second: "2-digit" });
        $("format").textContent = hour12 ? "12h" : "24h";

        const zones = [
            setting("clockTz1", "Europe/Paris"),
            setting("clockTz2", "America/New_York"),
            setting("clockTz3", "Asia/Tokyo"),
            setting("clockTz4", "UTC")
        ];

        slots.forEach((card, i) => {
            const tz = String(zones[i] || "").trim();
            const name = card.querySelector("[data-name]");
            const time = card.querySelector("[data-time]");
            const date = card.querySelector("[data-date]");
            const dot = card.querySelector("[data-dot]");
            if (!tz) {
                name.textContent = "--";
                time.textContent = "--:--";
                date.textContent = "Set time zone";
                dot.classList.remove("is-day");
                card.classList.remove("is-day");
                return;
            }
            name.textContent = tzCity(tz);
            time.textContent = safeFormat(now, { ...timeOpts, timeZone: tz });
            date.textContent = time.textContent === "--" ? "Invalid time zone" : safeFormat(now, { ...dateOpts, timeZone: tz });
            const h = localHour(tz);
            const isDay = Number.isFinite(h) && h >= 6 && h < 20;
            card.classList.toggle("is-day", isDay);
            dot.classList.toggle("is-day", isDay);
        });
    }

    function start() {
        if (timer) return;
        tick();
        timer = setInterval(tick, 1000);
    }

    window.WorldClock = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: tick };
    start();
})();
