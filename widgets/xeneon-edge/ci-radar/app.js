(() => {
    "use strict";

    // CI Radar: one signal lamp per repository for its last GitHub Actions run, and the pull requests that
    // request the user's review as flight strips. GitHub's REST API answers browsers directly (CORS).
    // Without a token: 60 requests an hour, so the poll is every 5 minutes for at most four repositories.
    const $ = id => document.getElementById(id);
    const API = "https://api.github.com";
    const setting = (n, d) => (typeof window[n] !== "undefined" && window[n] !== null && window[n] !== "" ? String(window[n]) : d);
    const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

    function repos() {
        return [...new Set(setting("ciRepos", "inerthel-agi/icue-edge-widgets").split(",").map(s => s.trim()).filter(s => REPO.test(s)))].slice(0, 4);
    }
    /** Lamp colour of a workflow run: green passed, amber queued or running, red failed, grey otherwise. */
    function lamp(run) {
        if (!run) return "off";
        if (run.status !== "completed") return "amber";
        return run.conclusion === "success" ? "green" : ["failure", "timed_out", "startup_failure"].includes(run.conclusion) ? "red" : "off";
    }
    const ago = at => { const m = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000)); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`; };
    function open(url) {
        if (!/^https:\/\/github\.com\//.test(url)) return;
        if (window.plugins && window.plugins.Linkprovider && typeof pluginLinkprovider_initialized !== "undefined" && pluginLinkprovider_initialized) window.plugins.Linkprovider.open(url);
        else window.open(url, "_blank", "noopener");
    }
    function headers() {
        const h = { Accept: "application/vnd.github+json" };
        const token = setting("ciToken", "").trim();
        if (/^[A-Za-z0-9_]{20,255}$/.test(token)) h.Authorization = `Bearer ${token}`;
        return h;
    }
    const get = path => WidgetRuntime.requestJson(API + path, { headers: headers(), credentials: "omit" }).then(r => r.data);

    function render(runs, queue, user) {
        $("lamps").replaceChildren(...runs.map(({ repo, run, error }) => {
            const el = document.createElement("div");
            el.className = `l ${error ? "off" : lamp(run)}`;
            el.setAttribute("role", "button"); el.tabIndex = 0;
            const i = document.createElement("i"), name = document.createElement("span"), small = document.createElement("small");
            name.textContent = repo.split("/")[1];
            small.textContent = error ? error : !run ? "no runs" : run.status !== "completed" ? `${run.status.replace("_", " ")} · ${ago(run.run_started_at || run.created_at)}` : `${run.head_branch} · ${run.conclusion} · ${ago(run.updated_at)}`;
            el.append(i, name, small);
            el.addEventListener("click", () => open(run ? run.html_url : `https://github.com/${repo}/actions`));
            return el;
        }));
        $("lamps").style.setProperty("--n", String(Math.max(1, runs.length)));
        $("widget").dataset.queue = user ? "on" : "off";
        if (!user) return;
        $("queueTitle").textContent = `REVIEW QUEUE · ${queue.length}`;
        $("queue").replaceChildren(...queue.slice(0, 4).map(pr => {
            const fs = document.createElement("div");
            const days = (Date.now() - Date.parse(pr.created_at)) / 86400000;
            fs.className = "fs" + (days >= 3 ? " old" : "");
            fs.setAttribute("role", "button"); fs.tabIndex = 0;
            const b = document.createElement("b"), s = document.createElement("span"), em = document.createElement("em");
            b.textContent = `#${pr.number}`; s.textContent = pr.title; em.textContent = ago(pr.created_at);
            fs.append(b, s, em);
            fs.addEventListener("click", () => open(pr.html_url));
            return fs;
        }));
        if (!queue.length) { const p = document.createElement("p"); p.className = "none"; p.textContent = "Nothing waiting for you."; $("queue").append(p); }
    }

    async function update() {
        if (/[?&]demo\b/.test(location.search)) {
            const m = 60000, iso = d => new Date(Date.now() - d).toISOString();
            return render([
                { repo: "inerthel-agi/icue-edge-widgets", run: { status: "completed", conclusion: "success", head_branch: "main", updated_at: iso(4 * m) } },
                { repo: "inerthel-agi/claude-rpc", run: { status: "in_progress", run_started_at: iso(m) } },
                { repo: "inerthel-agi/portfolio", run: { status: "completed", conclusion: "failure", head_branch: "main", updated_at: iso(30 * m) } },
                { repo: "inerthel-agi/dotfiles", run: { status: "completed", conclusion: "success", head_branch: "main", updated_at: iso(2 * 1440 * m) } },
            ], [{ number: 142, title: "Spotify ban fallback", created_at: iso(120 * m) }, { number: 139, title: "Pump relay for Pump Faces", created_at: iso(1440 * m) }, { number: 131, title: "README screenshots", created_at: iso(4 * 1440 * m) }], "demo");
        }
        const list = repos(), user = setting("ciUser", "").trim();
        const runs = await Promise.all(list.map(repo => get(`/repos/${repo}/actions/runs?per_page=1`)
            .then(d => ({ repo, run: d && d.workflow_runs && d.workflow_runs[0] }))
            .catch(e => ({ repo, error: e && e.status === 404 ? "not found" : e && e.rateLimited ? "rate limited" : "unreachable" }))));
        let queue = [];
        if (/^[A-Za-z0-9-]{1,39}$/.test(user)) {
            try { queue = ((await get(`/search/issues?q=${encodeURIComponent(`is:pr is:open archived:false review-requested:${user}`)}&per_page=5`)) || {}).items || []; } catch (_) { queue = []; }
        }
        const allDown = runs.length && runs.every(r => r.error === "unreachable");
        $("overlay").classList.toggle("visible", !!allDown);
        render(runs, queue, /^[A-Za-z0-9-]{1,39}$/.test(user) ? user : "");
    }

    let key = "";
    window.CiRadar = { lamp };
    window.icueEvents = { onICUEInitialized: update, onDataUpdated: () => { const k = setting("ciRepos", "") + setting("ciUser", ""); if (k !== key) { key = k; update(); } } };
    update();
    setInterval(update, 5 * 60000);
    setInterval(window.icueEvents.onDataUpdated, 3000);
})();
