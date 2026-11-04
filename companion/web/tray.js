// Tray card (design v2): two provider summaries and the main actions.
// The window is destroyed by the companion as soon as it loses focus.
(function () {
  "use strict";
  const U = window.Usage, esc = U.esc;
  const card = document.getElementById("card");
  const I = {
    open: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
    quit: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 2v10"/>',
  };
  const icon = (k) => '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + I[k] + "</svg>";
  // The e-strip mark (companion/icons/mark.svg), in the theme's text colour.
  const MARK = '<svg class="mark-logo" aria-hidden="true" viewBox="0 0 256 256" fill="currentColor"><g transform="translate(-6.0 0)"><path d="M150.9 178.9A72 72 0 1 1 170.8 141.0L145.2 136.3A46 46 0 1 0 132.5 160.5Z"/><rect x="48" y="115.0" width="192" height="26" rx="13.0"/></g></svg>';
  let lastHtml = "";

  function prov(p, paused) {
    const t = U.tightest(p);
    let body;
    if (!t) body = '<p class="err">' + esc(p.limitsError || p.reason || "No limits reported.") + "</p>";
    else body = '<div class="fig"><b>' + t.pct + '%</b><span>' + esc(t.name.toLowerCase()) + " " + t.word + "</span></div>" +
      U.limitBar(t, paused || t.stale ? "off" : "") +
      '<div class="meta"><span>Resets ' + esc(U.resetText(t.resetAt).split(" · ")[0]) + "</span><span>" + U.big(p.tokens.total) + " tokens today</span></div>" +
      (t.stale && p.reason ? '<p class="err note">Reading from ' + esc(U.ago(t.at)) + ": " + esc(p.reason) + "</p>" : "");
    return '<div class="prov"><div class="prov-top"><span class="mark sm ' + p.id + '">' + p.letter + "</span><strong>" + esc(p.name) +
      '</strong><span class="pill ' + (p.state === "idle" ? "" : p.state) + '">' + esc(p.stateText) + "</span></div>" + body + "</div>";
  }

  function render() {
    const v = U.view;
    let html;
    if (!v) html = '<header class="header">' + MARK + '<div><strong>iCUE Edge Companion</strong><small>' + esc(U.link.message || "Loading…") + "</small></div></header>";
    else {
      // AI usage is off by default (Settings > AI usage): then the card is the menu alone.
      const ai = window.showAi();
      const problem = ai ? [v.claude, v.codex].find((p) => p.state === "danger" || p.state === "warn") : null;
      const sub = v.paused ? "Collection paused" : problem ? problem.name + ": check needed · open the dashboard" : ai ? "Up to date" : "Running";
      html = '<header class="header">' + MARK + '<div><strong>iCUE Edge Companion</strong><small>' + esc(sub) + "</small></div></header>" +
        (ai ? '<div class="usage">' + prov(v.claude, v.paused) + prov(v.codex, v.paused) + "</div>" : "") +
        '<div class="separator"></div>' +
        '<button type="button" class="item" data-act="open">' + icon("open") + '<span class="label">Open dashboard</span></button>' +
        (ai ? '<button type="button" class="item" data-act="refresh">' + icon("refresh") + '<span class="label">Refresh limits</span></button>' : "") +
        '<button type="button" class="item" data-act="pause" role="switch" aria-checked="' + v.paused + '">' + icon("pause") + '<span class="label">Pause collection</span><span class="switch" aria-hidden="true" aria-checked="' + v.paused + '"></span></button>' +
        '<div class="separator"></div>' +
        '<button type="button" class="item danger" data-act="quit">' + icon("quit") + '<span class="label">Quit</span></button>';
    }
    if (html === lastHtml) return;
    card.innerHTML = html;
    lastHtml = html;
    U.applyWidths(card);
  }

  const close = () => window.__TAURI__.window.getCurrentWindow().close();

  card.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    switch (b.dataset.act) {
      case "open": return U.invoke("open_main");
      case "refresh": {
        const ok = await U.refresh();
        b.querySelector(".label").textContent = ok ? "Refresh requested" : "Try again in 30 s";
        return setTimeout(close, 900);
      }
      case "pause": return U.invoke("set_paused", { paused: !U.view.paused });
      case "quit": return U.invoke("quit_app");
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("ai-change", () => { lastHtml = ""; render(); });

  U.start(render);
})();
