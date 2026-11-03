// Applies the saved theme before the first paint; shared by the window and the tray card (same origin).
(() => {
  const THEMES = ["oled", "dark", "light"];
  const apply = (t) => { document.documentElement.dataset.theme = THEMES.includes(t) ? t : "oled"; };
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch (_) { /* storage blocked: default theme */ }
  apply(new URLSearchParams(location.search).get("theme") || saved);
  window.addEventListener("storage", (e) => { if (e.key === "theme") apply(e.newValue); });
  window.setTheme = (t) => { apply(t); try { localStorage.setItem("theme", t); } catch (_) { /* not remembered */ } };
})();
