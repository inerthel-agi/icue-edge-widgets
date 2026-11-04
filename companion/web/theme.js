// Applies the saved theme and the AI switch before the first paint; shared by the window and the tray card (same origin).
(() => {
  const THEMES = ["oled", "dark", "light"];
  const apply = (t) => { document.documentElement.dataset.theme = THEMES.includes(t) ? t : "oled"; };
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch (_) { /* storage blocked: default theme */ }
  apply(new URLSearchParams(location.search).get("theme") || saved);
  window.setTheme = (t) => { apply(t); try { localStorage.setItem("theme", t); } catch (_) { /* not remembered */ } };
  // AI usage (Claude, Codex, AI cost) is off by default: it is for people who use AI coding tools a lot.
  let ai = false;
  try { ai = localStorage.getItem("ai.show") === "1"; } catch (_) { /* storage blocked: off */ }
  const applyAi = () => document.documentElement.classList.toggle("no-ai", !ai);
  applyAi();
  window.showAi = () => ai;
  window.setShowAi = (on) => { ai = !!on; applyAi(); try { localStorage.setItem("ai.show", ai ? "1" : "0"); } catch (_) { /* not remembered */ } };
  window.addEventListener("storage", (e) => {
    if (e.key === "theme") apply(e.newValue);
    if (e.key === "ai.show") { ai = e.newValue === "1"; applyAi(); window.dispatchEvent(new Event("ai-change")); }
  });
})();
