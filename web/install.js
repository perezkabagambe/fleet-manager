// Getting Fleet Manager as an app: a slim bar at the top of the website and a dialog with the choices (install the web app,
// download the Android app, or open the page in the Android app if it is already installed). It never shows inside the
// installed app itself, and on an iPhone it only explains Add to Home Screen (the Android file cannot be installed there).
(function () {
  'use strict';

  var el = UI.el;
  var cfg = window.FLEET_CONFIG || {};
  var ua = navigator.userAgent || '';
  var android = /Android/i.test(ua);
  var ios = !android && (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)); // an iPad can say it is a Mac
  var GUEST_PATH = /^#\/guest\//;
  var SEEN_KEY = 'fm-app-seen';          // set whenever the page is running inside an installed app
  var DISMISS_KEY = 'fm-install-dismissed'; // the bar was closed (for two weeks)
  var deferred = null;                    // the browser's own install prompt, when it offers one
  var relatedInstalled = false;           // the browser says the Android app is installed
  var bar = null;
  var openNote = '';

  function standalone() {
    var mq = function (q) { return !!(window.matchMedia && window.matchMedia(q).matches); };
    return mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || mq('(display-mode: minimal-ui)') || window.navigator.standalone === true;
  }
  function get(store, key) { try { return window[store].getItem(key); } catch (e) { return null; } }
  function set(store, key, value) { try { window[store].setItem(key, value); } catch (e) { /* ignore */ } }

  // Running inside the installed app: remember it, so a browser tab on the same phone can offer "Open in app" (the browser and
  // the app often share this storage; where they do not, the dialog still has the button)
  if (standalone()) set('localStorage', SEEN_KEY, '1');

  function appInstalled() { return android && !standalone() && (relatedInstalled || get('localStorage', SEEN_KEY) === '1'); }

  /** Open this page in the installed Android app. If the app is not installed, the browser stays on this page. */
  function openInApp() {
    var route = location.hash || '#/';
    var fallback = location.href;
    var intent = 'intent://' + location.host + location.pathname + '?go=' + encodeURIComponent(route) +
      '#Intent;scheme=https;package=' + cfg.androidPackage + ';S.browser_fallback_url=' + encodeURIComponent(fallback) + ';end';
    var left = false;
    function onHide() { if (document.visibilityState === 'hidden') left = true; }
    document.addEventListener('visibilitychange', onHide);
    window.location.href = intent;
    setTimeout(function () {
      document.removeEventListener('visibilitychange', onHide);
      if (!left) { openNote = 'The app did not open. It may not be installed on this phone yet.'; draw(); }
    }, 2200);
  }

  function promptInstall() {
    if (!deferred) return Promise.resolve();
    var p = deferred;
    deferred = null;
    p.prompt();
    return p.userChoice.then(function () { draw(); }, function () { draw(); });
  }

  // ---------- the dialog ----------
  function openDialog() {
    var overlay = el('div', { class: 'dialog-overlay' });
    var close = el('button', { type: 'button', class: 'btn small secondary', text: 'Close' });
    function shut() { overlay.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(ev) { if (ev.key === 'Escape') shut(); }
    close.addEventListener('click', shut);
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) shut(); });
    document.addEventListener('keydown', onKey, true);

    var blocks = [el('h2', { text: 'Get Fleet Manager as an app' })];
    if (appInstalled() && android) {
      var open = el('button', { type: 'button', class: 'btn', text: 'Open in the app' });
      open.addEventListener('click', function () { shut(); openInApp(); });
      blocks.push(el('div', { class: 'install-option' }, [el('strong', { text: 'It is installed on this phone' }), el('p', { class: 'small-text muted', text: 'Open this page in the Fleet Manager app.' }), open]));
    }
    // 1. the web app
    var webKids = [el('strong', { text: ios ? 'Add it to your Home Screen' : 'Install the web app' })];
    if (deferred) {
      var go = el('button', { type: 'button', class: 'btn', text: 'Install' });
      go.addEventListener('click', function () { shut(); promptInstall(); });
      webKids.push(el('p', { class: 'small-text muted', text: 'Adds Fleet Manager to your home screen. It opens like an app.' }), go);
    } else if (ios) {
      webKids.push(el('p', { class: 'small-text', text: 'In Safari, tap the Share button, then Add to Home Screen.' }));
    } else {
      webKids.push(el('p', { class: 'small-text', text: 'Open your browser menu (⋮) and choose Install app, or Add to Home screen.' }));
    }
    blocks.push(el('div', { class: 'install-option' }, webKids));
    // 2. the Android app (not for iPhones)
    if (android && cfg.androidApkUrl) {
      blocks.push(el('div', { class: 'install-option' }, [
        el('strong', { text: 'Download the Android app' }),
        el('p', { class: 'small-text muted', text: 'An APK file. If your phone asks, allow installing from your browser.' }),
        el('a', { class: 'btn', href: cfg.androidApkUrl, rel: 'noopener', text: 'Download the APK' }),
      ]));
    }
    blocks.push(el('div', { class: 'dialog-actions' }, [close]));
    overlay.append(el('div', { class: 'dialog install-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Get Fleet Manager as an app' }, blocks));
    document.body.append(overlay);
  }

  // ---------- the bar ----------
  function dismissed() {
    if (appInstalled()) return get('sessionStorage', DISMISS_KEY) === '1';
    var until = Number(get('localStorage', DISMISS_KEY) || 0);
    return until > Date.now();
  }

  function draw() {
    if (!bar) return;
    var onGuest = GUEST_PATH.test(location.hash || '');
    var offerWeb = android || ios || !!deferred; // a desktop browser with no install prompt has nothing to offer
    if (standalone() || onGuest || !offerWeb || dismissed()) { bar.hidden = true; bar.replaceChildren(); return; }
    var text, label, action;
    if (appInstalled()) { text = 'Fleet Manager is installed on this phone.'; label = 'Open in app'; action = openInApp; }
    else if (ios) { text = 'Add Fleet Manager to your Home Screen.'; label = 'How'; action = openDialog; }
    else { text = 'Get the Fleet Manager app.'; label = 'Install app'; action = openDialog; }
    var btn = el('button', { type: 'button', class: 'btn small', text: label });
    btn.addEventListener('click', action);
    var x = el('button', { type: 'button', class: 'installbar-x', 'aria-label': 'Hide this', text: '✕' });
    x.addEventListener('click', function () {
      if (appInstalled()) set('sessionStorage', DISMISS_KEY, '1'); else set('localStorage', DISMISS_KEY, String(Date.now() + 14 * 24 * 3600 * 1000));
      draw();
    });
    var more = appInstalled() ? el('button', { type: 'button', class: 'linklike small-text', text: 'More options' }) : null;
    if (more) more.addEventListener('click', openDialog);
    bar.hidden = false;
    bar.replaceChildren(el('div', { class: 'installbar-text' }, [el('span', { text: text }), openNote ? el('span', { class: 'small-text muted', text: ' ' + openNote }) : null, more ? el('span', {}, [document.createTextNode(' '), more]) : null]), btn, x);
  }

  window.addEventListener('beforeinstallprompt', function (ev) { ev.preventDefault(); deferred = ev; draw(); });
  window.addEventListener('appinstalled', function () { deferred = null; set('localStorage', SEEN_KEY, '1'); draw(); });
  window.addEventListener('hashchange', draw);

  function start() {
    bar = document.getElementById('installbar');
    draw();
    // an Android browser can tell whether the app is installed (it needs the manifest's related_applications)
    if (android && !standalone() && navigator.getInstalledRelatedApps) {
      navigator.getInstalledRelatedApps().then(function (list) { if (list && list.length) { relatedInstalled = true; draw(); } }).catch(function () { /* not available */ });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.InstallUI = { draw: draw, openDialog: openDialog, standalone: standalone, android: android, ios: ios };
})();
