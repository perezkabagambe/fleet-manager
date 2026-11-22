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
  // Coming back to a car's page from one of its other pages (an entry, a reminder, the fluids...) puts you where you were:
  // the same sections open, scrolled to the same place. Going anywhere else forgets it.
  var shownPath = '';  // the screen on show (its path only)
  var carBack = null;  // { carId, y, open } while you are on a page that was opened from a car's page
  var CAR_PAGE = /^\/car\/([0-9a-f-]{8,40})$/;
  function carIdOf(path) { var m = /^\/car\/([0-9a-f-]{8,40})(?:\/|$)/.exec(path); return m ? m[1] : ''; }

  /** Scroll to `y` once the page is tall enough (it fills in as its data arrives); give up on any touch or after a few seconds. */
  function restoreScroll(y) {
    var tries = 0;
    var stopped = false;
    function stop() { stopped = true; window.removeEventListener('touchstart', stop); window.removeEventListener('wheel', stop); }
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('wheel', stop, { passive: true });
    (function step() {
      if (stopped) return;
      var room = document.documentElement.scrollHeight - window.innerHeight;
      if (room >= y - 1 || tries > 40) { window.scrollTo(0, Math.min(y, Math.max(room, 0))); if (room >= y - 1) { setTimeout(stop, 400); return; } }
      tries++;
      setTimeout(step, 100);
    })();
  }

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
    if (!r.keepOpen) {
      var newCar = carIdOf(r.path);
      var wasCar = CAR_PAGE.exec(shownPath);
      var isCarPage = CAR_PAGE.test(r.path);
      if (wasCar && newCar === wasCar[1] && !isCarPage) {
        carBack = { carId: wasCar[1], y: window.scrollY, open: Views.getOpenCards ? Views.getOpenCards() : null }; // leaving the car's page for one of its pages
      } else if (!(carBack && newCar === carBack.carId)) {
        carBack = null; // went somewhere else: forget
      }
      if (isCarPage && carBack && carBack.carId === newCar) {
        r.restoreOpen = true;
        r.restoreY = carBack.y;
        if (carBack.open && Views.setOpenCards) Views.setOpenCards(carBack.open);
        carBack = null;
      }
    }
    shownPath = r.path;
    currentPath = r.path;
    if (!r.keepOpen) { banner = Object.assign({ title: 'Fleet Manager', subtitle: '', back: '', icon: '', share: null, ref: '', action: null }, defaultBanner(r.path)); }
    refreshNav();
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
    if (r.restoreY !== undefined) restoreScroll(r.restoreY);
    else if (!r.query.focus && !r.keepOpen) window.scrollTo(0, 0);
  }

  // ---------- the banner and the tab bar ----------
  // The banner at the top always names the page you are on. On a page you opened from another it has a back arrow; on the
  // main pages it has the page's icon. It can also carry the page's main action (Add car, Share). The bar at the bottom
  // moves between the main places: Fleet, Inbox, Users (admins) and Me.
  var ICONS = {
    back: '<path d="M15 6l-6 6l6 6"/>',
    plus: '<path d="M12 5l0 14"/><path d="M5 12l14 0"/>',
    car: '<path d="M5 17a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M15 17a2 2 0 1 0 4 0a2 2 0 0 0 -4 0"/><path d="M5 17h-2v-6l2 -5h9l4 5h1a2 2 0 0 1 2 2v4h-2m-4 0h-6m-6 -6h15m-6 0v-5"/>',
    inbox: '<path d="M4 4m0 2a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z"/><path d="M4 13h3l3 3h4l3 -3h3"/>',
    users: '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
    user: '<path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"/><path d="M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/>',
  };
  function icon(name, size) {
    var span = el('span', { class: 'ico', 'aria-hidden': 'true' });
    span.innerHTML = '<svg viewBox="0 0 24 24" width="' + (size || 24) + '" height="' + (size || 24) + '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>'; // fixed drawings
    return span;
  }

  var banner = { title: 'Fleet Manager', subtitle: '', back: '', icon: '', share: null, ref: '', action: null };
  var currentPath = '/';

  /** What the banner says before the page has loaded its data (the page then adds details with FleetApp.setBanner). */
  function defaultBanner(path) {
    var m;
    if (path === '/') return { title: 'Fleet', icon: 'car' };
    if (path === '/inbox') return { title: 'Receipt Inbox', icon: 'inbox' };
    if (/^\/inbox\/[0-9a-f-]+$/.test(path)) return { title: 'Receipt', back: '#/inbox' };
    if (path === '/admin/users') return { title: 'Users', icon: 'users' };
    if ((m = /^\/admin\/users\/([0-9a-f-]+)\/cars$/.exec(path))) return { title: 'Their cars', back: '#/admin/users' };
    if (path === '/profile') return { title: 'Me', icon: 'user' };
    if (path === '/profile/cars') return { title: 'Choose my cars', back: '#/profile' };
    if (path === '/diag') return { title: 'Diagnostics', back: FleetAuth.hasSession() ? '#/profile' : '#/login' };
    if (path === '/feedback') return { title: 'Report a bug or request a feature', back: FleetAuth.hasSession() ? '#/profile' : '#/login' };
    if (path === '/car/new') return { title: 'Add a car', back: '#/' };
    if ((m = /^\/car\/([0-9a-f-]{8,40})$/.exec(path))) return { title: 'Car', back: '#/' };
    if ((m = /^\/car\/([0-9a-f-]{8,40})\/(edit|fluids|people|label)$/.exec(path))) return { title: { edit: 'Edit car', fluids: 'Edit specs', people: 'Owners', label: 'QR label' }[m[2]], back: '#/car/' + m[1] };
    if ((m = /^\/car\/([0-9a-f-]{8,40})\/add$/.exec(path))) return { title: 'Add an entry', back: '#/car/' + m[1] };
    if ((m = /^\/car\/([0-9a-f-]{8,40})\/add\/(\w+)$/.exec(path))) return { title: 'Add ' + ({ issue: 'an issue', maintenance: 'maintenance', repair: 'maintenance', purchase: 'a purchased item', compliance: 'a renewal' }[m[2]] || 'an entry'), back: '#/car/' + m[1] + '/add' };
    if ((m = /^\/car\/([0-9a-f-]{8,40})\/entry\/([0-9a-f-]{8,40})\/edit$/.exec(path))) return { title: 'Edit entry', back: '#/car/' + m[1] + '/entry/' + m[2] };
    if ((m = /^\/car\/([0-9a-f-]{8,40})\/entry\/([0-9a-f-]{8,40})$/.exec(path))) return { title: 'Entry', back: '#/car/' + m[1] };
    if ((m = /^\/car\/([0-9a-f-]{8,40})\/reminder\/(new|[0-9a-f-]{8,40})$/.exec(path))) return { title: m[2] === 'new' ? 'New reminder' : 'Edit reminder', back: '#/car/' + m[1] };
    return { title: 'Fleet Manager' };
  }

  function drawBanner() {
    var signedIn = FleetAuth.hasSession() && !!FleetAuth.getUser();
    var back = document.getElementById('bar-back');
    var logo = document.getElementById('bar-logo');
    var title = document.getElementById('bar-title');
    var sub = document.getElementById('bar-sub');
    var actions = document.getElementById('bar-actions');
    if (!back) return;
    back.hidden = !banner.back;
    if (banner.back) { back.setAttribute('href', banner.back); back.replaceChildren(icon('back', 26)); }
    logo.hidden = !!banner.back || signedIn; // the logo is for the sign-in pages; signed in, the page's own icon leads
    var lead = document.getElementById('bar-icon');
    if (lead) lead.remove();
    if (!banner.back && signedIn && banner.icon) { lead = icon(banner.icon, 24); lead.id = 'bar-icon'; lead.classList.add('bar-icon'); title.parentNode.parentNode.insertBefore(lead, title.parentNode); }
    title.textContent = banner.title;
    sub.textContent = banner.subtitle || '';
    sub.hidden = !banner.subtitle;
    var kids = [];
    if (banner.action) {
      var a = el('a', { class: 'bar-action', href: banner.action.href, 'aria-label': banner.action.label }, [icon(banner.action.icon || 'plus', 24)]);
      kids.push(a);
    }
    if (banner.share) {
      kids.push(el('div', { class: 'bar-share' }, [
        UI.shareButton(banner.share.url, { title: banner.share.title, aria: banner.share.aria || 'Share' }),
        banner.ref ? el('span', { class: 'ref-tiny' , text: banner.ref }) : null,
      ]));
    }
    actions.replaceChildren.apply(actions, kids);
    document.title = (banner.title && banner.title !== 'Fleet Manager' ? banner.title + ' · ' : '') + 'Fleet Manager';
  }

  function setBanner(o) {
    Object.keys(o || {}).forEach(function (k) { banner[k] = o[k]; });
    drawBanner();
  }

  /** Pages that did not name their banner still get a back arrow if they have a "back" link, and no title is shown twice. */
  function tidyPage() {
    if (!banner.back) {
      var a = appEl.querySelector('a.back');
      if (a && a.getAttribute('href')) { banner.back = a.getAttribute('href'); drawBanner(); }
    }
    var shown = (banner.title || '').trim().toLowerCase();
    Array.prototype.forEach.call(appEl.querySelectorAll('h1'), function (h) {
      h.classList.toggle('dup-title', !!shown && h.textContent.trim().toLowerCase() === shown);
    });
  }
  var tidyQueued = false;
  new MutationObserver(function () {
    if (tidyQueued) return;
    tidyQueued = true;
    window.requestAnimationFrame(function () { tidyQueued = false; tidyPage(); });
  }).observe(appEl, { childList: true, subtree: true });

  function currentTab(path) {
    if (path === '/' || /^\/car\//.test(path)) return 'fleet';
    if (/^\/inbox/.test(path)) return 'inbox';
    if (/^\/admin\//.test(path)) return 'users';
    if (/^\/(profile|diag|feedback)/.test(path)) return 'me';
    return '';
  }

  function drawTabs() {
    var bar = document.getElementById('tabbar');
    var signedIn = FleetAuth.hasSession() && !!FleetAuth.getUser();
    var onGuestPage = GUEST_PATH.test(currentPath) || (!FleetAuth.hasSession());
    bar.hidden = !signedIn || onGuestPage;
    document.body.classList.toggle('has-tabs', !bar.hidden);
    document.body.classList.toggle('on-me-page', !bar.hidden && currentPath === '/profile'); // the version line, Privacy and Terms live at the bottom of Me
    if (bar.hidden) { bar.replaceChildren(); return; }
    var here = currentTab(currentPath);
    var n = window.InboxUI ? InboxUI.getCount() : 0;
    var tabs = [{ id: 'fleet', label: 'Fleet', icon: 'car', href: '#/' }, { id: 'inbox', label: 'Inbox', icon: 'inbox', href: '#/inbox', badge: n }];
    if (FleetAuth.isAdmin()) tabs.push({ id: 'users', label: 'Users', icon: 'users', href: '#/admin/users' });
    tabs.push({ id: 'me', label: 'Me', icon: 'user', href: '#/profile' });
    bar.replaceChildren.apply(bar, tabs.map(function (t) {
      return el('a', { class: 'tab' + (t.id === here ? ' on' : ''), href: t.href, 'aria-current': t.id === here ? 'page' : null }, [
        icon(t.icon, 24), el('span', { class: 'tab-label', text: t.label }),
        t.badge ? el('span', { class: 'tab-badge', text: t.badge > 99 ? '99+' : String(t.badge) }) : null,
      ]);
    }));
  }

  function refreshNav() { drawTabs(); drawBanner(); }

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

    // each car's easy and private receipt addresses, with a way to replace a private one
    var addrBody = el('div', { class: 'stack' });
    var addrLoaded = false;
    function loadAddresses() {
      addrBody.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
      FleetApi.call('listReceiptAddresses', {}, { timeoutMs: 60000 }).then(function (r) {
        addrBody.replaceChildren.apply(addrBody, [el('p', { class: 'muted small-text', text: 'The registration address only works for mail from an approved user\'s own email address. The private address works for anyone who has it (shops, automatic forwarding): share it carefully.' })].concat(r.data.cars.map(function (c) {
          var again = el('button', { type: 'button', class: 'btn small secondary', text: 'Make a new private address' });
          again.addEventListener('click', function () {
            UI.confirm('Make a new private address for ' + c.registration + '? The old private address stops working straight away (the registration address is not affected).', { okLabel: 'Make a new one', danger: true }).then(function (yes) {
              if (!yes) return;
              UI.busy(again, 'Working…', FleetApi.call('replaceReceiptSecret', { carId: c.carId })).then(loadAddresses)
                .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
            });
          });
          return el('div', { class: 'addr-row' }, [
            el('strong', { text: c.registration }),
            el('div', { class: 'small-text' }, [el('span', { class: 'muted', text: 'Registration address: ' }), el('code', { text: c.address || 'none (the registration is too short)' })]),
            el('div', { class: 'small-text' }, [el('span', { class: 'muted', text: 'Private address: ' }), el('code', { text: c.privateAddress }), UI.copyValueButton(c.privateAddress, 'Copy the private address for ' + c.registration)]),
            again,
          ]);
        })));
      }).catch(function (e) { addrLoaded = false; addrBody.replaceChildren(UI.notice('error', UI.errorText(e))); });
    }
    var addrBox = el('details', { class: 'copy-section' }, [el('summary', { text: 'Receipt email addresses for each car' }), addrBody]);
    addrBox.addEventListener('toggle', function () { if (addrBox.open && !addrLoaded) { addrLoaded = true; loadAddresses(); } });

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
      addrBox,
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
    setBanner: setBanner,
    signOut: function () { signOut(); },
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
