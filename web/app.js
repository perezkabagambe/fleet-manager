// Fleet Manager shell: router, navigation, sign-in guard, home, diagnostics,
// update banner and revision footer.
(function () {
  'use strict';

  var cfg = window.FLEET_CONFIG;
  var el = UI.el;
  var appEl = document.getElementById('app');
  var Views = (window.Views = window.Views || {});

  // Pages anyone can open without signing in.
  var PUBLIC = { '/login': 1, '/login/verify': 1, '/request': 1, '/diag': 1 };

  // ---------- routing ----------
  function parseHash() {
    var h = location.hash.replace(/^#/, '') || '/';
    var i = h.indexOf('?');
    var path = i < 0 ? h : h.slice(0, i);
    var query = {};
    if (i >= 0) new URLSearchParams(h.slice(i + 1)).forEach(function (v, k) { query[k] = v; });
    return { path: path || '/', query: query, raw: h };
  }

  function go(path, query) {
    var qs = query ? '?' + new URLSearchParams(query).toString() : '';
    var target = '#' + path + qs;
    if (location.hash === target) route(); else location.hash = target;
  }

  function showLoading() {
    appEl.replaceChildren(el('p', { class: 'muted center pad', text: 'Loading…' }));
  }

  function route() {
    var r = parseHash();
    if (!PUBLIC[r.path]) {
      if (!FleetAuth.hasSession()) { go('/login', { next: r.raw }); return; }
      if (!FleetAuth.getUser()) {
        showLoading();
        FleetApi.call('me').then(function (res) {
          FleetAuth.setUser(res.data.user);
          refreshNav();
          route();
        }).catch(function (e) {
          if (e.code === 'unauthorized') return; // handled by the 'fleet:unauthorized' listener
          appEl.replaceChildren(UI.notice('error', UI.errorText(e)), el('p', { class: 'center' }, [
            el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: route }),
          ]));
        });
        return;
      }
    }
    var view;
    if (r.path === '/' ) view = viewHome;
    else if (r.path === '/diag') view = viewDiag;
    else if (r.path === '/login') view = Views.login;
    else if (r.path === '/login/verify') view = Views.verify;
    else if (r.path === '/request') view = Views.request;
    else if (r.path === '/admin/users') view = FleetAuth.isAdmin() ? Views.adminUsers : viewForbidden;
    else view = viewNotFound;
    view(r, appEl);
    appEl.focus({ preventScroll: true });
    if (!r.query.focus) window.scrollTo(0, 0);
  }

  // ---------- navigation ----------
  function refreshNav() {
    var nav = document.getElementById('topnav');
    var user = FleetAuth.getUser();
    var links = [];
    if (FleetAuth.hasSession()) links.push(el('a', { href: '#/', text: 'Home' }));
    if (FleetAuth.isAdmin()) links.push(el('a', { href: '#/admin/users', text: 'Users' }));
    links.push(el('a', { href: '#/diag', text: 'Diagnostics' }));
    if (FleetAuth.hasSession()) {
      links.push(el('button', { type: 'button', class: 'navbtn', text: 'Sign out', onclick: signOut }));
    } else {
      links.push(el('a', { href: '#/login', text: 'Sign in' }));
    }
    nav.replaceChildren.apply(nav, links);
    nav.setAttribute('aria-label', user ? 'Main menu for ' + user.name : 'Main menu');
  }

  function signOut() {
    var done = function () {
      FleetAuth.clear();
      refreshNav();
      go('/login');
    };
    FleetApi.call('logout').then(done, done);
  }

  window.addEventListener('fleet:unauthorized', function () {
    refreshNav();
    var r = parseHash();
    if (!PUBLIC[r.path]) go('/login', { next: r.raw });
  });

  // ---------- footer / version check ----------
  var backendInfo = null;

  function shortRev(rev) {
    return !rev || rev.indexOf('__') === 0 ? 'dev' : rev.slice(0, 7);
  }

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
    return FleetApi.call('ping').then(function (r) {
      backendInfo = r.data;
      renderFooter();
    }).catch(function () { /* footer simply shows no backend info */ });
  }

  // ---------- views ----------
  function viewHome(r, root) {
    var user = FleetAuth.getUser();
    root.replaceChildren(
      el('section', { class: 'card' }, [
        el('h1', { text: 'Welcome, ' + user.name }),
        el('p', { text: 'You are signed in' + (user.role === 'admin' ? ' as an administrator.' : '.') }),
        el('p', { class: 'muted', text: 'Cars, issues, repairs, maintenance and reminders are coming in the next phases.' }),
        FleetAuth.isAdmin() ? el('a', { class: 'btn', href: '#/admin/users', text: 'Manage users' }) : null,
      ])
    );
  }

  function viewForbidden(r, root) {
    root.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: 'Not allowed' }),
      el('p', { text: 'Only administrators can open this page.' }),
      el('a', { class: 'btn', href: '#/', text: 'Go home' }),
    ]));
  }

  function viewNotFound(r, root) {
    root.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: 'Page not found' }),
      el('a', { class: 'btn', href: '#/', text: 'Go home' }),
    ]));
  }

  function viewDiag(r, root) {
    var out = el('div');
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
      row('Signed in', FleetAuth.getUser() ? FleetAuth.getUser().email : 'no');
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
          return FleetApi.call('ping').then(function (res) {
            times.push(res.ms);
            info = res.data;
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
    root.replaceChildren(el('section', { class: 'card' }, [el('h1', { text: 'Diagnostics' }), list, runBtn, out]));
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
  window.FleetApp = { go: go, refreshNav: refreshNav };
  window.addEventListener('hashchange', route);
  renderFooter();
  refreshNav();
  route();
  checkBackend();
  setupServiceWorker();
})();
