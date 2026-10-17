// Applies the remembered colour theme before first paint (a classic script, so it runs before the
// stylesheet-driven render; the CSP allows only same-origin scripts, not inline ones).
(function () {
  var theme = null;
  try { theme = localStorage.getItem('elpida:theme'); } catch (e) {}
  if (theme !== 'light' && theme !== 'dark') theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  try { if (localStorage.getItem('elpida:dock') === 'pinned') document.documentElement.setAttribute('data-dock-pinned', ''); } catch (e) {}
})();
