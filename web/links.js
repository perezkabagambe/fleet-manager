// Links to other websites (a parts catalogue, an AI source...): the person chooses, in Me, whether they open in the app
// (over it, with a way back) or in their phone's own browser. The choice is kept on this phone.
(function () {
  'use strict';

  var KEY = 'fm-link-mode'; // 'app' or 'browser'
  var android = /Android/i.test(navigator.userAgent || '');

  function mode() {
    try { return localStorage.getItem(KEY) === 'browser' ? 'browser' : 'app'; } catch (e) { return 'app'; }
  }
  function setMode(m) {
    try { localStorage.setItem(KEY, m === 'browser' ? 'browser' : 'app'); } catch (e) { /* the choice just is not kept */ }
  }

  /** An Android link that hands a web address to the phone's own browser (if that fails, it opens where it is). */
  function intentFor(href) {
    var u = new URL(href);
    return 'intent://' + u.host + u.pathname + u.search +
      '#Intent;scheme=' + u.protocol.replace(':', '') + ';action=android.intent.action.VIEW;S.browser_fallback_url=' + encodeURIComponent(u.href.split('#')[0]) + ';end';
  }

  // Only ordinary links to other websites; a file to download (the Android app) and links within the app are left alone.
  function isExternal(a) {
    var href = a.getAttribute('href') || '';
    if (!/^https?:/i.test(href)) return false;
    try {
      var u = new URL(a.href);
      return u.origin !== location.origin && !a.hasAttribute('download') && !/\.apk$/i.test(u.pathname);
    } catch (e) { return false; }
  }

  document.addEventListener('click', function (ev) {
    if (ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || !isExternal(a)) return;
    if (mode() === 'browser' && android) { // the phone's own browser
      ev.preventDefault();
      window.location.href = intentFor(a.href);
      return;
    }
    // in the app: the link opens over it (a separate window with a way back) and never replaces the app's own page
    if (!a.target) a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }, true);

  window.ExternalLinks = { mode: mode, setMode: setMode, intentFor: intentFor, isExternal: isExternal };
})();
