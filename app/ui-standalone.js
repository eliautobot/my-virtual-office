(function () {
  'use strict';

  var root = document.documentElement;

  function currentTheme() {
    return root.dataset.uiTheme === 'light' ? 'light' : 'dark';
  }

  function syncControls() {
    var theme = currentTheme();
    var next = theme === 'dark' ? 'light' : 'dark';
    document.querySelectorAll('[data-ui-theme-toggle]').forEach(function (button) {
      button.textContent = next === 'light' ? 'Light' : 'Dark';
      button.title = 'Switch to ' + next + ' theme';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    });
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#eef3f8' : '#070b13');
  }

  function applyTheme(theme, persist) {
    var normalized = theme === 'light' ? 'light' : 'dark';
    root.dataset.uiTheme = normalized;
    if (persist) {
      try { localStorage.setItem('vo-ui-theme', normalized); } catch (e) { /* Storage may be unavailable. */ }
    }
    syncControls();
  }

  function init() {
    var stored = 'dark';
    try { stored = localStorage.getItem('vo-ui-theme') === 'light' ? 'light' : 'dark'; } catch (e) { /* Use dark default. */ }
    applyTheme(stored, false);
    document.querySelectorAll('[data-ui-theme-toggle]').forEach(function (button) {
      button.addEventListener('click', function () {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
