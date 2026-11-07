// The same choice of light or dark colours as the application (same origin, same key), set before the page is painted.
(function () {
  var key = 'tmrkz-theme';
  var saved = null;
  try { saved = localStorage.getItem(key); } catch (e) { /* no storage: the sand */ }
  var theme = saved === 'dark' ? 'dark' : 'light'; // with no choice, the sand
  document.documentElement.setAttribute('data-theme', theme);
  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('tm-theme');
    if (!button) return;
    button.addEventListener('click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', theme);
      try { localStorage.setItem(key, theme); } catch (e) { /* this page only */ }
    });
  });
})();
