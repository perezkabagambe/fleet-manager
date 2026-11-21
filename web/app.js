// Fleet Manager shell: router, navigation, sign-in guard, home, diagnostics,
// update banner and revision footer.
(function () {
  'use strict';

  var cfg = window.FLEET_CONFIG;
  var el = UI.el;
  var appEl = document.getElementById('app');
  var Views = (window.Views = window.Views || {});

  // Pages anyone can open without signing in.
  var PUBLIC = { '/login': 1, '/login/verify': 1, '/request': 1, '/diag': 1, '/feedback': 1 };
  var lastPage = ''; // the screen before the feedback form, so the report can say where it was sent from

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

  // Pages that need no sign-in: the public ones, the guest pages, and a car's QR link for someone not signed in.
  var GUEST_PATH = /^\/guest\/([0-9a-f-]{8,40})(?:\/add\/(maintenance|purchase))?$/;
  var SCAN_PATH = /^\/car\/([0-9a-f-]{8,40})$/;
  function isOpen(r) {
    return !!(PUBLIC[r.path] || GUEST_PATH.test(r.path) || (r.query.g && SCAN_PATH.test(r.path) && !FleetAuth.hasSession()));
  }

  var inboxAsked = false; // the Inbox count is fetched once per page load (and whenever the Inbox changes)
  var started = false; // nothing is drawn until the phone's saved copy has been read (a moment at most)

  function route(opts) {
    if (!started) return;
    var r = parseHash();
    r.keepOpen = !!(opts && opts.keepOpen === true); // redrawing the same screen because its data changed: keep what was open
    if (r.keepOpen) { if (shownFlash && !flash) flash = shownFlash; } else shownFlash = null; // a message is still there after such a redraw
    if (!isOpen(r)) {
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
    if (FleetAuth.hasSession() && FleetAuth.getUser() && window.InboxUI && !inboxAsked) { inboxAsked = true; InboxUI.refreshCount(); }
    if (FleetAuth.hasSession() && FleetAuth.getUser() && window.FleetSync) FleetSync.start(); // saves the fleet's data on this phone (once), then keeps it fresh
    var view;
    var m;
    r.params = {};
    if (r.path !== '/feedback') lastPage = r.path; // path only: never the query, which can hold a guest secret
    if ((m = GUEST_PATH.exec(r.path))) {
      r.params.id = m[1]; r.params.type = m[2] || '';
      view = m[2] ? Views.guestForm : Views.guestHome;
    } else if (r.query.g && !FleetAuth.hasSession() && (m = SCAN_PATH.exec(r.path))) {
      r.params.id = m[1];
      view = Views.guestEntry;
    } else if (r.path === '/') view = Views.fleet;
    else if (r.path === '/diag') view = viewDiag;
    else if (r.path === '/login') view = Views.login;
    else if (r.path === '/login/verify') view = Views.verify;
    else if (r.path === '/request') view = Views.request;
    else if (r.path === '/feedback') view = Views.feedback;
    else if (r.path === '/inbox') view = Views.inbox;
    else if ((m = /^\/inbox\/([0-9a-f-]{8,40})$/.exec(r.path))) { r.params.id = m[1]; view = Views.receipt; }
    else if (r.path === '/profile') view = Views.profile;
    else if (r.path === '/profile/cars') view = Views.userCars;
    else if (r.path === '/admin/users') view = FleetAuth.isAdmin() ? Views.adminUsers : viewForbidden;
    else if ((m = /^\/admin\/users\/([0-9a-f-]{8,40})\/cars$/.exec(r.path))) {
      r.params.userId = m[1];
      view = FleetAuth.isAdmin() ? Views.userCars : viewForbidden;
    } else if (r.path === '/car/new') view = Views.carForm;
    else if ((m = /^\/car\/([0-9a-f-]{8,40})\/reminder\/(new|[0-9a-f-]{8,40})$/.exec(r.path))) {
      r.params.id = m[1]; r.params.tid = m[2] === 'new' ? '' : m[2]; view = Views.reminderForm;
    } else if ((m = /^\/car\/([0-9a-f-]{8,40})\/add$/.exec(r.path))) { r.params.id = m[1]; view = Views.chooseEntry; }
    else if ((m = /^\/car\/([0-9a-f-]{8,40})\/add\/(issue|repair|maintenance|purchase|compliance)$/.exec(r.path))) {
      r.params.id = m[1]; r.params.type = m[2]; view = Views.entryForm;
    } else if ((m = /^\/car\/([0-9a-f-]{8,40})\/entry\/([0-9a-f-]{8,40})(\/edit)?$/.exec(r.path))) {
      r.params.id = m[1]; r.params.eid = m[2]; view = m[3] ? Views.entryForm : Views.entry;
    }
    else if ((m = /^\/car\/([0-9a-f-]{8,40})(?:\/(edit|fluids|label|people))?$/.exec(r.path))) {
      r.params.id = m[1];
      view = {
        edit: Views.carForm, fluids: Views.carForm, people: Views.carForm, label: Views.carLabel,
      }[m[2]] || Views.car;
    } else view = viewNotFound;
    view(r, appEl);
    appEl.focus({ preventScroll: true });
    if (!r.query.focus && !r.keepOpen) window.scrollTo(0, 0);
  }

  // ---------- navigation ----------
  function refreshNav() {
    var nav = document.getElementById('topnav');
    var user = FleetAuth.getUser();
    var links = [];
    if (FleetAuth.hasSession()) links.push(el('a', { href: '#/', text: 'Fleet' }));
    if (FleetAuth.hasSession() && window.InboxUI) {
      var n = InboxUI.getCount();
      links.push(el('a', { href: '#/inbox', text: n > 0 ? 'Inbox (' + n + ')' : 'Inbox' }));
    }
    if (FleetAuth.isAdmin()) links.push(el('a', { href: '#/admin/users', text: 'Users' }));
    if (user) links.push(el('a', { href: '#/profile', text: user.name.split(' ')[0] }));
    if (FleetAuth.hasSession()) {
      if (user && window.FleetSync) links.push(el('button', { type: 'button', class: 'navbtn', id: 'refresh-all', text: 'Refresh all app data', onclick: function () { FleetSync.refreshAll(); } }));
      links.push(el('button', { type: 'button', class: 'navbtn', text: 'Sign out', onclick: signOut }));
    } else {
      links.push(el('a', { href: '#/login', text: 'Sign in' }));
    }
    nav.replaceChildren.apply(nav, links);
    nav.setAttribute('aria-label', user ? 'Main menu for ' + user.name : 'Main menu');
  }

  function signOut() {
    var done = function () {
      inboxAsked = false;
      FleetAuth.clear();
      refreshNav();
      go('/login');
    };
    FleetApi.call('logout').then(done, done);
  }

  // the number of receipts waiting is shown on the menu: it is asked for on opening the app, and when it changes
  window.addEventListener('fleet:inbox-count', function () { refreshNav(); });

  window.addEventListener('fleet:unauthorized', function () {
    refreshNav();
    var r = parseHash();
    if (!isOpen(r)) go('/login', { next: r.raw });
  });

  // ---------- saved data changed behind the scenes ----------
  // When the phone downloads newer data for the screen being shown (someone else changed it, or "Refresh all app data"
  // was used), the screen is drawn again, unless the person is in the middle of typing.
  window.addEventListener('fleet:data-updated', function (ev) {
    var d = (ev && ev.detail) || {};
    var r = parseHash();
    var m = /^\/car\/([0-9a-f-]{8,40})(?:\/entry\/[0-9a-f-]{8,40})?$/.exec(r.path);
    var affected = r.path === '/' ? !!(d.fleet || d.all) : m ? !!(d.all || (d.cars || []).indexOf(m[1]) !== -1) : false;
    var a = document.activeElement;
    if (!affected || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
    route({ keepOpen: true });
  });

  // ---------- footer / version check ----------
  var backendInfo = null;

  function shortRev(rev) {
    return !rev || rev.indexOf('__') === 0 ? 'dev' : rev.slice(0, 7);
  }

  function renderSaved() {
    var span = document.getElementById('rev-saved');
    var at = window.FleetSync ? FleetSync.lastSaved() : 0;
    if (!span) return;
    span.textContent = at ? '· data saved on this phone ' + new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  }
  window.addEventListener('fleet:synced', renderSaved);

  function renderFooter() {
    renderSaved();
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

    // The car page is the busiest screen: time it, and say how much of the wait was the server itself.
    function carTest() {
      if (!FleetAuth.getUser()) return null;
      return FleetApi.call('listCars').then(function (r) {
        var first = r.data.cars[0];
        if (!first) return null;
        var describe = function (res) { return res.ms + ' ms in all, server ' + (res.serverMs === null ? 'unknown' : res.serverMs + ' ms'); };
        // twice: the first may have to read the sheets, the second shows the everyday speed
        return FleetApi.call('getCarPage', { id: first.id }).then(function (res) {
          row('Car page, first time', describe(res));
          return FleetApi.call('getCarPage', { id: first.id });
        }).then(function (res) { row('Car page, again', describe(res)); });
      }).catch(function () { row('Car page', 'could not be tested', 'bad'); });
    }

    function run() {
      renderStatic();
      out.replaceChildren();
      runBtn.disabled = true;
      runBtn.textContent = 'Testing…';
      var times = [];
      var serverTimes = [];
      var chain = Promise.resolve();
      var info = null;
      var failure = null;

      for (var i = 0; i < 5; i++) {
        chain = chain.then(function () {
          if (failure) return;
          return FleetApi.call('ping').then(function (res) {
            times.push(res.ms);
            serverTimes.push(res.serverMs);
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
          var onServer = serverTimes.filter(function (t) { return typeof t === 'number'; });
          if (onServer.length) row('Of which on the server', Math.round(onServer.reduce(function (x, y) { return x + y; }, 0) / onServer.length) + ' ms');
          row('Server time', info.serverTime);
          row('Result', 'Connected', 'ok');
        }
        return failure ? null : carTest();
      }).then(function () {
        runBtn.disabled = false;
        runBtn.textContent = 'Run connection test again';
      });
    }

    renderStatic();
    runBtn.addEventListener('click', run);
    root.replaceChildren(el('section', { class: 'card' }, [el('h1', { text: 'Diagnostics' }), list, runBtn, out]));
    if (FleetAuth.isAdmin()) root.append(receiptDiagnostics());
  }

  // ---------- receipts: is everything working? (admins) ----------
  function ago(iso) {
    var t = Date.parse(iso);
    if (!t) return 'never';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago';
  }

  function receiptDiagnostics() {
    var list = el('ul', { class: 'diag-list' });
    var recent = el('div', { class: 'stack' });
    var msg = el('div');
    var report = el('pre', { class: 'diag-pre', hidden: true });
    var timer = null;
    function row(label, value, cls) { list.append(el('li', { class: cls || '' }, [el('span', { class: 'k', text: label }), el('span', { class: 'v', text: value })])); }

    function draw(h) {
      list.replaceChildren();
      var mailAge = h.mail.lastRun ? (Date.parse(h.now) - Date.parse(h.mail.lastRun)) / 60000 : null;
      row('Email timer', !h.mail.timerOn ? 'NOT SET UP (run setupReceiptEmail in the Apps Script editor)' : mailAge === null ? 'on, but has not run yet'
        : mailAge > 15 ? 'on, but last ran ' + ago(h.mail.lastRun) + ' (it should run every 5 minutes)' : 'on, last ran ' + ago(h.mail.lastRun),
        h.mail.timerOn && mailAge !== null && mailAge <= 15 ? 'ok' : 'bad');
      row('Timers in this project', (h.mail.timers || []).map(function (t) { return t.handler + (t.count > 1 ? ' ×' + t.count : ''); }).join(', ') || 'none', (h.mail.timers || []).some(function (t) { return t.handler === 'processReceiptEmails' && t.count === 1; }) ? '' : 'bad');
      if (h.mail.timerMade) row('Timer re-created', ago(h.mail.timerMade));
      row('Last timer run', h.mail.lastResult || 'nothing recorded yet', /^error/.test(h.mail.lastResult) ? 'bad' : '');
      row('Receipt mailbox', h.mail.mailbox);
      row('Gemini key', h.reading.keyOn ? 'set (' + h.reading.model + ')' : 'MISSING: add GEMINI_API_KEY in the Apps Script project settings', h.reading.keyOn ? 'ok' : 'bad');
      row('Receipts read today', h.reading.usedToday + ' of ' + h.reading.appLimit + ' (up to ' + h.reading.userLimit + ' per person)', h.reading.usedToday >= h.reading.appLimit ? 'bad' : '');
      row('Emails sent today', h.emails.adminNoticesToday + ' admin notices and ' + h.emails.confirmationsToday + ' confirmations (limit ' + h.emails.dailyLimit + ' of each)' + (h.emails.quotaLeft !== null ? '; ' + h.emails.quotaLeft + ' left in the mail allowance' : ''));
      var c = h.inbox.counts;
      row('Inbox now', h.inbox.openTotal + ' open: ' + c.Pending + ' ready to check, ' + c.Queued + ' waiting to be read, ' + c.Unreadable + ' to fill in by hand, ' + c.New + ' not read yet');
      if (h.inbox.oldestOpen) row('Oldest open receipt', ago(h.inbox.oldestOpen), Date.parse(h.now) - Date.parse(h.inbox.oldestOpen) > 3 * 86400000 ? 'bad' : '');
      row('Handled so far', c.Approved + ' approved, ' + c.Dismissed + ' dismissed');
      recent.replaceChildren.apply(recent, h.recent.length ? h.recent.map(function (r) {
        var what = [r.vendor || r.subject || 'Receipt', r.total !== null ? r.currency + ' ' + r.total : '', r.car].filter(Boolean).join(' · ');
        return el('div', { class: 'diag-receipt' }, [
          el('div', {}, [el('strong', { text: what }), el('span', { class: 'muted small-text', text: '  ' + ago(r.receivedAt) })]),
          el('div', { class: 'muted small-text', text: (r.source === 'email' ? 'Emailed' : 'Uploaded') + (r.sender ? ' by ' + r.sender : '') + ' · ' + r.status +
            (r.status === 'Queued' ? ' (tries again ' + (Date.parse(r.retryAfter) > Date.parse(h.now) ? 'in ' + Math.max(1, Math.round((Date.parse(r.retryAfter) - Date.parse(h.now)) / 60000)) + ' min' : 'at the next timer run') + (r.attempts ? ', ' + r.attempts + ' busy answers so far' : '') + ')' : '') }),
          r.note ? el('div', { class: 'muted small-text', text: r.note }) : null,
          el('a', { class: 'small-text', href: '#/inbox/' + r.id, text: 'Open' }),
        ]);
      }) : [el('p', { class: 'muted', text: 'No receipts yet.' })]);
    }

    function load() {
      return FleetApi.call('getReceiptHealth', {}, { timeoutMs: 40000 }).then(function (r) { msg.replaceChildren(); draw(r.data); }).catch(function (e) {
        if (e.code !== 'unauthorized') msg.replaceChildren(UI.notice('error', UI.errorText(e)));
      });
    }

    var refresh = el('button', { type: 'button', class: 'btn small secondary', text: 'Refresh' });
    refresh.addEventListener('click', function () { UI.busy(refresh, 'Refreshing…', load()); });
    var now = el('button', { type: 'button', class: 'btn small', text: 'Check the mail now' });
    now.addEventListener('click', function () {
      msg.replaceChildren();
      UI.busy(now, 'Checking…', FleetApi.call('processReceiptsNow', {}, { timeoutMs: 120000 }).then(function (r) {
        msg.replaceChildren(UI.notice('ok', r.data.lastResult || 'Done.'));
        return load();
      })).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
    });
    var reset = el('button', { type: 'button', class: 'btn small secondary', text: 'Re-create the timer' });
    reset.addEventListener('click', function () {
      UI.confirm('Throw away the receipt email timer and make a new one that runs every 5 minutes?', { okLabel: 'Re-create it' }).then(function (yes) {
        if (!yes) return;
        msg.replaceChildren();
        UI.busy(reset, 'Working…', FleetApi.call('resetReceiptTimer').then(function () { msg.replaceChildren(UI.notice('ok', 'A new timer was made. It should run within 5 minutes; this page shows when it does.')); return load(); }))
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
    });
    var inspect = el('button', { type: 'button', class: 'btn small secondary', text: 'Show how recent emails were handled' });
    inspect.addEventListener('click', function () {
      msg.replaceChildren();
      UI.busy(inspect, 'Looking…', FleetApi.call('inspectReceiptMail', {}, { timeoutMs: 60000 }).then(function (r) {
        report.hidden = false;
        report.textContent = r.data.lines.join('\n');
      })).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
    });

    // keep it fresh while the page is open
    timer = setInterval(function () { if (location.hash !== '#/diag' || !document.body.contains(list)) { clearInterval(timer); return; } load(); }, 30000);
    load();
    return el('section', { class: 'card' }, [
      el('h2', { text: 'Receipts' }),
      el('p', { class: 'muted small-text', text: 'Is everything behind emailed and photographed receipts working? This refreshes every 30 seconds.' }),
      msg, list,
      el('div', { class: 'btn-row' }, [now, inspect, reset, refresh]),
      report,
      el('h3', { text: 'Latest receipts' }), recent,
    ]);
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
  // A one-shot message to show on the next screen (e.g. "saved, but the photo failed").
  var flash = null;
  var shownFlash = null; // the message the screen just showed, so a redraw of the same screen can show it again
  window.FleetApp = {
    go: go,
    refreshNav: refreshNav,
    previousPage: function () { return lastPage; },
    setFlash: function (kind, text) { flash = { kind: kind, text: text }; },
    takeFlash: function () { var f = flash; flash = null; if (f) shownFlash = f; return f; },
  };
  window.addEventListener('hashchange', function () { route(); });
  function boot() {
    if (started) return;
    started = true;
    renderFooter();
    refreshNav();
    route();
    checkBackend();
    setupServiceWorker();
  }
  (window.FleetStore ? window.FleetStore.ready : Promise.resolve()).then(boot, boot);
})();
