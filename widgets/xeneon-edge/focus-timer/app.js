(() => {
    "use strict";

    const storage = WidgetRuntime.storage("focus-timer", "xeneonFocusState");
    const RING_LEN = 326.726;
    const $ = id => document.getElementById(id);
    let timer = null;

    function setting(name, fallback) {
        try {
            if (name === "focusWork" && typeof focusWork !== "undefined") return Number(focusWork) || fallback;
            if (name === "focusBreak" && typeof focusBreak !== "undefined") return Number(focusBreak) || fallback;
            if (name === "focusLong" && typeof focusLong !== "undefined") return Number(focusLong) || fallback;
            if (name === "focusCycles" && typeof focusCycles !== "undefined") return Number(focusCycles) || fallback;
        } catch (_) {}
        return fallback;
    }

    function durations() {
        return {
            work: Math.min(60, Math.max(5, setting("focusWork", 25))) * 60000,
            short: Math.min(30, Math.max(3, setting("focusBreak", 5))) * 60000,
            long: Math.min(45, Math.max(10, setting("focusLong", 15))) * 60000,
            cycles: Math.min(8, Math.max(2, Math.round(setting("focusCycles", 4))))
        };
    }

    function modeDuration(state, d) {
        if (state.mode === "work") return d.work;
        if (state.mode === "long") return d.long;
        return d.short;
    }

    function load() {
        try {
            const saved = storage.read();
            if (saved) {
                if (!saved || !["work", "break", "long"].includes(saved.mode) ||
                    !Number.isFinite(saved.remaining) || saved.remaining < 0 || saved.remaining > 3600000 ||
                    !Number.isInteger(saved.cycle) || saved.cycle < 1 || saved.cycle > 8 ||
                    typeof saved.running !== "boolean" || !Number.isFinite(saved.startedAt)) return null;
                // Older snapshots saved reduced remaining time with the original start time.
                // That elapsed time cannot be recovered; resume the last saved duration once.
                if (saved.version !== 2) saved.startedAt = Date.now();
                return saved;
            }
        } catch (_) {}
        return null;
    }

    function save(state) {
        storage.write({ ...state, version: 2 });
    }

    let state = load() || {
        mode: "work",
        cycle: 1,
        running: false,
        startedAt: 0,
        remaining: 0
    };

    function ensureRemaining(d) {
        if (state.remaining > 0) return;
        state.remaining = modeDuration(state, d);
    }

    function pad(n) { return String(n).padStart(2, "0"); }

    function fmt(ms) {
        const s = Math.max(0, Math.ceil(ms / 1000));
        return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
    }

    function modeLabel() {
        if (state.mode === "work") return "Work";
        if (state.mode === "long") return "Long Break";
        return "Break";
    }

    function advance(d, startedAt) {
        if (state.mode === "work") {
            const isLast = state.cycle >= d.cycles;
            state.mode = isLast ? "long" : "break";
        } else if (state.mode === "long") {
            state.mode = "work";
            state.cycle = 1;
        } else {
            state.mode = "work";
            state.cycle = Math.min(d.cycles, state.cycle + 1);
        }
        state.remaining = modeDuration(state, d);
        state.running = true;
        state.startedAt = startedAt;
    }

    function renderDots(total, current, mode) {
        const host = $("cycleDots");
        if (!host) return;
        if (host.childElementCount !== total) {
            host.innerHTML = "";
            for (let i = 0; i < total; i++) {
                const d = document.createElement("span");
                d.className = "cd";
                host.appendChild(d);
            }
        }
        const nodes = host.children;
        for (let i = 0; i < total; i++) {
            const cls = nodes[i].classList;
            cls.remove("done", "active");
            const idx = i + 1;
            if (idx < current) cls.add("done");
            else if (idx === current && mode === "work") cls.add("active");
            else if (idx < current || (idx === current && mode !== "work")) cls.add("done");
        }
    }

    function flash() {
        document.body.dataset.flash = "1";
        setTimeout(() => { document.body.dataset.flash = "0"; }, 600);
    }

    function tick() {
        const d = durations();
        ensureRemaining(d);
        let remaining = state.remaining;
        if (state.running) {
            const cycleLength = d.cycles * d.work + (d.cycles - 1) * d.short + d.long;
            const elapsed = Math.max(0, Date.now() - state.startedAt);
            if (elapsed >= cycleLength) state.startedAt += Math.floor(elapsed / cycleLength) * cycleLength;
            remaining = state.remaining - (Date.now() - state.startedAt);
            let advanced = false;
            while (remaining <= 0) {
                advance(d, state.startedAt + state.remaining);
                remaining = state.remaining - (Date.now() - state.startedAt);
                advanced = true;
            }
            if (advanced) flash();
            if (advanced || elapsed >= cycleLength) save(state);
        }
        const total = modeDuration(state, d);
        const ratio = Math.max(0, Math.min(1, remaining / total));
        $("time").textContent = fmt(remaining);
        $("ringFill").setAttribute("stroke-dashoffset", String(RING_LEN * (1 - ratio)));
        $("modeBadge").textContent = modeLabel();
        $("cycle").textContent = `Cycle ${state.cycle} / ${d.cycles}`;
        renderDots(d.cycles, state.cycle, state.mode);
        document.body.dataset.mode = state.mode === "long" ? "long" : state.mode === "break" ? "break" : "work";
        $("btnStart").textContent = state.running ? "Pause" : "Start";
    }

    function toggle() {
        tick();
        const d = durations();
        ensureRemaining(d);
        if (state.running) {
            state.remaining = Math.max(0, state.remaining - (Date.now() - state.startedAt));
            state.running = false;
        } else {
            state.startedAt = Date.now();
            state.running = true;
        }
        save(state);
        tick();
    }

    function reset() {
        const d = durations();
        state = { mode: "work", cycle: 1, running: false, startedAt: 0, remaining: d.work };
        save(state);
        tick();
    }

    $("btnStart").addEventListener("click", toggle);
    $("btnReset").addEventListener("click", reset);

    function start() {
        if (timer) return;
        tick();
        save(state);
        timer = setInterval(tick, 250);
    }

    window.FocusTimer = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: () => {} };
    WidgetRuntime.onResume(tick);
    start();
})();
