(() => {
    "use strict";

    const API = "https://api.github.com";
    const POLL_MS = 5 * 60 * 1000;
    const $ = id => document.getElementById(id);
    let timer = null;
    let retryTimer = null;
    let failures = 0;
    let hasLiveData = false;
    let activeRepo = "";
    let updateSeq = 0;
    let request = null;
    let settingsTimer = null;
    let notBefore = 0;
    let lastUpdated = 0;

    let status = "Loading";

    function renderStatus() {
        const text = WidgetRuntime.freshness(lastUpdated, status, notBefore);
        if ($("dataStatus").textContent !== text) $("dataStatus").textContent = text;
    }

    function setting(name, fallback) {
        try {
            if (name === "githubRepo" && typeof githubRepo !== "undefined") return githubRepo || fallback;
            if (name === "githubToken" && typeof githubToken !== "undefined") return githubToken || fallback;
        } catch (_) {}
        return fallback;
    }

    function headers() {
        const token = String(setting("githubToken", "")).trim();
        const h = { "Accept": "application/vnd.github+json" };
        if (token) h.Authorization = `Bearer ${token}`;
        return h;
    }

    function compact(value) {
        return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
    }

    function age(value) {
        const then = new Date(value).getTime();
        if (!Number.isFinite(then)) return "--";
        const hours = Math.max(0, Math.floor((Date.now() - then) / 3600000));
        const days = Math.floor(hours / 24);
        return days ? `${days}d` : `${hours}h`;
    }

    function show(title, sub) {
        status = title;
        renderStatus();
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    function hide() {
        $("overlay").classList.remove("visible");
    }

    function normalizeRepo(value) {
        return String(value || "")
            .trim()
            .replace(/^https:\/\/github\.com\//i, "")
            .replace(/\/+$/, "");
    }

    function renderLoading(repo) {
        status = "Loading";
        renderStatus();
        $("repo").textContent = repo || "Repo Monitor";
        $("branch").textContent = "--";
        $("stars").textContent = "--";
        $("issues").textContent = "--";
        $("prs").textContent = "--";
        $("pushed").textContent = "--";
        $("sha").textContent = "------";
        $("message").textContent = "Loading repository...";
        hide();
    }

    async function getJson(path, paginated = false) {
        try {
            const result = await WidgetRuntime.requestJson(`${API}${path}`, { headers: headers(), signal: request.signal });
            return paginated ? { data: result.data, hasNext: /rel="next"/.test(result.headers.get("link") || "") } : result.data;
        } catch (error) {
            if (error.status === 409 && path.includes("/commits?")) return [];
            throw error;
        }
    }

    async function openCounts(repo, seq) {
        let issues = 0, pulls = 0;
        // ponytail: scan at most 1,000 open items; use search totals if larger repos need exact counts.
        for (let page = 1; page <= 10; page++) {
            if (seq !== updateSeq) throw new Error("superseded");
            const { data, hasNext } = await getJson(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`, true);
            if (!Array.isArray(data)) throw new Error("invalid_issues");
            for (const item of data) {
                if (item.pull_request) pulls++;
                else issues++;
            }
            if (!hasNext) return { issues, pulls, complete: true };
        }
        return { issues, pulls, complete: false };
    }

    function renderCount(id, value, complete) {
        $(id).textContent = complete ? compact(value) : `≥${value.toLocaleString("en")}`;
        $(id).title = complete ? String(value) : `At least ${value}; first 1,000 open items counted`;
    }

    async function update() {
        const repo = normalizeRepo(setting("githubRepo", "inerthel-agi/icue-edge-widgets"));
        const repoChanged = repo !== activeRepo;
        if (repoChanged) {
            activeRepo = repo;
            failures = 0;
            hasLiveData = false;
            lastUpdated = 0;
            clearTimeout(retryTimer);
            renderLoading(repo);
        }
        if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return show("Repository Missing", "Use owner/repo in iCUE settings.");

        if (Date.now() < notBefore) {
            if (repoChanged) {
                show("Refresh paused", "Waiting for the next allowed API request.");
                // Retry when the backoff ends instead of waiting for the next 5-minute tick.
                clearTimeout(retryTimer);
                retryTimer = setTimeout(update, notBefore - Date.now());
            }
            return;
        }
        const seq = ++updateSeq;
        if (request) request.abort();
        request = new AbortController();
        clearTimeout(retryTimer);
        try {
            const [info, counts, commits] = await Promise.all([
                getJson(`/repos/${repo}`),
                openCounts(repo, seq),
                getJson(`/repos/${repo}/commits?per_page=1`)
            ]);
            if (seq !== updateSeq || repo !== activeRepo) return;
            const commit = commits && commits[0];
            $("repo").textContent = repo;
            $("branch").textContent = info.default_branch || "main";
            $("stars").textContent = compact(info.stargazers_count);
            renderCount("issues", counts.issues, counts.complete);
            renderCount("prs", counts.pulls, counts.complete);
            $("pushed").textContent = age(info.pushed_at);
            $("sha").textContent = commit ? commit.sha.slice(0, 7) : "-------";
            $("message").textContent = commit ? commit.commit.message.split("\n")[0] : "Latest commit unavailable";
            failures = 0;
            notBefore = 0;
            hasLiveData = true;
            lastUpdated = Date.now();
            status = "ready";
            renderStatus();
            clearTimeout(retryTimer);
            hide();
        } catch (error) {
            if (seq !== updateSeq || repo !== activeRepo) return;
            request.abort();
            failures += 1;
            const delay = [401, 403, 404].includes(error.status) ? POLL_MS : Math.min(POLL_MS, 15000 * 2 ** Math.min(failures - 1, 5));
            notBefore = Math.max(error.retryAt || 0, Date.now() + delay);
            retryTimer = setTimeout(update, Math.min(2147483647, notBefore - Date.now()));
            const title = error.rateLimited ? "Rate limited" : error.status === 401 ? "Token rejected" : error.status === 403 ? "Access denied" : error.status === 404 ? "Repository not found" : "Repository offline";
            if (hasLiveData) {
                status = title;
                renderStatus();
                hide();
            } else {
                const details = error.rateLimited ? "GitHub paused requests. The next attempt is scheduled below." :
                    error.status === 401 ? "Check the GitHub token in iCUE settings." :
                    error.status === 403 ? "The current token cannot access this repository." :
                    error.status === 404 ? "Check owner/repo and whether your token can read it." :
                    "GitHub did not respond. Retrying automatically.";
                show(title, details);
            }
        }
    }

    function refreshFromSettings() {
        ++updateSeq;
        if (request) request.abort();
        clearTimeout(settingsTimer);
        settingsTimer = setTimeout(update, 250);
    }

    function start() {
        if (timer) return;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.GithubRepoMonitor = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: refreshFromSettings };
    setInterval(renderStatus, 30000);
    WidgetRuntime.onResume(update);
    start();
})();
