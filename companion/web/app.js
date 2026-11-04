// Companion window (design v2): sidebar, seven pages, back / forward history, status footer.
(function () {
  "use strict";
  const U = window.Usage, esc = U.esc;
  const content = document.getElementById("content");
  let page = "overview";
  let info = null;
  let lastHtml = "";
  let helpOpen = false;
  let sp = null;
  let spClientId = "";
  let renderedPage = null;
  let enterPending = true;
  let screen = null;          // Screen Time snapshot (screentime/1)
  const stored = (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } };
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* not kept */ } };
  let widgetFilter = stored("widgets.filter", "all");
  let widgetSort = stored("widgets.sort", "az");
  let widgetScreen = stored("widgets.screen", "all");
  const hist = { back: [], fwd: [] };
  const TITLES = { community: "Community", changelog: "Changelog", overview: "Overview", claude: "Claude", codex: "Codex", aicost: "AI cost", screentime: "Screen time", spotify: "Spotify", widgets: "Widgets", settings: "Settings" };
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");

  const ICON_ALERT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  const pill = (p) => '<span class="pill ' + (p.state === "idle" ? "" : p.state) + '">' + esc(p.stateText) + "</span>" + (p.refreshing ? ' <span class="pill busy">Updating</span>' : "");
  const bar = (u, extra) => '<div class="bar ' + U.level(u) + (extra ? " " + extra : "") + '"><i data-w="' + u + '"></i></div>';
  // 24 h chart and pace estimate for the headline limit (Claude only).
  const TREND = { claude: true };
  const alert = (text, cls) => '<div class="alert ' + (cls || "") + '">' + ICON_ALERT + "<span>" + esc(text) + "</span></div>";

  // ---------- overview ----------
  function providerCard(p) {
    const t = U.tightest(p);
    let hero;
    if (!p.detected) hero = alert(p.reason || p.name + " not detected", "warn");
    else if (!t) hero = alert(p.limitsError || "No limits reported.", p.state === "danger" ? "" : "warn");
    else {
      const eta = TREND[p.id] ? U.forecast(t) : null;
      hero = '<div><div class="hero-figure"><b>' + t.pct + '%</b><span>of ' + esc(t.name.toLowerCase()) + " " + t.word + "</span></div>" +
        U.limitBar(t, t.stale ? "off" : "") + '<p class="hero-meta">Resets ' + U.resetText(t.resetAt) + (t.stale && t.reason ? " · " + esc(t.reason) : "") + "</p>" +
        (eta ? '<p class="hero-meta' + (eta.warn ? " eta-warn" : "") + '">' + esc(eta.text) + "</p>" : "") + "</div>";
    }
    const others = t ? p.limits.filter((l) => l !== t).map((l) =>
      '<div class="mini-row"><span>' + esc(l.name) + "</span><b>" + l.pct + "%</b>" + U.limitBar(l, l.stale ? "off" : "") + "</div>").join("") : "";
    const reason = t && p.state === "danger" && p.reason ? alert(p.reason) : "";
    const ctx = p.context ? U.big(p.context.used) + (p.context.capacity ? ' <small class="muted">/ ' + U.big(p.context.capacity) + "</small>" : "") : "—";
    return '<section class="card">' +
      '<div class="card-head"><span class="mark ' + esc(p.id) + '">' + p.letter + "</span><div><strong>" + esc(p.name) + "</strong><small>" + esc(p.clients) + "</small></div>" + pill(p) + "</div>" +
      reason + hero + (others ? '<div class="mini">' + others + "</div>" : "") +
      '<div class="facts"><div class="fact"><span>Tokens today</span><b>' + U.big(p.tokens.total) + "</b></div>" +
      '<div class="fact"><span>Current conversation</span><b>' + ctx + "</b></div></div>" +
      '<div class="card-foot"><span>Limits read ' + U.ago(p.limitsAt) + '</span><button type="button" class="link" data-go="' + p.id + '">View details →</button></div>' +
      "</section>";
  }

  // ---------- overview: AI usage, media and screens ----------
  const NOTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 18.5a3 3 0 1 1-2-2.83V5.2l12-2.2v12.5a3 3 0 1 1-2-2.83V6.4l-8 1.47z"/></svg>';
  const fmtTime = (sec) => { sec = Math.max(0, Math.floor(sec)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); };

  function nowPlayingCard(m) {
    const s = m && m.session;
    const players = m ? m.sessions.length : 0;
    const state = !s ? ["Idle", ""] : s.playback === "playing" ? ["Playing", "live"] : s.playback === "paused" ? ["Paused", ""] : ["Unknown", ""];
    let body;
    if (!m) body = '<p class="muted">Media sessions are not available.</p>';
    else if (!s) body = '<p class="muted">Nothing playing. Start playback in any app shown in the Windows media flyout.</p>';
    else {
      const t = s.timeline;
      let prog = "", pos = null;
      if (t && t.duration) {
        pos = Math.min(t.duration, t.position + (s.playback === "playing" ? Math.max(0, Date.now() - t.updatedAt) / 1000 : 0));
        prog = '<div class="np-prog"><div class="bar np-bar"><i data-w="' + Math.round(pos / t.duration * 100) + '"></i></div><div class="np-times"><span>' + fmtTime(pos) +
          "</span><span>−" + fmtTime(t.duration - pos) + "</span></div></div>";
      }
      // The line being sung, when synced lyrics are ready (same source as the widget).
      const lines = s.lyrics && s.lyrics.state === "ready" ? s.lyrics.lines : null;
      let line = "";
      if (lines && pos !== null) { for (const l of lines) { if (l.timeMs <= pos * 1000 + 250) line = l.text; else break; } }
      const c = s.caps || {}, btn = (cmd, label, icon, on) => '<button type="button" class="np-btn" data-act="np" data-cmd="' + cmd + '" aria-label="' + label + '"' + (on ? "" : " disabled") + ">" + icon + "</button>";
      const ctl = '<div class="np-ctl">' +
        btn("prev", "Previous", '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>', c.prev) +
        btn("playPause", s.playback === "playing" ? "Pause" : "Play", s.playback === "playing" ? '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>', c.playPause) +
        btn("next", "Next", '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>', c.next) + "</div>";
      body = '<div class="np"><div class="np-art">' + (s.art ? '<img src="' + esc(s.art.url) + '" alt="">' : NOTE) + "</div>" +
        '<div class="np-text"><b>' + esc(s.title || "Untitled") + "</b><span>" + esc(s.artist || "") + "</span><small>" + esc(s.album || s.app.name) + "</small></div>" + ctl + "</div>" +
        (line ? '<p class="np-line">' + esc(line) + "</p>" : "") + prog;
    }
    // The player's own mark when it is Spotify; a note for any other app.
    const spotifyApp = s && /spotify/i.test(s.app.name);
    return '<div class="card"><div class="card-head"><span class="mark ' + (spotifyApp ? "spotify" : "media") + '">' + (spotifyApp ? U.LOGO.spotify : NOTE) + "</span><div><strong>Now Playing</strong><small>" +
      (s ? esc(s.app.name) + " · " : "Windows media · ") +
      players + (players === 1 ? " player" : " players") + '</small></div><span class="pill ' + state[1] + '">' + state[0] + "</span></div>" + body +
      '<div class="card-foot"><span>Shown on Now Playing and Windows Media Pump</span></div></div>';
  }

  function spotifyCard(s) {
    const [label, cls] = s ? SP_STATUS[s.status] || SP_STATUS.error : ["Loading", "busy"];
    let body;
    if (!s || s.status === "not_configured") body = '<p class="muted">Connect your own Spotify app to control playback and show synced lyrics on the XENEON EDGE.</p>';
    else if (s.item) body = '<div class="np-text"><b>' + esc(s.item.title) + "</b><span>" + esc(s.item.artists) + "</span><small>" +
      (s.device ? esc(s.device.name) + (s.device.volume == null ? "" : " · volume " + s.device.volume + "%") : "No active device") + " · lyrics " + esc(s.lyrics) + "</small></div>";
    else body = '<p class="muted">' + (s.device ? "Nothing playing on " + esc(s.device.name) + "." : "No active device. Start Spotify on a computer, phone or speaker.") + "</p>";
    return '<div class="card"><div class="card-head"><span class="mark spotify">' + U.LOGO.spotify + '</span><div><strong>Spotify</strong><small>' +
      (s && s.account ? esc(s.account.name) : "Your own Spotify app") + '</small></div><span class="pill ' + cls + '">' + label + "</span></div>" + body +
      '<div class="card-foot"><span>Shown on Spotify</span><button type="button" class="link" data-go="spotify">' + (s && s.status === "not_configured" ? "Connect" : "View details") + " →</button></div></div>";
  }

  // Screens on the Overview: the map alone (a click opens the Widgets page on that screen); a server error still shows.
  function screensGroup() {
    const i = info || {};
    return (i.serverError ? alert(i.serverError + ". Widgets cannot connect.", "page-alert") : "") + deviceMap(i.widgets || [], "wscreen-go");
  }

  function overview(v) {
    const ai = window.showAi();
    return '<div class="page"><h1>Overview</h1><p class="sub">What the companion tracks on this computer and sends to your XENEON EDGE and pump.</p>' +
      (v.paused ? alert("Collection is paused" + (ai ? ": AI figures stay frozen until you resume." : "."), "warn page-alert") : "") +
      (ai ? '<div class="group-title">AI usage</div><div class="cards">' + providerCard(v.claude) + providerCard(v.codex) + "</div>" : "") +
      '<div class="group-title">Media</div><div class="cards">' + nowPlayingCard(media) + spotifyCard(sp) + "</div>" +
      '<div class="group-title">Screens</div>' + screensGroup() +
      (ai ? aiHelp() : "") + "</div>";
  }

  function aiHelp() {
    return '<details class="help"' + (helpOpen ? " open" : "") + '><summary>How to read the AI figures</summary><dl>' +
      "<dt>Limits</dt><dd>Share of your plan already used over a period (5 hours, one week). They reset on their own at the time shown.</dd>" +
      "<dt>Tokens today</dt><dd>Amount of text processed since midnight (" + esc(U.TZ) + "). The cache (text already sent and re-read) is often most of it.</dd>" +
      "<dt>Current conversation</dt><dd>Size of the conversation open right now. The bigger it gets, the more each message costs.</dd>" +
      "<dt>Why no link between the two?</dt><dd>Claude and Codex do not say how many tokens one percent of a limit is worth, so they are never converted.</dd>" +
      "</dl></details>";
  }

  // ---------- provider page ----------
  function providerPage(p) {
    let limits;
    if (!p.limits.length) limits = '<div class="row">' + alert(p.limitsError || p.reason || "No limits reported.", p.state === "danger" ? "" : "warn") + "</div>";
    else limits = p.limits.map((l) => '<div class="row"><div class="row-text"><span>' + esc(l.name) + "</span><small>Resets " + U.resetText(l.resetAt) +
      (l.stale && l.reason ? " · " + esc(l.reason) : "") + '</small></div><div class="limit-right">' + U.limitBar(l, l.stale ? "off" : "") + "<b>" + l.pct + "% " + l.word + "</b></div></div>").join("");
    const top = U.tightest(p);
    const tr = TREND[p.id] && top ? U.trend(top) : null;
    const eta = tr ? U.forecast(top) : null;
    const trendGroup = tr ? '<div class="group-title">' +  esc(top.name) + " · " + esc(tr.span.toLowerCase()) + "<small>Peak " + tr.peak + '%</small></div><div class="group trend-group">' + tr.svg +
      (eta ? '<p class="hero-meta' + (eta.warn ? " eta-warn" : "") + '">' + esc(eta.text) + "</p>" : "") + "</div>" : "";
    const t = p.tokens;
    const inc = (s) => (t.cacheIncluded ? s + " · included in input" : s);
    const tokenRows = t.total == null ? '<div class="empty">Tokens unavailable: ' + esc(p.name) + " is not detected.</div>" : [
      ["Input", "Text sent to the model (your messages, files, history)", t.input],
      ["Output", "Text generated by the model" + (t.reasoning ? " · including " + U.nf.format(t.reasoning) + " reasoning" : ""), t.output],
      ["Cache read", inc("Text already sent, re-read at lower cost"), t.cacheRead],
      ["Cache write", inc("Text cached for the next messages"), t.cacheWrite],
    ].map(([a, b, n]) => '<div class="row"><div class="row-text"><span>' + a + "</span><small>" + esc(b) + '</small></div><span class="row-value">' + U.nf.format(n) + "</span></div>").join("");
    let ctx;
    if (!p.context) ctx = '<div class="row"><div class="row-text"><span>No open conversation</span><small>Open ' + esc(p.name) + " to see its size here</small></div></div>";
    else if (p.context.capacity) {
      const pct = Math.round(p.context.used / p.context.capacity * 100);
      ctx = '<div class="row"><div class="row-text"><span>Current size · ' + pct + "%</span><small>" + U.big(p.context.used) + " of " + U.big(p.context.capacity) + ' tokens</small></div><div class="limit-right">' + bar(pct) + "<b>" + U.big(p.context.used) + "</b></div></div>";
    } else ctx = '<div class="row"><div class="row-text"><span>Current size</span><small>' + (p.context.estimate ? "Estimate · " : "") + esc(p.name) + ' does not report its maximum capacity</small></div><span class="row-value">' + U.big(p.context.used) + " tokens</span></div>";
    const sessions = p.sessions.length ? p.sessions.map((s) => '<div class="row"><span class="tag">' + esc(s.client) + '</span><div class="row-text"><span>' + esc(s.model) + '</span><small class="mono">' + esc(s.id) + "</small></div>" +
      '<div class="row-text row-right"><span class="num">' + U.big(s.tokens) + " tokens</span><small>" + (s.active ? "active · " : "") + U.ago(s.last) + "</small></div></div>").join("")
      : '<div class="empty">No session in the last 24 hours.</div>';
    const events = p.events.length ? '<div class="group-title">Recent events</div><div class="group">' +
      p.events.slice(0, 6).map((e) => '<div class="row"><div class="row-text"><span>' + esc(e.text) + "</span><small>" + U.ago(e.at) + "</small></div></div>").join("") + "</div>" : "";
    return '<div class="page"><div class="page-head"><span class="mark ' + esc(p.id) + '">' + p.letter + "</span><h1>" + esc(p.name) + "</h1>" + pill(p) + "</div>" +
      '<p class="sub">' + esc(p.clients) + (p.model ? " · " + esc(p.model) : "") + "</p>" +
      (p.reason && p.state !== "live" ? alert(p.reason, p.state === "danger" ? "page-alert" : "warn page-alert") : "") +
      '<div class="group-title">Plan limits<small>Read ' + U.ago(p.limitsAt) + '</small></div><div class="group">' + limits + "</div>" + trendGroup +
      '<div class="group-title">Tokens today<small>Total ' + U.big(t.total) + '</small></div><div class="group">' + tokenRows + "</div>" +
      '<div class="group-title">Current conversation</div><div class="group">' + ctx + "</div>" +
      '<div class="group-title">Recent sessions<small>' + p.sessions.length + ' in 24 h</small></div><div class="group">' + sessions + "</div>" + events +
      '<div class="group-title">Where these figures come from</div><div class="group">' +
      '<div class="row"><div class="row-text"><span>Tokens and conversation</span><small>' + esc(p.src.tokens) + "</small></div></div>" +
      '<div class="row"><div class="row-text"><span>Limits</span><small>' + (p.limits[0] ? "Source: " + (p.id === "claude" ? "Anthropic service (unofficial interface), every minute while in use" : "Codex events, or codex app-server when nothing is recent") : "No reading yet") + "</small></div></div></div></div>";
  }

  // ---------- widgets & settings (need app_info) ----------
  const wicon = (w, cls) => '<span class="wico' + (cls ? " " + cls : "") + '" data-icon="' + esc(w.icon) + '"><i></i></span>';

  const screenOf = (w) => (w.screen === "Pump LCD" ? "pump" : "edge");
  const SCREEN_NAME = { edge: "XENEON EDGE", pump: "Pump LCD" };
  // Counter digits: leading zeros stay dim, like a two-digit display.
  const two = (n) => { const s = String(n).padStart(2, "0"); const k = s.search(/[1-9]/); const cut = k < 0 ? s.length - 1 : k; return "<i>" + s.slice(0, cut) + "</i>" + s.slice(cut); };

  // The XENEON EDGE page iCUE shows, drawn to scale: a 3 × 2 grid where each widget keeps its slot and size
  // (read by the companion from iCUE's layout file). Free cells stay hatched.
  const SIZE_NAME = { 1: "S", 2: "M", 4: "L", 6: "XL" };
  function edgeGlass(list) {
    const lay = (info && info.edgeLayout) || { widgets: [] };
    const used = new Set();
    const tiles = lay.widgets.map((x) => {
      const col = Math.floor(x.slot / 2), row = x.slot % 2, cols = x.size >= 4 ? x.size / 2 : 1, rows = x.size === 1 ? 1 : 2;
      for (let c = col; c < col + cols; c++) for (let r = row; r < row + rows; r++) used.add(c * 2 + r);
      const w = list.find((v) => v.id === x.id);
      const cls = "tile c" + col + " r" + row + " s" + x.size;
      return w ? '<span class="' + cls + '" data-icon="' + esc(w.icon) + '" title="' + esc(w.name) + " · " + SIZE_NAME[x.size] + '">' + wicon(w) + "<em>" + esc(w.name) + "</em><b>" + SIZE_NAME[x.size] + "</b></span>"
        : '<span class="' + cls + ' other" title="Another iCUE widget"><em>iCUE widget</em><b>' + SIZE_NAME[x.size] + "</b></span>";
    }).join("");
    let free = "";
    for (let k = 0; k < 6; k++) if (!used.has(k)) free += '<span class="cell c' + Math.floor(k / 2) + " r" + (k % 2) + '"></span>';
    return '<span class="glass">' + free + tiles + "</span>";
  }

  // The two screens with what is placed on them. `act` is "wscreen" on the Widgets page (keeps only that
  // screen's widgets) and "wscreen-go" elsewhere (opens the Widgets page on it).
  function deviceMap(list, act) {
    const on = (s) => list.filter((w) => screenOf(w) === s && (w.placed || w.live));
    const lay = info && info.edgeLayout;
    const pageNote = (s) => (s === "edge" && lay && lay.pages > 1 ? "Page " + (lay.page + 1) + " of " + lay.pages + " · " : "");
    const note = (s) => pageNote(s) + on(s).length + " placed · " + list.filter((w) => screenOf(w) === s && w.installed).length + " installed";
    const pressed = (s) => (act === "wscreen" ? ' aria-pressed="' + (widgetScreen === s) + '"' : "");
    return '<div class="map">' +
      '<button type="button" class="screen-btn edge" data-act="' + act + '" data-screen="edge"' + pressed("edge") + ' title="Show the XENEON EDGE widgets">' +
      '<span class="bezel">' + edgeGlass(list) + "</span>" +
      '<span class="screen-label"><b>XENEON EDGE</b><small>' + note("edge") + "</small></span></button>" +
      '<button type="button" class="screen-btn pump" data-act="' + act + '" data-screen="pump"' + pressed("pump") + ' title="Show the pump widgets">' +
      '<span class="ring"><span class="lcd">' + on("pump").slice(0, 1).map((w) => wicon(w)).join("") + "</span></span>" +
      '<span class="screen-label"><b>Pump LCD</b><small>' + note("pump") + "</small></span></button></div>";
  }

  const TICK = '<svg class="tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const PLUG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function widgets() {
    const i = info || {};
    const list = i.widgets || [];
    const state = (w) => w.live ? ["Connected", "live"] : w.placed ? [w.companion ? "Placed · not connected" : "On screen", w.companion ? "warn" : "live"] : w.installed ? ["Installed · not placed", ""] : ["Not installed", ""];
    // Install / Update from the fingerprint of the installed files: an up-to-date widget only offers a quiet reinstall.
    const installButton = (w) => {
      const [text, cls, title] = w.update === "missing" ? ["Install", "btn", "Install in iCUE"]
        : w.update === "current" ? [TICK + "<span>Up to date</span>", "btn ghost", "Reinstall the same version"]
        : w.update === "outdated" ? ["Update", "btn amber", "A newer version is available"]
        : ["Update", "btn", "Could not check for a newer version"];
      const pump = screenOf(w) === "pump";
      return '<button type="button" class="' + cls + '" title="' + (pump ? title + " (on the pump)" : title) + '" data-act="' + (pump ? "install-pump" : "install") + '" data-id="' + esc(w.id) + '">' +
        (text.startsWith("<") ? text : "<span>" + text + "</span>") + "</button>";
    };
    const FILTERS = {
      all: ["All", () => true],
      installed: ["Installed", (w) => w.installed],
      missing: ["Not installed", (w) => !w.installed],
      outdated: ["To update", (w) => w.update === "outdated"],
      placed: ["On screen", (w) => w.placed || w.live],
      companion: ["Companion", (w) => w.companion],
    };
    if (!FILTERS[widgetFilter]) widgetFilter = "all";
    if (!SCREEN_NAME[widgetScreen]) widgetScreen = "all";
    const order = widgetSort === "za" ? -1 : 1;
    const shown = list.filter((w) => FILTERS[widgetFilter][1](w) && (widgetScreen === "all" || screenOf(w) === widgetScreen))
      .sort((a, b) => order * a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    const card = (w) => {
      const [label, cls] = state(w);
      return '<article class="wmod" data-id="' + esc(w.id) + '" data-icon="' + esc(w.icon) + '">' + wicon(w) +
        '<div class="wmod-text"><h3>' + esc(w.name) + "</h3><p>" + esc(w.desc) + ' · <span class="nowrap">' + (w.screen === "Pump LCD" ? "480 × 480" : "S · M · L · XL") + "</span></p></div>" +
        '<div class="wmod-foot"><span class="pill ' + cls + '">' + label + "</span>" + (w.companion ? '<span class="needs" title="Needs iCUE Edge Companion">' + PLUG + "Companion</span>" : "") + "</div>" +
        installButton(w) + "</article>";
    };
    const group = (s) => {
      const ws = shown.filter((w) => screenOf(w) === s);
      const live = ws.filter((w) => w.live).length;
      return '<h2 class="grp" data-id="grp-' + s + '">' + SCREEN_NAME[s] + "<small>" + ws.length + (live ? " · " + live + " connected" : "") + "</small></h2>" +
        (ws.length ? '<div class="wgrid">' + ws.map(card).join("") + "</div>" : '<p class="empty" data-id="empty-' + s + '">No widget here with this filter.</p>');
    };
    const f = (id) => '<button type="button" data-act="wfilter" data-f="' + id + '" aria-pressed="' + (widgetFilter === id) + '">' + FILTERS[id][0] +
      "<small>" + list.filter(FILTERS[id][1]).length + "</small></button>";
    const s = (id, label, title) => '<button type="button" data-act="wsort" data-s="' + id + '" title="' + title + '" aria-pressed="' + (widgetSort === id) + '">' + label + "</button>";
    const outdated = list.filter((w) => w.update === "outdated").length;
    return '<div class="page"><h1>Widgets</h1><p class="sub">Every widget for your XENEON EDGE and pump, where it sits, and whether it talks to the companion.</p>' +
      '<div class="own-note"><span class="own-mark" aria-hidden="true">e</span><div><b>Our own widgets, designed and made by inerthel-agi</b>' +
      "<p>The ones marked <span class=\"needs\">" + PLUG + "Companion</span> get their data from iCUE Edge Companion: without it running, they show nothing. The others work with iCUE alone.</p></div></div>" +
      (i.serverError ? alert(i.serverError + ". Widgets cannot connect.", "page-alert") : "") +
      '<div class="summary"><div><b>' + two(list.filter((w) => w.live).length) + "</b><small>Connected</small></div><div><b>" + two(list.filter((w) => w.installed).length) +
      "</b><small>Installed</small></div><div" + (outdated ? ' class="warn"' : "") + "><b>" + two(outdated) + "</b><small>To update</small></div><div><b>" + two(list.length) + "</b><small>Available</small></div></div>" +
      deviceMap(list, "wscreen") +
      '<div class="toolbar"><div class="filters" role="group" aria-label="Filter">' + Object.keys(FILTERS).map(f).join("") + "</div>" +
      '<div class="listbar"><span class="shown">' + shown.length + " of " + list.length + " shown" + (widgetScreen === "all" ? "" : " · " + SCREEN_NAME[widgetScreen] + " only") + "</span>" +
      '<div class="seg sort" role="group" aria-label="Order by name">' + s("az", "A → Z", "Names from A to Z") + s("za", "Z → A", "Names from Z to A") + "</div></div></div>" +
      ["edge", "pump"].filter((x) => widgetScreen === "all" || widgetScreen === x).map(group).join("") +
      '<h2 class="grp">Install a widget</h2><div class="group">' +
      '<div class="row"><span class="step">1</span><div class="row-text"><span>Press Install (or Update) on the widget</span><small>iCUE opens the package and asks you to confirm; the packages also sit in the repository</small></div><button type="button" class="btn" data-act="link" data-link="packages">Packages</button></div>' +
      '<div class="row"><span class="step">2</span><div class="row-text"><span>Place it on the screen</span><small>XENEON EDGE → Widgets, or the pump LCD screen settings</small></div></div>' +
      '<div class="row"><span class="step">3</span><div class="row-text"><span>Keep iCUE Edge Companion running</span><small>Only the widgets marked Companion need it; it stays in the notification area</small></div></div></div>' +
      '<p class="hint">Read from the iCUE files (installed widgets, XENEON EDGE layout, pump profiles); nothing there is changed by reading; installing goes through the confirmation in iCUE. Widgets without the companion can only show installed and placed.</p></div>';
  }

  // ---------- Community (widgets other people share on GitHub; list built daily by the repository) ----------
  let community = null;
  let communityFilter = stored("community.filter", "all");
  let communitySort = stored("community.sort", "stars");
  let communityQuery = "";
  let communitySource = stored("community.source", "github");
  let marketFilter = stored("market.filter", "all");
  let marketSort = stored("market.sort", "az");
  let marketQuery = "";
  let communityJob = null;          // { key, sentAt, phase: "sent" | "installed" | "wait" }
  async function loadCommunity() {
    try { community = await U.invoke("community"); } catch (e) { community = { error: String(e) }; }
    communityStatus();
    if (page === "community") render();
  }
  const DEVICE = { dashboard_lcd: "XENEON EDGE", pump_lcd: "Pump LCD", keyboard_lcd: "Keyboard" };
  const PLUGIN = (p) => /sensors/i.test(p) ? "Sensors" : /media/i.test(p) ? "Media" : /link/i.test(p) ? "Links" : String(p).split(":")[1] || String(p);
  const C_FILTERS = {
    all: ["All", () => true],
    edge: ["XENEON EDGE", (w) => (w.devices || []).includes("dashboard_lcd")],
    pump: ["Pump LCD", (w) => (w.devices || []).includes("pump_lcd")],
    package: ["Packages", (w) => w.kind === "release"],
    installed: ["Installed", (w) => w.installed],
  };
  const licence = (l) => (l === "none" ? "no licence" : l === "NOASSERTION" ? "own licence" : l);
  const avatar = (w) => (Number.isInteger(w.ownerId) ? '<img class="ava" src="https://avatars.githubusercontent.com/u/' + w.ownerId + '?s=40&amp;v=4" alt="">' : "");
  const STAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" fill="currentColor"/></svg>';
  const GH = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 .2a8 8 0 0 0-2.5 15.6c.4 0 .5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7 0-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.1 0 3.1-1.9 3.7-3.6 3.9.3.3.6.8.6 1.5v2.2c0 .2.1.5.6.4A8 8 0 0 0 8 .2z"/></svg>';

  function communityCard(w) {
    const letter = esc((w.name || "?").charAt(0).toUpperCase());
    const icon = typeof w.icon === "string" && w.icon.startsWith("https://raw.githubusercontent.com/")
      ? '<img class="cicon" src="' + esc(w.icon) + '" alt="" loading="lazy" data-letter="' + letter + '">' : '<span class="cicon mono">' + letter + "</span>";
    const devs = (w.devices || []).length ? w.devices.map((d) => '<span class="chip scr">' + esc(DEVICE[d] || d) + "</span>").join("") : "";
    const plugs = (w.plugins || []).map((p) => '<span class="chip">' + esc(PLUGIN(p)) + "</span>").join("");
    const src = w.kind === "release" ? '<span class="chip pkg">Package ' + esc(w.tag || "") + "</span>" : '<span class="chip">Source folder</span>';
    const author = w.author || w.owner;
    const btn = !w.installable ? '<button type="button" class="btn" disabled title="Needs files outside its folder: install it from its repository"><span>Source only</span></button>'
      : w.installed ? '<button type="button" class="btn ghost" data-act="community-open" data-key="' + esc(w.key) + '" title="Installed in iCUE. Install again">' + TICK + "<span>Installed</span></button>"
      : '<button type="button" class="btn" data-act="community-open" data-key="' + esc(w.key) + '"><span>Install</span></button>';
    return '<article class="cmod" data-id="c:' + esc(w.key) + '">' + icon +
      '<div class="cmod-text"><h3>' + esc(w.name) + '</h3><p class="by">' + avatar(w) + "by <b>" + esc(author) + "</b>" +
      (String(author).toLowerCase() !== String(w.owner).toLowerCase() ? ' <span class="muted">· @' + esc(w.owner) + "</span>" : "") + "</p>" +
      '<p class="desc">' + esc(w.description || "No description.") + "</p></div>" +
      '<div class="chips">' + devs + plugs + src + "</div>" +
      '<div class="cmod-foot"><span class="cmeta">' + STAR + esc(w.stars) + " · " + esc(w.pushed) + " · " + esc(licence(w.license)) + "</span>" +
      '<button type="button" class="btn ghost" data-act="community-source" data-key="' + esc(w.key) + '" title="Open its source on GitHub">' + GH + "<span>Source</span></button>" + btn + "</div></article>";
  }

  function communityShown() {
    const list = (community && community.widgets) || [];
    const q = communityQuery.trim().toLowerCase();
    const f = (C_FILTERS[communityFilter] || C_FILTERS.all)[1];
    const cmp = communitySort === "recent" ? (a, b) => String(b.pushed).localeCompare(String(a.pushed))
      : communitySort === "az" ? (a, b) => String(a.name).localeCompare(String(b.name), "en", { sensitivity: "base" })
      : (a, b) => (b.stars || 0) - (a.stars || 0) || String(a.name).localeCompare(String(b.name));
    return list.filter((w) => f(w) && (!q || (w.name + " " + w.author + " " + w.owner + " " + w.description).toLowerCase().includes(q))).sort(cmp);
  }
  const communityResults = (shown) => shown.length ? '<div class="cgrid">' + shown.map(communityCard).join("") + "</div>"
    : '<div class="group"><div class="empty">No widget matches.</div></div>';

  function communityPage() {
    const head = '<div class="page"><h1>Community</h1><p class="sub">Widgets other people share on GitHub, with their author. Install one in two clicks; iCUE asks you to confirm.</p>';
    const share = '<h2 class="grp">Share yours</h2><div class="group">' +
      '<div class="row"><span class="step">1</span><div class="row-text"><span>Put your widget on GitHub</span><small>A public repository with its folder (manifest.json, index.html), or an .icuewidget file in a release</small></div></div>' +
      '<div class="row"><span class="step">2</span><div class="row-text"><span>Add the topic icue-widget</span><small>Or put icuewidget in the repository name. The list is rebuilt every day; your name shows on the card.</small></div></div>' +
      '<div class="row"><div class="row-text"><span>Elgato Marketplace</span><small>The official store for XENEON EDGE widgets</small></div><button type="button" class="btn" data-act="csource" data-src="marketplace"><span>See</span></button></div></div></div>';
    const count = community && community.widgets ? community.widgets.length : null;
    const mcount = community && community.marketplace ? community.marketplace.length : null;
    const tabs = '<div class="seg source" role="group" aria-label="Where the widgets come from">' +
      '<button type="button" data-act="csource" data-src="github" aria-pressed="' + (communitySource !== "marketplace") + '">GitHub' + (count === null ? "" : "<small>" + count + "</small>") + "</button>" +
      '<button type="button" data-act="csource" data-src="marketplace" aria-pressed="' + (communitySource === "marketplace") + '">Elgato Marketplace' + (mcount ? "<small>" + mcount + "</small>" : "") + "</button></div>";
    if (communitySource === "marketplace") return '<div class="page"><h1>Community</h1><p class="sub">Widgets other people share, with their author.</p>' + tabs + marketplacePanel() + marketList() + marketSteps() + "</div>";
    if (!community) return '<p class="waiting">Loading the community list…</p>';
    if (community.error) return head + tabs + alert(community.error, "page-alert") + share;
    if (!C_FILTERS[communityFilter]) communityFilter = "all";
    const list = community.widgets;
    const shown = communityShown();
    const authors = new Set(list.map((w) => String(w.owner).toLowerCase())).size;
    const f = (id) => '<button type="button" data-act="cfilter" data-f="' + id + '" aria-pressed="' + (communityFilter === id) + '">' + C_FILTERS[id][0] + "<small>" + list.filter(C_FILTERS[id][1]).length + "</small></button>";
    const s = (id, label) => '<button type="button" data-act="csort" data-s="' + id + '" aria-pressed="' + (communitySort === id) + '">' + label + "</button>";
    return head + tabs +
      alert("Not made or checked by us. Each widget runs its own code in iCUE: look at its source and its author before installing.", "warn page-alert") +
      '<div class="summary"><div><b>' + two(list.length) + "</b><small>Widgets</small></div><div><b>" + two(authors) + "</b><small>Authors</small></div><div><b>" +
      two(list.filter((w) => w.kind === "release").length) + '</b><small>Packages</small></div><div><b class="date">' + esc(String(community.generated || "").slice(0, 10)) + "</b><small>List updated</small></div></div>" +
      '<div class="toolbar"><div class="filters" role="group" aria-label="Filter">' + Object.keys(C_FILTERS).map(f).join("") + "</div>" +
      '<div class="listbar"><label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      '<input id="community-q" type="search" placeholder="Search a widget or an author" aria-label="Search the community widgets" value="' + esc(communityQuery) + '"></label>' +
      '<div class="seg sort" role="group" aria-label="Order">' + s("stars", "★ Stars") + s("recent", "Recent") + s("az", "A → Z") + "</div></div></div>" +
      '<p class="shown" id="community-shown">' + shown.length + " of " + list.length + " shown</p>" +
      '<div id="community-results">' + communityResults(shown) + "</div>" + share;
  }

  // Elgato Marketplace: the official store. Its widgets come from the user's Elgato account (many are paid) and
  // iCUE installs them; there is no public list, so the companion links to it and downloads nothing.
  function marketplacePanel() {
    return '<div class="market-head"><div><b>Elgato Marketplace</b><p>Free widgets: Get, sign in with your Elgato account, and iCUE installs them. Paid widgets are bought on their page. ' +
      "The companion opens the page and downloads nothing: Marketplace widgets come from your Elgato account.</p></div>" +
      '<div class="btns"><button type="button" class="btn" data-act="link" data-link="marketplace-widgets"><span>Browse the site</span></button>' +
      '<button type="button" class="btn" data-act="link" data-link="marketplace-library"><span>Your library</span></button></div></div>';
  }
  const marketSteps = () => '<h2 class="grp">How it works</h2><div class="group">' +
    '<div class="row"><span class="step">1</span><div class="row-text"><span>Open the widget\'s page</span><small>Get it free or Buy opens it in your browser</small></div></div>' +
    '<div class="row"><span class="step">2</span><div class="row-text"><span>Get or buy it with your Elgato account</span><small>It goes to your library on the Marketplace</small></div></div>' +
    '<div class="row"><span class="step">3</span><div class="row-text"><span>Install it in iCUE</span><small>From the widget\'s page or your library (iCUE 5.44 or later). For a pump widget, open the pump\'s screen in iCUE first.</small></div></div></div>';

  const M_FILTERS = { all: ["All", () => true], free: ["Free", (m) => m.free], paid: ["Paid", (m) => !m.free] };
  const money = (p) => {
    if (!p || typeof p.amount !== "number" || !/^[A-Z]{3}$/.test(p.currency || "")) return "Paid";
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency }).format(p.amount / 100); } catch (_) { return (p.amount / 100).toFixed(2) + " " + p.currency; }
  };
  function marketShown() {
    const list = (community && community.marketplace) || [];
    const q = marketQuery.trim().toLowerCase();
    const f = (M_FILTERS[marketFilter] || M_FILTERS.all)[1];
    const cmp = marketSort === "recent" ? (a, b) => String(b.published).localeCompare(String(a.published))
      : marketSort === "price" ? (a, b) => (a.free === b.free ? 0 : a.free ? -1 : 1)
          || String((a.price && a.price.currency) || "").localeCompare(String((b.price && b.price.currency) || ""))
          || ((a.price && a.price.amount) || 0) - ((b.price && b.price.amount) || 0) || String(a.name).localeCompare(String(b.name))
      : (a, b) => String(a.name).localeCompare(String(b.name), "en", { sensitivity: "base" });
    return list.filter((m) => f(m) && (!q || (m.name + " " + m.maker + " " + m.type + " " + m.description).toLowerCase().includes(q))).sort(cmp);
  }
  function marketCard(m) {
    const img = m.image ? '<img class="mthumb" src="' + esc(m.image) + '" alt="" loading="lazy">' : '<span class="mthumb"></span>';
    const devices = (m.devices || []).map((d) => '<span class="chip scr">' + esc(d) + "</span>").join("") + (m.type ? '<span class="chip">' + esc(m.type) + "</span>" : "");
    const price = m.free ? '<span class="chip pkg">Free</span>' : '<span class="chip paid">' + esc(money(m.price)) + "</span>";
    return '<article class="mcard" data-id="m:' + esc(m.id) + '">' + img + '<div class="mbody"><h3>' + esc(m.name) + '</h3><p class="by">by <b>' + esc(m.maker) + "</b></p>" +
      '<p class="desc">' + esc(m.description || "") + '</p><div class="chips">' + price + devices + "</div>" +
      '<div class="cmod-foot"><span class="cmeta">' + esc(m.published || "") + "</span>" +
      (m.installed ? '<button type="button" class="btn ghost" data-act="market-open" data-id="' + esc(m.id) + '" title="A widget with this name is installed in iCUE">' + TICK + "<span>Installed</span></button>"
        : '<button type="button" class="btn ' + (m.free ? "" : "amber") + '" data-act="market-open" data-id="' + esc(m.id) + '"><span>' + (m.free ? "Get it free" : "Buy · " + esc(money(m.price))) + "</span></button>") + "</div></div></article>";
  }
  const marketResults = (shown) => shown.length ? '<div class="mgrid">' + shown.map(marketCard).join("") + "</div>" : '<div class="group"><div class="empty">No widget matches.</div></div>';
  function marketList() {
    if (!community || !community.marketplace || !community.marketplace.length) return "";
    if (!M_FILTERS[marketFilter]) marketFilter = "all";
    const list = community.marketplace;
    const shown = marketShown();
    const f = (id) => '<button type="button" data-act="mfilter" data-f="' + id + '" aria-pressed="' + (marketFilter === id) + '">' + M_FILTERS[id][0] + "<small>" + list.filter(M_FILTERS[id][1]).length + "</small></button>";
    const s = (id, label) => '<button type="button" data-act="msort" data-s="' + id + '" aria-pressed="' + (marketSort === id) + '">' + label + "</button>";
    return '<h2 class="grp">On the Marketplace<small>list of ' + esc(String(community.generated || "").slice(0, 10)) + "</small></h2>" +
      '<div class="toolbar"><div class="filters" role="group" aria-label="Filter">' + Object.keys(M_FILTERS).map(f).join("") + "</div>" +
      '<div class="listbar"><label class="search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
      '<input id="market-q" type="search" placeholder="Search a widget or a maker" aria-label="Search the Marketplace widgets" value="' + esc(marketQuery) + '"></label>' +
      '<div class="seg sort" role="group" aria-label="Order">' + s("az", "A → Z") + s("recent", "Recent") + s("price", "Price") + "</div></div></div>" +
      '<p class="shown" id="market-shown">' + shown.length + " of " + list.length + " shown</p>" +
      '<div id="market-results">' + marketResults(shown) + "</div>";
  }

  // Install sheet: what the widget is and uses, then the checked download.
  function communitySheet(key) {
    const w = ((community && community.widgets) || []).find((x) => x.key === key);
    if (!w) return;
    const devices = (w.devices || []).map((d) => DEVICE[d] || d);
    const pump = (w.devices || []).includes("pump_lcd");
    const uses = (w.plugins || []).map(PLUGIN).concat(w.interactive ? ["touch"] : []);
    const kb = w.size ? " · " + (w.size >= 1048576 ? (w.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(w.size / 1024)) + " KB") : "";
    const fact = (title, text) => '<li><span class="step">' + TICK + "</span><div><b>" + title + "</b><small>" + esc(text) + "</small></div></li>";
    const sheet = document.getElementById("community-sheet");
    sheet.innerHTML = '<p class="cap">Community · github.com/' + esc(w.repo) + "</p>" +
      '<h2 id="community-sheet-title">Install ' + esc(w.name) + "</h2>" +
      '<p class="sub">by <b>' + esc(w.author || w.owner) + "</b> · " + esc(licence(w.license)) + ". Not checked by us: the companion only makes sure you get exactly the files on the list.</p>" +
      '<ol class="sheet-steps facts-list">' +
      fact("Screen", devices.join(", ") || "Not stated") +
      fact("Uses", uses.length ? uses.join(", ") : "Nothing from iCUE") +
      fact("Source", (w.kind === "release" ? "Package " + (w.asset || "") + " from release " + (w.tag || "") : "Folder " + (w.folder || "(root)") + " at the listed commit, packed by the companion") + kb) +
      (pump ? '<li class="s-open"><span class="step">!</span><div><b>For the pump: show it in iCUE first</b><small>iCUE adds a pump widget only while the pump\'s LCD screen is open in iCUE.</small></div><button type="button" class="btn" data-act="open-icue"><span>Open iCUE</span></button></li>' : "") +
      "</ol>" +
      '<p class="sheet-status" id="community-status" role="status"></p>' +
      '<div class="sheet-foot"><button type="button" class="link" data-act="community-source" data-key="' + esc(w.key) + '">View the source on GitHub</button>' +
      '<div class="btns"><button type="button" class="btn ghost" data-act="sheet-close"><span>Close</span></button>' +
      '<button type="button" class="btn amber" data-act="community-install" data-key="' + esc(w.key) + '" id="community-send"><span>' + (w.installed ? "Install again" : "Install") + "</span></button></div></div>";
    communityJob = { key: w.key, before: !!w.installed, sentAt: 0, phase: "wait" };
    sheet.showModal();
  }
  function communityStatus() {
    if (!communityJob || communityJob.phase !== "sent") return;
    const w = ((community && community.widgets) || []).find((x) => x.key === communityJob.key);
    const st = document.getElementById("community-status");
    if (!st) return;
    if (w && w.installed && !communityJob.before) {
      communityJob.phase = "installed";
      st.className = "sheet-status ok";
      st.textContent = w.name + " is installed in iCUE. Place it from iCUE" + ((w.devices || []).includes("pump_lcd") && !(w.devices || []).includes("dashboard_lcd") ? " on the pump's screen." : ".");
      const send = document.getElementById("community-send");
      if (send) send.hidden = true;
    } else if (Date.now() - communityJob.sentAt > 25000) {
      communityJob.phase = "wait";
      st.className = "sheet-status warn";
      st.textContent = communityJob.before ? "Sent again. The same version gives no visible change." : "iCUE has not added it yet. Confirm in iCUE; for the pump, open its screen in iCUE first.";
    }
  }

  // ---------- Changelog (CHANGELOG.md of the repository, built into the companion) ----------
  let changelogText = null;
  let changelogAll = false;
  async function loadChangelog() {
    try { changelogText = await U.invoke("changelog"); } catch (_) { changelogText = ""; }
    if (page === "changelog") render();
  }
  // Markdown, the little the changelog uses: `code`, **bold**, [text](link) shown as its text.
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const SHOWN = 8;
  function changelogPage() {
    if (changelogText === null) return '<p class="waiting">Loading…</p>';
    const releases = [];
    let rel = null, sec = null;
    for (const raw of changelogText.split(/\r?\n/)) {
      const line = raw.trim();
      let m;
      if ((m = /^## \[([^\]]+)\](?:\s*-\s*(.+))?/.exec(line))) { rel = { name: m[1], date: m[2] || "", secs: [] }; releases.push(rel); sec = null; }
      else if (!rel || !line || line === "---") continue;
      else if ((m = /^### (.+)/.exec(line))) { sec = { title: m[1], items: [] }; rel.secs.push(sec); }
      else {
        if (!sec) { sec = { title: "", items: [] }; rel.secs.push(sec); }
        if ((m = /^[-*] (.+)/.exec(line)) || !sec.items.length) sec.items.push(m ? m[1] : line);
        else sec.items[sec.items.length - 1] += " " + line;
      }
    }
    const total = releases.reduce((n, r) => n + r.secs.length, 0);
    let left = changelogAll ? Infinity : SHOWN;
    const KIND = /^(Added|Changed|Fixed|Removed|Security|Deprecated)\b\s*(?:-\s*)?(.*)$/;
    const body = releases.map((r) => {
      const secs = r.secs.slice(0, Math.max(0, left));
      left -= secs.length;
      if (!secs.length) return "";
      return '<h2 class="grp">' + esc(r.name) + (r.date ? "<small>" + esc(r.date) + "</small>" : "") + "</h2>" + secs.map((s) => {
        const k = KIND.exec(s.title);
        const head = k ? '<span class="kind ' + k[1].toLowerCase() + '">' + k[1] + "</span>" + (k[2] ? "<b>" + inline(k[2]) + "</b>" : "") : s.title ? "<b>" + inline(s.title) + "</b>" : "";
        return '<section class="group rel">' + (head ? '<div class="rel-head">' + head + "</div>" : "") + '<ul class="rel-list">' + s.items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</ul></section>";
      }).join("");
    }).join("");
    return '<div class="page"><h1>Changelog</h1><p class="sub">What changed in the widgets and in iCUE Edge Companion, newest first.</p>' +
      (body || '<div class="group"><div class="empty">The changelog could not be read.</div></div>') +
      (!changelogAll && total > SHOWN ? '<div class="more"><button type="button" class="btn" data-act="changelog-all"><span>Show all ' + total + " changes</span></button></div>" : "") + "</div>";
  }

  // ---------- AI cost (estimate from token counts) ----------
  function aiCost() {
    const wire = U.wire;
    if (!wire) return '<p class="waiting">Loading…</p>';
    const C = window.Costs, s = C.summarize(wire), m = C.money;
    const max = Math.max(...s.series, 0.0001);
    const bars = s.series.map((v, i) => '<rect class="' + (v ? "" : "z") + '" x="' + (i * 10 + 1) + '" y="' + (62 - Math.max(2, v / max * 60)).toFixed(1) + '" width="8" height="' + Math.max(2, v / max * 60).toFixed(1) + '" rx="2"/>').join("");
    const per = s.providers.map((p) => '<div class="row"><span class="mark sm ' + p.id + '">' + (U.LOGO[p.id] || "") + '</span><div class="row-text"><span>' + esc(p.name) + "</span><small>" +
      esc(p.model || "No model seen yet") + " · priced as " + esc(p.tier) + " ($" + p.price[0] + " / $" + p.price[1] + " per million tokens)</small></div>" +
      '<div class="row-text row-right"><span class="num">' + m(p.today) + "</span><small>" + U.big(p.tokens) + " tokens</small></div></div>").join("");
    return '<div class="page"><h1>AI cost</h1><p class="sub">What today’s Claude and Codex tokens would cost at public API prices.</p>' +
      '<div class="cost-hero"><b>' + m(s.today) + "</b><small>today · " + U.big(s.tokensToday) + " tokens</small></div>" +
      '<div class="group chart-group"><svg class="bars24" viewBox="0 0 240 64" preserveAspectRatio="none" aria-label="Cost per hour, last 24 hours">' + bars + "</svg></div>" +
      '<div class="summary"><div><b>' + m(s.yesterday) + "</b><small>yesterday</small></div><div><b>" + (s.month === null ? "--" : m(s.month)) + "</b><small>month so far</small></div><div><b>" +
      (s.pace === null ? "--" : m(s.pace)) + "</b><small>pace for the month</small></div></div>" +
      '<div class="group-title">By provider</div><div class="group">' + per + "</div>" +
      '<p class="hint">An estimate, not a bill: subscriptions (Pro, Max, Plus) are not billed per token. The price follows the model last seen; long-context surcharges are not counted. Prices checked 3 Nov 2026.</p></div>';
  }

  // ---------- Screen Time ----------
  const dur = (secs) => { const h = Math.floor(secs / 3600), mn = Math.round(secs % 3600 / 60); return h ? h + " h " + String(mn).padStart(2, "0") + " min" : mn + " min"; };
  function screenTime() {
    const st = screen;
    if (!st) return '<p class="waiting">Loading…</p>';
    if (!st.enabled) return '<div class="page"><h1>Screen time</h1><p class="sub">Time per application, on this computer only.</p><div class="group">' +
      '<div class="row"><div class="row-text"><span>Not counting yet</span><small>It starts when you press Start or when the Screen Time widget first runs. Only application names and seconds are kept, never window titles or what you type; idle time and the lock screen do not count.</small></div>' +
      '<button type="button" class="btn" data-act="st-start">Start</button></div></div></div>';
    const top = Math.max(1, ...st.apps.map((a) => a.secs));
    // The app's own icon (read by the companion); its initial when the executable has none.
    const appIcon = (a) => a.icon && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(a.icon) ? '<img class="app-ico" src="' + a.icon + '" alt="">' : '<span class="app-ico letter" aria-hidden="true">' + esc((a.name || "?").charAt(0).toUpperCase()) + "</span>";
    const apps = st.apps.length ? st.apps.map((a) => '<div class="row">' + appIcon(a) + '<div class="row-text"><span>' + esc(a.name) + "</span><small>" + esc(a.cat) + '</small></div><div class="limit-right">' +
      '<div class="bar"><i data-w="' + Math.round(a.secs / top * 100) + '"></i></div><b>' + dur(a.secs) + "</b></div></div>").join("") : '<div class="empty">Nothing counted yet today.</div>';
    const wmax = Math.max(1, ...st.week.map((d) => d.secs));
    const week = st.week.map((d, i) => '<rect class="' + (d.secs ? "" : "z") + '" x="' + (i * 34 + 2) + '" y="' + (62 - Math.max(2, d.secs / wmax * 60)).toFixed(1) + '" width="30" height="' + Math.max(2, d.secs / wmax * 60).toFixed(1) + '" rx="3"/>').join("");
    return '<div class="page"><h1>Screen time</h1><p class="sub">Time per application, on this computer only.</p>' +
      '<div class="cost-hero"><b>' + dur(st.todaySecs) + "</b><small>today · yesterday " + (st.yesterdaySecs ? dur(st.yesterdaySecs) : "no data") + "</small></div>" +
      '<div class="group-title">Applications today</div><div class="group">' + apps + "</div>" +
      '<div class="group-title">Last 7 days</div><div class="group chart-group"><svg class="bars24" viewBox="0 0 240 64" preserveAspectRatio="none" aria-label="Time per day, last 7 days">' + week + "</svg></div>" +
      '<p class="hint">Kept in %LOCALAPPDATA%\\icue-edge-companion\\screentime.json, 35 days at most, never sent anywhere. To stop and erase: quit the companion and delete that file and screentime-icons.json (the app icons).</p></div>';
  }
  async function loadScreen(start) {
    try { screen = await U.invoke(start ? "screentime_enable" : "screentime_state"); } catch (_) { screen = null; }
    if (page === "screentime") render();
  }

  function settings(v) {
    const i = info || {};
    const sw = (on, act, label) => '<button type="button" class="switch" role="switch" data-act="' + act + '" aria-checked="' + !!on + '" aria-label="' + label + '"></button>';
    const theme = document.documentElement.dataset.theme;
    const opt = (id, label) => '<button type="button" data-act="theme" data-theme="' + id + '" aria-pressed="' + (theme === id) + '">' + label + "</button>";
    const ai = window.showAi();
    return '<div class="page"><h1>Settings</h1><p class="sub">Appearance, startup, collection and stored data.</p>' +
      '<div class="group-title">Appearance</div><div class="group">' +
      '<div class="row"><div class="row-text"><span>Theme</span><small>OLED keeps every surface true black</small></div><div class="seg" role="group" aria-label="Theme">' +
      opt("light", "Light") + opt("dark", "Dark") + opt("oled", "OLED") + "</div></div></div>" +
      '<div class="group-title">AI usage</div><div class="group">' +
      '<div class="row"><div class="row-text"><span>Show AI usage</span><small>Claude and Codex limits, tokens and estimated cost, in this window and the tray menu. For people who use AI coding tools (Claude Code, Codex) a lot; off by default.</small></div>' +
      sw(ai, "show-ai", "Show AI usage") + "</div></div>" +
      '<div class="group-title">Startup</div><div class="group">' +
      '<div class="row"><div class="row-text"><span>Start with Windows</span><small>iCUE Edge Companion opens in the notification area</small></div>' + sw(i.autostart, "autostart", "Start with Windows") + "</div></div>" +
      '<div class="group-title">Collection</div><div class="group">' +
      '<div class="row"><div class="row-text"><span>Collect data</span><small>Turn off to pause everything</small></div>' + sw(!v.paused, "collect", "Collect data") + "</div>" +
      (ai ? '<div class="row"><div class="row-text"><span>Refresh limits now</span><small>At most once every 30 seconds</small></div><button type="button" class="btn" data-act="refresh">Refresh</button></div>' +
      '<div class="row"><div class="row-text"><span>Renew the Claude sign-in</span><small>When Claude Code has not renewed it, the companion does and rewrites ~/.claude/.credentials.json</small></div>' + sw(i.renewClaudeToken, "renew", "Renew the Claude sign-in") + "</div>" : "") + "</div>" +
      (ai ? '<div class="group-title">Data</div><div class="group">' +
      '<div class="row"><div class="row-text"><span>Stored history</span><small>90 days, on this computer only. Nothing is sent elsewhere.</small></div></div>' +
      '<div class="row"><div class="row-text"><span>Clear history</span><small>Ongoing sessions will not be counted again</small></div><button type="button" class="btn danger" data-act="clear">Clear…</button></div></div>' : "") +
      '<div class="group-title">About</div><div class="group">' +
      '<div class="row"><div class="row-text"><span>iCUE Edge Companion ' + esc(i.version || "") + "</span><small>MIT license</small></div></div>" +
      '<div class="row"><div class="row-text"><span>Project</span><small>github.com/inerthel-agi/icue-edge-widgets</small></div><button type="button" class="btn" data-act="link" data-link="repo">Open</button></div>' +
      '<div class="row"><div class="row-text"><span>Author</span><small>github.com/inerthel-agi</small></div><button type="button" class="btn" data-act="link" data-link="profile">Open</button></div>' +
      '<div class="row"><div class="row-text"><small>Not affiliated with or endorsed by Corsair Gaming, Inc., Anthropic, OpenAI or Spotify. iCUE, XENEON, Claude, Codex and Spotify are trademarks of their owners.</small></div></div></div></div>';
  }

  // ---------- Spotify (needs spotify_page; the tokens never reach this page) ----------
  const SP_STATUS = {
    not_configured: ["Not connected", ""], connecting: ["Connecting", "busy"], connected: ["Connected", "live"],
    needs_login: ["Sign in again", "warn"], premium_required: ["Premium required", "danger"], error: ["Action needed", "danger"],
  };
  const validClientId = (v) => /^[A-Za-z0-9]{32}$/.test(v);
  const spRow = (title, sub, right) => '<div class="row"><div class="row-text"><span>' + title + "</span>" + (sub ? "<small>" + sub + "</small>" : "") + "</div>" + (right || "") + "</div>";

  function spotifyPage(s) {
    if (!s) return '<p class="waiting">Loading…</p>';
    let [label, cls] = SP_STATUS[s.status] || SP_STATUS.error;
    // Spotify asked this app to wait (too many requests): nothing can be read or refreshed until then.
    const wait = s.rateLimitedUntil ? new Date(s.rateLimitedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    if (wait) [label, cls] = ["Waiting until " + wait, "warn"];
    const head = '<div class="page-head"><span class="mark spotify">' + U.LOGO.spotify + '</span><h1>Spotify</h1><span class="pill ' + cls + '">' + label + "</span></div>" +
      '<p class="sub">Controls Spotify from the XENEON EDGE widget with your own Spotify app. The companion stores no password and no client secret.</p>';
    const problem = wait
      ? alert("Spotify asked this app to wait until " + wait + " (too many requests). Until then the account, the token and the queue cannot be read; the widget follows the Spotify app on this PC instead.", "warn page-alert")
      : s.message && s.status !== "connected" ? alert(s.message, s.status === "needs_login" ? "warn page-alert" : "page-alert") : "";
    if (s.pending) {
      return '<div class="page">' + head + alert("Finish signing in to Spotify in your browser. This page updates by itself.", "warn page-alert") +
        '<div class="group">' + spRow("Browser did not open?", "Start the sign-in again, or cancel.", '<div class="btns"><button type="button" class="btn" data-act="sp-connect">Open again</button><button type="button" class="btn" data-act="sp-cancel">Cancel</button></div>') + "</div></div>";
    }
    if (s.status === "connected" || (s.status === "connecting" && s.clientIdTail)) {
      const acc = s.account;
      const dev = s.device;
      const item = s.item;
      return '<div class="page">' + head + problem +
        '<div class="group-title">Account</div><div class="group">' +
        spRow(acc ? esc(acc.name) : wait ? "Account read after " + wait : "Reading account…", acc ? esc(acc.product === "premium" ? "Premium" : acc.product) : "", acc && acc.product === "premium" ? '<span class="tag">Premium</span>' : "") +
        spRow("Client ID", '<span class="mono">' + "•".repeat(28) + esc(s.clientIdTail || "") + "</span>", '<button type="button" class="btn" data-act="sp-change">Change</button>') + "</div>" +
        '<div class="group-title">Access</div><div class="group">' +
        spRow("Token", "Stored encrypted for your Windows account. Refreshed automatically; never displayed.", (wait && s.status !== "connected" ? '<span class="pill warn">Waiting</span>' : '<span class="pill ' + (s.status === "connected" ? "live" : "busy") + '">' + (s.status === "connected" ? "Valid" : "Refreshing") + "</span>")) +
        spRow("Permissions", '<span class="scopes">' + (s.scopes || []).map((x) => '<span class="tag">' + esc(x) + "</span>").join("") + "</span>") + "</div>" +
        '<div class="group-title">Playback</div><div class="group">' +
        (s.local ? spRow(esc(s.local.title), esc(s.local.artists) + (s.local.playing ? " · playing" : " · paused") + " · from the Spotify app on this PC (Windows)")
          : dev ? spRow(esc(dev.name) + " · " + esc(dev.type), "Active device" + (dev.volume == null ? " · volume fixed by the device" : " · volume " + dev.volume + "%")) : spRow("No active device", "Start Spotify on a computer, phone or speaker.")) +
        (item && !s.local ? spRow(esc(item.title), esc(item.artists) + (item.playing ? " · playing" : " · paused")) : "") +
        spRow("Lyrics", "Synced lyrics from LRCLIB (community database) · " + esc(s.lyrics)) +
        spRow("Refresh", "With the Spotify app open on this PC: every 15 s while playing, 30 s otherwise, and at once on each change in the app. Without it: every 3 s while playing, 5 to 10 s otherwise. At most 20 requests per 30 s; Spotify waits are respected, also across restarts.") + "</div>" +
        '<div class="group-title">XENEON widget</div><div class="group">' + spRow("Spotify widget", "Add “Spotify” in iCUE · XENEON EDGE. Nothing to enter in iCUE.") + "</div>" +
        '<div class="group">' + spRow("Disconnect", "Deletes the token from this computer. The widget shows “Connect Spotify”.", '<button type="button" class="btn danger" data-act="sp-disconnect">Disconnect</button>') + "</div></div>";
    }
    const again = s.status === "needs_login" && s.clientIdTail
      ? '<div class="group">' + spRow("Connect again", "Uses the saved Client ID ending in " + esc(s.clientIdTail) + ".", '<button type="button" class="btn primary" data-act="sp-connect">Connect again</button>') + "</div>"
      : "";
    return '<div class="page">' + head + problem + again +
      '<div class="group-title">Connect your Spotify account</div><div class="group">' +
      '<div class="row"><ol class="steps">' +
      "<li>Open <b>developer.spotify.com/dashboard</b> and create an app with the <b>Web API</b>.</li>" +
      "<li>Add this <b>Redirect URI</b> to the app, exactly as written.</li>" +
      "<li>Under <b>User Management</b>, add the e-mail of your Spotify account.</li>" +
      "<li>Copy the app's <b>Client ID</b> below, then select <b>Connect</b>. Your browser opens to approve access.</li></ol></div>" +
      spRow("Redirect URI", '<span class="mono">' + esc(s.redirectUri) + "</span>", '<button type="button" class="btn" data-act="sp-copy">Copy</button>') +
      '<div class="row"><div class="row-text grow"><span>Client ID</span><div class="field">' +
      '<input id="sp-client-id" data-act="sp-client-id" autocomplete="off" spellcheck="false" maxlength="32" aria-label="Client ID" placeholder="32 characters from your Spotify app" value="' + esc(spClientId) + '" aria-describedby="sp-hint" />' +
      '<button type="button" class="btn primary" data-act="sp-connect-new"' + (validClientId(spClientId) ? "" : " disabled") + ">Connect</button></div>" +
      '<small class="hint" id="sp-hint">A Client ID is 32 letters and digits. It is not a secret; no client secret is needed.</small></div></div></div>' +
      '<div class="group-title">Requirements</div><div class="group">' +
      spRow("Spotify Premium", "Required by Spotify for playback control, for you and for the app owner.") +
      spRow("Development mode", "A personal Spotify app accepts up to 5 accounts listed under User Management.") + "</div></div>";
  }

  let media = null;
  // The artwork (a data URL) is sent only when the track changes; in between the cached one is reused.
  let mediaArt = { key: null, url: null };
  async function loadMedia() {
    try {
      media = await U.invoke("media_state", { known: mediaArt.key });
      const s = media && media.session;
      if (s && s.art && s.art.url) mediaArt = { key: s.art.key, url: s.art.url };
      else if (s && s.art && s.art.key === mediaArt.key) s.art.url = mediaArt.url;
      else mediaArt = { key: null, url: null };
    } catch (_) { media = null; }
    if (page === "overview") render();
  }

  async function loadSpotify() {
    try { sp = await U.invoke("spotify_page"); } catch (_) { sp = null; }
    render();
  }

  // ---------- rendering ----------
  function render() {
    const v = U.view;
    let html;
    if (!v) html = '<p class="waiting">' + esc(U.link.message || "Loading…") + "</p>";
    else if (page === "claude" || page === "codex") html = providerPage(v[page]);
    else if (page === "widgets") html = widgets();
    else if (page === "aicost") html = aiCost();
    else if (page === "screentime") html = screenTime();
    else if (page === "spotify") html = spotifyPage(sp);
    else if (page === "settings") html = settings(v);
    else if (page === "changelog") html = changelogPage();
    else if (page === "community") html = communityPage();
    else html = overview(v);
    // Where you are, one click from the Overview.
    if (page !== "overview" && html.startsWith('<div class="page">'))
      html = '<div class="page"><p class="crumb"><button type="button" data-page="overview">Overview</button><span aria-hidden="true">›</span><span>' + TITLES[page] + "</span></p>" + html.slice(18);
    // Re-render only on change so scrolling, focus and open sections stay put.
    if (html !== lastHtml) {
      const focused = document.activeElement && content.contains(document.activeElement) ? document.activeElement.dataset.act || document.activeElement.dataset.go : null;
      const focusedTheme = focused === "theme" ? document.activeElement.dataset.theme : null;
      // On the same page the bars grow from their old widths; on a new page they grow from zero.
      const from = renderedPage === page ? [...content.querySelectorAll("[data-w]")].map((e) => Number(e.dataset.w)) : [];
      content.innerHTML = html;
      lastHtml = html;
      renderedPage = page;
      U.applyWidths(content, from);
      // A page slides in once, when its real content first shows (not for the "Loading…" placeholder).
      if (enterPending && !html.includes('class="waiting"')) { enterPending = false; enterPage(); }
      if (focused) { const el = content.querySelector(focusedTheme ? '[data-theme="' + focusedTheme + '"]' : '[data-act="' + focused + '"],[data-go="' + focused + '"]'); if (el) el.focus(); }
    }
    chrome(v);
  }

  // ---------- motion ----------
  // Web Animations on the blocks already in place: a later re-render (a clock tick, a new reading)
  // makes new nodes that are not animated, so nothing replays on its own.
  function countUp(el) {
    const m = /^(\d+)(.*)$/.exec(el.textContent.trim());
    if (!m || Number(m[1]) === 0) return;
    const end = Number(m[1]), rest = m[2], t0 = performance.now(), ms = 800;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      el.textContent = Math.round(end * (1 - Math.pow(1 - k, 3))) + rest;
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = "0" + rest;
    requestAnimationFrame(step);
  }

  function enterPage() {
    if (still.matches) return;
    const root = content.querySelector(".page") || content;
    const blocks = [];
    for (const el of root.children) { if (el.classList.contains("cards")) blocks.push(...el.children); else blocks.push(el); }
    blocks.forEach((el, i) => el.animate(
      [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }],
      { duration: 420, delay: Math.min(i, 8) * 55, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" }));
    content.querySelectorAll(".spark").forEach((el) => el.animate(
      [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }],
      { duration: 1000, delay: 250, easing: "cubic-bezier(.3,.6,.2,1)", fill: "backwards" }));
    content.querySelectorAll(".hero-figure b, .limit-right b").forEach((el) => { if (/^\d+%/.test(el.textContent.trim())) countUp(el); });
  }

  // Widgets page after a filter, order or screen change: focus stays on the pressed control, cards that stay
  // glide to their new place and new ones rise in.
  function reorder(pressed) {
    const before = new Map([...content.querySelectorAll("[data-id]")].map((el) => [el.dataset.id, el.getBoundingClientRect()]));
    render();
    const b = content.querySelector(pressed);
    if (b) b.focus();
    if (still.matches) return;
    if (b) b.animate([{ transform: "scale(.94)" }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" });
    let n = 0;
    content.querySelectorAll("[data-id]").forEach((el) => {
      const r = before.get(el.dataset.id);
      if (r) {
        const a = el.getBoundingClientRect();
        const dx = r.left - a.left, dy = r.top - a.top;
        if (dx || dy) el.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.75,.2,1)" });
      } else {
        el.animate([{ opacity: 0, transform: "translateY(10px) scale(.98)" }, { opacity: 1, transform: "none" }],
          { duration: 300, delay: Math.min(n++, 14) * 18, easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" });
      }
    });
  }

  // Sidebar: how many widgets sit on each screen.
  function devices() {
    const list = (info && info.widgets) || [];
    for (const s of ["edge", "pump"]) {
      const n = list.filter((w) => screenOf(w) === s && (w.placed || w.live)).length;
      const el = document.getElementById("dev-" + s);
      const b = el.querySelector("b");
      b.textContent = info ? String(n) : "–";
      b.classList.toggle("zero", !n);
      el.title = n + (n === 1 ? " widget" : " widgets") + " placed on " + SCREEN_NAME[s];
    }
  }

  function moveNav(instant) {
    const ind = document.getElementById("navInd");
    const cur = document.querySelector('.nav[aria-current="page"]');
    if (!ind || !cur) return;
    ind.classList.toggle("instant", !!instant);
    ind.style.height = cur.offsetHeight + "px";
    ind.style.transform = "translateY(" + cur.offsetTop + "px)";
    ind.classList.add("ready");
    if (instant) requestAnimationFrame(() => ind.classList.remove("instant"));
  }
  window.addEventListener("resize", () => moveNav(true));
  window.addEventListener("ai-change", () => { lastHtml = ""; render(); moveNav(true); });

  function chrome(v) {
    const side = document.getElementById("side-status");
    const msg = document.getElementById("footer-msg");
    if (!v) { side.textContent = "Connecting…"; side.classList.add("warn"); return; }
    side.textContent = v.paused ? "Collection paused" : "Collection active";
    side.classList.toggle("warn", v.paused);
    for (const p of [v.claude, v.codex]) {
      document.getElementById("dot-" + p.id).className = "dot " + (p.state === "live" ? "live" : p.state);
      // The dot is colour only: the state is also given to screen readers.
      document.querySelector('.nav[data-page="' + p.id + '"]').setAttribute("aria-label", p.name + ": " + p.stateText);
    }
    if (sp) document.getElementById("dot-spotify").className = "dot " + (sp.status === "connected" ? "live" : sp.status === "not_configured" ? "" : "warn");
    const problem = window.showAi() ? [v.claude, v.codex].find((p) => p.state === "danger") : null;
    msg.classList.toggle("warn", v.paused || !!problem);
    const last = Math.max(v.claude.lastEventAt || 0, v.codex.lastEventAt || 0, v.claude.limitsAt || 0, v.codex.limitsAt || 0);
    msg.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      (v.paused ? '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>' : problem ? '<path d="M12 8v5M12 16h.01"/>' : '<path d="M20 6 9 17l-5-5"/>') + "</svg>" +
      esc(v.paused ? "Collection paused" : problem ? problem.name + ": something needs attention" : window.showAi() ? "Data up to date · last activity " + U.ago(last) : "iCUE Edge Companion is running");
  }

  // Pump install sheet: what was sent, and whether iCUE has added it (the installed files change).
  // phase: "wait" (not sent), "sent", "installed" (files arrived), "placed" (chosen on the pump's screen).
  let pumpJob = null;
  function pumpSheet(w) {
    pumpJob = { id: w.id, before: w.update, sentAt: 0, phase: "wait" };
    document.getElementById("pump-sheet").classList.remove("done", "placed");
    document.getElementById("pump-sheet-title").textContent = "Install " + w.name + " on the pump";
    const send = document.getElementById("pump-send");
    send.dataset.id = w.id;
    send.querySelector("span").textContent = w.update === "outdated" ? "Update" : w.update === "current" ? "Reinstall" : "Install";
    const st = document.getElementById("pump-status");
    st.className = "sheet-status";
    st.textContent = "";
    document.getElementById("pump-sheet").showModal();
  }
  function pumpStatus() {
    if (!pumpJob) return;
    const w = ((info && info.widgets) || []).find((x) => x.id === pumpJob.id);
    if (!w) return;
    const sheet = document.getElementById("pump-sheet");
    const st = document.getElementById("pump-status");
    if (pumpJob.phase === "sent") {
      if (pumpJob.before !== "current" && w.update === "current") {
        pumpJob.phase = "installed";
        sheet.classList.add("done");
        st.className = "sheet-status ok";
        st.textContent = w.name + " is installed in iCUE. Last step: choose it on the pump's screen.";
      } else if (Date.now() - pumpJob.sentAt > 20000) {
        pumpJob.phase = "wait";
        st.className = "sheet-status warn";
        st.textContent = pumpJob.before === "current" ? "Sent. The same version gives no visible change."
          : "iCUE has not added it yet. Check that the pump's screen is open in iCUE and press Install again, or import the file from that screen.";
      }
    }
    if (pumpJob.phase === "installed" && (w.placed || w.live)) {
      pumpJob.phase = "placed";
      sheet.classList.add("placed");
      st.textContent = w.name + " is on the pump. You can close this sheet.";
    }
  }

  // When the XENEON EDGE layout changes in iCUE, the map redraws and its tiles settle in.
  let lastLayout = null;
  async function loadInfo() {
    try { info = await U.invoke("app_info"); } catch (_) { info = null; }
    const ver = document.getElementById("version");
    if (info) ver.textContent = "Version " + info.version;
    devices();
    render();
    const layout = info ? JSON.stringify(info.edgeLayout) : null;
    if (lastLayout !== null && layout !== lastLayout && !still.matches)
      content.querySelectorAll(".glass .tile").forEach((el) => el.animate([{ opacity: 0, transform: "scale(.94)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.75,.2,1)" }));
    if (layout) lastLayout = layout;
    pumpStatus();
  }

  function go(next, how) {
    if (how === "back") { if (!hist.back.length) return; hist.fwd.push(page); next = hist.back.pop(); }
    else if (how === "fwd") { if (!hist.fwd.length) return; hist.back.push(page); next = hist.fwd.pop(); }
    else if (!TITLES[next]) return;
    else if (next !== page) { hist.back.push(page); hist.fwd.length = 0; if (hist.back.length > 50) hist.back.shift(); }
    document.getElementById("navBack").disabled = !hist.back.length;
    document.getElementById("navFwd").disabled = !hist.fwd.length;
    page = next;
    document.querySelectorAll(".nav").forEach((n) => n.setAttribute("aria-current", n.dataset.page === page ? "page" : "false"));
    lastHtml = "";
    enterPending = true;
    moveNav(false);
    render();
    content.scrollTop = 0;
    if (page === "widgets" || page === "settings") loadInfo();
    if (page === "spotify") loadSpotify();
    if (page === "screentime") loadScreen();
    if (page === "changelog" && changelogText === null) loadChangelog();
    if (page === "community") loadCommunity();
    if (page === "overview") { loadMedia(); loadInfo(); }
  }

  function flash(el, text, ms) {
    // The first label is kept, so a second click during the message cannot make it permanent.
    const old = (el.dataset.orig ??= el.textContent);
    const btn = el.closest("button") || el;
    el.textContent = text;
    btn.disabled = true;
    clearTimeout(el._flash);
    el._flash = setTimeout(() => { el.textContent = old; btn.disabled = false; }, ms || 1800);
  }

  document.addEventListener("click", async (e) => {
    const win = e.target.closest("[data-win]");
    if (win) {
      const w = window.__TAURI__.window.getCurrentWindow();
      return win.dataset.win === "minimize" ? w.minimize() : win.dataset.win === "maximize" ? w.toggleMaximize() : w.close();
    }
    if (e.target.closest("#navBack")) return go(null, "back");
    if (e.target.closest("#navFwd")) return go(null, "fwd");
    const nav = e.target.closest("[data-page]"); if (nav) return go(nav.dataset.page);
    const to = e.target.closest("[data-go]"); if (to) return go(to.dataset.go);
    if (e.target.closest("#refresh")) {
      const ok = await U.refresh();
      return flash(document.getElementById("refresh-label"), ok ? "Refresh requested" : "Try again in 30 s");
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    switch (act.dataset.act) {
      case "theme": {
        const root = document.documentElement;
        root.classList.add("theme-fade");
        setTimeout(() => root.classList.remove("theme-fade"), 450);
        window.setTheme(act.dataset.theme);
        lastHtml = "";
        return render();
      }
      case "changelog-all": changelogAll = true; return render();
      case "cfilter": communityFilter = act.dataset.f; store("community.filter", communityFilter); return reorder('[data-f="' + communityFilter + '"]');
      case "csort": communitySort = act.dataset.s; store("community.sort", communitySort); return reorder('[data-s="' + communitySort + '"]');
      case "community-open": return communitySheet(act.dataset.key);
      case "mfilter": marketFilter = act.dataset.f; store("market.filter", marketFilter); return reorder('[data-act="mfilter"][data-f="' + marketFilter + '"]');
      case "msort": marketSort = act.dataset.s; store("market.sort", marketSort); return reorder('[data-act="msort"][data-s="' + marketSort + '"]');
      case "market-open":
        try { await U.invoke("marketplace_open", { id: act.dataset.id }); flash(act.querySelector("span") || act, "Opened in your browser", 2500); } catch (_) { flash(act.querySelector("span") || act, "Unavailable"); }
        return;
      case "csource": communitySource = act.dataset.src; store("community.source", communitySource); lastHtml = ""; return render();
      case "community-source":
        try { await U.invoke("community_source", { key: act.dataset.key }); } catch (_) { flash(act.querySelector("span") || act, "Unavailable"); }
        return;
      case "community-install": {
        const st = document.getElementById("community-status");
        st.className = "sheet-status";
        st.textContent = "Downloading and checking every file…";
        flash(act.querySelector("span") || act, "Checking…", 4000);
        try {
          await U.invoke("community_install", { key: act.dataset.key });
          communityJob = { ...(communityJob || {}), key: act.dataset.key, sentAt: Date.now(), phase: "sent" };
          st.textContent = "Checked and sent to iCUE. Confirm there; this line updates when iCUE has it.";
        } catch (e) {
          st.className = "sheet-status warn";
          st.textContent = String(e);
        }
        return;
      }
      case "show-ai":
        window.setShowAi(!window.showAi());
        lastHtml = "";
        if (!window.showAi() && (page === "claude" || page === "codex" || page === "aicost")) return go("overview");
        render();
        return moveNav(true);
      case "autostart":
        await U.invoke("set_autostart", { enabled: act.getAttribute("aria-checked") !== "true" });
        return loadInfo();
      case "renew":
        await U.invoke("set_renew_claude_token", { enabled: act.getAttribute("aria-checked") !== "true" });
        return loadInfo();
      case "collect":
        return U.invoke("set_paused", { paused: act.getAttribute("aria-checked") === "true" });
      case "refresh": return flash(act, (await U.refresh()) ? "Requested" : "In 30 s");
      case "clear":
        if (!confirm("Clear usage history? Today's totals restart from zero; nothing is counted again.")) return;
        await U.invoke("clear_history");
        return flash(act, "Cleared");
      case "wfilter": widgetFilter = act.dataset.f; store("widgets.filter", widgetFilter); return reorder('[data-f="' + widgetFilter + '"]');
      case "wsort": widgetSort = act.dataset.s; store("widgets.sort", widgetSort); return reorder('[data-s="' + widgetSort + '"]');
      case "wscreen":
        widgetScreen = widgetScreen === act.dataset.screen ? "all" : act.dataset.screen;
        store("widgets.screen", widgetScreen);
        return reorder('.map [data-screen="' + act.dataset.screen + '"]');
      case "wscreen-go": widgetScreen = act.dataset.screen; store("widgets.screen", widgetScreen); return go("widgets");
      case "np": {
        const s = media && media.session;
        if (!s) return;
        try { await U.invoke("media_command", { body: { cmd: act.dataset.cmd, sessionId: s.id, rev: s.rev } }); } catch (_) { flash(act, "!"); }
        return setTimeout(loadMedia, 350);
      }
      case "st-start": return loadScreen(true);
      case "install-pump": {
        const w = ((info && info.widgets) || []).find((x) => x.id === act.dataset.id);
        return w && pumpSheet(w);
      }
      case "open-icue":
        try { await U.invoke("open_icue"); } catch (_) { flash(act.querySelector("span") || act, "iCUE not found"); }
        return;
      case "show-package":
        if (!pumpJob) return;
        try { await U.invoke("show_package", { id: pumpJob.id }); } catch (_) { flash(act, "Unavailable"); }
        return;
      case "sheet-close": return act.closest("dialog").close();
      case "install":
        if (act.id === "pump-send" && pumpJob) {
          pumpJob.sentAt = Date.now();
          pumpJob.phase = "sent";
          const st = document.getElementById("pump-status");
          st.className = "sheet-status";
          st.textContent = "Sent to iCUE. Confirm there; this line updates when the pump has it.";
        }
        flash(act.querySelector("span") || act, "Opening iCUE…", 4000);
        try { await U.invoke("install_widget", { id: act.dataset.id }); } catch (e) { flash(act.querySelector("span") || act, "Failed"); }
        return;
      case "link":
        try { await U.invoke("open_link", { link: act.dataset.link }); } catch (_) { flash(act, "Unavailable"); }
        return;
      case "sp-copy":
        try { await navigator.clipboard.writeText(sp.redirectUri); flash(act, "Copied"); } catch (_) { flash(act, "Select and copy it"); }
        return;
      case "sp-connect-new":
      case "sp-connect":
        try { await U.invoke("spotify_connect", { clientId: act.dataset.act === "sp-connect-new" ? spClientId : "" }); }
        catch (err) { window.alert(String(err)); }
        return loadSpotify();
      case "sp-cancel": await U.invoke("spotify_cancel"); return loadSpotify();
      case "sp-change":
      case "sp-disconnect":
        if (!confirm("Disconnect Spotify? The token is deleted from this computer and the widget stops.")) return;
        await U.invoke("spotify_disconnect");
        spClientId = "";
        return loadSpotify();
    }
  });
  // Back and forward: Alt+arrows, and the mouse's side buttons.
  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); go(null, e.key === "ArrowLeft" ? "back" : "fwd"); }
  });
  document.addEventListener("mouseup", (e) => { if (e.button === 3 || e.button === 4) { e.preventDefault(); go(null, e.button === 3 ? "back" : "fwd"); } });

  content.addEventListener("input", (e) => {
    if (e.target.id !== "market-q") return;
    marketQuery = e.target.value;
    const shown = marketShown();
    document.getElementById("market-results").innerHTML = marketResults(shown);
    document.getElementById("market-shown").textContent = shown.length + " of " + community.marketplace.length + " shown";
    lastHtml = communityPage().replace(/^<div class="page">/, '<div class="page"><p class="crumb"><button type="button" data-page="overview">Overview</button><span aria-hidden="true">›</span><span>Community</span></p>');
  });
  content.addEventListener("input", (e) => {
    if (e.target.id !== "community-q") return;
    communityQuery = e.target.value;
    const shown = communityShown();
    document.getElementById("community-results").innerHTML = communityResults(shown);
    document.getElementById("community-shown").textContent = shown.length + " of " + community.widgets.length + " shown";
    lastHtml = communityPage().replace(/^<div class="page">/, '<div class="page"><p class="crumb"><button type="button" data-page="overview">Overview</button><span aria-hidden="true">›</span><span>Community</span></p>');
  });
  // A community icon that does not load becomes the widget's initial.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("cicon")) return;
    const s = document.createElement("span");
    s.className = "cicon mono";
    s.textContent = img.dataset.letter || "?";
    img.replaceWith(s);
  }, true);

  // Typing a Client ID only toggles the button: the page is not re-rendered under the caret.
  content.addEventListener("input", (e) => {
    if (e.target.id !== "sp-client-id") return;
    spClientId = e.target.value.trim();
    const ok = validClientId(spClientId);
    e.target.setAttribute("aria-invalid", String(!!spClientId && !ok));
    const hint = document.getElementById("sp-hint");
    if (hint) hint.className = "hint" + (spClientId && !ok ? " bad" : "");
    const btn = content.querySelector('[data-act="sp-connect-new"]');
    if (btn) btn.disabled = !ok;
    // The DOM already shows what was typed: record it, so the next render does not rebuild the field under the caret.
    lastHtml = spotifyPage(sp);
  });
  window.__TAURI__.event.listen("spotify-state", (e) => { sp = e.payload; if (page === "spotify") render(); else chrome(U.view); });
  content.addEventListener("toggle", (e) => { if (e.target.matches("details.help")) helpOpen = e.target.open; }, true);

  document.querySelectorAll("[data-logo]").forEach((el) => { el.innerHTML = U.LOGO[el.dataset.logo]; });
  U.start(render);
  moveNav(true);
  loadInfo();
  loadSpotify();
  // Connected widget count and autostart can change outside this window.
  setInterval(loadInfo, 5000);
  setInterval(() => { if (communityJob && communityJob.phase === "sent") loadCommunity(); }, 5000);
  setInterval(() => { if (page === "overview") loadMedia(); }, 2000);
  setInterval(() => { if (page === "screentime") loadScreen(); }, 15000);
  loadMedia();
})();
