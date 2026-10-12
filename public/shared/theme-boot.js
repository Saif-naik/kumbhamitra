/*
  Applied before the page paints, so a dark-mode user never sees a white
  flash. Loaded as a plain (blocking) script in <head>; it must stay tiny and
  must not throw. The full switcher is in theme.js.

  km.theme = "light" | "dark" | "auto" (default: follow the phone).
*/
(function () {
  var theme = 'auto';
  try { theme = localStorage.getItem('km.theme') || 'auto'; } catch (e) { /* storage blocked */ }
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
}());
