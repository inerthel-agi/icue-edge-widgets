(() => {
    "use strict";

    const $ = id => document.getElementById(id);
    const FACES = ["flip", "nixie", "vfd"];
    const setting = (name, fallback) => (typeof window[name] !== "undefined" && window[name] !== null && window[name] !== "" ? window[name] : fallback);
    const digits = [];   // { el, value, timer }
    let shape = "";

    function make(tag, cls, text) {
        const el = document.createElement(tag);
        el.className = cls;
        if (text !== undefined) el.textContent = text;
        return el;
    }

    // A digit: two fixed halves and two flaps that turn over when the value changes.
    function digit() {
        const el = make("span", "digit");
        for (const cls of ["half top", "half bottom", "flap top", "flap bottom"]) {
            const part = make("span", cls);
            part.append(make("i", ""));
            el.append(part);
        }
        return { el, value: null, timer: 0 };
    }

    function face() { const f = String(setting("clockFace", "flip")); return FACES.includes(f) ? f : "flip"; }

    function build(groups, period) {
        const clock = $("clock");
        clock.replaceChildren();
        digits.length = 0;
        groups.forEach((n, i) => {
            if (i) clock.append(make("span", "colon", ":"));
            const g = make("span", "group");
            for (let k = 0; k < n; k++) { const d = digit(); digits.push(d); g.append(d.el); }
            clock.append(g);
        });
        if (period) clock.append(make("span", "period", ""));
        $("widget").style.setProperty("--n", String(digits.length));
        $("widget").style.setProperty("--groups", String(groups.length));
    }

    function set(d, value, animate) {
        if (d.value === value) return;
        const old = d.value === null ? value : d.value;
        d.value = value;
        const [top, bottom, flapTop, flapBottom] = d.el.querySelectorAll("i");
        top.textContent = value;
        flapBottom.textContent = value;
        flapTop.textContent = old;
        clearTimeout(d.timer);
        if (!animate || old === value) { bottom.textContent = value; d.el.classList.remove("flip"); return; }
        bottom.textContent = old;
        d.el.classList.remove("flip");
        void d.el.offsetWidth;   // restarts the animation
        d.el.classList.add("flip");
        d.timer = setTimeout(() => { bottom.textContent = value; d.el.classList.remove("flip"); }, 620);
    }

    function tick() {
        const now = new Date();
        const h12 = setting("clockFormat", "24h") === "12h";
        const secs = setting("clockSeconds", false) === true || setting("clockSeconds", false) === "true";
        const f = face();
        const key = `${h12}|${secs}`;
        if (key !== shape) { shape = key; build(secs ? [2, 2, 2] : [2, 2], h12); }
        $("widget").dataset.face = f;
        let h = now.getHours();
        if (h12) h = h % 12 || 12;
        const text = String(h).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0") + (secs ? String(now.getSeconds()).padStart(2, "0") : "");
        const animate = f === "flip" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
        [...text].forEach((c, i) => set(digits[i], c, animate));
        const period = $("clock").querySelector(".period");
        if (period) period.textContent = now.getHours() < 12 ? "AM" : "PM";
        const showDate = setting("clockDate", true) !== false && setting("clockDate", true) !== "false";
        $("date").hidden = !showDate;
        $("date").textContent = now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
        $("clock").setAttribute("aria-label", now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: h12 }));
    }

    // Ticks on the second boundary so the minute flips when the minute changes.
    function loop() { tick(); setTimeout(loop, 1000 - (Date.now() % 1000) + 5); }

    window.icueEvents = { onICUEInitialized: tick, onDataUpdated: tick };
    loop();
})();
