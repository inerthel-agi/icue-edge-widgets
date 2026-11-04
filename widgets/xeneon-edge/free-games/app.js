(() => {
    "use strict";

    // Free Games: Epic's free games (now, then next) as tickets, and the Steam games the user watches as
    // price tags, from iCUE Edge Companion's /api/deals/state (it caches the stores for an hour).
    const $ = id => document.getElementById(id);
    const ENDPOINT = document.body.dataset.endpoint;
    const DEMO = /[?&]demo\b/.test(location.search);
    const setting = (n, d) => (typeof window[n] !== "undefined" && window[n] !== null && window[n] !== "" ? String(window[n]) : d);

    const money = (cents, cur) => {
        if (cents === null || cents === undefined) return "";
        try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "EUR" }).format(cents / 100); } catch (_) { return (cents / 100).toFixed(2); }
    };
    /** "until Thu 17:00" / "from Thu 17:00" / "ends in 3 h": short and readable at a glance. */
    function when(iso, prefix, now = Date.now()) {
        const t = Date.parse(iso);
        if (!Number.isFinite(t)) return "";
        const h = (t - now) / 3600000;
        if (prefix === "until" && h > 0 && h < 24) return `ends in ${Math.max(1, Math.round(h))} h`;
        const d = new Date(t);
        return `${prefix} ${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
    }
    function openLink(url) {
        if (!/^https:\/\/(store\.epicgames\.com|store\.steampowered\.com)\//.test(url)) return;
        if (window.plugins && window.plugins.Linkprovider && typeof pluginLinkprovider_initialized !== "undefined" && pluginLinkprovider_initialized) window.plugins.Linkprovider.open(url);
        else window.open(url, "_blank", "noopener");
    }
    function el(tag, cls, parent, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        if (parent) parent.append(n);
        return n;
    }
    // iCUE does not show internet images in widgets: covers come through the companion
    // (/api/deals/image) as blobs, each fetched once and kept for the next renders.
    const blobs = new Map();
    function load(src) {
        if (!blobs.has(src)) {
            blobs.set(src, src.startsWith("/") ? fetch(ENDPOINT + src, { cache: "no-store", credentials: "omit" })
                .then(r => (r.ok ? r.blob() : null)).then(b => (b && /^image\//.test(b.type) ? URL.createObjectURL(b) : null)).catch(() => null)
                : Promise.resolve(src));   // ?demo only: the stores' own addresses
            if (blobs.size > 30) { const [k, p] = blobs.entries().next().value; blobs.delete(k); p.then(u => u && u.startsWith("blob:") && URL.revokeObjectURL(u)); }
        }
        return blobs.get(src);
    }
    function art(parent, src) {
        const box = el("div", "art", parent);
        if (src) load(src).then(url => {
            if (!url || !box.isConnected) return;
            const img = el("img", "", box); img.alt = ""; img.src = url; img.onerror = () => img.remove();
        });
        return box;
    }

    function ticket(g, kind) {
        const t = el("div", `ticket ${kind}`, $("free"));
        t.setAttribute("role", "button"); t.tabIndex = 0;
        t.setAttribute("aria-label", `${g.title}, ${kind === "now" ? "free now" : "free next"}`);
        art(t, g.image);
        const stub = el("div", "stub", t);
        el("span", "stamp", stub, kind === "now" ? "FREE" : "NEXT");
        el("b", "title", stub, g.title);
        el("span", "when", stub, kind === "now" ? when(g.end, "until") : when(g.start, "from"));
        if (g.worth) el("s", "worth", stub, money(g.worth, g.currency));
        if (g.url) t.addEventListener("click", () => openLink(g.url));
    }
    function tag(g) {
        const t = el("div", "tag" + (g.discount ? " sale" : ""), $("watch"));
        t.setAttribute("role", "button"); t.tabIndex = 0;
        art(t, g.image);
        el("b", "name", t, g.name);
        const price = el("span", "price", t);
        if (g.free) price.textContent = "Free to play";
        else if (g.final !== null) {
            if (g.discount) { el("em", "pct", price, `−${g.discount}%`); el("s", "", price, money(g.initial, g.currency)); }
            el("strong", "", price, money(g.final, g.currency));
        } else price.textContent = "No price";
        t.addEventListener("click", () => openLink(g.url));
    }

    function render(d) {
        $("free").replaceChildren();
        $("watch").replaceChildren();
        const epic = d.epic || { now: [], next: [] };
        epic.now.forEach(g => ticket(g, "now"));
        epic.next.slice(0, Math.max(0, 3 - epic.now.length)).forEach(g => ticket(g, "next"));
        // Sales first, then the cheapest.
        (d.steam || []).slice().sort((a, b) => (b.discount || 0) - (a.discount || 0) || (a.final || 0) - (b.final || 0)).forEach(tag);
        $("widget").dataset.watch = d.steam && d.steam.length ? "on" : "off";
        $("widget").dataset.state = "ready";
        $("msg").textContent = d.epicStale && d.epic ? "Stores unreachable: last known offers" : !d.epic ? "Epic Games Store unreachable" : "";
    }

    async function poll() {
        if (DEMO) {
            const day = 86400000, now = Date.now(), iso = t => new Date(t).toISOString(), ep = "https://cdn1.epicgames.com/spt-assets/";
            return render({ epic: {
                now: [{ title: "Sorry We're Closed", image: ep + "9ab7eaaeb2f041969b350955b789f0f7/sorry-were-closed-1orqh.png", url: "https://store.epicgames.com/p/x", worth: 2239, currency: "EUR", end: iso(now + 20 * 3600000) }],
                next: [{ title: "Flotsam", image: ep + "5c36b876e80d4285b9993947efeeaf2b/flotsam-1yczl.jpg", url: "https://store.epicgames.com/p/y", worth: 1999, currency: "EUR", start: iso(now + day) }, { title: "Idle Champions of the Forgotten Realms", image: ep + "a53f91e55c6840018cb5de0b204f1ad9/idle-champions-of-the-forgotten-realms-1cv5z.jpg", worth: 0, start: iso(now + day) }] },
                steam: [{ name: "ELDEN RING", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg", final: 2999, initial: 5999, discount: 50, currency: "EUR", url: "https://store.steampowered.com/app/1245620" },
                    { name: "Hollow Knight: Silksong", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1030300/header.jpg", final: 1950, initial: 1950, discount: 0, currency: "EUR", url: "https://store.steampowered.com/app/1030300" },
                    { name: "Dota 2", image: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/570/header.jpg", free: true, url: "https://store.steampowered.com/app/570" }] });
        }
        try {
            const q = `cc=${encodeURIComponent(setting("dealsCountry", "FR"))}&steam=${encodeURIComponent(setting("dealsSteam", "").replace(/[^\d,]/g, ""))}`;
            const { data } = await window.WidgetRuntime.requestJson(`${ENDPOINT}/api/deals/state?${q}`, { credentials: "omit" });
            if (data && data.schema === "deals/1") render(data);
        } catch (e) {
            $("widget").dataset.state = $("free").children.length ? "ready" : "offline";
            $("msg").textContent = e && e.status === 401 ? "iCUE Edge Companion only answers iCUE" : "Start iCUE Edge Companion to see the offers";
        }
    }

    let key = "";
    window.icueEvents = { onICUEInitialized: poll, onDataUpdated: () => { const k = setting("dealsCountry", "FR") + setting("dealsSteam", ""); if (k !== key) { key = k; poll(); } } };
    window.FreeGames = { when };
    poll();
    setInterval(poll, 10 * 60000);   // the companion caches for an hour; this only keeps the countdown fresh
    setInterval(() => window.icueEvents.onDataUpdated(), 2000);
})();
