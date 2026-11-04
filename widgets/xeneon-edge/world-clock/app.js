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

    // Newsroom wall: one analog clock per card, drawn once; the hands turn every second.
    const NS = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs, parent) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); parent.append(n); return n; };
    const faces = slots.map(card => {
        const s = svgEl("svg", { class: "face", viewBox: "0 0 100 100", "aria-hidden": "true" }, card);
        svgEl("circle", { class: "rim", cx: 50, cy: 50, r: 46 }, s);
        for (let i = 0; i < 60; i++) {
            const a = i * Math.PI / 30, big = i % 5 === 0, r1 = big ? 36 : 40;
            svgEl("line", { class: big ? "tk big" : "tk", x1: (50 + Math.sin(a) * r1).toFixed(1), y1: (50 - Math.cos(a) * r1).toFixed(1), x2: (50 + Math.sin(a) * 43).toFixed(1), y2: (50 - Math.cos(a) * 43).toFixed(1) }, s);
        }
        const h = svgEl("line", { class: "hh", x1: 50, y1: 54, x2: 50, y2: 27 }, s);
        const m = svgEl("line", { class: "mh", x1: 50, y1: 56, x2: 50, y2: 14 }, s);
        const sec = svgEl("line", { class: "sh", x1: 50, y1: 60, x2: 50, y2: 12 }, s);
        svgEl("circle", { class: "hub", cx: 50, cy: 50, r: 2.6 }, s);
        return { h, m, sec };
    });
    function hands(i, tz, now) {
        let hh = NaN, mm = NaN;
        try {
            const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
            hh = Number(p.find(x => x.type === "hour").value) % 24; mm = Number(p.find(x => x.type === "minute").value);
        } catch (_) { /* invalid zone: hands stay */ }
        if (!Number.isFinite(hh)) return;
        const s = now.getSeconds();
        faces[i].h.setAttribute("transform", `rotate(${((hh % 12) * 30 + mm / 2).toFixed(1)} 50 50)`);
        faces[i].m.setAttribute("transform", `rotate(${(mm * 6 + s / 10).toFixed(1)} 50 50)`);
        faces[i].sec.setAttribute("transform", `rotate(${s * 6} 50 50)`);
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
            hands(i, tz, now);
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
