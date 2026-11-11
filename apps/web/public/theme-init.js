/* Apply the stored or system theme before first paint. Mirrors src/appearance.ts.
   Served as a same-origin classic script because the SPA CSP forbids inline scripts. */
(function () {
  var root = document.documentElement, mode = "system";
  try {
    var stored = JSON.parse(localStorage.getItem("benchledger.appearance.v1") || "null");
    if (stored && (stored.colourMode === "light" || stored.colourMode === "dark")) mode = stored.colourMode;
    if (stored && stored.density === "compact") root.dataset.density = "compact";
    if (stored && stored.collapsed === true) root.dataset.nav = "rail";
  } catch (error) { /* Storage may be blocked; use the system theme. */ }
  var dark = mode === "dark" || (mode === "system" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  var chrome = dark ? "#191f28" : "#ffffff";
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i += 1) metas[i].setAttribute("content", chrome);
})();
