(() => {
    "use strict";

    const API = "https://api.github.com";
    const POLL_MS = 5 * 60 * 1000;
    const STARTUP_GRACE_MS = 6000;
    const OFFLINE_FAILURES = 3;
    const RETRY_MS = 15000;
    const $ = id => document.getElementById(id);
    let timer = null;
    let retryTimer = null;
    let failures = 0;
    let graceUntil = Date.now() + STARTUP_GRACE_MS;
    let hasLiveData = false;
    let activeRepo = "";
    let updateSeq = 0;

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
        $("overlayTitle").textContent = title;
        $("overlaySub").textContent = sub;
        $("overlay").classList.add("visible");
    }

    function hide() {
        $("overlay").classList.remove("visible");
    }

    function scheduleRetry() {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(update, RETRY_MS);
    }

    function normalizeRepo(value) {
        return String(value || "")
            .trim()
            .replace(/^https:\/\/github\.com\//i, "")
            .replace(/\/+$/, "");
    }

    function renderLoading(repo) {
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

    async function getJson(path) {
        const response = await fetch(`${API}${path}`, { headers: headers(), cache: "no-store" });
        if (response.status === 403) throw new Error("rate_limited");
        if (!response.ok) throw new Error("unavailable");
        return response.json();
    }

    async function update() {
        const repo = normalizeRepo(setting("githubRepo", "inerthel-agi/icue-edge-widgets"));
        const repoChanged = repo !== activeRepo;
        if (repoChanged) {
            activeRepo = repo;
            failures = 0;
            hasLiveData = false;
            graceUntil = 0;
            clearTimeout(retryTimer);
            renderLoading(repo);
        }
        if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return show("Repository Missing", "Use owner/repo in iCUE settings.");

        const seq = ++updateSeq;
        try {
            const [info, pulls, issues, commits] = await Promise.all([
                getJson(`/repos/${repo}`),
                getJson(`/repos/${repo}/pulls?state=open&per_page=100`),
                getJson(`/repos/${repo}/issues?state=open&per_page=100`),
                getJson(`/repos/${repo}/commits?per_page=1`)
            ]);
            if (seq !== updateSeq || repo !== activeRepo) return;
            const commit = commits && commits[0];
            $("repo").textContent = repo;
            $("branch").textContent = info.default_branch || "main";
            $("stars").textContent = compact(info.stargazers_count);
            $("issues").textContent = compact((issues || []).filter(item => !item.pull_request).length);
            $("prs").textContent = compact(Array.isArray(pulls) ? pulls.length : 0);
            $("pushed").textContent = age(info.pushed_at);
            $("sha").textContent = commit ? commit.sha.slice(0, 7) : "-------";
            $("message").textContent = commit ? commit.commit.message.split("\n")[0] : "Latest commit unavailable";
            failures = 0;
            graceUntil = 0;
            hasLiveData = true;
            clearTimeout(retryTimer);
            hide();
        } catch (error) {
            if (seq !== updateSeq || repo !== activeRepo) return;
            failures += 1;
            scheduleRetry();
            if (!repoChanged && hasLiveData && (Date.now() < graceUntil || failures < OFFLINE_FAILURES)) return;
            const starting = Date.now() < graceUntil || failures < OFFLINE_FAILURES;
            show(error.message === "rate_limited" ? "Rate Limited" : starting ? "Reconnecting" : "Repo Unavailable", starting ? "Keeping last repo status visible. Retrying automatically..." : repo);
        }
    }

    function refreshFromSettings() {
        update();
        setTimeout(update, 250);
        setTimeout(update, 1000);
    }

    function start() {
        if (timer) return;
        graceUntil = Date.now() + STARTUP_GRACE_MS;
        update();
        timer = setInterval(update, POLL_MS);
    }

    window.GithubRepoMonitor = { start };
    window.icueEvents = { onICUEInitialized: start, onDataUpdated: refreshFromSettings };
    start();
})();
