// XENEON EDGE widget for one provider (body[data-provider]), design v2.
(function () {
  "use strict";
  const U = window.Usage, esc = U.esc;
  const pid = document.body.dataset.provider;
  const root = document.getElementById("w");
  let sheetOpen = false;
  let lastHtml = "";

  const pill = (p) => '<span class="pill ' + (p.state === "idle" ? "" : p.state) + '">' + esc(p.stateText) + "</span>";
  const bar = (l, off) => U.limitBar(l, off ? "off" : "");
  // 24 h chart and pace estimate for the headline limit (Claude only).
  const TREND = { claude: true };
  const alertBox = (text, cls) => '<div class="alert ' + (cls || "") + '">' + esc(text) + "</div>";

  // iCUE "Widget Personalization" settings (globals set by iCUE); invalid or missing values keep the defaults.
  function theme() {
    const css = document.documentElement.style;
    const color = (name, v) => { if (typeof v === "string" && CSS.supports("color", v)) css.setProperty(name, v); };
    color("--bg", typeof backgroundColor !== "undefined" ? backgroundColor : null);
    color("--text", typeof textColor !== "undefined" ? textColor : null);
    color("--accent", typeof accentColor !== "undefined" ? accentColor : null);
    // A bar in an accent too close to the background (e.g. the light default on a light theme) uses the text colour.
    const cs = getComputedStyle(document.documentElement);
    const low = U.contrast(cs.getPropertyValue("--accent"), cs.getPropertyValue("--bg")) < 1.8;
    if (low) css.setProperty("--bar", "var(--text)"); else css.removeProperty("--bar");
    const t = Number(typeof transparency !== "undefined" ? transparency : NaN);
    if (Number.isFinite(t)) css.setProperty("--bg-opacity", String(Math.max(0, Math.min(1, t / 100))));
  }

  function layout() {
    const w = innerWidth, h = innerHeight, r = w / h;
    document.body.classList.toggle("wide", r > 1.35 && r <= 2.8);
    document.body.classList.toggle("xwide", r > 2.8);
    document.body.classList.toggle("short", h <= 460);
    document.body.classList.toggle("tiny", h <= 360 && r <= 1.35);
    // Headline size follows the space actually available.
    const big = Math.max(48, Math.min(r > 1.35 ? h * 0.3 : w * 0.24, 180));
    document.body.style.setProperty("--big", Math.round(big) + "px");
  }

  function message(text) {
    const mark = '<span class="mark ' + pid + '">' + U.LOGO[pid] + "</span>";
    return '<div class="message">' + mark + "<p>" + esc(text) + "</p></div>";
  }

  function main(p) {
    const t = U.tightest(p);
    let hero;
    if (!p.detected) hero = alertBox(p.reason || p.name + " not detected", "warn");
    else if (!t) hero = alertBox(p.limitsError || p.reason || "No limits reported.", p.state === "danger" ? "" : "warn");
    else {
      const eta = TREND[p.id] ? U.forecast(t) : null;
      hero = '<div class="figure"><b class="num">' + t.pct + '%</b><span>of ' + esc(t.name.toLowerCase()) + " " + t.word + "</span></div>" +
        bar(t, t.stale) + '<div class="reset">Resets ' + esc(U.resetText(t.resetAt)) + "</div>" +
        (eta ? '<div class="eta' + (eta.warn ? " warn" : "") + '">' + esc(eta.text) + "</div>" : "");
    }
    const others = t ? p.limits.filter((l) => l !== t) : [];
    const tr = TREND[p.id] && t ? U.trend(t) : null;
    const chart = tr ? '<div class="trend"><div class="trend-head"><span>' + esc(tr.span) + '</span><span>Peak ' + tr.peak + "%</span></div>" + tr.svg + "</div>" : "";
    const more = chart + (others.length
      ? others.map((l) => '<div class="lim"><span>' + esc(l.name) + '</span><b class="num">' + l.pct + "%</b>" + bar(l, l.stale) + "</div>").join("")
      : p.state === "danger" && t && p.reason ? alertBox(p.reason) : "");
    const ctx = p.context ? U.big(p.context.used) + (p.context.capacity ? " / " + U.big(p.context.capacity) : "") : "—";
    return '<section class="panel">' +
      '<div class="head"><span class="mark ' + esc(p.id) + '">' + p.letter + "</span><h1>" + esc(p.name) + "</h1>" + pill(p) +
      '<button type="button" class="details-btn" data-act="details">Details</button></div>' +
      '<div class="hero">' + hero + "</div>" +
      '<div class="more">' + more + "</div>" +
      '<div class="facts"><div class="fact"><span>Tokens today</span><b class="num">' + U.big(p.tokens.total) + "</b><small>" + esc(p.clients) + "</small></div>" +
      '<div class="fact"><span>Conversation</span><b class="num">' + ctx + "</b><small>Limits read " + U.ago(p.limitsAt) + "</small></div></div>" +
      "</section>";
  }

  function sheet(p) {
    const t = p.tokens;
    const inc = t.cacheIncluded ? " · included in input" : "";
    const rows = (list) => list.map(([a, b, v]) => '<div class="row"><div class="t"><span>' + esc(a) + "</span>" + (b ? "<small>" + esc(b) + "</small>" : "") + "</div><b class=\"num\">" + v + "</b></div>").join("");
    return '<div class="sheet" role="dialog" aria-label="' + esc(p.name) + ' · details">' +
      '<div class="sheet-head"><span class="mark ' + esc(p.id) + '">' + p.letter + "</span><h2>" + esc(p.name) + "</h2>" + pill(p) +
      '<button type="button" class="details-btn" data-act="close">Close</button></div>' +
      (p.reason && p.state !== "live" ? alertBox(p.reason, p.state === "danger" ? "" : "warn") : "") +
      '<div class="group-title">Plan limits</div><div class="group">' +
      (p.limits.length ? rows(p.limits.map((l) => [l.name, "Resets " + U.resetText(l.resetAt), l.pct + "% " + l.word])) : '<div class="row"><div class="t"><span>' + esc(p.limitsError || "No limits reported") + "</span></div></div>") + "</div>" +
      '<div class="group-title">Tokens today · total ' + U.big(t.total) + '</div><div class="group">' +
      (t.total == null ? '<div class="row"><div class="t"><span>Unavailable</span></div></div>' : rows([
        ["Input", "Text sent to the model", U.big(t.input)],
        ["Output", "Generated text", U.big(t.output)],
        ["Cache read", "Already sent, re-read at lower cost" + inc, U.big(t.cacheRead)],
        ["Cache write", "Cached for later messages" + inc, U.big(t.cacheWrite)],
      ])) + "</div>" +
      '<div class="group-title">Sessions</div><div class="group">' +
      (p.sessions.length ? rows(p.sessions.slice(0, 4).map((s) => [s.client + " · " + s.model, (s.active ? "active · " : "") + U.ago(s.last), U.big(s.tokens)])) : '<div class="row"><div class="t"><span>No session in the last 24 h</span></div></div>') +
      "</div></div>";
  }

  function render() {
    theme();
    layout();
    const v = U.view;
    let html;
    if (!v) html = message(U.link.state === "connecting" ? "Connecting to iCUE Edge Companion…" : U.link.message);
    else if (U.link.state !== "live" && U.link.state !== "connecting") html = message(U.link.message) ;
    else html = main(v[pid]) + (sheetOpen ? sheet(v[pid]) : "");
    if (html === lastHtml) return;
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.act : null;
    root.innerHTML = html;
    lastHtml = html;
    U.applyWidths(root);
    // Secondary limits that do not fit are dropped from the end (they stay in Details), then the chart if still needed.
    const more = root.querySelector(".more");
    if (more) {
      const items = [...more.querySelectorAll(".trend, .lim")];
      while (more.scrollHeight > more.clientHeight + 1 && items.length) items.pop().remove();
    }
    if (focused) { const el = root.querySelector('[data-act="' + (focused === "details" && sheetOpen ? "close" : focused === "close" && !sheetOpen ? "details" : focused) + '"]'); if (el) el.focus(); }
  }

  root.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    sheetOpen = b.dataset.act === "details";
    lastHtml = "";
    render();
    const target = root.querySelector('[data-act="' + (sheetOpen ? "close" : "details") + '"]');
    if (target) target.focus();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheetOpen) { sheetOpen = false; lastHtml = ""; render(); } });
  addEventListener("resize", () => { lastHtml = ""; render(); });
  U.start(render);
})();
