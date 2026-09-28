(() => {
    "use strict";

    const TICK_MS = 60 * 1000;
    const $ = id => document.getElementById(id);
    let timer = null;

    function setting(name, fallback) {
        try {
            if (name === "countdown1Label" && typeof countdown1Label !== "undefined") return countdown1Label || fallback;
            if (name === "countdown1Date" && typeof countdown1Date !== "undefined") return countdown1Date || fallback;
            if (name === "countdown1Color" && typeof countdown1Color !== "undefined") return countdown1Color || fallback;
            if (name === "countdown2Label" && typeof countdown2Label !== "undefined") return countdown2Label || fallback;
            if (name === "countdown2Date" && typeof countdown2Date !== "undefined") return countdown2Date || fallback;
            if (name === "countdown2Color" && typeof countdown2Color !== "undefined") return countdown2Color || fallback;
            if (name === "countdown3Label" && typeof countdown3Label !== "undefined") return countdown3Label || fallback;
            if (name === "countdown3Date" && typeof countdown3Date !== "undefined") return countdown3Date || fallback;
            if (name === "countdown3Color" && typeof countdown3Color !== "undefined") return countdown3Color || fallback;
        } catch (_) {}
        return fallback;
    }

    function safeColor(value, fallback) {
        const color = String(value || "").trim();
        return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
    }

    function parseDate(value) {
        const raw = String(value || "").trim();
        const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!match) return null;
        const year = Number(match[1]), month = Number(match[2]) - 1, day = Number(match[3]);
        const date = new Date(0);
        date.setFullYear(year, month, day);
        date.setHours(0, 0, 0, 0);
        return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
    }

    function readEvents() {
        return [1, 2, 3].map(index => {
            const fallbackColor = index === 1 ? "#00c8ff" : index === 2 ? "#ffb84d" : "#a678ff";
            const date = parseDate(setting(`countdown${index}Date`, ""));
            return {
                label: String(setting(`countdown${index}Label`, `Event ${index}`)).trim() || `Event ${index}`,
                date,
                color: safeColor(setting(`countdown${index}Color`, fallbackColor), fallbackColor)
            };
        }).filter(item => item.date);
    }

    function daysLeft(date) {
        const today = new Date();
        function calendarDay(value) {
            const utc = new Date(0);
            utc.setUTCFullYear(value.getFullYear(), value.getMonth(), value.getDate());
            return utc.getTime() / 86400000;
        }
        return calendarDay(date) - calendarDay(today);
    }

    function dateLabel(date) {
        return date.toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "\"": "&quot;",
            "'": "&#39;"
        }[c]));
    }

    function status(days, label) {
        if (days < 0) return `${label} has passed.`;
        if (days === 0) return `${label} is today.`;
        if (days === 1) return `${label} is tomorrow.`;
        return `${label} is in ${days} days.`;
    }

    function renderCard(item, index) {
        const days = daysLeft(item.date);
        const card = document.createElement("article");
        card.className = "count-card x-card";
        card.style.borderColor = item.color;
        card.innerHTML = `
            <p class="x-kicker x-truncate">${escapeHtml(item.label)}</p>
            <b class="x-value">${days < 0 ? "Done" : days}</b>
            <small class="x-label">${days === 1 ? "Day" : "Days"}</small>
            <span class="date x-truncate">${dateLabel(item.date)}</span>
        `;
        return card;
    }

    function render() {
        const events = readEvents().sort((a, b) => daysLeft(a.date) - daysLeft(b.date));
        const upcoming = events.filter(item => daysLeft(item.date) >= 0);
        const next = upcoming[0] || events[0];
        const cards = $("cards");
        cards.innerHTML = "";

        if (!next) {
            $("overlay").classList.add("visible");
            return;
        }

        $("overlay").classList.remove("visible");
        const nextDays = daysLeft(next.date);
        document.documentElement.style.setProperty("--x-accent", next.color);
        $("nextLabel").textContent = next.label;
        $("nextDays").textContent = nextDays < 0 ? "Done" : String(nextDays);
        $("nextUnit").textContent = nextDays === 1 ? "day" : "days";
        $("nextStatus").textContent = status(nextDays, next.label);
        $("nextDate").textContent = dateLabel(next.date);
        events.slice(0, 3).forEach((item, index) => cards.appendChild(renderCard(item, index)));
    }

    function start() {
        if (!timer) timer = setInterval(render, TICK_MS);
        render();
    }

    window.Countdowns = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: render };
    start();
})();
