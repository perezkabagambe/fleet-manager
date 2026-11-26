// Fleet list, car page, add/edit form, fluids editor and printable QR label.
(function () {
  'use strict';

  var el = UI.el;

  /**
   * A box whose text shrinks as it fills, so a long registration or VIN stays fully visible instead of scrolling sideways.
   * It never shrinks below `minPx`. Set through the style property (the page's security policy blocks inline style attributes).
   */
  function shrinkToFit(input, minPx) {
    var base = 0;
    function fit() {
      if (!input.isConnected || !input.clientWidth) return; // not on screen yet
      if (!base) base = parseFloat(window.getComputedStyle(input).fontSize) || 16;
      var size = base;
      input.style.fontSize = size + 'px';
      while (input.scrollWidth > input.clientWidth && size > minPx) { size -= 0.5; input.style.fontSize = size + 'px'; }
    }
    input.addEventListener('input', fit);
    window.addEventListener('resize', fit);
    setTimeout(fit, 0);
    setTimeout(fit, 400); // once the page has settled (fonts loaded, boxes sized)
    input._fit = fit; // for when the text is filled in by the program (for instance from the log book)
    return input;
  }

  /** Which of the three ways of asking answered: 1 the latest model with search, 2 an older model with search, 3 the latest model without search. */
  function methodText(m) {
    var what = m.step === 1 ? 'the latest model, with Google Search' : m.step === 2 ? 'an older model, with Google Search' : 'the latest model, without web search (search was not available)';
    return 'Method ' + m.step + ' of 3 was used: ' + what + ' (' + m.model + ').';
  }
  // A permanent reminder wherever AI-filled specifications are shown (it stays after the car is saved).
  var AI_CHECK_NOTE = 'Some entries below may have been AI generated. Please check before use, e.g if it says ACEA C3 5W-30 engine oil below, but Euro Car Parts suggests ACEA A3/B3 5W-20, do some further research and update these entries accordingly.';
  function isAiRow(f) { return /^AI suggestion/.test((f && f.source) || ''); }
  function aiCheckNote() { return el('p', { class: 'section-note', text: AI_CHECK_NOTE }); }
  var MARKETS = ['European', 'UK', 'Japanese (JDM)', 'North American', 'Middle East (GCC)', 'Australian', 'African', 'Asian', 'Other'];
  var Views = (window.Views = window.Views || {});
  var cfg = window.FLEET_CONFIG;

  var FLUID_TEMPLATE = [
    'Engine oil', 'Gearbox oil / ATF', 'Front differential oil', 'Rear differential oil', 'Transfer case oil',
    'Coolant', 'Brake fluid', 'Power steering fluid', 'AC refrigerant',
  ];

  // Bulbs are rows of the same list as the fluids, marked with kind 'bulb'. The name is where the bulb goes ("Dipped
  // beam"), the Specification says the bulb type and then the specific bulb (e.g. "Halogen H7 55 W"), and the
  // Capacity box says how many are fitted.
  var BULB_TEMPLATE = [
    'Dipped beam', 'Full beam', 'Front side light', 'Front indicator', 'Rear indicator', 'Front fog', 'Rear fog',
    'Front daytime running', 'Rear light', 'Rear brake light', 'Rear reverse light',
  ];
  function isBulbRow(row) { return row && row.kind === 'bulb'; }

  // Greyed-out examples shown in an empty Specification / Capacity box. They are
  // only suggestions of a typical standard for that kind of fluid, never saved.
  // Order matters: the first pattern that matches the fluid name wins.
  var FLUID_HINTS = [
    [/transfer/i, { spec: 'e.g. 75W-90 API GL-4', cap: 'e.g. 1 L' }],
    [/differential|diff\b/i, { spec: 'e.g. 75W-90 API GL-5', cap: 'e.g. 1.2 L' }],
    [/engine|motor oil/i, { spec: 'e.g. 5W-30, ACEA C3, API SN', cap: 'e.g. 5.5 L with filter change' }],
    [/gearbox|transmission|\batf\b|gear oil/i, { spec: 'e.g. ATF Dexron VI, or 75W-80 GL-4', cap: 'e.g. 7 L' }],
    [/coolant|antifreeze/i, { spec: 'e.g. Pink OAT, VW TL 774-J (G12+), 50/50', cap: 'e.g. 8 L' }],
    [/brake|clutch/i, { spec: 'e.g. DOT 4', cap: 'e.g. 1 L' }],
    [/steering/i, { spec: 'e.g. ATF Dexron III, or CHF 11S', cap: 'e.g. 1 L' }],
    [/refrigerant|a\/c|\bac\b|air con/i, { spec: 'e.g. R134a or R1234yf', cap: 'e.g. 450 g' }],
  ];
  var FLUID_HINT_DEFAULT = { spec: 'e.g. grade or standard', cap: 'e.g. 1 L' };
  var BULB_HINT = { spec: 'e.g. Halogen H7 55 W', cap: 'e.g. 2 (one each side)' };
  function fluidHint(name) {
    for (var i = 0; i < FLUID_HINTS.length; i++) {
      if (FLUID_HINTS[i][0].test(name || '')) return FLUID_HINTS[i][1];
    }
    return FLUID_HINT_DEFAULT;
  }

  var CURRENCY_OPTIONS = [['GBP', 'GBP (£)'], ['UGX', 'UGX (USh)'], ['USD', 'USD ($)'], ['KES', 'KES (KSh)'], ['EUR', 'EUR (€)']];

  var carsCache = null; // last fleet list: shown instantly while a fresh copy loads

  // Other screens call this to keep the fleet list fresh.
  Views.invalidateCars = function () { carsCache = null; };

  // ---------- helpers ----------
  function num(n) { return n === null || n === undefined ? '–' : Number(n).toLocaleString('en-GB'); }
  function countText(n, one, many) { return n === 0 ? 'None' : n + ' ' + (n === 1 ? one : many); }
  function reminderHint(tasks) {
    var active = tasks.filter(function (t) { return t.active; });
    var overdue = active.filter(function (t) { return t.status === 'overdue'; }).length;
    var soon = active.filter(function (t) { return t.status === 'due_soon'; }).length;
    if (overdue) return overdue + ' overdue';
    if (soon) return soon + ' due soon';
    return active.length ? 'All OK' : 'None';
  }
  function carTitle(c) { return c.make + ' ' + c.model + (c.year ? ' (' + c.year + ')' : ''); }
  // The date is stored as YYYY, YYYY-MM or YYYY-MM-DD; show only the precision that is known.
  function fmtAcquired(s) {
    if (!s) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p = s.split('-');
    if (p.length === 1) return p[0];
    if (p.length === 2) return months[Number(p[1]) - 1] + ' ' + p[0];
    return Number(p[2]) + ' ' + months[Number(p[1]) - 1] + ' ' + p[0];
  }
  // Show where a link goes (e.g. partsouq.com) so nobody taps it blind.
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'link'; }
  }
  function money(n, currency) {
    try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency }).format(n); }
    catch (e) { return currency + ' ' + n; }
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function chip(status) {
    return el('span', { class: 'chip ' + status.toLowerCase().replace(/[^a-z]/g, ''), text: status });
  }
  // Thumbnail on the fleet list, full-size on the car page. Falls back to a placeholder.
  function photo(car, cls, kind) {
    return Photos.element(car, kind || 'thumb', cls);
  }
  function loading() { return el('p', { class: 'muted center pad', text: 'Loading…' }); }
  function backLink(href, text) { return el('a', { class: 'back', href: href, text: '← ' + text }); }
  function notFound(root) {
    root.replaceChildren(el('section', { class: 'card' }, [
      el('h1', { text: 'Car not found' }),
      el('p', { class: 'muted', text: 'It may have been deleted.' }),
      el('a', { class: 'btn', href: '#/', text: 'Back to fleet' }),
    ]));
  }

  function qrDataUrl(text) {
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
  }
  function carUrl(id) { return (cfg.siteUrl || location.origin + location.pathname) + '#/car/' + id; }
  // What the QR code holds: the car's address plus its guest secret (only used if guest access is switched on).
  function qrLink(car) { return carUrl(car.id) + (car.guestSecret ? '?g=' + car.guestSecret : ''); }
  function entryUrl(carId, entryId) { return carUrl(carId) + '/entry/' + entryId; }

  // Shared with the entry screens.
  Views.fmt = {
    carUrl: carUrl, entryUrl: entryUrl,
    money: money, date: fmtDate, num: num, hostOf: hostOf, chip: chip, loading: loading, backLink: backLink,
    notFound: notFound, currencyOptions: CURRENCY_OPTIONS,
  };

  // ---------- fleet ----------
  Views.fleet = function (ctx, root) {
    var msg = el('div');
    var grid = el('div', { class: 'car-list' });
    var deletedBox = el('div');
    FleetApp.setBanner({ title: 'Fleet', icon: 'car', action: { href: '#/car/new', label: 'Add a car', text: 'Add car', icon: 'plus' } });

    // Shown once, in the installed Android app: how to make Fleet Manager links open straight in the app (a phone setting
    // that an app cannot switch on for itself, and that a downloaded app starts with switched off).
    function linksTip() {
      var android = /Android/i.test(navigator.userAgent || '');
      var installed = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
      var seen = false;
      try { seen = localStorage.getItem('fm-links-tip') === '1'; } catch (e) { seen = false; }
      if (!android || !installed || seen) return null;
      var done = el('button', { type: 'button', class: 'btn small', text: 'Got it' });
      var box = el('div', { class: 'tip-card', role: 'note' }, [
        el('strong', { text: 'Open Fleet Manager links in this app' }),
        el('p', { class: 'small-text', text: 'So that links to a car, or the sign-in link in your email, open straight here and not in your browser: go to Settings → Apps → Fleet Manager → Open by default, and turn on Open supported links.' }),
        done,
      ]);
      done.addEventListener('click', function () {
        try { localStorage.setItem('fm-links-tip', '1'); } catch (e) { /* ignore */ }
        box.remove();
      });
      return box;
    }
    // ---- search: the box at the top, and its results in place of the fleet while there is something typed ----
    var searchInput = el('input', { type: 'search', class: 'fleet-search-input', name: 'q', placeholder: 'Search cars, entries, files, reminders…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search the fleet' });
    var searchClear = el('button', { type: 'button', class: 'fleet-search-clear', 'aria-label': 'Clear the search', text: '✕', hidden: true });
    var searchBox = el('div', { class: 'fleet-search' }, [el('span', { class: 'fleet-search-icon', 'aria-hidden': 'true', text: '🔍' }), searchInput, searchClear]);
    var results = el('div', { class: 'search-results', hidden: true, 'aria-live': 'polite' });
    var searchData = null;
    var expanded = {};
    var GROUPS = [['cars', 'Cars'], ['entries', 'Log entries'], ['files', 'Files'], ['reminders', 'Reminders']];
    var SHOW = 5;

    function highlight(text, words) {
      var parts = words.filter(function (w) { return w; }).map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); });
      if (!parts.length) return [document.createTextNode(text)];
      var out = [];
      var re = new RegExp('(' + parts.join('|') + ')', 'ig');
      String(text).split(re).forEach(function (piece, i) { if (piece) out.push(i % 2 ? el('mark', { text: piece }) : document.createTextNode(piece)); });
      return out;
    }

    function openFile(item) {
      var action = item.kind === 'document' ? 'getCarDocument' : 'getAttachment';
      var shown = Viewer.show({ mime: item.mime, filename: item.filename, load: function () { return FleetApi.call(action, { id: item.fileId }).then(function (r) { return r.data; }); } });
      return shown;
    }

    function resultRow(item, words) {
      var thumb = item.kind === 'entry' ? EntryUI.typeThumb(item.type) : el('div', { class: 'type-thumb tt-search tt-' + item.kind, 'aria-hidden': 'true', text: item.kind === 'car' ? '🚗' : item.kind === 'reminder' ? '⏰' : '📄' });
      var kids = [
        thumb,
        el('div', { class: 'search-main' }, [el('div', { class: 'search-title' }, highlight(item.title, words)), el('div', { class: 'muted small-text search-sub', text: item.sub })]),
        item.id ? el('span', { class: 'search-id' }, highlight(item.id, words)) : null,
      ];
      if (item.kind === 'attachment' || item.kind === 'document') {
        var b = el('button', { type: 'button', class: 'search-row' }, kids);
        b.addEventListener('click', function () { openFile(item).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); }); });
        return b;
      }
      var href = item.kind === 'car' ? '#/car/' + item.carId
        : item.kind === 'entry' ? '#/car/' + item.carId + '/entry/' + item.entryId
        : '#/car/' + item.carId + '/reminder/' + item.taskId;
      return el('a', { class: 'search-row', href: href }, kids);
    }

    function runSearch() {
      var q = searchInput.value;
      var active = q.trim().length >= 2;
      searchClear.hidden = !q.length;
      results.hidden = !active;
      grid.hidden = active; deletedBox.hidden = active;
      if (!active) return;
      if (!searchData) searchData = FleetSearch.collect(FleetApi.peek);
      var found = FleetSearch.find(searchData, q);
      var words = q.trim().toLowerCase().split(/\s+/);
      if (!found.total) {
        results.replaceChildren(el('div', { class: 'empty search-none' }, [
          el('p', { text: 'Nothing found for "' + q.trim() + '".' }),
          el('p', { class: 'muted small-text', text: 'Try a registration, a part, a garage or an ID. Search looks at the data saved on this phone.' }),
        ]));
        return;
      }
      results.replaceChildren.apply(results, GROUPS.filter(function (g) { return found[g[0]].length; }).map(function (g) {
        var hits = found[g[0]];
        var all = !!expanded[g[0]];
        var shown = all ? hits : hits.slice(0, SHOW);
        var head = el('div', { class: 'search-group' }, [el('span', { text: g[1] + ' · ' + hits.length })]);
        if (hits.length > SHOW) {
          var more = el('button', { type: 'button', class: 'linklike', text: all ? 'Show fewer' : 'Show all' });
          more.addEventListener('click', function () { expanded[g[0]] = !all; runSearch(); });
          head.append(more);
        }
        return el('div', {}, [head, el('div', { class: 'search-list' }, shown.map(function (i) { return resultRow(i, words); }))]);
      }));
    }
    searchInput.addEventListener('input', runSearch);
    searchInput.addEventListener('focus', function () { searchData = null; }); // what is saved may have changed since: read it again
    searchClear.addEventListener('click', function () { searchInput.value = ''; expanded = {}; runSearch(); searchInput.focus(); });

    root.replaceChildren(el('section', { class: 'card fleet-card' }, [linksTip(), searchBox, results, msg, grid, deletedBox]));

    function card(c, mine) {
      // a row: the photo on the left; in the middle the plate with the mileage at its top right, the make and model on one line
      // (cut off with "…" if too long), the year on its own line, then the tags; an arrow on the right
      var link = el('a', { class: 'car-row', href: '#/car/' + c.id }, [
        photo(c, 'row-photo'),
        el('div', { class: 'car-row-body' }, [
          el('div', { class: 'car-row-top' }, [
            el('span', { class: 'reg', text: c.registration }),
            c.odometer === null ? null : el('span', { class: 'muted small-text car-row-odo', text: num(c.odometer) + ' mi' }),
          ]),
          el('div', { class: 'muted small-text car-row-title', text: [c.make, c.model].filter(Boolean).join(' ') }),
          c.year ? el('div', { class: 'muted small-text car-row-year', text: String(c.year) }) : null,
          el('div', { class: 'car-row-tags' }, [chip(c.status), mine && mine.owner ? el('span', { class: 'chip sold', text: 'Yours' }) : null]),
        ]),
        el('div', { class: 'car-row-side' }, [
          el('span', { class: 'menu-chev', 'aria-hidden': 'true', text: '›' }),
        ]),
      ]);
      return link;
    }

    function render(data) {
      var active = data.cars.filter(function (c) { return c.status === 'Active'; }).length;
      FleetApp.setBanner({ subtitle: data.cars.length + (data.cars.length === 1 ? ' vehicle' : ' vehicles') + (data.cars.length ? ' · ' + active + ' active' : '') });
      grid.replaceChildren.apply(grid, data.cars.length
        ? data.cars.map(function (c) { return card(c, (data.mine || {})[c.id]); })
        : [el('div', { class: 'empty' }, [
          el('p', { text: 'No cars yet.' }),
          el('a', { class: 'btn', href: '#/car/new?mine=1', text: 'Add your first car' }),
        ])]);
      deletedBox.replaceChildren();
      if (data.deleted && data.deleted.length) {
        var list = data.deleted.map(function (c) {
          var b = el('button', { type: 'button', class: 'btn small secondary', text: 'Restore' });
          b.addEventListener('click', function () {
            UI.busy(b, 'Restoring…', FleetApi.call('restoreCar', { id: c.id }))
              .then(function () { carsCache = null; Views.fleet(ctx, root); })
              .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
          });
          return el('div', { class: 'deleted-row' }, [
            el('span', { text: c.registration + ' · ' + carTitle(c) }), b,
          ]);
        });
        deletedBox.append(el('details', { class: 'deleted' }, [el('summary', { text: 'Deleted cars (' + data.deleted.length + ')' })].concat(list)));
      }
    }

    grid.append(loading());
    // the copy saved last time appears at once; the fresh list replaces it if anything changed
    FleetApi.seen('listCars', {}, function (data) {
      carsCache = data;
      render(data);
    }).catch(function (e) {
      if (e.code === 'unauthorized') return;
      msg.replaceChildren(UI.notice('error', e.hadSaved ? 'Could not refresh the list, so this is the copy saved on this phone. ' + UI.errorText(e) : UI.errorText(e)));
      if (!e.hadSaved) grid.replaceChildren();
    });
  };

  // ---------- car page ----------
  // Which sections of a car page are open. Every visit starts with all of them closed; the page redrawing itself
  // (the fresh answer replacing the saved copy, or after an odometer update) keeps what you had opened.
  var openCards = { carId: '', keys: {} };

  /** Turn a card into a section that opens and closes. Its heading stays visible; `hint` is a short summary beside it. */
  function collapsible(key, card, hint, action) {
    if (!card) return null;
    var kids = Array.prototype.slice.call(card.childNodes);
    var heading = kids.filter(function (n) { return n.tagName === 'H2'; })[0];
    var rest = kids.filter(function (n) { return n !== heading; });
    var summary = el('summary', {}, [
      heading || el('h2', { text: key }),
      hint ? el('span', { class: 'muted small-text collapse-hint', text: hint }) : null,
      action ? el('span', { class: 'collapse-action' }, [action]) : null, // e.g. an Edit button beside the title (shown while the section is open)
    ]);
    var d = el('details', { class: 'card collapsible' }, [summary, el('div', { class: 'collapse-body' }, rest)]);
    d.open = !!openCards.keys[key];
    d.addEventListener('toggle', function () { openCards.keys[key] = d.open; if (d.open && typeof card.onOpen === 'function') card.onOpen(); });
    if (d.open && typeof card.onOpen === 'function') card.onOpen();
    return d;
  }

  // which sections of a car's page are open (kept so that coming back to the page finds it as it was left)
  Views.getOpenCards = function () { return { carId: openCards.carId, keys: Object.assign({}, openCards.keys) }; };
  Views.setOpenCards = function (o) { openCards = o; };
  /** Open the named sections the next time this car's page is drawn (and only then). */
  Views.openCarSections = function (carId, keys) { openCards = { carId: carId, keys: keys, once: true }; };

  Views.car = function (ctx, root) {
    var id = ctx.params.id;
    var openOnce = !!(openCards.once && openCards.carId === id); // sections asked to be open by a link (the user guide's demo links)
    if (!(ctx.keepOpen || ctx.restoreOpen || openOnce) || openCards.carId !== id) openCards = { carId: id, keys: {} };
    openCards.once = false;
    var flash = FleetApp.takeFlash(); // taken once: the page may be drawn twice (saved copy, then fresh)
    root.replaceChildren(el('section', { class: 'card' }, [loading()]));

    // One request brings the car, its history, reminders and costs. The copy saved last time is shown at once,
    // and the page is redrawn only if the fresh answer is different.
    FleetApi.seen('getCarPage', { id: id }, function (page) {
      render(page.car, page.fluids, page.people || { owners: [] }, page);
    }).catch(function (e) {
      if (e.code === 'not_found') notFound(root);
      else if (e.hadSaved && e.code !== 'unauthorized') root.prepend(UI.notice('error', 'Could not refresh, so this is the copy saved on this phone. ' + UI.errorText(e)));
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e)), backLink('#/', 'Fleet')]));
    });

    function render(car, fluids, people, page) {
      var msg = el('div');

      // odometer
      var odoInput = el('input', { type: 'text', inputmode: 'numeric', name: 'odometer', autocomplete: 'off', placeholder: 'New reading' });
      var odoBtn = el('button', { type: 'submit', class: 'btn small', text: 'Update' });
      var odoForm = el('form', { class: 'inline-form', novalidate: true }, [
        el('label', { class: 'sr-only', for: 'odo-input', text: 'New odometer reading in miles' }), odoInput, odoBtn,
      ]);
      odoInput.id = 'odo-input';
      function sendOdometer(force) {
        return FleetApi.call('updateOdometer', { id: car.id, odometer: odoInput.value, forceOdometer: !!force }).then(function () {
          carsCache = null;
          Views.car(Object.assign({}, ctx, { keepOpen: true }), root); // the sections you opened stay open
        });
      }
      odoForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        UI.busy(odoBtn, 'Saving…', sendOdometer(false)).catch(function (e) {
          if (e.code === 'odometer_lower' && FleetAuth.isAdmin()) {
            UI.confirm('That is lower than the current reading (' + num(car.odometer) + '). Correct it anyway?', { okLabel: 'Correct it' }).then(function (yes) {
              if (yes) UI.busy(odoBtn, 'Saving…', sendOdometer(true)).catch(function (e2) { msg.replaceChildren(UI.notice('error', UI.errorText(e2))); });
              else msg.replaceChildren(UI.notice('error', UI.errorText(e)));
            });
            return;
          }
          msg.replaceChildren(UI.notice('error', UI.errorText(e)));
        });
      });

      if (flash) msg.append(UI.notice(flash.kind, flash.text));

      function detail(label, value, cls) {
        return value ? [el('dt', { text: label }), el('dd', { text: value, class: cls })] : [];
      }
      // Always listed, so it is clear where to find it (and that it can be added): "Not recorded" until it is filled in.
      function detailAlways(label, value) {
        return [el('dt', { text: label }), el('dd', { class: value ? '' : 'muted', text: value || 'Not recorded' })];
      }
      // The details in three groups, each under a small heading (a group with nothing in it is left out)
      var fuelText = [car.fuelType, car.fuelCapacity === null || car.fuelCapacity === undefined ? '' : car.fuelCapacity + ' L'].filter(Boolean).join(' · ');
      var marketText = [car.market, car.driveSide].filter(Boolean).join(', ');
      var ownerNames = people.owners.map(function (x) { return x.name; }).concat(car.ownerOther ? [car.ownerOther] : []); // names from app users, plus any free-text person who is not a user
      var groups = [
        ['Key details', [].concat(
          detail('Make and model', carTitle(car)),
          detail('Colour', car.colour),
          detail('VIN / chassis', car.vin, 'vin-line'),
          detail('Location', car.country === 'UG' ? 'Uganda' : 'United Kingdom'),
          detail('Imported', fmtAcquired(car.importDate))
        )],
        ['Technical details', [].concat(
          detail('Engine code', car.engineCode),
          detail('Transmission', car.transmission),
          detail('Gearbox code', car.gearboxCode),
          detail('Fuel', fuelText),
          detail('Engine size', car.engineSize === null || car.engineSize === undefined ? '' : car.engineSize + ' L'),
          detail(car.market ? 'Market' : 'Drive', marketText)
        )],
        ['Ownership details', [].concat(
          detail('Acquired', fmtAcquired(car.acquisitionDate)),
          detailAlways('Acquisition cost', car.acquisitionCost === null || car.acquisitionCost === undefined ? '' : money(car.acquisitionCost, car.acquisitionCurrency || car.currency)),
          [el('dt', { text: 'Owner/Custodian' }), el('dd', { class: ownerNames.length ? '' : 'muted', text: ownerNames.length ? ownerNames.join(', ') : 'Not recorded yet' })]
        )],
      ];
      var detailGroups = el('div', { class: 'detail-groups' }, groups.filter(function (g) { return g[1].length; }).map(function (g) {
        return el('div', { class: 'detail-group' }, [el('h3', { class: 'detail-group-title', text: g[0] }), el('dl', { class: 'details' }, g[1])]);
      }));

      // The notes: trimmed to three lines, with "Show more" only if there is more to show
      var notesEl = car.notes ? el('p', { class: 'notes clamped', text: car.notes }) : null;
      var notesMore = el('button', { type: 'button', class: 'linklike notes-more', text: 'Show more', hidden: true });
      if (notesEl) {
        notesMore.addEventListener('click', function () {
          var open = notesEl.classList.toggle('clamped');
          notesMore.textContent = open ? 'Show more' : 'Show less';
        });
        var fitNotes = function () { if (notesEl.clientHeight && notesEl.classList.contains('clamped')) notesMore.hidden = notesEl.scrollHeight <= notesEl.clientHeight + 1; };
        setTimeout(fitNotes, 0);
        setTimeout(fitNotes, 400);
      }

      // "I own or look after this car": a quick way to add yourself, so nobody has to open Edit car for it. It is only offered to someone
      // who is not listed yet; taking yourself off is done in Edit car.
      var me = FleetAuth.getUser();
      var isMine = !!me && people.owners.some(function (x) { return x.userId === me.id; });
      var mineBtn = null;
      if (!isMine) {
        mineBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'I own or look after this car' });
        mineBtn.addEventListener('click', function () {
          msg.replaceChildren();
          UI.busy(mineBtn, 'Saving…', FleetApi.call('setMyCarRole', { carId: car.id, owner: true })).then(function () {
            carsCache = null;
            FleetApp.setFlash('ok', 'You are now listed as an owner/custodian of this car. Its reminders will come to you.');
            Views.car(Object.assign({}, ctx, { keepOpen: true }), root);
          }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
      }

      // Fluids are blue with a water drop; bulbs are amber with a light bulb.
      function specRow(f, name, kind) {
        return el('li', { class: 'fluid kind-' + kind }, [
          el('div', { class: 'fluid-name' }, [el('span', { class: 'spec-icon', 'aria-hidden': 'true', text: kind === 'bulb' ? '💡' : '💧' }), el('span', { text: name })]),
          el('div', { text: [f.specification, f.capacity].filter(Boolean).join(' · ') || '–' }),
          f.notes ? el('div', { class: 'muted small-text', text: f.notes }) : null,
        ]);
      }
      // The parts catalogues: a button for each, with the website's own icon beside it (fetched by the server when the link was saved)
      var catalogueBox = el('div', { class: 'catalogues' });
      function catalogueIconEl(src) { return el('img', { class: 'catalogue-icon', src: src, alt: '', width: '32', height: '32' }); }
      var cats = car.catalogues && car.catalogues.length ? car.catalogues : (car.partsouqUrl ? [{ url: car.partsouqUrl, icon: car.catalogueIcon || '' }] : []);
      if (cats.length) {
        var catRows = cats.map(function (c) {
          var row = el('div', { class: 'catalogue' }, [
            c.icon ? catalogueIconEl(c.icon) : null,
            el('a', { class: 'btn small secondary', href: c.url, target: '_blank', rel: 'noopener noreferrer', text: (cats.length === 1 ? 'Parts catalogue: ' : '') + hostOf(c.url) + (cats.length === 1 ? '' : ' ↗') }),
          ]);
          return row;
        });
        if (cats.length > 1) catalogueBox.append(el('div', { class: 'catalogue-head', text: 'Parts catalogues' }));
        catRows.forEach(function (r) { catalogueBox.append(r); });
        // a link saved before icons existed (or when its site did not answer): try once a session, and show each icon as it arrives
        var triedKey = 'fm-icon-tried-' + car.id;
        var tried = false;
        try { tried = sessionStorage.getItem(triedKey) === '1'; } catch (e) { tried = false; }
        if (!tried && cats.some(function (c) { return !c.icon; })) {
          try { sessionStorage.setItem(triedKey, '1'); } catch (e) { /* ignore */ }
          FleetApi.call('refreshCatalogueIcon', { carId: car.id }, { timeoutMs: 60000 }).then(function (r) {
            (r.data.catalogues || []).forEach(function (c, i) {
              var row = catRows[i];
              if (c.icon && row && document.body.contains(catalogueBox) && !row.querySelector('.catalogue-icon')) row.prepend(catalogueIconEl(c.icon));
            });
          }).catch(function () { /* no icon: the button works without it */ });
        }
      } else {
        catalogueBox.append(el('span', { class: 'muted', text: 'No parts catalogue link yet. Tap Edit car to add one.' }));
      }
      var fluidRows = fluids.filter(function (f) { return !isBulbRow(f); }).map(function (f) { return specRow(f, f.fluid, 'fluid'); });
      var bulbRows = fluids.filter(isBulbRow).map(function (f) { return specRow(f, f.fluid, 'bulb'); });

      // Export this car's data: the person ticks what to include.
      var exportBtn = el('button', { type: 'button', class: 'btn block secondary', text: 'Export vehicle data' });
      exportBtn.addEventListener('click', function () { ExportAll.run(car); });

      // the banner names the car and carries its share symbol
      FleetApp.setBanner({ title: car.registration, subtitle: carTitle(car), back: '#/', icon: '', share: { url: carUrl(car.id), title: car.registration + ' · ' + carTitle(car), aria: 'Share ' + car.registration } });

      root.replaceChildren(
        el('section', { class: 'card' }, [
          el('div', { class: 'page-head' }, [chip(car.status)]),
          msg,
          el('div', { class: 'section-head' }, [
            el('h2', { text: 'Vehicle details' }),
            el('a', { class: 'btn small secondary section-edit', href: '#/car/' + car.id + '/edit', text: 'Edit', 'aria-label': 'Edit the vehicle details' }),
          ]),
          Photos.carousel(car),
          detailGroups,
          car.notes ? el('div', { class: 'car-notes' }, [el('div', { class: 'car-notes-label', text: 'Notes' }), notesEl, notesMore]) : null,
          mineBtn ? el('div', { class: 'btn-row' }, [mineBtn]) : null,
        ]),
        collapsible('Odometer Log', el('section', { class: 'card' }, [
          el('h2', { text: 'Odometer Log' }),
          el('div', { class: 'big-number', text: car.odometer === null ? 'Not set' : num(car.odometer) + ' mi' }),
          car.odometerUpdatedAt ? el('div', { class: 'muted small-text', text: 'Updated ' + fmtDate(car.odometerUpdatedAt) }) : null,
          odoForm,
        ]), car.odometer === null ? 'Not set' : num(car.odometer) + ' mi'),
        collapsible('Maintenance & Issues Log', EntryUI.historyCard(car, page && page.entries), page && page.entries ? countText(page.entries.length, 'entry', 'entries') : ''),
        collapsible('Reminders', RemindersUI.card(car, page && page.tasks), page && page.tasks ? reminderHint(page.tasks) : ''),
        collapsible('Fluids | Bulbs | Parts', el('section', { class: 'card' }, [
          el('h2', { text: 'Fluids | Bulbs | Parts' }),
          catalogueBox,
          fluids.some(isAiRow) ? aiCheckNote() : null,
          fluidRows.length ? el('h3', { class: 'spec-group kind-fluid', text: '💧 Fluids' }) : null,
          fluidRows.length ? el('ul', { class: 'fluids' }, fluidRows) : (bulbRows.length ? null : el('p', { class: 'muted', text: 'No fluid specs recorded yet. Tap Edit car to add them.' })),
          bulbRows.length ? el('h3', { class: 'spec-group kind-bulb', text: '💡 Bulbs' }) : null,
          bulbRows.length ? el('ul', { class: 'fluids' }, bulbRows) : null,
        ]), '', el('a', { class: 'btn small secondary section-edit', href: '#/car/' + car.id + '/fluids', text: 'Edit', 'aria-label': 'Edit the fluids, bulbs and specifications' })),
        collapsible('Documents', DocumentsUI.card(car, page && page.documents), page && page.documents ? countText(page.documents.length, 'document', 'documents') : ''),
        collapsible('Costs', EntryUI.costsCard(car, page && page.costs)),
        collapsible('Guest access', GuestUI.card(car), car.guestEnabled ? 'On' : 'Off'),
        collapsible('QR label', el('section', { class: 'card' }, [
          el('h2', { text: 'QR label' }),
          el('p', { class: 'section-note', text: 'Stick this on the windscreen or glovebox. Scanning it opens this car: signed-in people go straight to it, and anyone else can open it as a guest or sign in (unless guest access is switched off in the Guest access section).' }),
          el('img', { class: 'qr', src: qrDataUrl(qrLink(car)), alt: 'QR code for ' + car.registration, width: '140', height: '140' }),
          el('p', {}, [el('a', { class: 'btn small secondary', href: '#/car/' + car.id + '/label', text: 'Print label' })]),
        ])),
        FleetAuth.isAdmin() ? collapsible('Recycle bin', EntryUI.binCard(car)) : null, // the last section, for admins only
        el('div', { class: 'export-row' }, [
          exportBtn,
          el('p', { class: 'section-note', text: 'Choose what to include. You get a PDF, plus a folder for each photo, file and document you include, named by its unique ID.' }),
        ]),
        car.createdByName ? el('p', { class: 'muted small-text center created-note', text: 'Created by ' + car.createdByName + (car.createdAt ? ' on ' + fmtDate(car.createdAt) : '') }) : null,
        el('p', { class: 'muted small-text center', text: 'Car details last changed ' + fmtDate(car.updatedAt) }),
      );
      fitOneLine(root, '.vin-line'); // the VIN is long: its text is made just small enough to stay on one line
    }
  };

  /** Shrink the text of each matching element until it fits on one line (never below 9px). Runs again if the window is resized. */
  Views.fitOneLine = fitOneLine;
  function fitOneLine(scope, selector) {
    function fit() {
      Array.prototype.forEach.call(scope.querySelectorAll(selector), function (node) {
        node.style.fontSize = '';
        var size = parseFloat(window.getComputedStyle(node).fontSize) || 16;
        while (node.scrollWidth > node.clientWidth + 0.5 && size > 9) {
          size -= 0.5;
          node.style.fontSize = size + 'px';
        }
      });
    }
    window.requestAnimationFrame(fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    var timer = null;
    var onResize = function () {
      if (!scope.querySelector(selector)) { window.removeEventListener('resize', onResize); return; } // the page was replaced
      clearTimeout(timer);
      timer = setTimeout(fit, 120);
    };
    window.addEventListener('resize', onResize);
  }

  // ---------- fluids editor (one part of the car form) ----------
  function fluidsEditor(initial) {
    var rows = initial.map(function (f) { return Object.assign({}, f); });
    var list = el('div', { class: 'stack' });
    var bulbList = el('div', { class: 'stack' });
    var datalist = el('datalist', { id: 'fluid-names' }, FLUID_TEMPLATE.map(function (n) { return el('option', { value: n }); }));
    var bulbDatalist = el('datalist', { id: 'bulb-names' }, BULB_TEMPLATE.map(function (n) { return el('option', { value: n }); }));

    function rowEl(row) {
      var bulb = isBulbRow(row);
      function inp(key, attrs) {
        var input = el('input', Object.assign({ type: 'text', value: row[key] || '', autocomplete: 'off' }, attrs || {}));
        input.addEventListener('input', function () { row[key] = input.value; });
        return input;
      }
      var nameIn = inp('fluid', { list: bulb ? 'bulb-names' : 'fluid-names', maxlength: '40' });
      var specIn = inp('specification', { maxlength: '300' });
      var capIn = inp('capacity', { maxlength: '150' });
      // The examples follow the name, so a differential oil never suggests an engine oil grade.
      function showHints() {
        var h = bulb ? BULB_HINT : fluidHint(nameIn.value);
        specIn.placeholder = h.spec;
        capIn.placeholder = h.cap;
        if (bulb) nameIn.placeholder = 'e.g. Dipped beam';
      }
      nameIn.addEventListener('input', showHints);
      showHints();
      var remove = el('button', { type: 'button', class: 'btn small danger', text: 'Remove' });
      remove.addEventListener('click', function () { rows.splice(rows.indexOf(row), 1); draw(); });
      // The name and the specification share a line, to save scrolling. A bulb row asks for where the bulb goes,
      // the bulb type and name, and how many, instead of a fluid, a specification and a capacity.
      return el('div', { class: 'fluid-edit ' + (bulb ? 'kind-bulb' : 'kind-fluid') }, [
        el('div', { class: 'field-pair' }, [
          UI.field(bulb ? 'Bulb location' : 'Fluid', nameIn),
          UI.field(bulb ? 'Bulb type and name' : 'Specification', specIn),
        ]),
        UI.field(bulb ? 'How many' : 'Capacity', capIn),
        UI.field('Notes', inp('notes', { maxlength: '200' })),
        remove,
      ]);
    }

    // The fluids and the bulbs are one list on the car, shown as two sections of the form.
    var aiNoteBox = el('div', {});
    function draw() {
      aiNoteBox.replaceChildren.apply(aiNoteBox, rows.some(isAiRow) ? [aiCheckNote()] : []);
      var fluidRows = rows.filter(function (r) { return !isBulbRow(r); });
      var bulbRows = rows.filter(isBulbRow);
      list.replaceChildren.apply(list, fluidRows.length
        ? fluidRows.map(rowEl)
        : [el('p', { class: 'muted', text: 'No fluids yet. Add one, or add the standard set.' })]);
      bulbList.replaceChildren.apply(bulbList, bulbRows.length
        ? bulbRows.map(rowEl)
        : [el('p', { class: 'muted', text: 'No bulbs yet. Add one, or add the standard set.' })]);
    }

    function addStandard(names, kind) {
      var have = rows.filter(function (r) { return (r.kind === 'bulb') === (kind === 'bulb'); }).map(function (r) { return (r.fluid || '').toLowerCase(); });
      names.forEach(function (n) {
        if (have.indexOf(n.toLowerCase()) === -1) rows.push({ kind: kind, fluid: n, specification: '', capacity: '', notes: '' });
      });
      draw();
    }
    var addBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add fluid' });
    addBtn.addEventListener('click', function () { rows.push({ kind: 'fluid', fluid: '', specification: '', capacity: '', notes: '' }); draw(); });
    var stdBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add standard fluids' });
    stdBtn.addEventListener('click', function () { addStandard(FLUID_TEMPLATE, 'fluid'); });
    var addBulbBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add bulb' });
    addBulbBtn.addEventListener('click', function () { rows.push({ kind: 'bulb', fluid: '', specification: '', capacity: '', notes: '' }); draw(); });
    var bulbBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add standard bulbs' });
    bulbBtn.addEventListener('click', function () { addStandard(BULB_TEMPLATE, 'bulb'); });

    // Rows suggested by AI: added only where the car has no row of that name yet. Returns how many were added.
    function addSuggested(suggested) {
      var added = 0;
      suggested.forEach(function (s) {
        var exists = rows.some(function (r) { return (r.kind === 'bulb') === (s.kind === 'bulb') && (r.fluid || '').toLowerCase() === (s.fluid || '').toLowerCase(); });
        if (exists) return;
        rows.push({ kind: s.kind === 'bulb' ? 'bulb' : 'fluid', fluid: s.fluid, specification: s.specification || '', capacity: s.capacity || '', notes: s.notes || '', source: s.source || '' });
        added++;
      });
      draw();
      return added;
    }

    function findRow(kind, name) {
      return rows.filter(function (r) { return (r.kind === 'bulb') === (kind === 'bulb') && (r.fluid || '').toLowerCase() === (name || '').toLowerCase(); })[0] || null;
    }

    // Suggestions the person ticked: a row of that name is updated, otherwise a new row is added. Nothing is saved until Save.
    function applySuggestions(list) {
      list.forEach(function (s) {
        var r = findRow(s.kind, s.fluid);
        if (!r) { r = { kind: s.kind === 'bulb' ? 'bulb' : 'fluid', fluid: s.fluid }; rows.push(r); }
        r.specification = s.specification || '';
        r.capacity = s.capacity || '';
        r.notes = s.notes || '';
        r.source = s.source || '';
      });
      draw();
      return list.length;
    }

    // Rows with nothing in them are ignored when saving.
    function payload() {
      return rows
        .filter(function (r) { return (r.fluid || '').trim() || (r.specification || '').trim() || (r.capacity || '').trim(); })
        .map(function (r) { return { id: r.id, kind: r.kind === 'bulb' ? 'bulb' : 'fluid', fluid: r.fluid || '', specification: r.specification || '', capacity: r.capacity || '', notes: r.notes || '', source: r.source || '' }; });
    }
    var snapshot = JSON.stringify(payload());
    draw();

    return {
      node: el('div', {}, [datalist, aiNoteBox, list, el('div', { class: 'btn-row' }, [addBtn, stdBtn])]),
      bulbsNode: el('div', {}, [bulbDatalist, bulbList, el('div', { class: 'btn-row' }, [addBulbBtn, bulbBtn])]),
      payload: payload,
      addSuggested: addSuggested,
      findRow: findRow,
      applySuggestions: applySuggestions,
      dirty: function () { return JSON.stringify(payload()) !== snapshot; },
      // After a save the server gives every row its id; keep them so a retry never duplicates a row.
      markSaved: function (saved) {
        rows = saved.map(function (f) { return Object.assign({}, f); });
        snapshot = JSON.stringify(payload());
        draw();
      },
    };
  }

  // ---------- owner/custodian editor (one part of the car form) ----------
  // Admins tick any approved user. Everyone else can only tick or untick themselves.
  // `tickMe`: a new car that is yours to start with (nothing is saved for it yet, so ticking counts as a change)
  function ownersEditor(people, users, tickMe) {
    var me = FleetAuth.getUser();
    if (users) {
      // admins: a searchable drop-down of every approved user; the chosen ones show as chips
      var wanted = people.owners.map(function (x) { return x.userId; });
      if (tickMe && wanted.indexOf(me.id) === -1) wanted.push(me.id);
      var picker = UI.searchMulti(users.map(function (u) { return { value: u.id, label: u.name + ' (' + u.email + ')' }; }), { values: wanted, placeholder: 'Add an owner or custodian…', ariaLabel: 'Add an owner or custodian', emptyText: 'No one chosen yet.' });
      var ids = function () { return picker.values().sort().join(','); };
      var snap = people.owners.map(function (x) { return x.userId; }).sort().join(',');
      return {
        node: picker,
        dirty: function () { return ids() !== snap; },
        save: function (carId) {
          var chosen = picker.values();
          return FleetApi.call('setCarPeople', {
            carId: carId, people: users.map(function (u) { return { userId: u.id, owner: chosen.indexOf(u.id) !== -1 }; }),
          }).then(function () { snap = ids(); });
        },
      };
    }
    var meBox = el('input', { type: 'checkbox' });
    var savedMe = people.owners.some(function (x) { return x.userId === me.id; });
    meBox.checked = savedMe || !!tickMe;
    var others = people.owners.filter(function (x) { return x.userId !== me.id; }).map(function (x) { return x.name; });
    return {
      node: el('div', {}, [
        el('label', { class: 'check' }, [meBox, el('span', { text: 'I am an owner/custodian of this car' })]),
        others.length ? el('p', { class: 'muted small-text', text: 'Also: ' + others.join(', ') }) : null,
      ]),
      dirty: function () { return meBox.checked !== savedMe; },
      save: function (carId) {
        return FleetApi.call('setMyCarRole', { carId: carId, owner: meBox.checked }).then(function () { savedMe = meBox.checked; });
      },
    };
  }

  // ---------- add / edit form: everything about a car in one place ----------
  Views.carForm = function (ctx, root) {
    var id = ctx.params.id || '';
    root.replaceChildren(el('section', { class: 'card' }, [loading()]));
    if (!id) { chooser(); return; }
    var calls = [FleetApi.call('getCar', { id: id })];
    if (FleetAuth.isAdmin()) calls.push(FleetApi.call('listUsers')); // admins can pick any user as an owner/custodian
    Promise.all(calls).then(function (res) {
      var users = res[1] ? res[1].data.users.filter(function (u) { return u.status === 'Approved'; }) : null;
      build(res[0].data.car, res[0].data.fluids, res[0].data.people || { owners: [] }, users);
    }).catch(function (e) {
      if (e.code === 'not_found') notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    // The people who can be ticked as owners: admins pick from every approved user; anyone else gets their own tick box
    function loadUsers() {
      if (!FleetAuth.isAdmin()) return Promise.resolve(null);
      return FleetApi.call('listUsers').then(function (r) { return r.data.users.filter(function (u) { return u.status === 'Approved'; }); }).catch(function () { return null; });
    }

    // Adding a car starts with a choice: read the log book with AI, or fill the form in yourself.
    function chooser() {
      var reading = false;
      var heading = el('h1', { text: 'Add a car' });
      var card = el('section', { class: 'card' });

      function draw(status, errorNote) {
        var left = status && status.available ? status.remaining : 0;
        var canAi = !!(status && status.available && left > 0);
        var kids = [heading, el('p', { class: 'muted', text: 'How would you like to add it?' })];
        if (errorNote) kids.push(errorNote);

        // option 1: the log book, with its own note (including how many AI lookups are left)
        var noteText = !status ? 'AI can get things wrong, so check every box before you save.'
          : !status.available ? 'AI is not set up yet, so this option is not available.'
          : left > 0 ? 'AI can get things wrong, so check every box and fill in anything missing before you save. ' + left + ' of ' + status.limit + ' AI lookups left today.'
          : 'No AI lookups left today. They come back tomorrow.';
        var pickBtn = canAi
          ? Photos.fileButton('Choose the log book (PDF)', 'application/pdf', false, readBook)
          : el('button', { type: 'button', class: 'btn small secondary', disabled: true, text: 'Choose the log book (PDF)' });
        kids.push(el('div', { class: 'choice' }, [
          el('h2', { text: '1. Upload the vehicle log book' }),
          el('p', { text: 'Upload a clear PDF of the log book. AI fills in the key and technical details and attaches the PDF. It may take up to a minute.' }),
          el('p', { class: 'section-note', text: noteText }),
          el('div', { class: 'btn-row' }, [pickBtn]),
        ]));

        // option 2: the form as it was
        var manual = el('button', { type: 'button', class: 'btn small secondary', text: 'Add it manually' });
        manual.addEventListener('click', function () { loadUsers().then(function (users) { build(null, [], { owners: [] }, users); }); });
        kids.push(el('div', { class: 'choice' }, [
          el('h2', { text: '2. Add it yourself' }),
          el('p', { text: 'Manually with some optional AI assistance available for retrieving technical details like fluid specs.' }),
          el('div', { class: 'btn-row' }, [manual]),
        ]));
        card.replaceChildren.apply(card, kids.filter(Boolean));
      }

      function load(errorNote) {
        return FleetApi.call('aiStatus', {}).then(function (r) { draw(r.data, errorNote); })
          .catch(function () { draw(null, errorNote); });
      }

      function readBook(file) {
        if (reading) return Promise.resolve();
        reading = true;
        card.replaceChildren(heading, UI.waiting('Reading the log book with AI… this can take up to a minute. Please keep this screen open.'));
        return Photos.prepareAttachment(file).then(function (att) {
          if (att.mime !== 'application/pdf') throw new FleetApi.ApiError('logbook_pdf_only', 'PDF only');
          return FleetApi.call('aiReadLogbook', { mime: att.mime, data: att.data }, { timeoutMs: 170000 }).then(function (r) { return { att: att, result: r.data }; });
        }).then(function (pre) {
          reading = false;
          return loadUsers().then(function (users) {
            build(null, [], { owners: [] }, users, pre);
            window.scrollTo(0, 0);
          });
        }).catch(function (e) {
          reading = false;
          return load(UI.notice('error', UI.errorText(e)));
        });
      }

      root.replaceChildren(card);
      card.replaceChildren(heading, loading());
      load();
    }

    // `prefill` (a car added from its log book): { att: the PDF, result: what AI read and looked up }
    function build(car, fluids, people, users, prefill) {
      var f = {};
      var msg = el('div');
      function text(name, value, attrs) {
        f[name] = el('input', Object.assign({ type: 'text', name: name, value: value === null || value === undefined ? '' : String(value), autocomplete: 'off' }, attrs || {}));
        return f[name];
      }
      function select(name, options, value) {
        f[name] = el('select', { name: name }, options.map(function (o) {
          return el('option', { value: o[0], text: o[1], selected: o[0] === value });
        }));
        return f[name];
      }

      var v = car || Object.assign({ country: 'UK', currency: 'GBP', status: 'Active' }, prefill ? prefill.result.details : {});

      // Optional purchase price with its own currency, which can differ from the car's running-cost currency.
      function acquisitionCostField() {
        var cost = text('acquisitionCost', v.acquisitionCost === null || v.acquisitionCost === undefined ? '' : v.acquisitionCost, { inputmode: 'decimal', id: 'f-cost' });
        var cur = select('acquisitionCurrency', CURRENCY_OPTIONS, v.acquisitionCurrency || v.currency);
        cur.setAttribute('aria-label', 'Currency of the acquisition cost');
        // Starts from the country's usual currency, and follows it until you pick one here yourself.
        var touched = !!(car && car.acquisitionCost !== null && car.acquisitionCost !== undefined);
        cur.addEventListener('change', function () { touched = true; });
        f.country.addEventListener('change', function () { if (!touched) cur.value = f.country.value === 'UG' ? 'UGX' : 'GBP'; });
        return el('div', { class: 'field' }, [
          el('label', { for: 'f-cost', text: 'Acquisition cost' }),
          el('div', { class: 'odo-row' }, [cost, cur]),
          el('div', { class: 'hint', text: 'Optional. What you paid.' }),
        ]);
      }

      // Odometer reading, always in miles.
      function odometerField() {
        var odo = text('odometer', v.odometer === null || v.odometer === undefined ? '' : v.odometer, { inputmode: 'numeric', id: 'f-odometer' });
        return el('div', { class: 'field' }, [
          el('label', { for: 'f-odometer', text: 'Odometer (miles)' }),
          odo,
          el('div', { class: 'hint', text: 'Whole number.' }),
        ]);
      }

      // Two short fields side by side, to save scrolling.
      function pair(a, b, cls) { return el('div', { class: 'field-pair' + (cls ? ' ' + cls : '') }, [a, b]); }
      // Vehicle details are three plain groups with simple headings (nothing collapses): key details, technical details, notes.
      // The fields in three groups. Key details: what identifies the car (and what AI needs to look it up). Technical details: the rest of its
      // technical details. Ownership & Other Details: where it is, its status and mileage, and how it was acquired.
      var keyFields = [
        pair(
          UI.field('Make *', text('make', v.make, { maxlength: '40', placeholder: 'e.g. Toyota', required: true })),
          UI.field('Model *', text('model', v.model, { maxlength: '40', placeholder: 'e.g. Land Cruiser', required: true }))
        ),
        pair(
          UI.field('Year *', text('year', v.year, { inputmode: 'numeric', maxlength: '4', placeholder: 'e.g. 2015', required: true })),
          UI.field('Colour', text('colour', v.colour, { maxlength: '30' }))
        ),
        pair(
          UI.field('Fuel type *', select('fuelType', [['', 'Not recorded'], ['Petrol', 'Petrol'], ['Diesel', 'Diesel'], ['Petrol hybrid', 'Petrol hybrid'], ['Diesel hybrid', 'Diesel hybrid'], ['Fully electric', 'Fully electric']], v.fuelType)),
          UI.field('Engine size (litres) *', text('engineSize', v.engineSize === null || v.engineSize === undefined ? '' : v.engineSize, { inputmode: 'decimal', maxlength: '4', placeholder: 'e.g. 2.5' }), 'Leave empty for an electric car.'),
          'aligned tall-labels' // equal columns and two-line labels, so the two boxes line up
        ),
        pair(
          UI.field('Transmission *', select('transmission', [['', 'Not recorded'], ['Manual', 'Manual'], ['Automatic', 'Automatic'], ['CVT', 'CVT']], v.transmission)),
          UI.field('Drive side', select('driveSide', [['', 'Not recorded'], ['LHD', 'Left-hand (LHD)'], ['RHD', 'Right-hand (RHD)']], v.driveSide))
        ),
        pair(
          UI.field('Registration *', shrinkToFit(text('registration', v.registration, { maxlength: '20', autocapitalize: 'characters', required: true }), 10)),
          UI.field('VIN / chassis', shrinkToFit(text('vin', v.vin, { maxlength: '30', autocapitalize: 'characters' }), 10), 'Please enter the VIN if you have it: it is the most reliable way for AI to fill in the rest.'),
          'wide-second' // a VIN is long, a registration is short
        ),
      ];
      var techFields = [
        pair(
          UI.field('Engine code', text('engineCode', v.engineCode, { maxlength: '30', autocapitalize: 'characters' }), 'Optional, e.g. 1GR-FE.'),
          UI.field('Gearbox code', text('gearboxCode', v.gearboxCode, { maxlength: '30', autocapitalize: 'characters' }), 'Optional, e.g. A750F. It can be checked against the vehicle\'s UK log book.')
        ),
        UI.field('Market', select('market', [['', 'Not recorded']].concat(MARKETS.map(function (m) { return [m, m]; })), v.market), 'Where it was built and sold for.'),
        UI.field('Fuel capacity (litres)', text('fuelCapacity', v.fuelCapacity === null || v.fuelCapacity === undefined ? '' : v.fuelCapacity, { inputmode: 'decimal', maxlength: '6', placeholder: 'e.g. 87' }), 'Optional. The size of the fuel tank.'),
      ];
      var ownershipFields = [
        pair(
          UI.field('Location', select('country', [['UK', 'UK'], ['UG', 'Uganda']], v.country), 'Where it is based. Sets the usual currency.'),
          UI.field('Date imported', text('importDate', v.importDate, { maxlength: '24', placeholder: 'e.g. Mar 2021' }), 'Optional. A date, month or year.')
        ),
        pair(
          UI.field('Status', select('status', [['Active', 'Active'], ['Off-road', 'Off-road'], ['Sold', 'Sold'], ['Scrapped', 'Scrapped']], v.status)),
          odometerField()
        ),
        pair(
          UI.field('Acquisition date', text('acquisitionDate', v.acquisitionDate, { maxlength: '24', placeholder: 'e.g. Mar 2021' }), 'Optional. A date, month or year.'),
          acquisitionCostField(),
          'aligned' // equal columns, both labels two lines tall, so the two boxes line up
        ),
      ];
      // The parts catalogue link lives at the top of the fluids and specifications part of the form.
      var MAX_CAT = 4;
      var catBox = el('div', { class: 'stack' });
      var catRowsEl = [];
      var addCat = el('button', { type: 'button', class: 'btn small secondary', text: 'Add another catalogue' });
      function catUrls() { return catRowsEl.map(function (r) { return r.input.value.trim(); }).filter(Boolean); }
      function drawCats() {
        catBox.replaceChildren.apply(catBox, catRowsEl.map(function (r) {
          var rm = catRowsEl.length > 1 ? el('button', { type: 'button', class: 'btn small secondary', text: 'Remove', 'aria-label': 'Remove this catalogue link' }) : null;
          if (rm) rm.addEventListener('click', function () { catRowsEl.splice(catRowsEl.indexOf(r), 1); drawCats(); });
          return el('div', { class: 'catalogue-edit' }, [r.input, rm]);
        }));
        addCat.hidden = catRowsEl.length >= MAX_CAT;
      }
      function addCatRow(value) {
        var input = el('input', { type: 'text', name: 'catalogue', value: value || '', inputmode: 'url', placeholder: 'https://…', autocomplete: 'off', 'aria-label': 'Parts catalogue link' });
        catRowsEl.push({ input: input });
      }
      ((v.catalogues && v.catalogues.length) ? v.catalogues.map(function (c) { return c.url; }) : (v.partsouqUrl ? [v.partsouqUrl] : [''])).forEach(addCatRow);
      addCat.addEventListener('click', function () { addCatRow(''); drawCats(); catRowsEl[catRowsEl.length - 1].input.focus(); });
      drawCats();
      var catalogueField = el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: 'Parts catalogue links' }),
        catBox,
        el('div', { class: 'btn-row' }, [addCat]),
        el('div', { class: 'hint', text: 'Optional. Up to 4 secure (https) links, e.g. partsouq.com' }),
      ]);
      var notes = el('textarea', { name: 'notes', rows: '4', maxlength: '2000' });
      notes.value = v.notes || '';
      f.notes = notes;
      notes.setAttribute('aria-label', 'Notes');
      var notesField = el('div', { class: 'field' }, [notes]); // the section heading says what it is: no label above the box

      var editLogbook = null; // a log book PDF read while editing: it is attached to the car's documents when the changes are saved

      // ---- "Use AI to fill in technical details": the first thing on the form, when adding a car and when editing one. It only fills empty boxes. ----
      function aiAssist() {
        var box = el('div', { class: 'ai-box' });
        var btn = el('button', { type: 'button', class: 'btn small secondary ai-btn', text: car ? '✨ Use AI to edit technical details' : '✨ Use AI to fill in technical details' });
        var HINT = 'AI can look the car up from its VIN, or from the details you give it. It fills the empty boxes, but it can be wrong: check what it adds.';
        var hint = el('div', { class: 'hint', text: HINT });
        var picker = el('div', { class: 'ai-matches' });
        var status = el('div', { class: 'ai-status' });
        box.append(btn, hint);
        var bookBtn = null;
        var bookHint = null;
        var reading = false;
        {
          // the log book can be read from here when adding a car by hand and when editing one (it fills the empty boxes and is kept with the car's documents)
          bookHint = el('div', { class: 'hint', text: 'AI reads a clear PDF of the log book, fills the empty boxes and keeps the PDF with this car\'s documents. It may take up to a minute.' });
          bookBtn = Photos.fileButton('📄 Read the log book (PDF)', 'application/pdf', false, readBook);
          box.append(el('div', { class: 'ai-or', text: 'or' }), bookBtn, bookHint);
        }
        box.append(status, picker);
        box.hidden = true; // shown only once we know AI is switched on

        function hasVin() { return f.vin.value.replace(/\s+/g, '').length >= 5; }
        var remainingText = '';
        function refresh() { hint.textContent = HINT + remainingText; }
        refresh();
        FleetApi.call('aiStatus', {}).then(function (r) {
          if (!r.data.available) return;
          box.hidden = false;
          remainingText = ' ' + r.data.remaining + ' of ' + r.data.limit + ' lookups left today.';
          refresh();
        }).catch(function () { /* no AI box: the form works without it */ });

        function setIfEmpty(input, value, label, filled) {
          if (!value || String(input.value).trim() !== '') return;
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push(label);
        }

        function apply(d) {
          var filled = [];
          var det = d.details || {};
          setIfEmpty(f.make, det.make, 'make', filled);
          setIfEmpty(f.model, det.model, 'model', filled);
          setIfEmpty(f.year, det.year, 'year', filled);
          setIfEmpty(f.colour, det.colour, 'colour', filled);
          setIfEmpty(f.engineCode, det.engineCode, 'engine code', filled);
          setIfEmpty(f.transmission, det.transmission, 'transmission', filled);
          setIfEmpty(f.fuelType, det.fuelType, 'fuel type', filled);
          setIfEmpty(f.gearboxCode, det.gearboxCode, 'gearbox code', filled);
          setIfEmpty(f.market, det.market, 'market', filled);
          setIfEmpty(f.driveSide, det.driveSide, 'drive side', filled);
          setIfEmpty(f.engineSize, det.engineSize, 'engine size', filled);
          setIfEmpty(f.fuelCapacity, det.fuelCapacity, 'fuel capacity', filled);
          var nFluids = fluidsEd.addSuggested(d.fluids || []);
          var nBulbs = fluidsEd.addSuggested(d.bulbs || []);
          var parts = [];
          if (filled.length) parts.push('the ' + filled.join(', '));
          if (nFluids) parts.push(nFluids + ' fluid' + (nFluids === 1 ? '' : 's'));
          if (nBulbs) parts.push(nBulbs + ' bulb' + (nBulbs === 1 ? '' : 's'));
          var kids = [];
          kids.push(UI.notice(parts.length ? 'ok' : 'error', parts.length
            ? 'AI filled in ' + parts.join(' and ') + ' (' + d.confidence + ' confidence). ' + (d.summary || '')
            : 'AI had nothing new to add. ' + (d.summary || '')));
          kids.push(el('p', { class: 'section-note', text: AI_CHECK_NOTE }));
          if (d.method) kids.push(el('div', { class: 'small-text muted ai-method', text: methodText(d.method) }));
          if (d.sources && d.sources.length) {
            kids.push(el('div', { class: 'small-text muted' }, [el('span', { text: 'Sources: ' })].concat(d.sources.map(function (s, i) {
              return el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: (i ? ', ' : '') + (s.title || 'link') });
            }))));
          }
          status.replaceChildren.apply(status, kids);
          remainingText = ' ' + d.remaining + ' AI lookups left today.';
          refresh();
        }

        /** Everything typed so far goes to the AI (never the owner, the notes or any costs). */
        function typed() {
          return {
            registration: f.registration.value, vin: f.vin.value, country: f.country.value, make: f.make.value, model: f.model.value, year: f.year.value,
            colour: f.colour.value, engineCode: f.engineCode.value, gearboxCode: f.gearboxCode.value, transmission: f.transmission.value, fuelType: f.fuelType.value, market: f.market.value, driveSide: f.driveSide.value, fuelCapacity: f.fuelCapacity.value, engineSize: f.engineSize.value,
          };
        }

        function fillFrom(extra) {
          status.replaceChildren(UI.waiting('Asking AI to look the car up… this can take up to a minute. Please wait.'));
          picker.replaceChildren();
          btn.disabled = true;
          return FleetApi.call('aiFillCar', Object.assign(typed(), extra || {}), { timeoutMs: 120000 }).then(function (r) { apply(r.data); })
            .catch(function (e) { status.replaceChildren(UI.notice('error', UI.errorText(e))); })
            .then(refresh);
        }

        // No VIN: AI first suggests a few versions this could be; the person picks one, and then the specs are filled in for it.
        function findFirst() {
          status.replaceChildren(UI.waiting('Asking AI which cars this could be… this can take up to a minute. Please wait.'));
          picker.replaceChildren();
          btn.disabled = true;
          FleetApi.call('aiFindCar', typed(), { timeoutMs: 120000 }).then(function (r) {
            remainingText = ' ' + r.data.remaining + ' AI lookups left today.';
            refresh();
            if (!r.data.candidates.length) {
              status.replaceChildren(UI.notice('error', 'AI could not tell which car this is from what you entered. Add the year, engine or market, or a VIN, and try again.'));
              return;
            }
            status.replaceChildren(el('p', { class: 'muted small-text', text: 'Which of these is your car? AI is only guessing from the make, model and year, so check it carefully. Tap one and the specs are filled in for it. Look at the engine and the market, they change the oil and bulbs.' }));
            var cards = r.data.candidates.map(function (c) {
              var pick = el('button', { type: 'button', class: 'btn small', text: 'This one' });
              pick.addEventListener('click', function () {
                var d = c.details || {};
                var chosen = Object.assign(typed(), { vin: '' });
                ['make', 'model', 'year', 'engineCode', 'gearboxCode', 'transmission', 'fuelType', 'engineSize', 'market', 'driveSide', 'fuelCapacity', 'colour'].forEach(function (k) { if (d[k]) chosen[k] = d[k]; });
                fillFrom(chosen);
              });
              return el('div', { class: 'ai-match' }, [
                el('div', {}, [el('strong', { text: c.label }), el('span', { class: 'muted small-text', text: '  (' + c.confidence + ' confidence)' })]),
                c.why ? el('div', { class: 'muted small-text', text: c.why }) : null,
                pick,
              ]);
            });
            var none = el('button', { type: 'button', class: 'linklike', text: 'None of these' });
            none.addEventListener('click', function () { picker.replaceChildren(); status.replaceChildren(); });
            picker.replaceChildren.apply(picker, cards.concat([none]));
          }).catch(function (e) { status.replaceChildren(UI.notice('error', UI.errorText(e))); })
            .then(refresh);
        }

        function readBook(file) {
          if (reading) return Promise.resolve();
          reading = true;
          btn.disabled = true;
          bookBtn.classList.add('disabled');
          picker.replaceChildren();
          status.replaceChildren(UI.waiting('Reading the log book with AI… this can take up to a minute. Please keep this screen open.'));
          return Photos.prepareAttachment(file).then(function (att) {
            if (att.mime !== 'application/pdf') throw new FleetApi.ApiError('logbook_pdf_only', 'PDF only');
            return FleetApi.call('aiReadLogbook', { mime: att.mime, data: att.data }, { timeoutMs: 170000 }).then(function (r) { return { att: att, result: r.data }; });
          }).then(function (got) {
            editLogbook = got.att;
            setIfEmpty(f.vin, (got.result.details || {}).vin, 'VIN', []);
            apply(got.result);
            status.append(el('div', { class: 'section-note', text: 'The log book PDF will be saved in this car\'s documents when you ' + (car ? 'save your changes' : 'add the car') + '. Check every box AI filled in first.' }));
          }).catch(function (e) { status.replaceChildren(UI.notice('error', UI.errorText(e))); })
            .then(function () { reading = false; bookBtn.classList.remove('disabled'); refresh(); });
        }

        // ---- the dialog: what details do you have? A VIN, or the details AI needs when there is no VIN ----
        // The boxes in the dialog are the form's own boxes, shown a second time: typing in one fills the other.
        var NEEDED = [
          ['make', 'Make', 'text'], ['model', 'Model', 'text'], ['year', 'Year', 'text'], ['fuelType', 'Fuel type', 'select'],
          ['engineSize', 'Engine size (litres)', 'text'], ['transmission', 'Transmission', 'select'], ['driveSide', 'Drive side', 'select'],
        ];
        function neededNow(k) { return !(k === 'engineSize' && f.fuelType.value === 'Fully electric'); } // an electric car has no engine size

        function openAskDialog() {
          var previous = document.activeElement;
          var mode = 'vin';
          var vinIn = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', maxlength: '30', placeholder: 'e.g. KNAKU814SE5455201', 'aria-label': 'VIN number', value: f.vin.value });
          var ask = el('button', { type: 'button', class: 'btn', text: 'Ask AI' });
          var cancel = el('button', { type: 'button', class: 'btn secondary', text: 'Cancel' });
          var summary = el('p', { class: 'note' });
          var help = el('div', { class: 'ask-help', role: 'status' });

          var rows = NEEDED.map(function (n) {
            var real = f[n[0]];
            var input = real.tagName === 'SELECT'
              ? el('select', { 'aria-label': n[1] }, [].map.call(real.options, function (o) { return el('option', { value: o.value, text: o.value === '' ? 'Choose…' : o.text }); }))
              : el('input', { type: 'text', autocomplete: 'off', inputmode: real.getAttribute('inputmode') || 'text', maxlength: real.getAttribute('maxlength') || '40', 'aria-label': n[1], placeholder: real.getAttribute('placeholder') || '' });
            input.value = real.value;
            var tick = el('span', { class: 'tick', 'aria-hidden': 'true' });
            var label = el('label', { text: n[1] + ' *' });
            input.addEventListener('input', function () { real.value = input.value; real.dispatchEvent(new Event('input', { bubbles: true })); update(); });
            input.addEventListener('change', function () { real.value = input.value; real.dispatchEvent(new Event('change', { bubbles: true })); update(); });
            var li = el('li', {}, [label, el('div', { class: 'ask-cell' }, [input, tick])]);
            return { key: n[0], name: n[1].replace(/ \(litres\)/, '').toLowerCase(), input: input, tick: tick, li: li };
          });
          var list = el('ul', { class: 'ask-list' }, rows.map(function (r) { return r.li; }));

          var optVin = el('div', { class: 'ask-opt' }, [
            el('label', { class: 'ask-opt-head' }, [el('input', { type: 'radio', name: 'askmode', value: 'vin' }), el('span', {}, [el('span', { class: 'ask-name', text: 'VIN number' }), el('span', { class: 'ask-rec', text: 'Recommended' }), el('span', { class: 'ask-note', text: 'It identifies this exact car, so it is the most reliable.' })])]),
            el('div', { class: 'ask-body' }, [vinIn]),
          ]);
          var optDet = el('div', { class: 'ask-opt' }, [
            el('label', { class: 'ask-opt-head' }, [el('input', { type: 'radio', name: 'askmode', value: 'details' }), el('span', {}, [el('span', { class: 'ask-name', text: 'No VIN: give me the details' }), summary])]),
            el('div', { class: 'ask-body' }, [list, help]),
          ]);
          // it opens on the VIN, unless there is none and the other details are all in already
          if (!hasVin() && rows.every(function (r) { return !neededNow(r.key) || String(r.input.value).trim() !== ''; })) mode = 'details';
          var radios = [].slice.call(optVin.querySelectorAll('input[type=radio]')).concat([].slice.call(optDet.querySelectorAll('input[type=radio]')));
          radios.forEach(function (r) { r.checked = r.value === mode; r.addEventListener('change', function () { if (r.checked) { mode = r.value; update(); } }); });

          function missingNow() { return rows.filter(function (r) { return neededNow(r.key) && String(r.input.value).trim() === ''; }); }
          function update() {
            optVin.classList.toggle('on', mode === 'vin');
            optDet.classList.toggle('on', mode === 'details');
            optVin.querySelector('.ask-body').hidden = mode !== 'vin';
            optDet.querySelector('.ask-body').hidden = mode !== 'details';
            var miss = missingNow();
            rows.forEach(function (r) {
              var applies = neededNow(r.key);
              r.li.hidden = !applies;
              var empty = String(r.input.value).trim() === '';
              r.input.classList.toggle('miss', applies && empty);
              r.tick.textContent = applies && !empty ? '✓' : '';
            });
            summary.textContent = miss.length ? 'You\'ll need to provide all of these * details.' : 'You\'ve provided all the details.';
            help.textContent = miss.length ? miss.length + ' more needed: ' + miss.map(function (r) { return r.name; }).join(', ') + '.' : '';
            ask.disabled = mode === 'vin' ? vinIn.value.replace(/\s+/g, '').length < 5 : miss.length > 0;
          }
          vinIn.addEventListener('input', function () { f.vin.value = vinIn.value; f.vin.dispatchEvent(new Event('input', { bubbles: true })); update(); });

          var overlay = el('div', { class: 'dialog-overlay' }, [el('div', { class: 'dialog ask-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': car ? 'Use AI to edit technical details' : 'Use AI to fill in technical details' }, [
            el('h2', { text: car ? 'Use AI to edit technical details' : 'Use AI to fill in technical details' }),
            el('p', { class: 'ask-sub', text: 'What details do you have?' }),
            optVin, optDet,
            el('p', { class: 'ask-fine', text: (remainingText ? remainingText.trim() + ' ' : '') + 'AI can get things wrong: its answers are suggestions, so check every box it fills in. What you give here (registration, VIN, make, model, year and similar) is sent to Google\'s Gemini AI service, which may search the web and may use it to improve its products. No owner details, notes or costs are sent. It can take up to a minute.' }),
            el('div', { class: 'dialog-actions' }, [cancel, ask]),
          ])]);
          function close() {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            if (previous && previous.focus) { try { previous.focus(); } catch (e) { /* ignore */ } }
          }
          function onKey(ev) { if (ev.key === 'Escape') { ev.preventDefault(); close(); } }
          cancel.addEventListener('click', close);
          overlay.addEventListener('click', function (ev) { if (ev.target === overlay) close(); });
          ask.addEventListener('click', function () {
            if (ask.disabled) return;
            var chosen = mode;
            close();
            if (chosen === 'vin') fillFrom(); else findFirst(); // with the VIN: one lookup; without: AI first suggests which version this is
          });
          document.addEventListener('keydown', onKey, true);
          document.body.append(overlay);
          update();
          (mode === 'vin' ? vinIn : (missingNow()[0] || rows[0]).input).focus();
        }

        btn.addEventListener('click', openAskDialog);
        return box;
      }
      // The AI workflow is the first thing on the form, when adding a car and when editing one (not needed when the log book already filled the technical details in)
      var aiBox = (prefill && prefill.result.technical) ? null : aiAssist();

      // Owner/custodian: people who use this app are ticked; anyone else is written in.
      var ownerFields = [
        UI.field('Other owner/custodian', text('ownerOther', v.ownerOther, { maxlength: '80' }), 'Optional. If the owner/custodian is not a user of this app, e.g. a company or a relative.'),
      ];
      // the same list when adding and when editing; a new car starts with you ticked if you came from "Add a new car"
      var ownersEd = ownersEditor(people, users, !car && ctx.query.mine === '1');
      ownerFields.push(el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Owners/Custodians using this app' }), ownersEd.node]));

      var fluidsEd = fluidsEditor(fluids);
      if (prefill) fluidsEd.addSuggested((prefill.result.fluids || []).concat(prefill.result.bulbs || []));

      // What was read from the log book, and what to do about it
      var prefillNote = null;
      if (prefill) {
        var rs = prefill.result;
        prefillNote = el('div', { class: 'section-note' }, [
          el('strong', { text: 'Filled in from the log book by AI.' }),
          el('p', { text: 'Please check every box against the log book before you save, fill in any key details it could not find (such as the odometer reading and acquisition details), and check the technical details too. You can then save, edit or add to it.' }),
          el('p', { text: rs.technical ? 'The technical details and fluid specifications were looked up using what the log book says.' : 'The technical details could not be looked up this time. Fill them in yourself, or use the AI button in the technical details.' }),
          rs.method ? el('p', { text: methodText(rs.method) }) : null,
          el('p', { text: 'The log book PDF is attached to this vehicle\'s documents when you save. You have ' + rs.remaining + ' AI lookups left today.' }),
        ]);
      }

      // Photos: up to 15. Add some, remove some, choose which is the main one (shown first, and on the fleet list).
      // Nothing is sent until you tap Save, like the other parts.
      var MAX_PHOTOS = 15;
      var tileCount = 0;
      var tiles = ((car && car.photos) || []).map(function (ph) { return { key: 'e' + ph.id, id: ph.id, removed: false }; });
      var coverKey = tiles.length ? tiles[0].key : '';
      var gridBox = el('div', { class: 'photo-grid' });
      var photoNote = el('div', { class: 'muted small-text', role: 'status' });
      var photoPicker = Photos.picker(function (file) {
        if (tiles.filter(function (t) { return !t.removed; }).length >= MAX_PHOTOS) { photoNote.textContent = 'A car can have up to ' + MAX_PHOTOS + ' photos. Remove one to add another.'; return; }
        var t = { key: 's' + (++tileCount), file: file, url: URL.createObjectURL(file), removed: false };
        tiles.push(t);
        if (!coverKey) coverKey = t.key; // the first photo of a car is its main photo
        drawPhotos();
      });
      function liveTiles() { return tiles.filter(function (t) { return !t.removed; }); }
      function fixCover() { // the main photo was removed: the first one left takes over
        var live = liveTiles();
        if (!live.some(function (t) { return t.key === coverKey; })) coverKey = live.length ? live[0].key : '';
      }
      function tileEl(t) {
        var thumb = el('div', { class: 'photo-tile-img' });
        if (t.url) thumb.append(el('img', { src: t.url, alt: 'New photo' }));
        else {
          thumb.append(el('span', { class: 'photo-tile-wait', text: '🚗' }));
          Photos.getById(car, { id: t.id }, 'thumb').then(function (src) { thumb.replaceChildren(el('img', { src: src, alt: 'Photo' })); }).catch(function () {});
        }
        var actions = [];
        if (t.removed) {
          var undo = el('button', { type: 'button', class: 'btn small secondary', text: 'Undo' });
          undo.addEventListener('click', function () { t.removed = false; if (!coverKey) coverKey = t.key; drawPhotos(); });
          actions.push(undo);
        } else {
          if (t.key !== coverKey) {
            var main = el('button', { type: 'button', class: 'btn small secondary', text: 'Make main' });
            main.addEventListener('click', function () { coverKey = t.key; drawPhotos(); });
            actions.push(main);
          }
          var rm = el('button', { type: 'button', class: 'btn small secondary danger-text', text: 'Remove' });
          rm.addEventListener('click', function () {
            if (t.id) t.removed = true; // a saved photo is removed when you tap Save (Undo until then)
            else { try { URL.revokeObjectURL(t.url); } catch (e) { /* ignore */ } tiles.splice(tiles.indexOf(t), 1); } // one just picked simply goes
            fixCover();
            drawPhotos();
          });
          actions.push(rm);
        }
        return el('div', { class: 'photo-tile' + (t.removed ? ' removed' : '') }, [
          thumb,
          t.key === coverKey && !t.removed ? el('span', { class: 'photo-tile-main', text: 'Main' }) : null,
          t.removed ? el('div', { class: 'muted small-text', text: 'Removed when you save' }) : (!t.id ? el('div', { class: 'muted small-text', text: 'New, saved with the car' }) : null),
          el('div', { class: 'photo-tile-actions' }, actions),
        ]);
      }
      function drawPhotos() {
        var n = liveTiles().length;
        gridBox.replaceChildren.apply(gridBox, tiles.length ? tiles.map(tileEl) : [el('p', { class: 'muted', text: 'No photos yet.' })]);
        photoNote.textContent = n + ' of ' + MAX_PHOTOS + ' photos' + (n > 1 ? '. The main photo is shown first; swipe to see the others on the car\'s page.' : '.');
        photoPicker.setBusy(n >= MAX_PHOTOS);
      }
      drawPhotos();
      var photoFields = [
        gridBox,
        el('div', { class: 'btn-row' }, [photoPicker.take, photoPicker.choose]),
        photoNote,
        el('div', { class: 'hint', text: 'Take a photo with your camera, or choose one from your gallery. Up to ' + MAX_PHOTOS + ' photos per car.' }),
      ];

      /** Send the photo changes: removals, then new photos, then the choice of main photo. Remembers what is done, so a retry never repeats a step. */
      function savePhotos() {
        var ps = state.photoProgress || (state.photoProgress = { removed: {}, added: {}, cover: false });
        var removals = tiles.filter(function (t) { return t.id && t.removed && !ps.removed[t.key]; });
        var live = liveTiles();
        var kept = live.filter(function (t) { return t.id; });
        var adds = live.filter(function (t) { return !t.id && !ps.added[t.key]; });
        // with no photo left from before, the one chosen as main goes up first, so it becomes the main photo
        if (!kept.length) adds.sort(function (x, y) { return (y.key === coverKey ? 1 : 0) - (x.key === coverKey ? 1 : 0); });
        var chain = Promise.resolve();
        removals.forEach(function (t) {
          chain = chain.then(function () {
            return FleetApi.call('removeCarPhoto', { carId: state.carId, photoId: t.id }).then(function () { ps.removed[t.key] = true; }, function (e) {
              if (e.code === 'no_photo') ps.removed[t.key] = true; else throw e;
            });
          });
        });
        adds.forEach(function (t) {
          chain = chain.then(function () { return Photos.upload(state.carId, t.file).then(function (r) { ps.added[t.key] = r.data.photo.id; }); });
        });
        return chain.then(function () {
          var chosen = live.filter(function (t) { return t.key === coverKey; })[0];
          var serverFirst = kept[0] || live.filter(function (t) { return !t.id; }).sort(function (x, y) { return (y.key === coverKey ? 1 : 0) - (x.key === coverKey ? 1 : 0); })[0];
          if (!chosen || ps.cover || chosen === serverFirst) return;
          var id = chosen.id || ps.added[chosen.key];
          if (!id) return;
          return FleetApi.call('setCoverPhoto', { carId: state.carId, photoId: id }).then(function () { ps.cover = true; });
        });
      }
      function photosChanged() {
        return tiles.some(function (t) { return !t.id || t.removed; }) || (car && tiles.length > 0 && coverKey !== tiles[0].key);
      }

      // Every part of the form opens and closes, and starts closed. (A new car starts with Details open, because
      // that is where the required fields are.)
      function section(title, children, open, kind) {
        var d = el('details', { class: 'form-section collapsible' + (kind ? ' ' + kind : '') }, [
          el('summary', {}, [el('h2', { text: title })]),
          el('div', { class: 'collapse-body' }, children),
        ]);
        d.open = !!open;
        return d;
      }
      function groupHeading(text) { return el('h2', { class: 'form-heading', text: text }); }
      var detailsSection = el('div', { class: 'form-groups' }, [
        groupHeading('Key details'), el('div', { class: 'stack' }, keyFields),
        groupHeading('Technical details'), el('div', { class: 'stack' }, techFields),
        groupHeading('Ownership & Other Details'), el('div', { class: 'stack' }, ownershipFields),
        groupHeading('Notes'), notesField,
      ]);
      var ownersSection = section('Owner/Custodian', ownerFields, true); // open to start with, like Photos
      // ---- "Refresh specs with AI" (a saved car): shows what AI would change and lets the person tick what to use ----
      function refreshSpecsBox() {
        var box = el('div', { class: 'ai-box' });
        var btn = el('button', { type: 'button', class: 'btn small secondary ai-btn', text: '✨ Refresh specs with AI' });
        var hint = el('div', { class: 'hint', text: 'AI looks the car up (by its VIN if it has one, otherwise by its details) and suggests its fluids and bulbs. You tick which suggestions to use, and nothing changes until you tap Save changes.' });
        var status = el('div', { class: 'ai-status' });
        var panel = el('div', { class: 'ai-review' });
        box.append(btn, hint, status, panel);
        box.hidden = true;
        // The same rule as "Use AI to edit technical details", applied to the car as it is saved (which is what this looks up):
        // a VIN, or all of these (an electric car has no engine size)
        var lacking = String(car.vin || '').replace(/\s+/g, '').length >= 5 ? [] : [['make', 'make'], ['model', 'model'], ['year', 'year'], ['fuelType', 'fuel type'], ['engineSize', 'engine size'], ['transmission', 'transmission'], ['driveSide', 'drive side']]
          .filter(function (n) { return !(n[0] === 'engineSize' && car.fuelType === 'Fully electric') && (car[n[0]] === null || car[n[0]] === undefined || String(car[n[0]]).trim() === ''); })
          .map(function (n) { return n[1]; });
        if (lacking.length) {
          btn.disabled = true;
          hint.textContent = 'To use this without a VIN, first add the ' + (lacking.length > 1 ? lacking.slice(0, -1).join(', ') + ' and ' + lacking[lacking.length - 1] : lacking[0]) + ', then tap Save changes.';
        }
        FleetApi.call('aiStatus', {}).then(function (r) {
          if (!r.data.available) return;
          box.hidden = false;
          if (!lacking.length) hint.textContent += ' ' + r.data.remaining + ' of ' + r.data.limit + ' lookups left today.';
        }).catch(function () { /* no AI box */ });

        var isAi = isAiRow;
        var shown = function (x) { return [x.specification, x.capacity].filter(Boolean).join(' · ') || 'nothing'; };

        function review(d) {
          var items = (d.fluids || []).concat(d.bulbs || []);
          var checks = [];
          var rowsEl = items.map(function (s) {
            var now = fluidsEd.findRow(s.kind, s.fluid);
            var has = !!(now && ((now.specification || '').trim() || (now.capacity || '').trim()));
            var same = has && (now.specification || '').trim() === (s.specification || '').trim() && (now.capacity || '').trim() === (s.capacity || '').trim();
            var tick = null;
            if (!same) {
              tick = el('input', { type: 'checkbox' });
              // new rows, empty rows and earlier AI suggestions are ticked; anything you entered yourself is left unticked
              tick.checked = !has || isAi(now);
              checks.push({ tick: tick, item: s });
            }
            return el('div', { class: 'ai-change ' + (s.kind === 'bulb' ? 'kind-bulb' : 'kind-fluid') }, [
              el('label', { class: 'check' }, [tick, el('span', { class: 'ai-change-name', text: (s.kind === 'bulb' ? '💡 ' : '💧 ') + s.fluid })]),
              el('div', { class: 'small-text' }, [el('span', { class: 'muted', text: 'Now: ' }), el('span', { text: has ? shown(now) : 'nothing yet' })]),
              el('div', { class: 'small-text' }, [el('span', { class: 'muted', text: 'AI: ' }), el('span', { text: same ? 'the same' : shown(s) })]),
              !same && s.notes ? el('div', { class: 'muted small-text', text: s.notes }) : null,
              has && !isAi(now) && !same ? el('div', { class: 'muted small-text', text: 'You entered this yourself, so it is not ticked.' }) : null,
            ]);
          });
          var apply = el('button', { type: 'button', class: 'btn small', text: 'Use the ticked ones' });
          var cancel = el('button', { type: 'button', class: 'btn small secondary', text: 'Cancel' });
          apply.addEventListener('click', function () {
            var chosen = checks.filter(function (c) { return c.tick.checked; }).map(function (c) { return c.item; });
            var n = fluidsEd.applySuggestions(chosen);
            panel.replaceChildren();
            status.replaceChildren(UI.notice(n ? 'ok' : 'error', n ? n + ' suggestion' + (n === 1 ? '' : 's') + ' put into the form. They are saved when you tap Save changes. AI answers are not perfect: check each one.' : 'Nothing was ticked, so nothing changed.'));
          });
          cancel.addEventListener('click', function () { panel.replaceChildren(); status.replaceChildren(); });
          panel.replaceChildren.apply(panel, [
            el('p', { class: 'small-text' }, [el('strong', { text: 'AI suggests these' }), el('span', { class: 'muted', text: ' (' + d.confidence + ' confidence). ' + (d.summary || '') })]),
            d.method ? el('p', { class: 'small-text muted ai-method', text: methodText(d.method) }) : null,
            checks.length ? null : el('p', { class: 'muted', text: 'Nothing differs from what you already have.' }),
          ].concat(rowsEl, [
            d.sources && d.sources.length ? el('div', { class: 'small-text muted' }, [el('span', { text: 'Sources: ' })].concat(d.sources.map(function (s, i) {
              return el('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: (i ? ', ' : '') + (s.title || 'link') });
            }))) : null,
            el('div', { class: 'btn-row' }, checks.length ? [apply, cancel] : [cancel]),
          ]));
        }

        btn.addEventListener('click', function () {
          UI.confirm('AI can get things wrong. Its answers are suggestions, not facts, and you choose which to use.\n\nTo look the car up, its registration, VIN, make, model, year and similar details are sent to Google\'s Gemini AI service, which may search the web. Google may use what is sent to improve its products. It can take up to a minute.', { okLabel: 'Ask AI' }).then(function (yes) {
            if (!yes) return;
            panel.replaceChildren();
            status.replaceChildren(UI.waiting('Asking AI to look the car up… this can take up to a minute. Please wait.'));
            btn.disabled = true;
            FleetApi.call('aiRefreshSpecs', { carId: car.id }, { timeoutMs: 120000 }).then(function (r) {
              status.replaceChildren();
              hint.textContent = r.data.remaining + ' AI lookups left today.';
              review(r.data);
            }).catch(function (e) { status.replaceChildren(UI.notice('error', UI.errorText(e))); })
              .then(function () { btn.disabled = false; });
          });
        });
        return box;
      }

      var fluidsSection = section('💧 Fluids & Specifications', car ? [catalogueField, refreshSpecsBox(), fluidsEd.node] : [catalogueField, fluidsEd.node], false, 'kind-fluid');
      var bulbsSection = section('💡 Bulbs', [fluidsEd.bulbsNode], false, 'kind-bulb');
      var photoSection = section('Photos', photoFields, true);
      var btn = el('button', { type: 'submit', class: 'btn block big save-gap', text: car ? 'Save changes' : 'Add car' });
      // A new car ends with its Add button. A saved car ends with one section holding both Save and Delete (below), so Save is never
      // mistaken for part of the Photos section; its button belongs to this form through the form attribute.
      var form = el('form', { novalidate: true, id: 'car-form' }, [
        aiBox,
        prefillNote,
        detailsSection,
        ownersSection,
        photoSection,
        fluidsSection,
        bulbsSection,
      ].concat(car ? [] : [btn]));
      if (car) btn.setAttribute('form', 'car-form');

      function collect() {
        return {
          registration: f.registration.value, make: f.make.value, model: f.model.value, year: f.year.value, colour: f.colour.value,
          vin: f.vin.value, engineCode: f.engineCode.value, gearboxCode: f.gearboxCode.value, transmission: f.transmission.value, fuelType: f.fuelType.value, country: f.country.value,
          market: f.market.value, driveSide: f.driveSide.value, fuelCapacity: f.fuelCapacity.value, engineSize: f.engineSize.value, importDate: f.importDate.value,
          status: f.status.value, odometer: f.odometer.value,
          acquisitionCost: f.acquisitionCost.value, acquisitionCurrency: f.acquisitionCurrency.value, acquisitionDate: f.acquisitionDate.value,
          catalogues: catUrls(), notes: f.notes.value,
          ownerOther: f.ownerOther.value,
        };
      }

      // What has been saved so far. If a later step fails, a retry only repeats the steps that did not finish.
      var state = { carId: car ? car.id : '', version: car ? car.version : 0, snapshot: car ? JSON.stringify(collect()) : '', markedMine: false, photoDone: false, logbookDone: false };
      function carDirty() { return !state.carId || JSON.stringify(collect()) !== state.snapshot; }

      function saveCarStep(extra) {
        if (!carDirty()) return Promise.resolve('skipped');
        var payload = Object.assign({ fields: collect() }, state.carId ? { id: state.carId, version: state.version } : {}, extra || {});
        return FleetApi.call('saveCar', payload).then(function (r) {
          var d = r.data;
          if (!d.saved) {
            var lines = d.warnings.map(function (w) { return (w.type === 'vin' ? 'Same VIN as ' : 'Same registration as ') + w.label; }).join('\n');
            return UI.confirm('Possible duplicate:\n' + lines + '\n\nSave anyway?', { okLabel: 'Save anyway' }).then(function (yes) {
              return yes ? saveCarStep(Object.assign({}, extra, { force: true })) : 'cancelled';
            });
          }
          state.carId = d.car.id;
          state.version = d.car.version;
          state.snapshot = JSON.stringify(collect());
          carsCache = null;
          return 'saved';
        }).catch(function (e) {
          if (e.code === 'odometer_lower' && !e.asked && FleetAuth.isAdmin()) {
            e.asked = true;
            return UI.confirm('That odometer reading is lower than the current one. Correct it anyway?', { okLabel: 'Correct it' }).then(function (yes) {
              if (yes) return saveCarStep(Object.assign({}, extra, { forceOdometer: true }));
              throw e;
            });
          }
          throw e;
        });
      }

      // When a catalogue link is saved (new or changed), the server fetches the website's icon. It is best effort and never holds up
      // the save for long: after a few seconds the car page is shown and fetches it again if it is still missing.
      function catalogueIconStep() {
        var urls = catUrls();
        var have = {};
        ((car && car.catalogues) || []).forEach(function (c) { if (c.icon) have[c.url] = true; });
        var key = urls.join(' ');
        if (!state.carId || !urls.length || state.iconFor === key || urls.every(function (u) { return have[u]; })) return Promise.resolve();
        state.iconFor = key;
        try { sessionStorage.setItem('fm-icon-tried-' + state.carId, '1'); } catch (e) { /* ignore */ }
        return Promise.race([
          FleetApi.call('refreshCatalogueIcon', { carId: state.carId }, { timeoutMs: 60000 }).then(function () {}, function () {}),
          new Promise(function (resolve) { setTimeout(resolve, 7000); }),
        ]);
      }

      function run() {
        var done = [];
        var step = 'the car details';
        return saveCarStep({}).then(function (res) {
          if (res === 'cancelled') return 'stop';
          if (res === 'saved') done.push('car details');
          return catalogueIconStep().then(function () { return res; });
        }).then(function (res) {
          if (res === 'stop' || res === 'cancelled') return 'stop';
          if (!fluidsEd.dirty()) return null;
          step = 'the fluids, bulbs and specifications';
          return FleetApi.call('saveFluids', { carId: state.carId, fluids: fluidsEd.payload() }).then(function (r) {
            fluidsEd.markSaved(r.data.fluids);
            done.push('fluids, bulbs and specifications');
          });
        }).then(function (stop) {
          if (stop === 'stop') return 'stop';
          step = 'the owner/custodian';
          if (!ownersEd.dirty()) return null;
          return ownersEd.save(state.carId).then(function () { done.push('owner/custodian'); });
        }).then(function (stop) {
          if (stop === 'stop') return 'stop';
          if (!photosChanged() || state.photoDone) return null;
          step = 'the photos';
          return savePhotos().then(function () {
            state.photoDone = true;
            done.push('photos');
          }, function (e) {
            if (car) throw e; // editing: stay here so the photos can be retried
            // A brand-new car is already saved, so report the photos on the next screen instead of blocking.
            FleetApp.setFlash('error', 'The car was saved, but its photos could not be added: ' + UI.errorText(e) + ' You can add them with Edit car.');
          });
        }).then(function (stop) {
          if (stop === 'stop') return 'stop';
          var book = prefill ? prefill.att : editLogbook;
          if (!book || state.logbookDone) return null;
          step = 'the log book';
          return FleetApi.call('uploadCarDocument', { carId: state.carId, type: 'Logbook', note: car ? 'Read by AI when the details were updated' : 'Read by AI when the vehicle was added', mime: book.mime, data: book.data, filename: book.filename }, { timeoutMs: 240000 }).then(function () {
            state.logbookDone = true;
            done.push('log book');
          }, function (e) {
            // the car is already saved: report it on the next screen instead of blocking
            FleetApp.setFlash('error', 'The car was saved, but the log book could not be attached: ' + UI.errorText(e) + ' You can add it under Documents.');
          });
        }).then(function (stop) {
          if (stop === 'stop') return;
          carsCache = null;
          FleetApp.go('/car/' + state.carId);
        }).catch(function (e) {
          e.savedParts = done;
          e.failedStep = step;
          throw e;
        });
      }

      // What a car needs before it can be saved (an electric car has no engine size)
      function missingRequired() {
        var electric = f.fuelType.value === 'Fully electric';
        return [['registration', 'registration'], ['make', 'make'], ['model', 'model'], ['year', 'year'], ['fuelType', 'fuel type'], ['engineSize', 'engine size'], ['transmission', 'transmission']]
          .filter(function (n) { return !(n[0] === 'engineSize' && electric) && String(f[n[0]].value).trim() === ''; })
          .map(function (n) { return n[1]; });
      }

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        var need = missingRequired();
        if (need.length) {
          msg.replaceChildren(UI.notice('error', 'Please fill in the ' + (need.length > 1 ? need.slice(0, -1).join(', ') + ' and ' + need[need.length - 1] : need[0]) + ' before saving.'));
          detailsSection.open = true;
          window.scrollTo(0, 0);
          return;
        }
        UI.busy(btn, 'Saving…', run()).catch(function (e) {
          var text = (e.savedParts && e.savedParts.length ? 'Saved: ' + e.savedParts.join(', ') + '. ' : '') +
            'Could not save ' + (e.failedStep || 'the changes') + ': ' + UI.errorText(e);
          msg.replaceChildren(UI.notice('error', text));
          // open the part that could not be saved, so the problem is in front of you
          var failed = e.failedStep || '';
          if (/details/.test(failed)) detailsSection.open = true;
          else if (/fluid/.test(failed)) { fluidsSection.open = true; bulbsSection.open = true; }
          else if (/owner/.test(failed)) ownersSection.open = true;
          else if (/photo/.test(failed)) photoSection.open = true;
          window.scrollTo(0, 0);
        });
      });

      // The last section of a saved car's form: Save, and (admins only) Delete, kept here so Delete is never one tap away from the car page.
      var finishBox = null;
      if (car) {
        var finishKids = [el('h2', { text: FleetAuth.isAdmin() ? 'Save or delete' : 'Save' }), btn];
        if (FleetAuth.isAdmin()) {
          var deleteBtn = el('button', { type: 'button', class: 'btn block danger-outline', text: 'Delete car' });
          deleteBtn.addEventListener('click', function () {
            UI.confirm('Delete ' + car.registration + '? You can restore it later from the fleet page.', { okLabel: 'Delete car', danger: true }).then(function (yes) {
              if (!yes) return;
              UI.busy(deleteBtn, 'Deleting…', FleetApi.call('deleteCar', { id: car.id }))
                .then(function () { carsCache = null; FleetApp.go('/'); })
                .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); window.scrollTo(0, 0); });
            });
          });
          finishKids.push(el('div', { class: 'finish-delete' }, [
            el('p', { class: 'section-note', text: 'Deleting removes the car from the fleet. You can restore it from the Fleet page.' }),
            deleteBtn,
          ]));
        }
        finishBox = el('div', { class: 'form-section finish-zone' }, finishKids);
      }

      root.replaceChildren(el('section', { class: 'card' }, [
        backLink(car ? '#/car/' + car.id : '#/', car ? car.registration : 'Fleet'),
        el('h1', { text: car ? 'Edit car' : 'Add a car' }),
        msg, form,
        finishBox,
      ]));
      // "Edit" on the Fluids, Bulbs & Specifications section of the car page lands straight on that part of the form
      if (/\/fluids$/.test(ctx.path || '')) { fluidsSection.open = true; setTimeout(function () { fluidsSection.scrollIntoView(); }, 0); }
    }
  };

  // ---------- printable label ----------
  Views.carLabel = function (ctx, root) {
    var id = ctx.params.id;
    root.replaceChildren(el('section', { class: 'card' }, [loading()]));
    FleetApi.call('getCar', { id: id }).then(function (r) {
      var car = r.data.car;
      var printBtn = el('button', { type: 'button', class: 'btn', text: 'Print label', onclick: function () { window.print(); } });
      root.replaceChildren(
        el('section', { class: 'card no-print' }, [
          backLink('#/car/' + car.id, car.registration),
          el('h1', { text: 'QR label' }),
          el('p', { class: 'section-note', text: 'Print this and stick it on the car. Scanning it opens the car: signed-in people go straight to it, and anyone else can open it as a guest or sign in (unless guest access is switched off for this car).' }),
          printBtn,
        ]),
        el('div', { class: 'label-wrap' }, [
          el('div', { class: 'label' }, [
            el('img', { src: qrDataUrl(qrLink(car)), alt: 'QR code for ' + car.registration }),
            el('div', { class: 'label-reg', text: car.registration }),
            el('div', { class: 'label-car', text: carTitle(car) }),
            el('div', { class: 'label-foot', text: 'Fleet Manager' }),
          ]),
        ])
      );
    }).catch(function (e) {
      if (e.code === 'not_found') notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });
  };
})();
