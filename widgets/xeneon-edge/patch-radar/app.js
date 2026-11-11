(() => {
    "use strict";

    // Patch Radar: official Steam announcements of the listed games, as telex strips, newest first. Unread
    // strips carry a red edge; tapping one opens it on Steam and marks it read (kept on this PC).
    const $ = id => document.getElementById(id);
    const ENDPOINT = document.body.dataset.endpoint;
    const store = window.WidgetRuntime ? WidgetRuntime.storage("patch-radar", "patch-radar") : null;
    const seen = new Set((() => { try { const s = store && store.read(); return Array.isArray(s) ? s : []; } catch (_) { return []; } })());
    const keyOf = it => `${it.game}|${it.at}`;
    const setting = (n, d) => (typeof window[n] !== "undefined" && window[n] !== null && window[n] !== "" ? String(window[n]) : d);

    /** All games' items in one list, newest first, at most `n`. */
    function merge(games, n) {
        return games.flatMap(g => (g.items || []).map(it => ({ ...it, game: g.name, stale: !!g.stale }))).sort((a, b) => b.at - a.at).slice(0, n);
    }
    function when(at) {
        const d = new Date(at), today = new Date();
        if (d.toDateString() === today.toDateString()) return `TODAY ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }).toUpperCase();
    }
    function open(url) {
        if (!/^https:\/\/([a-z0-9-]+\.)*(steampowered\.com|steamcommunity\.com|akamaihd\.net)\//.test(url)) return;
        if (window.plugins && window.plugins.Linkprovider && typeof pluginLinkprovider_initialized !== "undefined" && pluginLinkprovider_initialized) window.plugins.Linkprovider.open(url);
        else window.open(url, "_blank", "noopener");
    }

    let last = null;
    function render(games) {
        last = games;
        const items = merge(games, 6);
        const unread = items.filter(it => !seen.has(keyOf(it))).length;
        $("unread").textContent = unread ? `${unread} UNREAD` : "ALL READ";
        $("tapes").replaceChildren(...items.map(it => {
            const tape = document.createElement("div");
            tape.className = "tape" + (seen.has(keyOf(it)) ? "" : " new") + (it.patch ? " patch" : "");
            tape.setAttribute("role", "button"); tape.tabIndex = 0;
            const top = document.createElement("p"), b = document.createElement("b"), em = document.createElement("em");
            b.textContent = it.game.toUpperCase();
            // The companion could not refresh this game from Steam: its announcements may be out of date.
            em.textContent = when(it.at) + (it.stale ? " · NOT UPDATED" : "");
            top.append(b, document.createTextNode(` · ${it.title.toUpperCase()}`), em);
            const body = document.createElement("small");
            body.textContent = it.text || "";
            tape.append(top, body);
            tape.addEventListener("click", () => {
                seen.add(keyOf(it));
                if (store) store.write([...seen].slice(-200));
                open(it.url);
                render(last);
            });
            return tape;
        }));
        if (!items.length) {
            const p = document.createElement("p");
            p.className = "empty";
            p.textContent = "No announcement yet. Add Steam app ids in the iCUE settings.";
            $("tapes").append(p);
        }
        $("overlay").classList.remove("visible");
    }

    async function update() {
        if (/[?&]demo\b/.test(location.search)) {
            const h = 3600000, now = Date.now();
            return render([
                { name: "Grand Theft Auto V", items: [{ title: "Title Update 1.72", at: now - 2 * h, url: "https://store.steampowered.com/news/1", text: "Online tuning, Business Rivalries payouts raised, crash fixes for the Enhanced edition.", patch: true },
                    { title: "Halloween thrills all through October", at: now - 9 * 24 * h, url: "https://store.steampowered.com/news/2", text: "Paranormal visions are back in Los Santos." }] },
                { name: "Elden Ring", items: [{ title: "Patch 1.17", at: now - 2 * 24 * h, url: "https://store.steampowered.com/news/3", text: "Balance adjustments for several weapons and spells.", patch: true }] },
                { name: "Hollow Knight: Silksong", items: [{ title: "1.0.3 Steam Deck fixes", at: now - 3 * 24 * h, url: "https://store.steampowered.com/news/4", text: "Controller prompts and frame pacing.", patch: true }] },
            ]);
        }
        try {
            const apps = setting("patchApps", "271590").replace(/[^\d,]/g, "");
            const { data } = await WidgetRuntime.requestJson(`${ENDPOINT}/api/patches/state?apps=${encodeURIComponent(apps)}`, { credentials: "omit" });
            if (data && data.schema === "patches/1") render(data.games || []);
        } catch (e) {
            if (!last) {
                $("overlayTitle").textContent = e && e.status === 401 ? "Only iCUE can read this" : "Companion not running";
                $("overlay").classList.add("visible");
            }
        }
    }

    let key = setting("patchApps", "271590");
    window.PatchRadar = { merge };
    window.icueEvents = { onICUEInitialized: update, onDataUpdated: () => { const k = setting("patchApps", "271590"); if (k !== key) { key = k; update(); } } };
    update();
    setInterval(update, 15 * 60000);
    setInterval(window.icueEvents.onDataUpdated, 2000);
})();
