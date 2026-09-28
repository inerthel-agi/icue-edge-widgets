(function () {
  "use strict";
  // Applies the iCUE setting before the first paint; widget.js follows later changes.
  var th = typeof spotifyTheme !== "undefined" ? String(spotifyTheme) : "dark";
  document.documentElement.setAttribute("data-theme", th === "light" || th === "blur" ? th : "dark");
})();
