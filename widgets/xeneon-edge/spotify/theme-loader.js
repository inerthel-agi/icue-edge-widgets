(function () {
  "use strict";

  try {
    var theme = localStorage.getItem("pa_theme") || "dark";
    if (theme !== "dark" && theme !== "light" && theme !== "blur") {
      theme = "dark";
    }
    document.documentElement.setAttribute("data-theme", theme);
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
