// A car's history: the History and Costs cards, the "what do you want to add?" chooser,
// the entry page, and the form for issues, maintenance and purchases.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var fmt = Views.fmt; // formatting helpers shared from views-cars.js

  var ISSUE_STATUSES = ['Not resolved', 'In-work', 'Resolved', 'Ignored'];

  // The kinds of entry, with the examples shown when choosing.
  var TYPES = {
    issue: { type: 'Issue', label: 'Issue', blurb: 'Something that is wrong or needs looking at.',
      examples: 'Faulty parking sensor · Warning light on · Strange noise when braking', placeholder: 'e.g. Faulty parking sensor' },
    maintenance: { type: 'Maintenance', label: 'Maintenance', blurb: 'Servicing, checks, repairs and fixes.',
      examples: 'Oil and filter change · Replaced front brake pads · Fixed exhaust leak', placeholder: 'e.g. Oil and filter change' },
    purchase: { type: 'Purchase', label: 'Purchased item', blurb: 'Parts or items you bought for this car.',
      examples: 'Front brake pads (set) · 2 × oil filter · 5 L 5W-30 engine oil', placeholder: 'e.g. Front brake pads (set)' },
  };
  var BY_TYPE = {};
  Object.keys(TYPES).forEach(function (k) { BY_TYPE[TYPES[k].type] = Object.assign({ key: k }, TYPES[k]); });
  var PLURAL = { Issue: 'Issues', Maintenance: 'Maintenance', Purchase: 'Purchases' };

  var CATEGORY_LABELS = {
    parts: 'Parts', labour: 'Labour', other: 'Other costs', invoices: 'Invoice totals',
    compliance: 'Compliance', issues: 'Inspections and fees',
  };

  // ---------- small helpers ----------
  function isoToday() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }
  function dateText(iso) { return iso ? fmt.date(iso + 'T12:00:00Z') : ''; }
  function moneyMap(map) {
    var parts = Object.keys(map || {}).map(function (c) { return fmt.money(map[c], c); });
    return parts.join(' + ');
  }
  // The picture a log row shows when the entry has no photo: a plain icon for its type, in the colour of its tag.
  var TYPE_ICONS = {
    Maintenance: '<path d="M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5"/>',
    Issue: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>',
    Compliance: '<path d="M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06"/><path d="M15 19l2 2l4 -4"/>',
    Purchase: '<path d="M12 3l8 4.5v9l-8 4.5l-8 -4.5v-9l8 -4.5"/><path d="M12 12l8 -4.5"/><path d="M12 12v9"/><path d="M12 12l-8 -4.5"/>',
  };
  function typeThumb(type) {
    var box = el('div', { class: 'type-thumb tt-' + String(type).toLowerCase(), 'aria-hidden': 'true' });
    box.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + (TYPE_ICONS[type] || '') + '</svg>'; // fixed drawings, nothing from the data
    return box;
  }
  /** A unique ID (M-0042, A-0017...): very small plain text, always in the right-hand corner under the share symbol. It can be selected and copied. */
  function refTiny(ref) { return el('span', { class: 'ref-tiny', text: ref }); }
  window.EntryUI = window.EntryUI || {};
  window.EntryUI.refTiny = refTiny;
  window.EntryUI.typeThumb = typeThumb; // reminders use the same pictures as the log
  // `short`: the plain type name (Purchase, not Purchased item), for the narrow space under a log thumbnail
  function typeChip(type, short) { return el('span', { class: 'chip t-' + type.toLowerCase(), text: short ? type : BY_TYPE[type].label }); }
  function num0(s) {
    var n = Number(String(s === null || s === undefined ? '' : s).replace(/[£$€,\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  // The currency used most recently for a car, so a garage bill in shillings does not need re-selecting each time.
  var lastCurrency = {};
  Views.rememberCurrency = function (carId, entries) {
    if (entries && entries.length) lastCurrency[carId] = entries[0].currency; // newest first
  };

  // Readings are always in miles.
  function mileageText(e) {
    return fmt.num(e.mileage) + ' mi';
  }

  // A big file can take a minute or more to send, so uploads wait much longer than a normal request.
  var UPLOAD_TIMEOUT_MS = 240000;

  // What a file looks like in a list: a camera for photos, a page for PDFs, a paperclip for everything else.
  function fileIcon(mime) { return mime === 'image/jpeg' ? '📷 ' : mime === 'application/pdf' ? '📄 ' : '📎 '; }

  /**
   * One file that is already attached: its name on the first line, then View / Open / Download on the left and
   * (admins only) Remove on the right, so the two are never mistaken for each other.
   * hooks.error(err) shows a problem; hooks.removed(a, row) runs after a successful remove.
   */
  function attachmentRow(a, hooks) {
    var holder = el('div');
    var shown = Viewer.canShow(a.mime); // photos and PDFs are shown in the app; any other kind of file is saved to the phone
    var view = el('button', { type: 'button', class: 'btn small secondary', text: shown ? 'View' : 'Download' });
    view.addEventListener('click', function () {
      var go = Viewer.show({ mime: a.mime, filename: a.filename, load: function () { return Photos.fetchAttachment(a.id); } });
      if (!shown) UI.busy(view, 'Loading…', go).catch(hooks.error);
    });
    var actions = [view];
    var row = el('div', { class: 'attach-row' });
    if (FleetAuth.isAdmin()) {
      var rm = el('button', { type: 'button', class: 'btn small danger attach-remove', text: 'Remove' });
      rm.addEventListener('click', function () {
        UI.confirm('Remove ' + a.filename + '?', { okLabel: 'Remove', danger: true }).then(function (yes) {
          if (!yes) return;
          UI.busy(rm, 'Removing…', FleetApi.call('deleteAttachment', { id: a.id }))
            .then(function () { hooks.removed(a, row); })
            .catch(hooks.error);
        });
      });
      actions.push(rm);
    }
    row.append(el('div', { class: 'attach-name' }, [
      a.ref ? fileRefLine(a.ref) : null,
      el('div', { text: fileIcon(a.mime) + a.filename + ' · ' + kb(a.size) }),
    ]), el('div', { class: 'attach-actions' }, actions), holder);
    return row;
  }

  /** A file's unique ID (such as A-0042) with a button to copy it, like an entry's reference. */
  function fileRefLine(ref) {
    return refTiny(ref); // sits in the top right corner of its row, like the ID under a share symbol
  }
  window.EntryUI = window.EntryUI || {};
  window.EntryUI.fileRefLine = fileRefLine;

  /** The "add something" block: kept apart from the files that are already attached. */
  function addPanel(onFile, hint) {
    return el('div', { class: 'attach-add' }, [
      el('div', { class: 'attach-title', text: 'Add a photo or file' }),
      el('div', { class: 'attach-add-buttons' }, [
        Photos.fileButton('📷 Take photo', 'image/*', true, onFile),
        Photos.fileButton('🖼 Choose photo', 'image/*', false, onFile),
        Photos.fileButton('📎 Add file', '', false, onFile),
      ]),
      el('div', { class: 'hint', text: hint }),
    ]);
  }

  function costText(e) {
    if (e.type === 'Maintenance') return moneyMap(e.jobCost);
    if (e.type === 'Purchase') return fmt.money(e.total, e.currency);
    if (e.type === 'Issue' && e.cost !== null && e.cost !== undefined) return fmt.money(e.cost, e.currency);
    return '';
  }

  // ---------- History card (on the car page) ----------
  // `preloaded` (the car page's entries) saves a request; without it the card fetches its own.
  /** After a delete or a restore: the page is drawn again with the change (keeping its sections open) and shows a message. */
  function dataChanged(carId, text) {
    Views.invalidateCars();
    FleetApp.setFlash('ok', text);
    window.dispatchEvent(new CustomEvent('fleet:data-updated', { detail: { cars: [carId], fleet: true } }));
  }

  /** The recycle bin (admins): a card of its own on the car page. Deleted entries wait here for 30 days and can be restored. */
  function binCard(car) {
    var notes = el('div');
    var body = el('div', { class: 'stack' });
    var loaded = false;
    function ago(iso) {
      var n = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
      return n < 1 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago';
    }
    function load() {
      body.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
      FleetApi.call('listDeletedEntries', { carId: car.id }).then(function (r) {
        if (!r.data.entries.length) { body.replaceChildren(el('p', { class: 'muted', text: 'Nothing here. A deleted entry stays here for ' + r.data.days + ' days and can be restored.' })); return; }
        body.replaceChildren.apply(body, r.data.entries.map(function (x) {
          var restore = el('button', { type: 'button', class: 'btn small secondary', text: 'Restore' });
          restore.addEventListener('click', function () {
            notes.replaceChildren();
            UI.busy(restore, 'Restoring…', FleetApi.call('restoreEntry', { id: x.id })).then(function () {
              dataChanged(car.id, 'Restored "' + x.title + '"' + (x.ref ? ' (' + x.ref + ')' : '') + '.');
            }).catch(function (err) {
              notes.replaceChildren(UI.notice('error', err.code === 'not_enough_stock' ? 'It cannot be restored yet: parts it used have since been used on other work, so there is not enough in stock. Restore it after that work is changed or deleted.'
                : err.code === 'restore_expired' ? 'It was deleted more than ' + r.data.days + ' days ago, so it can no longer be restored.' : UI.errorText(err)));
            });
          });
          return el('div', { class: 'bin-row' }, [
            el('div', {}, [
              el('div', { class: 'entry-title', text: x.title }),
              el('div', { class: 'muted small-text', text: [x.type, dateText(x.date)].filter(Boolean).join(' · ') }),
              el('div', { class: 'muted small-text', text: 'Deleted ' + ago(x.deletedAt) + (x.deletedBy ? ' by ' + x.deletedBy : '') + ' · ' + x.daysLeft + (x.daysLeft === 1 ? ' day' : ' days') + ' left to restore' }),
            ]),
            el('div', { class: 'share-stack' }, [restore, x.ref ? refTiny(x.ref) : null]),
          ]);
        }));
      }).catch(function (err) { loaded = false; body.replaceChildren(UI.notice('error', UI.errorText(err))); });
    }
    var card = el('section', { class: 'card bin-card' }, [
      el('h2', { text: '🗑 Recycle bin' }),
      el('p', { class: 'section-note', text: 'Entries deleted from the log wait here for 30 days. Restore one to put it back in the log; after 30 days it can no longer be restored.' }),
      notes, body,
    ]);
    card.onOpen = function () { if (!loaded) { loaded = true; load(); } }; // loaded when the card is first opened
    return card;
  }

  // The car's receipt addresses: simple (from the registration) and public (a short reference, for anyone). Asked for once per car, then remembered
  var receiptEmails = {};
  function receiptEmailFor(car) {
    var key = car.id + '|' + car.registration;
    if (!receiptEmails[key]) receiptEmails[key] = FleetApi.call('getReceiptAddress', { carId: car.id }).then(function (r) { return { address: r.data.address, publicAddress: r.data.privateAddress }; }).catch(function (e) { delete receiptEmails[key]; throw e; });
    return receiptEmails[key];
  }

  function historyCard(car, preloaded) {
    var chips = el('div', { class: 'filter-box', role: 'group', 'aria-label': 'Filter the history' });
    var list = el('div', { class: 'history' }, [fmt.loading()]);
    var filter = 'All';
    var data = [];
    // A small location pin before the garage's name.
    function pinIcon() {
      var span = el('span', { class: 'pin', 'aria-hidden': 'true' });
      span.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"/><path d="M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z"/></svg>'; // a fixed drawing
      return span;
    }

    function row(e) {
      // Under the title: the date and mileage on one line, the garage (with a pin) on the next. A line that is too long
      // is cut off with "…" rather than wrapping. A purchase shows only its date (and its status below).
      var dm = [dateText(e.date)];
      if (e.type !== 'Purchase' && e.mileage !== null) dm.push(mileageText(e, car));
      var showGarage = e.type !== 'Purchase' && !!e.vendor;
      var tags = [];
      if (e.type === 'Issue') tags.push(el('span', { class: 'chip st-' + e.status.toLowerCase().replace(/[^a-z]/g, ''), text: e.status }));
      if (e.type === 'Purchase') tags.push(el('span', { class: 'chip ' + (e.stockStatus === 'In stock' ? 'active' : e.stockStatus === 'Fitted' ? 'sold' : 'pending'), text: e.stockStatus }));
      if (e.type === 'Purchase' && e.itemCount > 1) tags.push(el('span', { class: 'muted small-text', text: e.itemCount + ' items' }));
      if (e.attachmentCount) tags.push(el('span', { class: 'muted small-text', text: '📎 ' + e.attachmentCount }));
      if (e.guestName) tags.push(GuestUI.chip(e));
      var cost = costText(e);
      var link = el('a', { class: 'entry-row', href: '#/car/' + car.id + '/entry/' + e.id }, [
        // the picture, with the type tag beneath it
        el('div', { class: 'entry-lead' }, [
          e.thumbAttachmentId ? Photos.thumbBox(e.thumbAttachmentId, 'row-thumb') : typeThumb(e.type),
          typeChip(e.type, true),
        ]),
        // the title, one line of details, then the status tags: each on a single line
        el('div', { class: 'entry-main' }, [
          el('div', { class: 'entry-title', text: e.title }),
          el('div', { class: 'muted small-text entry-ref-line', text: dm.join(' · ') }),
          showGarage ? el('div', { class: 'muted small-text entry-garage-line' }, [pinIcon(), document.createTextNode(e.vendor)]) : null,
          // the status tags on the left, and the price in the bottom right corner
          el('div', { class: 'entry-foot' }, [
            el('div', { class: 'entry-foot-tags' }, tags),
            cost ? el('strong', { class: 'entry-cost', text: cost }) : null,
          ]),
        ]),
      ]);
      // On the right: the share symbol with the ID under it (and, in the link, the price in the bottom right corner).
      // While selecting, a tick box takes its place and tapping the row ticks it instead of opening the entry.
      var side;
      if (selecting) {
        var tick = el('input', { type: 'checkbox', class: 'entry-select', 'aria-label': 'Select ' + e.title });
        tick.checked = !!selected[e.id];
        tick.addEventListener('change', function () { setSelected(e.id, tick.checked); });
        side = el('div', { class: 'select-box' }, [tick]);
        link.addEventListener('click', function (ev) { ev.preventDefault(); setSelected(e.id, !selected[e.id]); });
      } else {
        side = el('div', { class: 'share-stack' }, [
          UI.shareButton(fmt.entryUrl(car.id, e.id), { title: e.title + ' · ' + car.registration, aria: 'Share ' + e.title }),
          e.ref ? refTiny(e.ref) : null,
        ]);
      }
      var line = el('div', { class: 'entry-line' + (selecting ? ' is-selecting' : '') + (selecting && selected[e.id] ? ' selected' : '') }, [link, side]);
      lines[e.id] = line;
      return line;
    }

    // ---------- choosing several entries to share or delete ----------
    var selecting = false;
    var selected = {};   // entry id -> true
    var lines = {};      // entry id -> its row
    var selectBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Select' });
    var selectTools = el('div', { class: 'select-tools' }, [selectBtn]);
    var selectInfo = el('span', { class: 'select-info' });
    var selectMsg = el('div', { class: 'select-msg small-text', hidden: true });
    var selectAll = el('button', { type: 'button', class: 'btn small secondary', text: 'Select all' });
    var shareSel = el('button', { type: 'button', class: 'btn small', text: 'Share' });
    var deleteSel = el('button', { type: 'button', class: 'btn small danger-outline', text: 'Delete' });
    var selectBar = el('div', { class: 'select-bar', role: 'region', 'aria-label': 'Selected entries' }, [
      selectMsg,
      el('div', { class: 'select-bar-row' }, [selectInfo, selectAll, shareSel, FleetAuth.isAdmin() ? deleteSel : null]),
    ]);
    function shownEntries() { return data.filter(function (e) { return filter === 'All' || e.type === filter; }); }
    function pickedEntries() { return data.filter(function (e) { return selected[e.id]; }); }
    function updateSelectUi() {
      var n = pickedEntries().length;
      selectInfo.textContent = n ? n + ' selected' : 'Tap entries to select';
      shareSel.disabled = !n;
      deleteSel.disabled = !n;
      var shown = shownEntries();
      selectAll.textContent = shown.length && shown.every(function (e) { return selected[e.id]; }) ? 'None' : 'Select all';
    }
    function setSelected(id, on) {
      if (on) selected[id] = true; else delete selected[id];
      var line = lines[id];
      if (line) { line.classList.toggle('selected', !!on); var t = line.querySelector('.entry-select'); if (t) t.checked = !!on; }
      selectMsg.hidden = true;
      updateSelectUi();
    }
    function enterSelect() {
      selecting = true;
      selected = {};
      selectBtn.textContent = 'Done';
      document.body.append(selectBar);
      document.body.classList.add('selecting');
      positionBar();
      render();
    }
    function leaveSelect() {
      selecting = false;
      selected = {};
      selectBtn.textContent = 'Select';
      selectBar.remove();
      document.body.classList.remove('selecting');
      selectMsg.hidden = true;
      render();
    }
    function positionBar() { selectBar.style.bottom = (document.getElementById('tabbar') && !document.getElementById('tabbar').hidden ? document.getElementById('tabbar').offsetHeight : 0) + 'px'; }
    window.addEventListener('resize', positionBar);
    // the bar belongs to this card: when the page changes it goes too
    function dropBarIfGone() {
      if (document.body.contains(list)) return;
      selectBar.remove();
      document.body.classList.remove('selecting');
      window.removeEventListener('hashchange', dropBarIfGone);
      window.removeEventListener('fleet:data-updated', dropBarIfGone);
      window.removeEventListener('resize', positionBar);
    }
    window.addEventListener('hashchange', function () { setTimeout(dropBarIfGone, 0); });
    window.addEventListener('fleet:data-updated', function () { setTimeout(dropBarIfGone, 0); });
    selectBtn.addEventListener('click', function () { if (selecting) leaveSelect(); else enterSelect(); });
    selectAll.addEventListener('click', function () {
      var shown = shownEntries();
      var all = shown.length && shown.every(function (e) { return selected[e.id]; });
      shown.forEach(function (e) { setSelected(e.id, !all); });
    });
    shareSel.addEventListener('click', function () {
      var picked = pickedEntries();
      if (!picked.length) return;
      var text = car.registration + ' · ' + picked.length + (picked.length === 1 ? ' entry' : ' entries') + '\n\n' + picked.map(function (e) {
        return e.title + (e.ref ? ' (' + e.ref + ')' : '') + '\n' + fmt.entryUrl(car.id, e.id);
      }).join('\n\n');
      function copied() {
        UI.copyText(text).then(function (ok) {
          if (!ok) { window.prompt('Copy these links:', text); return; }
          selectMsg.textContent = 'The links were copied.';
          selectMsg.hidden = false;
        });
      }
      if (navigator.share) {
        navigator.share({ title: car.registration + ' entries', text: text }).catch(function (e) { if (!(e && e.name === 'AbortError')) copied(); });
      } else copied();
    });
    deleteSel.addEventListener('click', function () {
      var picked = pickedEntries();
      if (!picked.length) return;
      UI.confirm('Delete ' + (picked.length === 1 ? 'this entry' : picked.length + ' entries') + '? ' + (picked.length === 1 ? 'It goes' : 'They go') + ' to the recycle bin and can be restored for 30 days.', { okLabel: 'Delete', danger: true }).then(function (yes) {
        if (!yes) return;
        selectMsg.hidden = true;
        UI.busy(deleteSel, 'Deleting…', FleetApi.call('deleteEntries', { ids: picked.map(function (e) { return e.id; }) }, { timeoutMs: 120000 })).then(function (r) {
          var d = r.data;
          var text = d.deleted + (d.deleted === 1 ? ' entry' : ' entries') + ' deleted.' + (d.failed.length ? ' ' + d.failed.length + ' could not be deleted (a purchase whose items were used in maintenance has to stay).' : '');
          selectBar.remove();
          document.body.classList.remove('selecting');
          dataChanged(car.id, text);
        }).catch(function (e) { selectMsg.textContent = UI.errorText(e); selectMsg.hidden = false; });
      });
    });

    // ---------- the bar that slides under the chosen filter tile ----------
    var sliderPos = null; // where the bar last was (position, width, colour), so the next one glides from there
    function placeSlider(wrap, slider, tile, animate) {
      var tries = 0;
      function go() {
        if (!tile || !wrap.isConnected || !wrap.clientWidth) { if (tries++ < 6) setTimeout(go, 60); return; } // not on screen yet: try again shortly
        var w = wrap.getBoundingClientRect();
        var t = tile.getBoundingClientRect();
        var next = { left: t.left - w.left, width: t.width, color: window.getComputedStyle(tile).color };
        if (animate && sliderPos) {
          slider.style.transition = 'none';
          slider.style.left = sliderPos.left + 'px'; slider.style.width = sliderPos.width + 'px'; slider.style.background = sliderPos.color;
          slider.offsetWidth; // let the starting place register before moving
          slider.style.transition = '';
        } else {
          slider.style.transition = 'none';
        }
        slider.style.left = next.left + 'px'; slider.style.width = next.width + 'px'; slider.style.background = next.color;
        if (!(animate && sliderPos)) { slider.offsetWidth; slider.style.transition = ''; }
        sliderPos = next;
      }
      go();
    }
    window.addEventListener('resize', function () {
      if (!document.body.contains(list)) return;
      var wrap = chips.querySelector('.filter-bar');
      if (!wrap) return;
      sliderPos = null;
      placeSlider(wrap, wrap.querySelector('.filter-slider'), wrap.querySelector('.filter-tile.on'), false);
    });

    function render() {
      lines = {};
      selectTools.hidden = !data.length;
      chips.replaceChildren();
      var counts = {};
      data.forEach(function (e) { counts[e.type] = (counts[e.type] || 0) + 1; });
      if (data.length) {
        // Tiles in the same soft colours as the pictures shown for entries without a photo; the chosen one is solid.
        // Every kind always has its tile, with a count of zero if there are none.
        var types = ['All'].concat(Object.keys(PLURAL));
        var tiles = el('div', { class: 'filter-tiles' });
        // each tile is as wide as its name needs (short ones narrower);
        // set here, not as an attribute (the page's security policy blocks inline style attributes)
        tiles.style.gridTemplateColumns = types.map(function (t) { return 'minmax(0, ' + ((t === 'All' ? 3 : PLURAL[t].length) + 3) + 'fr)'; }).join(' ');
        types.forEach(function (t) {
          var b = el('button', { type: 'button', class: 'filter-tile ft-' + t.toLowerCase() + (t === filter ? ' on' : '') + (t !== 'All' && !counts[t] ? ' none' : ''), 'aria-pressed': t === filter ? 'true' : 'false' }, [
            el('span', { class: 'ft-name', text: t === 'All' ? 'All' : PLURAL[t] }),
            el('b', { class: 'ft-count', text: String(t === 'All' ? data.length : (counts[t] || 0)) }),
          ]);
          b.addEventListener('click', function () { filter = t; render(); });
          tiles.append(b);
        });
        // a bar under the chosen tile: it glides from where it was to where it now belongs
        var wrap = el('div', { class: 'filter-bar' }, [tiles]);
        var slider = el('div', { class: 'filter-slider', 'aria-hidden': 'true' });
        wrap.append(slider);
        chips.append(el('p', { class: 'filter-note', text: 'You can filter the displayed list of log entries by selecting one of the options below.' }), wrap);
        placeSlider(wrap, slider, tiles.querySelector('.filter-tile.on'), true);
      }
      var shown = data.filter(function (e) { return filter === 'All' || e.type === filter; });
      if (selecting) updateSelectUi();
      list.replaceChildren.apply(list, shown.length ? shown.map(row)
        : [el('p', { class: 'muted', text: data.length ? 'No ' + (filter === 'All' ? 'entries' : PLURAL[filter].toLowerCase()) + ' yet.' : 'Nothing recorded yet. Add the first entry above.' })]);
    }

    function show(entries) {
      data = entries;
      Views.rememberCurrency(car.id, data);
      render();
    }
    if (preloaded) show(preloaded);
    else {
      FleetApi.call('listEntries', { carId: car.id }).then(function (r) { show(r.data.entries); }).catch(function (e) {
        list.replaceChildren(UI.notice('error', UI.errorText(e)));
      });
    }

    // A short note under the button: receipts and invoices can be emailed to the car's address, or uploaded here for AI to read
    var receiptHint = el('div', { class: 'receipt-hint section-note', hidden: true });
    var emailPart = el('p', { hidden: true });
    var aiPart = el('div', { hidden: true });
    receiptHint.append(emailPart, aiPart);
    function showHint() { receiptHint.hidden = emailPart.hidden && aiPart.hidden; }
    receiptEmailFor(car).then(function (a) {
      if (!a.address && !a.publicAddress) return;
      var kids = [document.createTextNode('Email part receipts or garage invoices for automatic processing. ')];
      if (a.address) {
        kids.push(
          document.createTextNode('Simple address (from your own email): '),
          el('a', { class: 'receipt-hint-link', href: 'mailto:' + a.address, text: a.address }),
          document.createTextNode('. ')
        );
      }
      if (a.publicAddress) {
        kids.push(
          document.createTextNode('Public address (works for anyone, so share it with your garage): '),
          el('a', { class: 'receipt-hint-link', href: 'mailto:' + a.publicAddress, text: a.publicAddress }),
          document.createTextNode('.')
        );
      }
      emailPart.replaceChildren.apply(emailPart, kids);
      emailPart.hidden = false;
      showHint();
    }).catch(function () { /* no email part: the log works without it */ });

    // Upload a receipt here: AI reads it, then the entry form opens filled in, to check and save
    function drawAiPart(status, problem) {
      var left = status.remaining;
      var kids = [el('p', { text: 'Or upload one now: AI reads it and opens the entry to review and save. Parts purchase receipts and garage invoices only.' })];
      if (problem) kids.push(problem);
      if (left > 0) {
        var input = el('input', { type: 'file', accept: 'image/*,application/pdf', class: 'file-input', 'aria-label': 'Choose a photo or PDF of a receipt or invoice' });
        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          input.value = '';
          if (file) readReceiptFile(file, status);
        });
        kids.push(
          el('p', { text: 'AI can get things wrong: check every box. ' + left + ' of ' + status.limit + ' AI reads left today.' }),
          el('label', { class: 'btn small secondary file-btn' }, [el('span', { text: 'Upload a receipt' }), input])
        );
      } else {
        kids.push(el('p', { text: 'No AI reads left today. They come back tomorrow.' }));
      }
      aiPart.replaceChildren.apply(aiPart, kids);
    }
    function readReceiptFile(file, status) {
      aiPart.replaceChildren(UI.waiting('Reading the receipt with AI… this can take up to a minute. Please keep this screen open.'));
      Photos.prepareAttachment(file).then(function (a) {
        if (a.mime !== 'image/jpeg' && a.mime !== 'application/pdf') throw new FleetApi.ApiError('invalid_attachment', 'Not a photo or PDF');
        return FleetApi.call('uploadReceipt', { carId: car.id, mime: a.mime, data: a.data, filename: a.filename }, { timeoutMs: 240000 });
      }).then(function (up) {
        var saved = up.data.receipt;
        return FleetApi.call('readReceipt', { id: saved.id }, { timeoutMs: 90000 }).then(function (x) { return x.data.receipt; }, function () { return saved; });
      }).then(function (r) {
        if (r.status === 'Pending' && (r.kind === 'Purchase' || r.kind === 'Maintenance')) {
          FleetApp.go('/car/' + car.id + '/add/' + r.kind.toLowerCase(), { inbox: r.id });
          return;
        }
        var text = r.status === 'Pending'
          ? 'That does not look like a parts purchase receipt or a garage invoice, so it cannot be used here. It is saved in the AI Inbox.'
          : (r.note || (r.status === 'Queued' ? 'AI could not read it just now. It is saved in the AI Inbox and will be read later.' : 'AI could not read it. It is saved in the AI Inbox, where you can fill in the entry by hand.'));
        FleetApi.call('getReceiptStatus').then(function (st) { drawAiPart(st.data, UI.notice('info', text)); }, function () { drawAiPart(status, UI.notice('info', text)); });
      }).catch(function (e) {
        FleetApi.call('getReceiptStatus').then(function (st) { drawAiPart(st.data, UI.notice('error', UI.errorText(e))); }, function () { drawAiPart(status, UI.notice('error', UI.errorText(e))); });
      });
    }
    FleetApi.call('getReceiptStatus').then(function (r) {
      if (!r.data.available) return;
      drawAiPart(r.data);
      aiPart.hidden = false;
      showHint();
    }).catch(function () { /* no AI part */ });
    return el('section', { class: 'card' }, [
      el('h2', { text: 'Maintenance & Issues Log' }),
      el('a', { class: 'btn block big', href: '#/car/' + car.id + '/add', text: 'Add entry' }),
      receiptHint,
      chips, selectTools, list,
    ]);
  }

  // ---------- Costs card (on the car page) ----------
  function costsCard(car, preloaded) {
    var body = el('div', {}, [fmt.loading()]);
    function show(costs) {
      var blocks = costs.currencies;
      if (!blocks.length) { body.replaceChildren(el('p', { class: 'muted', text: 'No costs recorded yet.' })); return; }
      body.replaceChildren.apply(body, blocks.map(function (b) {
        var cats = Object.keys(b.categories).map(function (k) {
          return el('li', {}, [el('span', { text: CATEGORY_LABELS[k] || k }), el('span', { text: fmt.money(b.categories[k], b.currency) })]);
        });
        var years = b.years.map(function (y) {
          return el('li', {}, [el('span', { text: y.year }), el('span', { text: fmt.money(y.total, b.currency) })]);
        });
        return el('div', { class: 'cost-block' }, [
          el('div', { class: 'big-number', text: fmt.money(b.total, b.currency) }),
          el('div', { class: 'muted small-text', text: 'Spent in ' + b.currency + '. Each cost is counted once, when the money was spent.' }),
          el('ul', { class: 'cost-list' }, cats),
          el('details', { class: 'cost-years' }, [el('summary', { text: 'By year' }), el('ul', { class: 'cost-list' }, years)]),
        ]);
      }));
    }
    if (preloaded) show(preloaded);
    else FleetApi.call('getCarCosts', { carId: car.id }).then(function (r) { show(r.data); }).catch(function (e) { body.replaceChildren(UI.notice('error', UI.errorText(e))); });
    return el('section', { class: 'card' }, [el('h2', { text: 'Costs' }), body]);
  }

  window.EntryUI = Object.assign(window.EntryUI || {}, { historyCard: historyCard, binCard: binCard, costsCard: costsCard });

  // ---------- "What do you want to add?" ----------
  Views.chooseEntry = function (ctx, root) {
    var carId = ctx.params.id;
    root.replaceChildren(el('section', { class: 'card' }, [fmt.loading()]));
    FleetApi.call('getCar', { id: carId }).then(function (r) {
      var car = r.data.car;
      var cards = ['issue', 'maintenance', 'purchase'].map(function (k) {
        var t = TYPES[k];
        return el('a', { class: 'type-card', href: '#/car/' + carId + '/add/' + k }, [
          el('div', { class: 'type-name', text: t.label }),
          el('div', { text: t.blurb }),
          el('div', { class: 'muted small-text', text: 'e.g. ' + t.examples }),
        ]);
      });
      root.replaceChildren(el('section', { class: 'card' }, [
        fmt.backLink('#/car/' + carId, car.registration),
        el('h1', { text: 'Add an entry' }),
        el('p', { class: 'muted', text: car.registration + ' · ' + car.make + ' ' + car.model + '. What would you like to record?' }),
        el('div', { class: 'stack' }, cards),
      ]));
    }).catch(function (e) {
      if (e.code === 'not_found') fmt.notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });
  };

  // ---------- one entry ----------
  Views.entry = function (ctx, root) {
    var carId = ctx.params.id;
    var id = ctx.params.eid;
    var flash = FleetApp.takeFlash();
    root.replaceChildren(el('section', { class: 'card' }, [fmt.loading()]));
    // the copy saved on this phone is used as it is when nothing has changed; otherwise it appears at once and the fresh one replaces it
    FleetApi.cached('getEntry', { id: id }, function (data) { render(data); }).catch(function (e) {
      if (e.hadSaved && e.code !== 'not_found' && e.code !== 'unauthorized') {
        root.prepend(UI.notice('error', 'Could not refresh, so this is the copy saved on this phone. ' + UI.errorText(e)));
      } else if (e.code === 'not_found') {
        root.replaceChildren(el('section', { class: 'card' }, [
          el('h1', { text: 'Entry not found' }), el('p', { class: 'muted', text: 'It may have been deleted.' }),
          el('a', { class: 'btn', href: '#/car/' + carId, text: 'Back to the car' }),
        ]));
      } else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function render(d) {
      var e = d.entry;
      var car = d.car;
      var msg = el('div');
      if (flash) msg.append(UI.notice(flash.kind, flash.text)); // taken once per visit: the page may be drawn again

      function line(label, value) { return value ? [el('dt', { text: label }), el('dd', { text: value })] : []; }

      // header
      var meta = [dateText(e.date)];
      if (e.mileage !== null) meta.push(mileageText(e, car));
      if (e.vendor) meta.push(e.vendor);
      var deleteBtn = null;
      if (FleetAuth.isAdmin()) {
        deleteBtn = el('button', { type: 'button', class: 'btn big danger-outline', text: 'Delete' });
        deleteBtn.addEventListener('click', function () {
          UI.confirm('Delete this ' + e.type.toLowerCase() + '? It moves to the recycle bin and can be restored for 30 days. Any parts it used go back to stock while it is deleted.', { okLabel: 'Delete', danger: true }).then(function (yes) {
            if (!yes) return;
            UI.busy(deleteBtn, 'Deleting…', FleetApi.call('deleteEntry', { id: e.id }))
              .then(function () { Views.invalidateCars(); FleetApp.setFlash('ok', 'Deleted "' + e.title + '". It is in the Recycle bin (under the log) for 30 days.'); FleetApp.go('/car/' + carId); })
              .catch(function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); });
          });
        });
      }
      var statusArea = el('div', { class: 'entry-status' });
      if (e.type === 'Issue') {
        var sel = el('select', { 'aria-label': 'Issue status' }, ISSUE_STATUSES.map(function (s) { return el('option', { value: s, text: s, selected: s === e.status }); }));
        sel.addEventListener('change', function () {
          msg.replaceChildren();
          sel.disabled = true;
          FleetApi.call('setIssueStatus', { id: e.id, status: sel.value }).then(function () { e.status = sel.value; })
            .catch(function (err) { sel.value = e.status; msg.replaceChildren(UI.notice('error', UI.errorText(err))); })
            .finally(function () { sel.disabled = false; });
        });
        statusArea.append(el('label', { class: 'field-label', text: 'Status' }), sel);
      }
      if (e.type === 'Purchase' && d.stock) statusArea.append(el('span', { class: 'chip ' + (d.stock.status === 'In stock' ? 'active' : d.stock.status === 'Fitted' ? 'sold' : 'pending'), text: d.stock.status }));

      // The entry's first photo, small, beside its title. Photos attached before thumbnails existed get theirs made here, once.
      var topThumb = el('div', { class: 'top-thumb', hidden: true });
      function refreshTopThumb() {
        var first = d.attachments.filter(function (a) { return a.mime === 'image/jpeg'; })[0];
        topThumb.replaceChildren();
        topThumb.hidden = !first;
        if (!first) return;
        if (first.thumb) { topThumb.append(Photos.thumbBox(first.id, 'entry-thumb')); return; }
        Photos.fetchAttachment(first.id).then(function (att) { return Photos.thumbFromBase64(att.data); }).then(function (b64) {
          if (d.attachments.filter(function (a) { return a.mime === 'image/jpeg'; })[0] !== first) return; // it was removed meanwhile
          var src = 'data:image/jpeg;base64,' + b64;
          Photos.rememberAttachmentThumb(first.id, src);
          first.thumb = true;
          topThumb.replaceChildren(Photos.thumbBox(first.id, 'entry-thumb'));
          FleetApi.call('setAttachmentThumb', { id: first.id, thumb: b64 }).then(function () { Views.invalidateCars(); }).catch(function () { /* shown anyway; it will be tried again next time */ });
        }).catch(function () { /* no thumbnail */ });
      }
      refreshTopThumb();

      // the banner names the entry and carries its share symbol, with the ID in tiny text under it
      FleetApp.setBanner({ title: e.title, subtitle: car.registration + ' · ' + BY_TYPE[e.type].label, back: '#/car/' + carId, icon: '', ref: e.ref || '', share: { url: fmt.entryUrl(carId, e.id), title: e.title + ' · ' + d.car.registration, aria: 'Share this entry' } });
      var cards = [
        el('section', { class: 'card' }, [
        // the entry's type tag lives in the top right corner, whatever the type
        el('div', { class: 'entry-top' }, [el('div', { class: 'entry-tags head-tags' }, [typeChip(e.type), e.guestName ? GuestUI.chip(e) : null])]),
        el('div', { class: 'entry-head' }, [
          el('h1', { text: e.title }),
          el('div', { class: 'muted entry-sub', text: meta.join(' · ') }), // the date, mileage and the garage (left out if blank)
          topThumb,
        ]),
        msg, statusArea,
        d.reminder ? el('p', { class: 'muted small-text' }, [el('span', { text: 'Reminder: ' }), el('a', { href: '#/car/' + carId + '/reminder/' + d.reminder.id, text: d.reminder.name })]) : null,
      ])];

      // type-specific details
      if (e.type === 'Maintenance') {
        var rows = [];
        if (d.linkedIssue) rows.push(el('p', {}, [el('span', { class: 'muted', text: 'Fixes issue: ' }), el('a', { href: '#/car/' + carId + '/entry/' + d.linkedIssue.id, text: d.linkedIssue.title + ' (' + d.linkedIssue.status + ')' })]));
        if (e.costMode === 'lump') {
          rows.push(el('dl', { class: 'details' }, line('Invoice total', e.lumpSumCost === null ? '' : fmt.money(e.lumpSumCost, e.lumpCurrency))));
        } else {
          var cost = [];
          d.parts.forEach(function (p) {
            cost.push(el('li', {}, [el('span', { text: p.name + ' × ' + p.quantity }), el('span', { text: fmt.money(p.cost, p.currency) })]));
          });
          if (e.labourCost !== null) {
            cost.push(el('li', {}, [el('span', { text: 'Labour' + (e.labourNote ? ' (' + e.labourNote + ')' : '') + (e.labourHours ? ', ' + e.labourHours + ' h' : '') }), el('span', { text: fmt.money(e.labourCost, e.labourCurrency) })]));
          }
          if (e.otherCost !== null) {
            cost.push(el('li', {}, [el('span', { text: 'Other' + (e.otherNote ? ' (' + e.otherNote + ')' : '') }), el('span', { text: fmt.money(e.otherCost, e.otherCurrency) })]));
          }
          rows.push(cost.length ? el('ul', { class: 'cost-list' }, cost) : el('p', { class: 'muted', text: 'No costs recorded.' }));
        }
        var total = moneyMap(d.jobCost);
        cards.push(el('section', { class: 'card' }, [
          el('h2', { text: 'Cost' }), rows[0] || null, rows[1] || null,
          total ? el('div', { class: 'job-total' }, [el('span', { text: 'Job cost' }), el('strong', { text: total })]) : null,
        ]));
      } else if (e.type === 'Issue') {
        var issueRows = [].concat(line('Inspection or fee', e.cost === null ? '' : fmt.money(e.cost, e.currency)));
        cards.push(el('section', { class: 'card' }, [
          el('h2', { text: 'Details' }),
          issueRows.length ? el('dl', { class: 'details' }, issueRows) : null,
          d.fixedBy && d.fixedBy.length
            ? el('div', {}, [el('div', { class: 'field-label one-line', text: 'Maintenance tasks related to this issue' })].concat(d.fixedBy.map(function (r) {
              return el('div', {}, [el('a', { href: '#/car/' + carId + '/entry/' + r.id, text: r.title + ' · ' + dateText(r.date) })]);
            })))
            : el('p', { class: 'muted', text: 'No maintenance linked to this issue yet.' }),
        ]));
      } else if (e.type === 'Purchase') {
        var s = d.stock;
        var itemList = (d.items || []).map(function (i) {
          return el('li', { class: 'purchase-item' }, [
            el('div', { class: 'item-name', text: i.name + (i.partNumber ? ' · ' + i.partNumber : '') }),
            el('div', { class: 'muted small-text', text: i.quantity + ' × ' + fmt.money(i.unitCost, e.currency) + ' = ' + fmt.money(i.lineTotal, e.currency) }),
            el('div', { class: 'muted small-text', text: i.used + ' used · ' + i.remaining + ' left' + ((d.items || []).length > 1 ? ' · ' + i.status : '') }),
          ]);
        });
        cards.push(el('section', { class: 'card' }, [
          el('h2', { text: (d.items || []).length > 1 ? 'Items (' + d.items.length + ')' : 'Item' }),
          el('ul', { class: 'purchase-items' }, itemList),
          el('dl', { class: 'details' }, [].concat(line('Total paid', fmt.money(s.total, e.currency)))),
          e.productUrl ? el('p', {}, [el('a', { class: 'btn small secondary', href: e.productUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Link: ' + fmt.hostOf(e.productUrl) })]) : null,
          d.usedIn && d.usedIn.length
            ? el('div', {}, [el('div', { class: 'field-label', text: 'Used in' })].concat(d.usedIn.map(function (u) {
              return el('div', {}, [el('a', { href: '#/car/' + carId + '/entry/' + u.id, text: u.title + ' × ' + u.quantity + (u.item ? ' (' + u.item + ')' : '') })]);
            })))
            : null,
        ]));
      }

      if (e.notes) cards.push(el('section', { class: 'card' }, [el('h2', { text: 'Notes' }), el('p', { class: 'notes', text: e.notes })]));

      // attachments
      var attBox = el('div', { class: 'stack' });
      var attHeading = el('div', { class: 'attach-title' });
      var attHooks = {
        error: function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); },
        removed: function (a) {
          d.attachments = d.attachments.filter(function (x) { return x.id !== a.id; });
          drawAttachments();
          refreshTopThumb();
        },
      };
      function drawAttachments() {
        attHeading.textContent = d.attachments.length ? 'Attached files (' + d.attachments.length + ')' : 'Attached files';
        attBox.replaceChildren.apply(attBox, d.attachments.length ? d.attachments.map(function (a) { return attachmentRow(a, attHooks); })
          : [el('p', { class: 'muted', text: 'Nothing attached yet.' })]);
      }
      drawAttachments();
      // Add straight from here: no need to open Edit first. (Removing is on each row, for admins.)
      function addFile(file) {
        msg.replaceChildren(UI.notice('ok', 'Adding ' + (file.name || 'the file') + '…' + (file.size > 1000000 ? ' A big file can take a minute or more.' : '')));
        return Photos.prepareAttachment(file).then(function (a) {
          return FleetApi.call('uploadAttachment', { entryId: e.id, mime: a.mime, data: a.data, thumb: a.thumb, filename: a.filename }, { timeoutMs: UPLOAD_TIMEOUT_MS });
        }).then(function (r) {
          Views.invalidateCars();
          d.attachments.push(r.data.attachment);
          drawAttachments();
          refreshTopThumb();
          msg.replaceChildren(UI.notice('ok', 'Added.'));
        }).catch(function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); });
      }
      cards.push(el('section', { class: 'card', id: 'entry-files' }, [
        el('h2', { text: 'Photos and documents' }),
        el('div', { class: 'attach-existing' }, [attHeading, attBox]),
        addPanel(addFile, 'Receipts, invoices, quotes, photos or any other file. Photos are shrunk automatically; other files can be up to 5 MB.'),
      ]));

      // Edit and Delete (admins) next to each other at the bottom of the entry
      cards.push(el('div', { class: 'entry-actions' }, [
        el('a', { class: 'btn big', href: '#/car/' + carId + '/entry/' + e.id + '/edit', text: 'Edit' }),
        deleteBtn,
      ]));
      root.replaceChildren.apply(root, cards);
      if (Views.fitOneLine) Views.fitOneLine(root, '.one-line'); // a label that must stay on one line is made just small enough to fit
    }
  };

  // ---------- adding / editing an entry ----------
  Views.entryForm = function (ctx, root) {
    var carId = ctx.params.id;
    var eid = ctx.params.eid || '';
    var typeKey = (ctx.params.type || '').toLowerCase();
    if (typeKey === 'repair') typeKey = 'maintenance'; // old links and bookmarks
    root.replaceChildren(el('section', { class: 'card' }, [fmt.loading()]));
    if (!eid && !TYPES[typeKey]) { fmt.notFound(root); return; }

    var calls = [FleetApi.call('getCar', { id: carId }), FleetApi.call('listPurchases', { carId: carId, eventId: eid }), FleetApi.call('listTasks', { carId: carId })];
    var draftId = eid ? '' : (ctx.query.inbox || ''); // a receipt from the Inbox being turned into this entry
    if (eid) calls.push(FleetApi.call('getEntry', { id: eid }));
    else if (draftId) calls.push(FleetApi.call('getInboxItem', { id: draftId }));
    Promise.all(calls).then(function (res) {
      build(res[0].data.car, res[1].data, eid && res[3] ? res[3].data : null, res[2].data.tasks, draftId && res[3] ? res[3].data.receipt : null);
    }).catch(function (e) {
      if (e.code === 'not_found') fmt.notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function build(car, lists, existingData, tasks, draft) {
      FleetApp.setBanner(Object.assign({ subtitle: car.registration + ' · ' + car.make + ' ' + car.model }, existingData ? { title: 'Edit ' + BY_TYPE[existingData.entry.type].label.toLowerCase() } : {})); // the banner says which car this is for
      var existing = existingData ? existingData.entry : null;
      var type = existing ? existing.type : TYPES[typeKey].type;
      var meta = BY_TYPE[type];
      var isJob = type === 'Maintenance';
      if (draft && (draft.status === 'Approved' || draft.status === 'Dismissed' || (type !== 'Purchase' && type !== 'Maintenance'))) draft = null; // a receipt that is already dealt with starts nothing
      var v = existing || (draft ? draftValues(draft, type) : {});
      var f = {};
      var msg = el('div');

      function text(name, value, attrs) {
        f[name] = el('input', Object.assign({ type: 'text', name: name, value: value === null || value === undefined ? '' : String(value), autocomplete: 'off' }, attrs || {}));
        return f[name];
      }
      function select(name, options, value) {
        f[name] = el('select', { name: name }, options.map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === value }); }));
        return f[name];
      }
      function area(name, value) {
        f[name] = el('textarea', { name: name, rows: '3', maxlength: '2000' });
        f[name].value = value || '';
        return f[name];
      }
      // Every cost has a currency dropdown beside it. They start from the currency used last on this car.
      var defaultCurrency = existing ? existing.currency : ((draft && draft.currency) || lastCurrency[car.id] || car.currency || 'GBP');
      function currencyPick(name, value) {
        var sel = select(name, fmt.currencyOptions, value || defaultCurrency);
        sel.setAttribute('aria-label', 'Currency');
        return sel;
      }
      var currencySelect = currencyPick('currency', existing ? existing.currency : '');
      function costField(label, input, cur, hint, id) {
        input.id = id;
        return el('div', { class: 'field' }, [
          el('label', { for: id, text: label }),
          el('div', { class: 'odo-row' }, [input, cur]),
          hint ? el('div', { class: 'hint', text: hint }) : null,
        ]);
      }
      var amountRow = function (label, input, hint, id) { return costField(label, input, currencySelect, hint, id); };

      // ----- common fields -----
      var sections = [];
      // A maintenance entry can be logged against a reminder (from the email link, or picked here).
      var taskSelect = null;
      var preTask = null;
      if (type === 'Maintenance') {
        var choices = tasks.filter(function (t) { return t.kind === 'maintenance'; });
        var chosenId = existing ? existing.taskId : (ctx.query.task || '');
        preTask = choices.filter(function (t) { return t.id === chosenId; })[0] || null;
        taskSelect = el('select', { name: 'taskId' }, [el('option', { value: '', text: 'Not linked to a reminder' })].concat(
          choices.map(function (t) { return el('option', { value: t.id, text: t.name + ' (' + t.text + ')', selected: preTask && t.id === preTask.id }); })));
        // a finished maintenance entry has already moved its reminder on; it is not moved again by editing
        if (existing) taskSelect.disabled = true;
        f.taskId = taskSelect;
      }
      // A purchase is a list of items, then date, currency, supplier and link for the whole purchase (see below).
      var dateField = type === 'Purchase' ? null : UI.field('Date *', text('date', v.date || isoToday(), { type: 'date', max: isoToday(), required: true }));
      var top = type === 'Purchase' ? [] : [
        UI.field('Title *', text('title', v.title || (preTask ? preTask.name : ''), { maxlength: '120', placeholder: meta.placeholder, required: true })),
        dateField,
      ];
      var purchaseItems = []; // the items being edited (purchases only)

      // mileage (not for purchases), with an offer to update the car's odometer
      var odoCheck = el('input', { type: 'checkbox' });
      odoCheck.checked = true;
      var odoText = el('span', { text: 'Update the car\'s Odometer Log to this reading' });
      var odoRow = el('label', { class: 'check', hidden: true }, [odoCheck, odoText]);
      function mileageField(withoutOffer) {
        var m = text('mileage', v.mileage === null || v.mileage === undefined ? '' : v.mileage, { inputmode: 'numeric', id: 'f-mileage' });
        // The box starts empty: the vehicle's recorded mileage is only mentioned in the note below it.
        // The car's odometer is offered a rise whenever the reading is higher than what it shows now.
        function check() {
          var reading = num0(m.value);
          odoRow.hidden = !(reading > 0 && reading > Number(car.odometer || 0));
          odoText.textContent = 'Update the car\'s Odometer Log to ' + fmt.num(reading) + ' mi';
        }
        m.addEventListener('input', check);
        check();
        // a small note under the box says what the vehicle's recorded mileage is now
        var recorded = car.odometer !== null && car.odometer !== undefined
          ? 'The vehicle\'s recorded mileage is ' + fmt.num(car.odometer) + ' mi.'
          : 'No mileage is recorded for this vehicle yet.';
        return el('div', { class: 'field' }, [
          el('label', { for: 'f-mileage', text: 'Mileage (miles)' }),
          m,
          el('div', { class: 'hint recorded-mileage', text: recorded }),
          withoutOffer ? null : odoRow,
        ]);
      }

      // Issues, maintenance and renewals: the date and the mileage share a line; the offer to update the odometer sits just below them.
      if (type !== 'Purchase') {
        var at = top.indexOf(dateField);
        top.splice(at, 1, el('div', { class: 'field-pair' }, [dateField, mileageField(true)]), odoRow);
      }

      if (taskSelect) {
        top.push(UI.field('Reminder', taskSelect, 'Optional. Logging this moves that reminder on: its next due date and distance are worked out from this entry.'));
        taskSelect.addEventListener('change', function () {
          var t = tasks.filter(function (x) { return x.id === taskSelect.value; })[0];
          if (t && !f.title.value.trim()) f.title.value = t.name;
        });
      }

      var body = [];
      var costTotal = null;

      if (type === 'Issue') {
        body = [
          UI.field('Status', select('status', ISSUE_STATUSES.map(function (s) { return [s, s]; }), v.status || 'Not resolved')),
          UI.field('Garage or who identified the issue', text('vendor', v.vendor, { maxlength: '80' }), 'Optional.'),
          amountRow('Inspection or diagnosis fee', text('cost', v.cost === null || v.cost === undefined ? '' : v.cost, { inputmode: 'decimal' }), 'Optional.', 'f-cost'),
        ];
      } else if (type === 'Purchase') {
        costTotal = el('div', { class: 'job-total' });
        // what the purchase would be called if it had no name of its own (the server does the same)
        var derivedName = function (rows) {
          var first = rows[0] ? rows[0].name : '';
          return first + (rows.length > 1 ? ' + ' + (rows.length - 1) + ' more' : '');
        };
        var existingItems = existingData && existingData.items ? existingData.items : null;
        var fromReceipt = draft && draft.data ? (draft.data.items || []).map(function (i) { return { name: i.name, partNumber: i.partNumber || '', quantity: String(i.quantity), unitCost: i.unitCost === null || i.unitCost === undefined ? '' : String(i.unitCost) }; }) : [];
        if (draft && !fromReceipt.length) fromReceipt = [{ name: '', partNumber: '', quantity: '1', unitCost: draft.total === null ? '' : String(draft.total) }];
        purchaseItems = existingItems
          ? existingItems.map(function (i) { return { id: i.id, name: i.name, partNumber: i.partNumber || '', quantity: String(i.quantity), unitCost: i.unitCost === null || i.unitCost === undefined ? '' : String(i.unitCost), used: i.used || 0 }; })
          : fromReceipt.length ? fromReceipt.map(function (i) { return { id: '', name: i.name, partNumber: i.partNumber, quantity: i.quantity, unitCost: i.unitCost, used: 0 }; })
          : [{ id: '', name: '', partNumber: '', quantity: '1', unitCost: '', used: 0 }];
        var ownName = existing && existing.title !== derivedName(purchaseItems) ? existing.title : '';
        var itemsBox = el('div', { class: 'stack items-edit' });
        var updatePurchaseTotal = function () {
          var t = purchaseItems.reduce(function (sum, r) { return sum + num0(r.quantity) * num0(r.unitCost); }, 0);
          costTotal.replaceChildren(el('span', { text: purchaseItems.length > 1 ? 'Total of all items' : 'Total' }), el('strong', { text: fmt.money(round2(t), currencySelect.value) }));
          itemsBox.querySelectorAll('[data-line]').forEach(function (n) {
            var r = purchaseItems[Number(n.getAttribute('data-line'))];
            if (r) n.textContent = 'This item: ' + fmt.money(round2(num0(r.quantity) * num0(r.unitCost)), currencySelect.value);
          });
        };
        var drawItems = function () {
          itemsBox.replaceChildren.apply(itemsBox, purchaseItems.map(itemEditor));
          updatePurchaseTotal();
        };
        var itemEditor = function (row, idx) {
          function inp(key, attrs) {
            var input = el('input', Object.assign({ type: 'text', value: row[key] || '', autocomplete: 'off' }, attrs || {}));
            input.addEventListener('input', function () { row[key] = input.value; updatePurchaseTotal(); });
            return input;
          }
          var remove = null;
          if (purchaseItems.length > 1) {
            remove = el('button', { type: 'button', class: 'btn small danger', text: 'Remove item' });
            if (row.used > 0) { remove.disabled = true; remove.title = 'This item has been used in maintenance'; }
            remove.addEventListener('click', function () { purchaseItems.splice(purchaseItems.indexOf(row), 1); drawItems(); });
          }
          return el('div', { class: 'item-edit' }, [
            el('div', { class: 'item-head' }, [el('strong', { text: 'Item ' + (idx + 1) }), remove]),
            el('div', { class: 'field-pair' }, [
              UI.field('Item *', inp('name', { maxlength: '120', placeholder: 'e.g. Front brake pads' })),
              UI.field('Part number', inp('partNumber', { maxlength: '60' })),
            ]),
            el('div', { class: 'field-pair' }, [
              UI.field('Quantity *', inp('quantity', { inputmode: 'decimal' })),
              UI.field('Price of each *', inp('unitCost', { inputmode: 'decimal' })),
            ]),
            row.used > 0 ? el('div', { class: 'muted small-text', text: row.used + ' already used in maintenance, so it cannot be removed or bought fewer times.' }) : null,
            el('div', { class: 'muted small-text', 'data-line': String(idx) }),
          ]);
        };
        var addItem = el('button', { type: 'button', class: 'btn small secondary', text: 'Add another item' });
        addItem.addEventListener('click', function () {
          purchaseItems.push({ id: '', name: '', partNumber: '', quantity: '1', unitCost: '', used: 0 });
          drawItems();
          var last = itemsBox.querySelector('.item-edit:last-child input');
          if (last) last.focus();
        });
        top = [
          UI.field('Purchase name', text('title', ownName, { maxlength: '120', placeholder: 'e.g. Euro Car Parts order' }), 'Optional. If left empty, the purchase is named after its items.'),
          el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Items bought' }), itemsBox, el('div', { class: 'btn-row' }, [addItem])]),
        ];
        body = [
          el('div', { class: 'field-pair' }, [
            UI.field('Date *', text('date', v.date || isoToday(), { type: 'date', max: isoToday(), required: true })),
            UI.field('Currency', currencySelect),
          ]),
          el('div', { class: 'field-pair' }, [
            UI.field('Supplier or shop', text('vendor', v.vendor, { maxlength: '80' })),
            UI.field('Product link', text('productUrl', v.productUrl, { inputmode: 'url', placeholder: 'https://…' })),
          ]),
          costTotal,
        ];
        currencySelect.addEventListener('change', updatePurchaseTotal);
        drawItems();
      } else {
        body = jobFields();
      }

      // ----- maintenance: parts, labour, other costs -----
      function jobFields() {
        var out = [UI.field('Garage or who did the work', text('vendor', v.vendor, { maxlength: '80' }), 'Optional.')]; // the mileage sits beside the date, near the top

        var issueSelect = null;
        var resolveCheck = null;
        {
          issueSelect = el('select', { name: 'linkedIssueId' }, [el('option', { value: '', text: 'Not linked to an issue' })].concat(
            lists.issues.map(function (i) { return el('option', { value: i.id, text: i.title + ' (' + i.status + ')', selected: i.id === v.linkedIssueId }); })));
          f.linkedIssueId = issueSelect;
          resolveCheck = el('input', { type: 'checkbox' });
          resolveCheck.checked = true;
          var resolveRow = el('label', { class: 'check', hidden: true }, [resolveCheck, el('span', { text: 'Mark this issue as Resolved' })]);
          var syncResolve = function () {
            var chosen = lists.issues.filter(function (i) { return i.id === issueSelect.value; })[0];
            resolveRow.hidden = !(chosen && chosen.status !== 'Resolved');
          };
          issueSelect.addEventListener('change', syncResolve);
          syncResolve();
          f.resolve = resolveCheck;
          out.push(el('div', { class: 'field' }, [el('label', { text: 'Fixes an issue?' }), issueSelect, resolveRow]));
        }

        // cost mode
        var modeItemised = el('input', { type: 'radio', name: 'costMode', value: 'itemised' });
        var labourCur = currencyPick('labourCurrency', existing ? existing.labourCurrency : '');
        var otherCur = currencyPick('otherCurrency', existing ? existing.otherCurrency : '');
        var lumpCur = currencyPick('lumpCurrency', existing ? existing.lumpCurrency : '');
        var modeLump = el('input', { type: 'radio', name: 'costMode', value: 'lump' });
        (existing && v.costMode !== 'lump' ? modeItemised : modeLump).checked = true; // a new entry starts as "Invoice total only"; an existing one keeps how it was recorded
        var itemisedBox = el('div', { class: 'stack' });
        var lumpBox = el('div');
        var totalBox = el('div', { class: 'job-total' });

        // parts
        var partRows = [];
        if (existingData && existingData.parts) {
          existingData.parts.forEach(function (p) {
            partRows.push({ kind: 'existing', purchaseId: p.purchaseId, name: p.name, quantity: String(p.quantity), unitCost: p.unitCost, currency: p.currency });
          });
        }
        var partsBox = el('div', { class: 'stack' });
        var pickBox = el('div');
        function availableFor(purchaseId) {
          var p = lists.purchases.filter(function (x) { return x.id === purchaseId; })[0];
          return p ? p.available : 0;
        }
        function jobTotals() {
          var map = {};
          var add = function (c, a) { if (a) map[c] = round2((map[c] || 0) + a); };
          if (modeLump.checked) {
            add(lumpCur.value, num0(f.lumpSumCost.value));
          } else {
            add(labourCur.value, num0(f.labourCost.value));
            add(otherCur.value, num0(f.otherCost.value));
            partRows.forEach(function (r) {
              var q = num0(r.quantity);
              if (r.kind === 'existing') add(r.currency, q * (r.unitCost || 0));
              else add(r.currency || defaultCurrency, q * num0(r.unitCost));
            });
          }
          return map;
        }
        function updateTotal() {
          var t = moneyMap(jobTotals());
          totalBox.replaceChildren(el('span', { text: 'Job cost' }), el('strong', { text: t || fmt.money(0, labourCur.value) }));
        }
        function partInput(row, key, label, attrs) {
          var input = el('input', Object.assign({ type: 'text', value: row[key] === undefined ? '' : String(row[key]), autocomplete: 'off' }, attrs || {}));
          input.addEventListener('input', function () { row[key] = input.value; updateTotal(); });
          return UI.field(label, input);
        }
        function partEl(row, i) {
          var remove = el('button', { type: 'button', class: 'btn small danger', text: 'Remove' });
          remove.addEventListener('click', function () { partRows.splice(i, 1); drawParts(); });
          if (row.kind === 'existing') {
            return el('div', { class: 'part-row' }, [
              el('div', { class: 'person-car', text: row.name }),
              el('div', { class: 'muted small-text', text: 'From your purchased items · up to ' + availableFor(row.purchaseId) + ' available · ' + fmt.money(row.unitCost, row.currency) + ' each' }),
              partInput(row, 'quantity', 'Quantity used', { inputmode: 'decimal' }),
              remove,
            ]);
          }
          var cur = el('select', { 'aria-label': 'Currency of this part' }, fmt.currencyOptions.map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === row.currency }); }));
          cur.addEventListener('change', function () { row.currency = cur.value; updateTotal(); });
          return el('div', { class: 'part-row' }, [
            partInput(row, 'name', 'New part', { maxlength: '120', placeholder: 'e.g. Brake pads' }),
            partInput(row, 'quantity', 'Quantity', { inputmode: 'decimal' }),
            el('div', { class: 'field' }, [el('label', { text: 'Price of each' }), el('div', { class: 'odo-row' }, [
              (function () { var i2 = el('input', { type: 'text', value: row.unitCost || '', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Price of each' }); i2.addEventListener('input', function () { row.unitCost = i2.value; updateTotal(); }); return i2; })(),
              cur,
            ])]),
            partInput(row, 'partNumber', 'Part number (optional)', { maxlength: '60' }),
            partInput(row, 'vendor', 'Supplier (optional)', { maxlength: '80' }),
            remove,
          ]);
        }
        function drawParts() {
          partsBox.replaceChildren.apply(partsBox, partRows.length ? partRows.map(partEl) : [el('p', { class: 'muted', text: 'No parts added yet.' })]);
          updateTotal();
        }
        var useBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Use a purchased item' });
        useBtn.addEventListener('click', function () {
          if (pickBox.childNodes.length) { pickBox.replaceChildren(); return; }
          var chosen = {};
          partRows.forEach(function (r) { if (r.kind === 'existing') chosen[r.purchaseId] = true; });
          var avail = lists.purchases.filter(function (p) { return !chosen[p.id] && p.available > 0; });
          pickBox.replaceChildren.apply(pickBox, avail.length ? avail.map(function (p) {
            var b = el('button', { type: 'button', class: 'pick-item', text: p.name + (p.from ? ' (' + p.from + ')' : '') + ' — ' + p.available + ' left · ' + fmt.money(p.unitCost, p.currency) + ' each' });
            b.addEventListener('click', function () {
              partRows.push({ kind: 'existing', purchaseId: p.id, name: p.name, quantity: String(Math.min(1, p.available)), unitCost: p.unitCost, currency: p.currency });
              pickBox.replaceChildren();
              drawParts();
            });
            return b;
          }) : [el('p', { class: 'muted', text: 'No purchased items left in stock. Add a new part below, or log the purchase first.' })]);
        });
        var newBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add a new part' });
        newBtn.addEventListener('click', function () {
          partRows.push({ kind: 'new', name: '', quantity: '1', unitCost: '', partNumber: '', vendor: '', currency: defaultCurrency });
          drawParts();
        });

        var labour = [
          costField('Labour cost', text('labourCost', v.labourCost === null || v.labourCost === undefined ? '' : v.labourCost, { inputmode: 'decimal' }), labourCur, null, 'f-labour'),
          UI.field('Who did the labour', text('labourNote', v.labourNote, { maxlength: '80' }), 'Optional, e.g. the garage or "myself".'),
          UI.field('Hours', text('labourHours', v.labourHours === null || v.labourHours === undefined ? '' : v.labourHours, { inputmode: 'decimal' }), 'Optional.'),
          costField('Other costs', text('otherCost', v.otherCost === null || v.otherCost === undefined ? '' : v.otherCost, { inputmode: 'decimal' }), otherCur, 'Optional: call-out, disposal, consumables.', 'f-other'),
          UI.field('What the other costs are for', text('otherNote', v.otherNote, { maxlength: '80' })),
        ];
        itemisedBox.append(
          el('div', { class: 'field-label', text: 'Parts' }), partsBox, pickBox,
          el('div', { class: 'btn-row' }, [useBtn, newBtn])
        );
        labour.forEach(function (x) { itemisedBox.append(x); });
        lumpBox.append(costField('Invoice total', text('lumpSumCost', v.lumpSumCost === null || v.lumpSumCost === undefined ? '' : v.lumpSumCost, { inputmode: 'decimal' }), lumpCur, 'The single figure on the invoice, with no breakdown.', 'f-lump'));

        function syncMode() {
          itemisedBox.hidden = modeLump.checked;
          lumpBox.hidden = !modeLump.checked;
          updateTotal();
        }
        modeItemised.addEventListener('change', syncMode);
        modeLump.addEventListener('change', syncMode);
        ['labourCost', 'otherCost', 'lumpSumCost'].forEach(function (k) { f[k].addEventListener('input', updateTotal); });
        [labourCur, otherCur, lumpCur].forEach(function (c) { c.addEventListener('change', updateTotal); });
        f.modeLump = modeLump;
        f.partRows = partRows;

        out.push(
          el('div', { class: 'field' }, [
            el('div', { class: 'field-label', text: 'How do you want to record the cost?' }),
            el('label', { class: 'check' }, [modeLump, el('span', { text: 'Invoice total only' })]),
            el('label', { class: 'check' }, [modeItemised, el('span', { text: 'Itemised: parts, labour and other costs' })]),
          ]),
          itemisedBox, lumpBox, totalBox
        );
        drawParts();
        syncMode();
        return out;
      }

      // ----- notes + attachments -----
      var notesField = UI.field('Notes', area('notes', v.notes));
      var staged = [];
      var stagedBox = el('div', { class: 'stack' });
      // A receipt being turned into this entry is listed with the files to add, and is attached when the entry is saved
      var receiptRow = null;
      var skipReceipt = false;
      if (draft) {
        var rView = el('button', { type: 'button', class: 'btn small secondary', text: 'View' });
        rView.addEventListener('click', function () {
          Viewer.show({ mime: draft.mime, filename: draft.filename, load: function () { return FleetApi.call('getReceiptFile', { id: draft.id }, { timeoutMs: UPLOAD_TIMEOUT_MS }).then(function (r) { return r.data; }); } })
            .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
        var rDrop = el('button', { type: 'button', class: 'btn small secondary', text: 'Don\'t add' });
        rDrop.addEventListener('click', function () { skipReceipt = true; receiptRow.remove(); receiptRow = null; countAttached(-1); });
        receiptRow = el('div', { class: 'attach-row staged' }, [
          el('div', { class: 'attach-name', text: fileIcon(draft.mime) + (draft.filename || 'receipt') }),
          el('div', { class: 'attach-actions' }, [rView, rDrop]),
        ]);
      }
      function drawStaged() {
        stagedBox.replaceChildren.apply(stagedBox, staged.map(function (s, i) {
          var rm = el('button', { type: 'button', class: 'btn small secondary', text: 'Don\'t add' });
          rm.addEventListener('click', function () { staged.splice(i, 1); drawStaged(); });
          return el('div', { class: 'attach-row staged' }, [el('div', { class: 'attach-name', text: fileIcon(/^image\//.test(s.type || '') ? 'image/jpeg' : s.type === 'application/pdf' ? 'application/pdf' : '') + s.name }), rm]);
        }));
        if (stagedBox.parentNode) stagedBox.parentNode.hidden = !staged.length;
      }
      function stage(file) { staged.push({ file: file, name: file.name || 'photo', type: file.type }); drawStaged(); }
      var attachList = el('div', { class: 'stack' });
      var existingCount = existingData ? existingData.attachments.length : 0;
      var existingHead = el('div', { class: 'attach-title', text: 'Attached files' + (existingCount ? ' (' + existingCount + ')' : '') });
      var formHooks = {
        error: function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); },
        removed: function (a, row) {
          row.remove();
          existingCount -= 1;
          if (!existingCount) attachList.append(el('p', { class: 'muted', text: 'Nothing attached yet.' }));
          existingHead.textContent = 'Attached files' + (existingCount ? ' (' + existingCount + ')' : '');
        },
      };
      // the receipt being turned into this entry counts as an attached file (it is attached when the entry is saved)
      var shownCount = existingCount + (receiptRow ? 1 : 0);
      function countAttached(change) {
        shownCount += change;
        existingHead.textContent = 'Attached files' + (shownCount ? ' (' + shownCount + ')' : '');
        if (!shownCount && !attachList.querySelector('.attach-empty')) attachList.append(el('p', { class: 'muted attach-empty', text: 'Nothing attached yet.' }));
      }
      if (existingCount) existingData.attachments.forEach(function (a) { attachList.append(attachmentRow(a, formHooks)); });
      if (receiptRow) attachList.append(receiptRow);
      if (!shownCount) attachList.append(el('p', { class: 'muted attach-empty', text: 'Nothing attached yet.' }));
      existingHead.textContent = 'Attached files' + (shownCount ? ' (' + shownCount + ')' : '');
      var stagedHead = el('div', { class: 'attach-title', text: 'Ready to add when you save' });
      var addBlock = addPanel(stage, 'Receipts, invoices, quotes, photos of the problem or any other file. Photos are shrunk automatically; other files can be up to 5 MB.');
      addBlock.append(el('div', { class: 'attach-staged', hidden: true }, [stagedHead, stagedBox]));
      var attachSection = el('div', { class: 'field attach-section' }, [
        el('div', { class: 'field-label', text: 'Photos and documents' }),
        el('div', { class: 'attach-existing' }, [existingHead, attachList]),
        addBlock,
      ]);

      // ----- save -----
      var btn = el('button', { type: 'submit', class: 'btn block big save-gap', text: existing ? 'Save changes' : 'Add ' + meta.label.toLowerCase() });
      var form = el('form', { novalidate: true }, top.concat(body, [notesField, attachSection, btn]));

      function collect() {
        var fields = {};
        ['title', 'date', 'mileage', 'vendor', 'notes', 'status', 'cost', 'partNumber', 'quantity', 'unitCost',
          'productUrl', 'lumpSumCost', 'labourCost', 'labourNote', 'labourHours', 'otherCost', 'otherNote', 'linkedIssueId',
          'labourCurrency', 'otherCurrency', 'lumpCurrency'].forEach(function (k) {
          if (f[k]) fields[k] = f[k].value;
        });
        // the entry's main currency: for maintenance it follows the labour (or the invoice total)
        fields.currency = isJob ? (f.modeLump.checked ? f.lumpCurrency.value : f.labourCurrency.value) : currencySelect.value;
        if (isJob) fields.costMode = f.modeLump.checked ? 'lump' : 'itemised';
        return fields;
      }

      var state = { entryId: existing ? existing.id : '', version: existing ? existing.version : 0 };
      var reminderNote = '';
      var uploadFailed = false;

      function uploadStaged(entryId) {
        var i = 0;
        function next() {
          if (i >= staged.length) return Promise.resolve();
          var s = staged[i];
          return Photos.prepareAttachment(s.file).then(function (a) {
            return FleetApi.call('uploadAttachment', { entryId: entryId, mime: a.mime, data: a.data, thumb: a.thumb, filename: a.filename }, { timeoutMs: UPLOAD_TIMEOUT_MS });
          }).then(function () { i++; return next(); }, function (e) {
            uploadFailed = true;
            FleetApp.setFlash('error', 'The entry was saved, but "' + s.name + '" could not be attached: ' + UI.errorText(e) + ' You can add it with Edit.');
          });
        }
        return next();
      }

      // A receipt from the Inbox is attached to the saved entry, and leaves the Inbox. (Saving again after a failure only repeats this step.)
      function attachReceipt(entryId) {
        if (!draft || state.receiptDone) return Promise.resolve();
        return FleetApi.call('resolveReceipt', { id: draft.id, entryId: entryId, attach: !skipReceipt }).then(function () {
          state.receiptDone = true;
          if (window.InboxUI) InboxUI.refreshCount();
        }, function (e) {
          e.prefix = 'The entry was saved, but the receipt could not be attached to it. ';
          throw e;
        });
      }

      function run() {
        var payload = { fields: collect() };
        if (state.entryId) { payload.id = state.entryId; payload.version = state.version; } else { payload.carId = car.id; payload.type = type; }
        if (isJob) {
          payload.parts = f.modeLump.checked ? [] : f.partRows.map(function (r) {
            return r.kind === 'existing'
              ? { purchaseId: r.purchaseId, quantity: r.quantity }
              : { name: r.name, quantity: r.quantity, unitCost: r.unitCost, partNumber: r.partNumber, vendor: r.vendor, currency: r.currency };
          });
          if (f.resolve && f.linkedIssueId.value) payload.resolveIssue = f.resolve.checked;
        }
        if (type === 'Purchase') {
          payload.items = purchaseItems.map(function (r) { return { id: r.id, name: r.name, partNumber: r.partNumber, quantity: r.quantity, unitCost: r.unitCost }; });
        }
        if (f.mileage && !odoRow.hidden && odoCheck.checked) payload.updateOdometer = true;
        if (taskSelect && taskSelect.value && !taskSelect.disabled) payload.taskId = taskSelect.value;
        return FleetApi.call('saveEntry', payload).then(function (r) {
          var entry = r.data.entry;
          reminderNote = r.data.reminder ? 'Reminder "' + r.data.reminder.name + '" is now ' + r.data.reminder.text + '.' : '';
          state.entryId = entry.id;
          state.version = entry.version;
          Views.invalidateCars();
          lastCurrency[car.id] = entry.currency;
          return attachReceipt(entry.id).then(function () { return uploadStaged(entry.id); }).then(function () {
            if (reminderNote && !uploadFailed) FleetApp.setFlash('ok', reminderNote);
            FleetApp.go('/car/' + car.id + '/entry/' + entry.id);
          });
        });
      }

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        UI.busy(btn, 'Saving…', run()).catch(function (e) {
          msg.replaceChildren(UI.notice('error', (e.prefix || '') + UI.errorText(e) + (e.prefix ? ' Tap the button again to retry.' : '')));
          window.scrollTo(0, 0);
        });
      });

      root.replaceChildren(el('section', { class: 'card' }, [
        draft ? fmt.backLink('#/inbox/' + draft.id, 'The receipt') : fmt.backLink(existing ? '#/car/' + car.id + '/entry/' + existing.id : '#/car/' + car.id + '/add', existing ? existing.title : 'Add an entry'),
        el('h1', { text: existing ? 'Edit ' + meta.label.toLowerCase() : 'Add ' + (type === 'Purchase' ? 'a purchased item' : type === 'Maintenance' ? 'maintenance' : 'a ' + meta.label.toLowerCase()) }),
        el('p', { class: 'muted', text: car.registration + ' · ' + car.make + ' ' + car.model + '. ' + meta.blurb }),
        draft ? InboxUI.panel(draft) : null,
        msg, form,
      ]));
    }

    /** The boxes of the form that a receipt from the Inbox can fill in. */
    function draftValues(draft, type) {
      var d = draft.data || {};
      var v = { date: draft.date || '', vendor: draft.vendor || '', notes: d.orderNumber ? 'Order number ' + d.orderNumber + '.' : '' };
      if (type === 'Maintenance') {
        v.title = d.title || (d.work ? d.work.slice(0, 120) : ''); // the entry's own title; the garage goes in its own box
        v.mileage = d.mileage ? String(d.mileage) : '';
        v.costMode = 'lump';
        v.lumpSumCost = draft.total === null ? '' : String(draft.total);
      }
      return v;
    }
  };
})();
