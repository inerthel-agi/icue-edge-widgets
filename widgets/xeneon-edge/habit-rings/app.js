(() => {
    "use strict";

    const storage = WidgetRuntime.storage("habit-rings", "xeneonHabitRingsV1");
    const RING_LEN = 326.726;
    const COLORS = ["#1db954", "#00c8ff", "#ffb84d"];
    const $ = id => document.getElementById(id);

    function setting(name, fallback) {
        try {
            if (name === "habit1Label" && typeof habit1Label !== "undefined") return habit1Label || fallback;
            if (name === "habit1Goal" && typeof habit1Goal !== "undefined") return Number(habit1Goal) || fallback;
            if (name === "habit2Label" && typeof habit2Label !== "undefined") return habit2Label || fallback;
            if (name === "habit2Goal" && typeof habit2Goal !== "undefined") return Number(habit2Goal) || fallback;
            if (name === "habit3Label" && typeof habit3Label !== "undefined") return habit3Label || fallback;
            if (name === "habit3Goal" && typeof habit3Goal !== "undefined") return Number(habit3Goal) || fallback;
        } catch (_) {}
        return fallback;
    }

    function todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }

    function defaults() {
        return { day: todayKey(), values: [0, 0, 0] };
    }

    function load() {
        try {
            const data = storage.read();
            if (data && data.day === todayKey() && Array.isArray(data.values)) return data;
        } catch (_) {}
        return defaults();
    }

    function save(state) {
        storage.write(state);
    }

    function habits() {
        return [
            { label: String(setting("habit1Label", "Water")).trim() || "Water", goal: Math.max(1, setting("habit1Goal", 8)), color: COLORS[0] },
            { label: String(setting("habit2Label", "Move")).trim() || "Move", goal: Math.max(1, setting("habit2Goal", 30)), color: COLORS[1] },
            { label: String(setting("habit3Label", "Read")).trim() || "Read", goal: Math.max(1, setting("habit3Goal", 20)), color: COLORS[2] }
        ];
    }

    let state = load();

    function ensureToday() {
        if (state.day !== todayKey()) {
            state = defaults();
            save(state);
        }
    }

    function dateLine() {
        $("dateLine").textContent = new Date().toLocaleDateString("en", {
            weekday: "long",
            month: "short",
            day: "numeric"
        });
    }

    function renderHabit(item, index) {
        const article = document.createElement("article");
        article.className = "habit";
        article.style.setProperty("--habit-color", item.color);
        article.innerHTML = `
            <div class="ring-wrap">
                <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
                    <circle class="track" cx="60" cy="60" r="52"></circle>
                    <circle class="fill" cx="60" cy="60" r="52"></circle>
                </svg>
                <div class="ring-center">
                    <b>0</b>
                    <small>%</small>
                </div>
            </div>
            <div class="habit-footer">
                <div class="x-stack">
                    <p class="x-truncate"></p>
                    <span class="x-truncate"></span>
                </div>
                <button type="button" class="add" data-index="${index}">+</button>
            </div>
        `;
        return article;
    }

    function render() {
        ensureToday();
        dateLine();
        const host = $("rings");
        habits().forEach((item, index) => {
            const article = host.children[index] || host.appendChild(renderHabit(item, index));
            const value = Number(state.values[index]);
            const current = Number.isFinite(value) ? Math.max(0, value) : 0;
            const ratio = Math.min(1, current / item.goal);
            article.querySelector(".fill").style.strokeDashoffset = String(RING_LEN * (1 - ratio));
            article.querySelector("b").textContent = Math.round(ratio * 100);
            article.querySelector("p").textContent = item.label;
            article.querySelector(".habit-footer span").textContent = `${current} / ${item.goal}`;
            article.querySelector("button").setAttribute("aria-label", `Add ${item.label}`);
        });
    }

    function increment(index) {
        ensureToday();
        const cfg = habits()[index];
        state.values[index] = Math.min(cfg.goal, Number(state.values[index] || 0) + 1);
        save(state);
        render();
    }

    $("rings").addEventListener("click", event => {
        const button = event.target.closest("button[data-index]");
        if (!button) return;
        increment(Number(button.dataset.index));
    });

    $("reset").addEventListener("click", () => {
        state = defaults();
        save(state);
        render();
    });

    function start() {
        render();
    }

    window.HabitRings = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: render };
    setInterval(() => { if (state.day !== todayKey()) render(); }, 60000);
    WidgetRuntime.onResume(render);
    start();
})();
