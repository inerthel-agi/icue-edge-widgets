(() => {
    "use strict";

    const ENDPOINT = "http://127.0.0.1:47821";
    const POLL_MS = 15 * 1000;
    const CATS = [["work", "Work"], ["web", "Web"], ["media", "Media"], ["other", "Other"]];
    const $ = id => document.getElementById(id);
    const SVG = "http://www.w3.org/2000/svg";

    let timer = null, request = null, lastData = null, lastOk = 0, failed = false;

    /** "5 h 42" style parts from seconds. */
    function parts(secs) {
        const minutes = Math.round(Math.max(0, secs) / 60);
        return { h: Math.floor(minutes / 60), m: minutes % 60 };
    }

    function text(secs) {
        const { h, m } = parts(secs);
        return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
    }

    function make(tag, cls, content) {
        const el = document.createElement(tag);
        if (cls) el.className = cls;
        if (content !== undefined) el.textContent = content;
        return el;
    }

    /** Shows only the app rows that fit whole: row height depends on the Style and the format. */
    function fitApps() {
        const box = $("apps");
        const rows = [...box.children];
        rows.forEach(r => { r.hidden = false; r.classList.remove("cut"); });
        const bottom = box.getBoundingClientRect().bottom + 1;
        let hide = false;
        for (const r of rows) {
            // Rows hidden by the format's own rules (display: none) have no box and are left alone.
            if (!r.getClientRects().length) continue;
            if (hide || r.getBoundingClientRect().bottom > bottom) { hide = true; r.classList.add("cut"); }
        }
    }
    window.addEventListener("resize", fitApps);

    function render(data) {
        const { h, m } = parts(data.todaySecs);
        $("hh").textContent = h;
        $("hh").hidden = $("hhUnit").hidden = h === 0;
        $("mm").textContent = h ? String(m).padStart(2, "0") : m;
        $("delta").textContent = data.yesterdaySecs ? `Yesterday ${text(data.yesterdaySecs)}` : "No data for yesterday";

        const top = Math.max(1, ...(data.apps || []).map(a => a.secs));
        const rows = (data.apps || []).map(app => {
            const row = make("div", "app");
            // The application's icon, read by the companion (its initial when there is none).
            const name = make("span", "name");
            if (typeof app.icon === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(app.icon)) {
                const img = make("img", "ico");
                img.src = app.icon;
                img.alt = "";
                name.append(img);
            } else {
                name.append(make("i", "ico ini", (app.name || "?").charAt(0).toUpperCase()));
            }
            name.append(make("span", "label", app.name));
            row.append(name, make("b", "", text(app.secs)));
            const bar = make("div", "x-bar"), fill = document.createElement("i");
            fill.style.width = `${Math.round(app.secs / top * 100)}%`;
            bar.append(fill);
            row.append(bar);
            return row;
        });
        $("apps").replaceChildren(...rows);
        fitApps();

        const total = Math.max(1, data.todaySecs);
        const stack = [], legend = [];
        for (const [key, label] of CATS) {
            const secs = (data.categories && data.categories[key]) || 0;
            if (!secs) continue;
            const seg = document.createElement("i");
            seg.className = `c-${key}`;
            seg.style.flex = String(Math.max(1, Math.round(secs / total * 100)));
            stack.push(seg);
            legend.push(make("em", `c-${key}`, `${label} ${text(secs)}`));
        }
        $("stack").replaceChildren(...stack);
        $("legend").replaceChildren(...legend);

        const hours = (data.hours && data.hours.length === 24 ? data.hours : new Array(24).fill(0));
        const peak = Math.max(1, ...hours);
        $("hours").replaceChildren(...hours.map((secs, i) => {
            const rect = document.createElementNS(SVG, "rect");
            const height = Math.max(2, secs / peak * 38);
            rect.setAttribute("x", String(i * 10 + 1));
            rect.setAttribute("y", String(40 - height));
            rect.setAttribute("width", "8");
            rect.setAttribute("height", String(height));
            rect.setAttribute("rx", "2");
            if (!secs) rect.setAttribute("class", "z");
            return rect;
        }));
    }

    function show(title, sub) {
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    function renderStatus() {
        const t = failed ? "Companion not running · showing the last data" : lastOk ? "Application names, icons and times only, kept on this PC." : "Waiting for the companion";
        if ($("status").textContent !== t) $("status").textContent = t;
        $("badge").textContent = failed ? "Offline" : "Today";
    }

    async function update() {
        if (/[?&]demo\b/.test(location.search)) {
            const h = [0, 0, 0, 0, 0, 0, 0, 0, 1200, 3000, 3300, 2400, 1500, 2800, 3400, 3100, 900, 0, 0, 0, 0, 0, 0, 0];
            render({ schema: "screentime/1", enabled: true, todaySecs: 21600, yesterdaySecs: 25200,
                apps: [{ name: "Claude", secs: 8400, cat: "Work" }, { name: "VS Code", secs: 5400, cat: "Work" }, { name: "GTA V", secs: 3600, cat: "Games" }, { name: "Spotify", secs: 2400, cat: "Media" }, { name: "Discord", secs: 1800, cat: "Other" }],
                categories: { Work: 13800, Games: 3600, Media: 2400, Other: 1800 }, hours: h, week: [] });
            $("overlay").classList.remove("visible");
            return;
        }
        if (request) request.abort();
        request = new AbortController();
        try {
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/screentime/state`, { signal: request.signal });
            if (!data || data.schema !== "screentime/1") throw new Error("unknown_version");
            lastData = data;
            lastOk = Date.now();
            failed = false;
            render(data);
            if (data.todaySecs === 0) show("Collecting", "Counting starts now. Use your PC as usual and the totals appear here.");
            else $("overlay").classList.remove("visible");
        } catch (error) {
            if (error && error.name === "AbortError") return;
            failed = true;
            if (lastData) render(lastData);
            else show("Companion not running", "Start iCUE Edge Companion (version with Screen Time).");
        }
        renderStatus();
    }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.ScreenTime = { start, parts, text };
    window.icueEvents = { onICUEInitialized: start };
    WidgetRuntime.onResume(update);
    setInterval(renderStatus, 30000);
    start();
})();
