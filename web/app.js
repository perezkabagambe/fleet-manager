// Fleet Manager - Phase 1 shell: router, diagnostics, update banner, revision footer.
(function () {
  'use strict';

  var cfg = window.FLEET_CONFIG;
  var appEl = document.getElementById('app');

  // ---------- helpers ----------
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'text') node.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { node.append(c); });
    return node;
  }

  function shortRev(rev) {
    return !rev || rev.indexOf('__') === 0 ? 'dev' : rev.slice(0, 7);
  }

  // ---------- footer / version check ----------
  var backendInfo = null;

  function renderFooter() {
    document.getElementById('rev-front').textContent = 'rev ' + shortRev(cfg.commit);
    var back = document.getElementById('rev-back');
    var warn = document.getElementById('rev-warn');
    if (backendInfo) {
      back.textContent = '· backend ' + backendInfo.backendRev;
      var mismatch = backendInfo.apiVersion !== cfg.apiVersion;
      warn.hidden = !mismatch;
      warn.textContent = mismatch ? 'Version mismatch: please reload or update.' : '';
    }
  }

  function checkBackend() {
    if (!cfg.apiUrl) return Promise.resolve();
    return window.FleetApi.call('ping').then(function (r) {
      backendInfo = r.data;
      renderFooter();
    }).catch(function () { /* footer simply shows no backend info */ });
  }

  // ---------- views ----------
  function viewHome() {
    appEl.replaceChildren(
      el('section', { class: 'card' }, [
        el('h1', { text: 'Fleet Manager' }),
        el('p', { text: 'The app shell is up. Login, cars, entries and reminders are coming in the next phases.' }),
        el('p', { class: 'muted', text: 'Use Diagnostics to check the connection to the backend.' }),
        el('a', { class: 'btn', href: '#/diag', text: 'Open diagnostics' }),
      ])
    );
  }

  function viewDiag() {
    var out = el('div', { class: 'diag-out' });
    var runBtn = el('button', { type: 'button', class: 'btn', text: 'Run connection test' });
    var list = el('ul', { class: 'diag-list' });

    function row(label, value, cls) {
      list.append(el('li', { class: cls || '' }, [el('span', { class: 'k', text: label }), el('span', { class: 'v', text: value })]));
    }

    function renderStatic() {
      list.replaceChildren();
      row('Frontend revision', shortRev(cfg.commit));
      row('Built', cfg.builtAt.indexOf('__') === 0 ? 'local dev build' : cfg.builtAt);
      row('Backend URL set', cfg.apiUrl ? 'yes' : 'no', cfg.apiUrl ? 'ok' : 'bad');
      row('Installed as app', window.matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'yes' : 'no (running in a browser tab)');
      row('Service worker', 'serviceWorker' in navigator ? 'supported' : 'not supported');
    }

    function run() {
      renderStatic();
      out.replaceChildren();
      runBtn.disabled = true;
      runBtn.textContent = 'Testing…';
      var times = [];
      var chain = Promise.resolve();
      var info = null;
      var failure = null;

      for (var i = 0; i < 5; i++) {
        chain = chain.then(function () {
          if (failure) return;
          return window.FleetApi.call('ping').then(function (r) {
            times.push(r.ms);
            info = r.data;
          }).catch(function (e) { failure = e; });
        });
      }

      chain.then(function () {
        if (failure) {
          row('Result', failure.message, 'bad');
        } else {
          backendInfo = info;
          renderFooter();
          var sum = times.reduce(function (a, b) { return a + b; }, 0);
          row('Backend revision', info.backendRev);
          row('API version', info.apiVersion + (info.apiVersion === cfg.apiVersion ? ' (matches)' : ' (MISMATCH - expected ' + cfg.apiVersion + ')'),
            info.apiVersion === cfg.apiVersion ? 'ok' : 'bad');
          row('First call (cold)', times[0] + ' ms');
          row('Next calls', times.slice(1).join(', ') + ' ms');
          row('Average', Math.round(sum / times.length) + ' ms');
          row('Server time', info.serverTime);
          row('Result', 'Connected', 'ok');
        }
        runBtn.disabled = false;
        runBtn.textContent = 'Run connection test again';
      });
    }

    renderStatic();
    runBtn.addEventListener('click', run);
    appEl.replaceChildren(el('section', { class: 'card' }, [el('h1', { text: 'Diagnostics' }), list, runBtn, out]));
  }

  function viewNotFound() {
    appEl.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: 'Page not found' }),
      el('a', { class: 'btn', href: '#/', text: 'Go home' }),
    ]));
  }

  var routes = { '': viewHome, '/': viewHome, '/diag': viewDiag };

  function route() {
    var path = location.hash.replace(/^#/, '');
    (routes[path] || viewNotFound)();
    appEl.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  // ---------- service worker + update banner ----------
  function setupServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var banner = document.getElementById('update-banner');
    var refreshing = false;

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (refreshing) return;
      refreshing = true;
      location.reload();
    });

    navigator.serviceWorker.register('sw.js').then(function (reg) {
      function showBanner(worker) {
        banner.hidden = false;
        document.getElementById('update-btn').onclick = function () { worker.postMessage('SKIP_WAITING'); };
      }
      if (reg.waiting && navigator.serviceWorker.controller) showBanner(reg.waiting);
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) showBanner(nw);
        });
      });
      // Look for a new version whenever the app is brought back to the foreground.
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') reg.update().catch(function () {});
      });
    }).catch(function () { /* app works without the service worker */ });
  }

  // ---------- start ----------
  window.addEventListener('hashchange', route);
  renderFooter();
  route();
  checkBackend();
  setupServiceWorker();
})();
