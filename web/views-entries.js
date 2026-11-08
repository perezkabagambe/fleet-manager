// A car's history: the History and Costs cards, the "what do you want to add?" chooser,
// the entry page, and the form for issues, maintenance, purchases and compliance.
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
    compliance: { type: 'Compliance', label: 'Compliance', blurb: 'Renewals and tests that must be kept up to date.',
      examples: 'MOT passed · Insurance renewed · Road tax renewed', placeholder: 'e.g. MOT passed' },
  };
  var BY_TYPE = {};
  Object.keys(TYPES).forEach(function (k) { BY_TYPE[TYPES[k].type] = Object.assign({ key: k }, TYPES[k]); });
  var PLURAL = { Issue: 'Issues', Maintenance: 'Maintenance', Purchase: 'Purchases', Compliance: 'Compliance' };

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
  function typeChip(type) { return el('span', { class: 'chip t-' + type.toLowerCase(), text: BY_TYPE[type].label }); }
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

  function costText(e) {
    if (e.type === 'Maintenance') return moneyMap(e.jobCost);
    if (e.type === 'Purchase') return fmt.money(e.total, e.currency);
    if ((e.type === 'Issue' || e.type === 'Compliance') && e.cost !== null && e.cost !== undefined) return fmt.money(e.cost, e.currency);
    return '';
  }

  // ---------- History card (on the car page) ----------
  // `preloaded` (the car page's entries) saves a request; without it the card fetches its own.
  function historyCard(car, preloaded) {
    var chips = el('div', { class: 'filters', role: 'group', 'aria-label': 'Filter the history' });
    var list = el('div', { class: 'history' }, [fmt.loading()]);
    var filter = 'All';
    var data = [];
    var editing = false; // the section's Edit button shows an Edit button on every row

    function row(e) {
      var meta = [e.ref, dateText(e.date)].filter(Boolean); // the reference first, e.g. M-0042
      if (e.mileage !== null) meta.push(mileageText(e, car));
      if (e.vendor) meta.push(e.vendor);
      var tags = [];
      if (e.type === 'Issue') tags.push(el('span', { class: 'chip st-' + e.status.toLowerCase().replace(/[^a-z]/g, ''), text: e.status }));
      if (e.type === 'Purchase') tags.push(el('span', { class: 'chip ' + (e.stockStatus === 'In stock' ? 'active' : e.stockStatus === 'Fitted' ? 'sold' : 'pending'), text: e.stockStatus }));
      if (e.attachmentCount) tags.push(el('span', { class: 'muted small-text', text: '📎 ' + e.attachmentCount }));
      if (e.guestName) tags.push(GuestUI.chip(e));
      var cost = costText(e);
      var link = el('a', { class: 'entry-row', href: '#/car/' + car.id + '/entry/' + e.id }, [
        e.thumbAttachmentId ? Photos.thumbBox(e.thumbAttachmentId, 'row-thumb') : null,
        el('div', { class: 'entry-main' }, [
          el('div', { class: 'entry-title', text: e.title }),
          el('div', { class: 'entry-meta' }, [
            el('span', { class: 'muted small-text', text: meta.join(' · ') }),
            cost ? el('strong', { class: 'entry-cost', text: cost }) : null,
          ]),
        ]),
        // the type, status (Fitted, Resolved...) and attachment count all sit to the right of the name
        el('div', { class: 'entry-tags' }, [typeChip(e.type)].concat(tags)),
      ]);
      // a small link icon beside each row copies a link straight to that entry
      return el('div', { class: 'entry-line' }, [
        link,
        editing ? el('a', { class: 'btn small secondary row-edit', href: '#/car/' + car.id + '/entry/' + e.id + '/edit', text: 'Edit', 'aria-label': 'Edit ' + e.title }) : null,
        UI.copyLinkButton(fmt.entryUrl(car.id, e.id), { aria: 'Copy link to ' + e.title }),
      ]);
    }

    function render() {
      chips.replaceChildren();
      var counts = {};
      data.forEach(function (e) { counts[e.type] = (counts[e.type] || 0) + 1; });
      if (Object.keys(counts).length > 1) {
        ['All'].concat(Object.keys(PLURAL).filter(function (t) { return counts[t]; })).forEach(function (t) {
          var b = el('button', { type: 'button', class: 'filter-chip' + (t === filter ? ' on' : ''), 'aria-pressed': t === filter ? 'true' : 'false',
            text: (t === 'All' ? 'All' : PLURAL[t]) + ' (' + (t === 'All' ? data.length : counts[t]) + ')' });
          b.addEventListener('click', function () { filter = t; render(); });
          chips.append(b);
        });
      }
      var shown = data.filter(function (e) { return filter === 'All' || e.type === filter; });
      list.replaceChildren.apply(list, shown.length ? shown.map(row)
        : [el('p', { class: 'muted', text: data.length ? 'Nothing of that kind yet.' : 'Nothing recorded yet. Add the first entry above.' })]);
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

    var editBtn = UI.editToggle(function (on) { editing = on; render(); });
    return el('section', { class: 'card' }, [
      el('h2', { text: 'Maintenance & Issues Log' }),
      el('div', { class: 'section-tools' }, [editBtn]),
      el('a', { class: 'btn block big', href: '#/car/' + car.id + '/add', text: 'Add entry' }),
      chips, list,
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

  window.EntryUI = { historyCard: historyCard, costsCard: costsCard };

  // ---------- "What do you want to add?" ----------
  Views.chooseEntry = function (ctx, root) {
    var carId = ctx.params.id;
    root.replaceChildren(el('section', { class: 'card' }, [fmt.loading()]));
    FleetApi.call('getCar', { id: carId }).then(function (r) {
      var car = r.data.car;
      var cards = ['issue', 'maintenance', 'purchase', 'compliance'].map(function (k) {
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
    root.replaceChildren(el('section', { class: 'card' }, [fmt.loading()]));
    FleetApi.call('getEntry', { id: id }).then(function (r) { render(r.data); }).catch(function (e) {
      if (e.code === 'not_found') {
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
      var flash = FleetApp.takeFlash();
      if (flash) msg.append(UI.notice(flash.kind, flash.text));

      function line(label, value) { return value ? [el('dt', { text: label }), el('dd', { text: value })] : []; }

      // header
      var meta = [dateText(e.date)];
      if (e.mileage !== null) meta.push(mileageText(e, car));
      if (e.vendor) meta.push(e.vendor);
      var deleteBtn = null;
      if (FleetAuth.isAdmin()) {
        deleteBtn = el('button', { type: 'button', class: 'btn small danger', text: 'Delete' });
        deleteBtn.addEventListener('click', function () {
          UI.confirm('Delete this ' + e.type.toLowerCase() + '? It will be hidden everywhere, and any parts it used go back to stock.', { okLabel: 'Delete', danger: true }).then(function (yes) {
            if (!yes) return;
            UI.busy(deleteBtn, 'Deleting…', FleetApi.call('deleteEntry', { id: e.id }))
              .then(function () { Views.invalidateCars(); FleetApp.go('/car/' + carId); })
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

      var cards = [el('div', { class: 'copy-row' }, [UI.copyLinkButton(fmt.entryUrl(carId, e.id), { label: 'Copy link to this entry' })]),
        el('section', { class: 'card' }, [
        fmt.backLink('#/car/' + carId, car.registration),
        el('div', { class: 'page-head' }, [el('div', { class: 'head-with-thumb' }, [topThumb, el('div', {}, [el('h1', { text: e.title }), el('div', { class: 'muted', text: meta.join(' · ') }), e.ref ? el('div', { class: 'ref-line' }, [el('span', { class: 'ref-badge', text: e.ref }), UI.copyValueButton(e.ref, 'Copy reference ' + e.ref)]) : null])]), el('div', { class: 'entry-tags' }, [typeChip(e.type), e.guestName ? GuestUI.chip(e) : null])]),
        msg, statusArea,
        d.reminder ? el('p', { class: 'muted small-text' }, [el('span', { text: 'Reminder: ' }), el('a', { href: '#/car/' + carId + '/reminder/' + d.reminder.id, text: d.reminder.name })]) : null,
        el('a', { class: 'btn block big edit-top', href: '#/car/' + carId + '/entry/' + e.id + '/edit', text: 'Edit ' + BY_TYPE[e.type].label.toLowerCase() }),
        deleteBtn ? el('div', { class: 'btn-row' }, [deleteBtn]) : null,
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
            ? el('div', {}, [el('div', { class: 'field-label', text: 'Maintenance for this issue' })].concat(d.fixedBy.map(function (r) {
              return el('div', {}, [el('a', { href: '#/car/' + carId + '/entry/' + r.id, text: r.title + ' · ' + dateText(r.date) })]);
            })))
            : el('p', { class: 'muted', text: 'No maintenance linked to this issue yet.' }),
        ]));
      } else if (e.type === 'Compliance') {
        cards.push(el('section', { class: 'card' }, [el('h2', { text: 'Details' }), el('dl', { class: 'details' }, [].concat(
          line('Cost', e.cost === null ? '' : fmt.money(e.cost, e.currency)), line('Valid until', dateText(e.expiryDate))))]));
      } else if (e.type === 'Purchase') {
        var s = d.stock;
        var pd = [].concat(
          line('Part number', e.partNumber), line('Quantity bought', String(e.quantity)),
          line('Price each', fmt.money(e.unitCost, e.currency)),
          e.shippingCost !== null ? line('Shipping', fmt.money(e.shippingCost, e.currency)) : [],
          line('Total paid', fmt.money(s.total, e.currency)),
          line('Used / left', s.used + ' used · ' + s.remaining + ' left')
        );
        cards.push(el('section', { class: 'card' }, [
          el('h2', { text: 'Item' }), el('dl', { class: 'details' }, pd),
          e.productUrl ? el('p', {}, [el('a', { class: 'btn small secondary', href: e.productUrl, target: '_blank', rel: 'noopener noreferrer', text: 'Link: ' + fmt.hostOf(e.productUrl) })]) : null,
          d.usedIn && d.usedIn.length
            ? el('div', {}, [el('div', { class: 'field-label', text: 'Used in' })].concat(d.usedIn.map(function (u) {
              return el('div', {}, [el('a', { href: '#/car/' + carId + '/entry/' + u.id, text: u.title + ' × ' + u.quantity })]);
            })))
            : null,
        ]));
      }

      if (e.notes) cards.push(el('section', { class: 'card' }, [el('h2', { text: 'Notes' }), el('p', { class: 'notes', text: e.notes })]));

      // attachments
      var attBox = el('div', { class: 'stack' });
      function drawAttachments() {
        attBox.replaceChildren.apply(attBox, d.attachments.length ? d.attachments.map(attachmentRow)
          : [el('p', { class: 'muted', text: 'Nothing attached.' })]);
      }
      function attachmentRow(a) {
        var isImage = a.mime === 'image/jpeg';
        var view = el('button', { type: 'button', class: 'btn small secondary', text: isImage ? 'View' : a.mime === 'application/pdf' ? 'Open' : 'Download' });
        var holder = el('div');
        view.addEventListener('click', function () {
          UI.busy(view, 'Loading…', Photos.fetchAttachment(a.id)).then(function (att) {
            var url = Photos.toBlobUrl(att);
            if (!isImage) { // PDFs and other files are saved or opened by the phone, never shown inside the app
              var link = el('a', { href: url, download: att.filename });
              document.body.append(link); link.click(); link.remove();
            } else {
              holder.replaceChildren(el('img', { class: 'attach-img', src: url, alt: att.filename }));
            }
          }).catch(function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); });
        });
        var buttons = [view];
        if (FleetAuth.isAdmin()) {
          var rm = el('button', { type: 'button', class: 'btn small danger', text: 'Remove' });
          rm.addEventListener('click', function () {
            UI.confirm('Remove ' + a.filename + '?', { okLabel: 'Remove', danger: true }).then(function (yes) {
              if (!yes) return;
              UI.busy(rm, 'Removing…', FleetApi.call('deleteAttachment', { id: a.id })).then(function () {
                d.attachments = d.attachments.filter(function (x) { return x.id !== a.id; });
                drawAttachments();
                refreshTopThumb();
              }).catch(function (err) { msg.replaceChildren(UI.notice('error', UI.errorText(err))); });
            });
          });
          buttons.push(rm);
        }
        return el('div', { class: 'attach-row' }, [
          el('div', { class: 'attach-name', text: fileIcon(a.mime) + a.filename + ' · ' + kb(a.size) }),
          el('div', { class: 'btn-row' }, buttons), holder,
        ]);
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
      cards.push(el('section', { class: 'card' }, [
        el('h2', { text: 'Photos and documents' }),
        attBox,
        el('div', { class: 'btn-row' }, [
          Photos.fileButton('Take photo', 'image/*', true, addFile),
          Photos.fileButton('Choose photo', 'image/*', false, addFile),
          Photos.fileButton('Add file', '', false, addFile),
        ]),
        el('div', { class: 'hint', text: 'Receipts, invoices, quotes, photos or any other file. Photos are shrunk automatically; other files can be up to 5 MB.' }),
      ]));

      cards.push(el('a', { class: 'btn block big edit-bottom', href: '#/car/' + carId + '/entry/' + e.id + '/edit', text: 'Edit ' + BY_TYPE[e.type].label.toLowerCase() }));
      root.replaceChildren.apply(root, cards);
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
    if (eid) calls.push(FleetApi.call('getEntry', { id: eid }));
    Promise.all(calls).then(function (res) {
      build(res[0].data.car, res[1].data, res[3] ? res[3].data : null, res[2].data.tasks);
    }).catch(function (e) {
      if (e.code === 'not_found') fmt.notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function build(car, lists, existingData, tasks) {
      var existing = existingData ? existingData.entry : null;
      var type = existing ? existing.type : TYPES[typeKey].type;
      var meta = BY_TYPE[type];
      var isJob = type === 'Maintenance';
      var v = existing || {};
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
      var defaultCurrency = existing ? existing.currency : (lastCurrency[car.id] || car.currency || 'GBP');
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
      // A maintenance entry can be logged against a reminder (from the email link, or picked here); a renewal can name the one it renews.
      var taskSelect = null;
      var preTask = null;
      if (type === 'Maintenance' || type === 'Compliance') {
        var wanted = type === 'Maintenance' ? 'maintenance' : 'compliance';
        var choices = tasks.filter(function (t) { return t.kind === wanted; });
        var chosenId = existing ? existing.taskId : (ctx.query.task || '');
        preTask = choices.filter(function (t) { return t.id === chosenId; })[0] || null;
        taskSelect = el('select', { name: 'taskId' }, [el('option', { value: '', text: type === 'Maintenance' ? 'Not linked to a reminder' : 'None of these' })].concat(
          choices.map(function (t) { return el('option', { value: t.id, text: t.name + ' (' + t.text + ')', selected: preTask && t.id === preTask.id }); })));
        // a finished maintenance entry has already moved its reminder on; it is not moved again by editing
        if (existing && type === 'Maintenance') taskSelect.disabled = true;
        f.taskId = taskSelect;
      }
      var top = [
        UI.field(type === 'Purchase' ? 'Item *' : 'Title *', text('title', v.title || (preTask ? preTask.name : ''), { maxlength: '120', placeholder: meta.placeholder, required: true })),
        UI.field(type === 'Compliance' ? 'Date done or paid *' : 'Date *', text('date', v.date || isoToday(), { type: 'date', max: isoToday(), required: true })),
      ];

      // mileage (not for purchases), with an offer to update the car's odometer
      var odoCheck = el('input', { type: 'checkbox' });
      odoCheck.checked = true;
      var odoText = el('span', { text: 'Update the car\'s Odometer Log to this reading' });
      var odoRow = el('label', { class: 'check', hidden: true }, [odoCheck, odoText]);
      function mileageField() {
        var m = text('mileage', v.mileage === null || v.mileage === undefined ? '' : v.mileage, { inputmode: 'numeric', id: 'f-mileage' });
        // The car's odometer is offered a rise whenever the reading is higher than what it shows now.
        function check() {
          var reading = num0(m.value);
          odoRow.hidden = !(reading > 0 && reading > Number(car.odometer || 0));
          odoText.textContent = 'Update the car\'s Odometer Log to ' + fmt.num(reading) + ' mi';
        }
        m.addEventListener('input', check);
        check();
        return el('div', { class: 'field' }, [
          el('label', { for: 'f-mileage', text: 'Mileage (miles)' }),
          m,
          odoRow,
        ]);
      }

      if (taskSelect) {
        top.push(UI.field('Reminder', taskSelect, type === 'Maintenance'
          ? 'Optional. Logging this moves that reminder on: its next due date and distance are worked out from this entry.'
          : 'Optional. Pick the reminder this renews. If you set a new expiry date below, a reminder is kept for it automatically.'));
        taskSelect.addEventListener('change', function () {
          var t = tasks.filter(function (x) { return x.id === taskSelect.value; })[0];
          if (t && !f.title.value.trim()) f.title.value = t.name;
        });
      }

      var body = [];
      var costTotal = null;

      if (type === 'Issue') {
        body = [
          mileageField(),
          UI.field('Status', select('status', ISSUE_STATUSES.map(function (s) { return [s, s]; }), v.status || 'Not resolved')),
          amountRow('Inspection or diagnosis fee', text('cost', v.cost === null || v.cost === undefined ? '' : v.cost, { inputmode: 'decimal' }), 'Optional.', 'f-cost'),
        ];
      } else if (type === 'Compliance') {
        body = [
          UI.field('Provider', text('vendor', v.vendor, { maxlength: '80' }), 'Optional, e.g. the testing station or insurer.'),
          mileageField(),
          amountRow('Cost', text('cost', v.cost === null || v.cost === undefined ? '' : v.cost, { inputmode: 'decimal' }), 'Optional.', 'f-cost'),
          UI.field('New expiry date', text('expiryDate', v.expiryDate, { type: 'date' }), 'Optional. When this runs out next. You\'ll receive email reminders for this.'),
        ];
      } else if (type === 'Purchase') {
        costTotal = el('div', { class: 'job-total' });
        // Shipping belongs to the same order, so it is in the same currency as the price.
        var shipCur = el('span', { class: 'cur-label' });
        var shippingField = function () {
          var ship = text('shippingCost', v.shippingCost === null || v.shippingCost === undefined ? '' : v.shippingCost, { inputmode: 'decimal', id: 'f-ship' });
          var showCur = function () { shipCur.textContent = currencySelect.value; };
          currencySelect.addEventListener('change', showCur);
          showCur();
          return el('div', { class: 'field' }, [
            el('label', { for: 'f-ship', text: 'Shipping or delivery' }),
            el('div', { class: 'odo-row' }, [ship, shipCur]),
            el('div', { class: 'hint', text: 'Optional. For the whole order, in the same currency as the price.' }),
          ]);
        };
        var updatePurchaseTotal = function () {
          var t = num0(f.quantity.value) * num0(f.unitCost.value) + num0(f.shippingCost.value);
          costTotal.replaceChildren(el('span', { text: 'Total' }), el('strong', { text: fmt.money(round2(t), currencySelect.value) }));
        };
        body = [
          UI.field('Supplier or shop', text('vendor', v.vendor, { maxlength: '80' }), 'Optional.'),
          UI.field('Part number', text('partNumber', v.partNumber, { maxlength: '60' }), 'Optional, e.g. the OEM number from the catalogue.'),
          UI.field('Quantity *', text('quantity', v.quantity === null || v.quantity === undefined ? '1' : v.quantity, { inputmode: 'decimal', required: true }), 'How many were bought, e.g. 1, 4 or 4.5 litres.'),
          amountRow('Price of each *', text('unitCost', v.unitCost === null || v.unitCost === undefined ? '' : v.unitCost, { inputmode: 'decimal', required: true }), null, 'f-unit'),
          shippingField(),
          UI.field('Product link', text('productUrl', v.productUrl, { inputmode: 'url', placeholder: 'https://…' }), 'Optional. A secure (https) link.'),
          costTotal,
        ];
        ['quantity', 'unitCost', 'shippingCost'].forEach(function (k) { f[k].addEventListener('input', updatePurchaseTotal); });
        currencySelect.addEventListener('change', updatePurchaseTotal);
        updatePurchaseTotal();
      } else {
        body = jobFields();
      }

      // ----- maintenance: parts, labour, other costs -----
      function jobFields() {
        var out = [UI.field('Garage or who did the work', text('vendor', v.vendor, { maxlength: '80' }), 'Optional.'), mileageField()];

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
        (v.costMode === 'lump' ? modeLump : modeItemised).checked = true;
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
              else add(r.currency || defaultCurrency, q * num0(r.unitCost) + num0(r.shippingCost));
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
            partInput(row, 'shippingCost', 'Shipping for these (optional, same currency)', { inputmode: 'decimal' }),
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
            var b = el('button', { type: 'button', class: 'pick-item', text: p.name + ' — ' + p.available + ' left · ' + fmt.money(p.unitCost, p.currency) + ' each' });
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
          partRows.push({ kind: 'new', name: '', quantity: '1', unitCost: '', shippingCost: '', partNumber: '', vendor: '', currency: defaultCurrency });
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
            el('label', { class: 'check' }, [modeItemised, el('span', { text: 'Itemised: parts, labour and other costs' })]),
            el('label', { class: 'check' }, [modeLump, el('span', { text: 'Invoice total only' })]),
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
      function drawStaged() {
        stagedBox.replaceChildren.apply(stagedBox, staged.map(function (s, i) {
          var rm = el('button', { type: 'button', class: 'linklike', text: 'Remove' });
          rm.addEventListener('click', function () { staged.splice(i, 1); drawStaged(); });
          return el('div', { class: 'attach-row' }, [el('div', { class: 'attach-name', text: fileIcon(/^image\//.test(s.type || '') ? 'image/jpeg' : s.type === 'application/pdf' ? 'application/pdf' : '') + s.name }), rm]);
        }));
      }
      function stage(file) { staged.push({ file: file, name: file.name || 'photo', type: file.type }); drawStaged(); }
      var attachList = el('div', { class: 'stack' });
      if (existingData && existingData.attachments.length) {
        existingData.attachments.forEach(function (a) {
          var line = [el('div', { class: 'attach-name', text: fileIcon(a.mime) + a.filename + ' · ' + kb(a.size) })];
          if (FleetAuth.isAdmin()) {
            var rm = el('button', { type: 'button', class: 'linklike', text: 'Remove' });
            rm.addEventListener('click', function () {
              UI.confirm('Remove ' + a.filename + '?', { okLabel: 'Remove', danger: true }).then(function (yes) {
                if (!yes) return;
                FleetApi.call('deleteAttachment', { id: a.id }).then(function () { row.remove(); })
                  .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
              });
            });
            line.push(rm);
          }
          var row = el('div', { class: 'attach-row' }, line);
          attachList.append(row);
        });
      }
      var attachSection = el('div', { class: 'field' }, [
        el('div', { class: 'field-label', text: 'Photos and documents' }),
        attachList, stagedBox,
        el('div', { class: 'btn-row' }, [
          Photos.fileButton('Take photo', 'image/*', true, stage),
          Photos.fileButton('Choose photo', 'image/*', false, stage),
          Photos.fileButton('Add file', '', false, stage),
        ]),
        el('div', { class: 'hint', text: 'Receipts, invoices, quotes, photos of the problem or any other file. Photos are shrunk automatically; other files can be up to 5 MB.' }),
      ]);

      // ----- save -----
      var btn = el('button', { type: 'submit', class: 'btn block big save-gap', text: existing ? 'Save changes' : 'Add ' + meta.label.toLowerCase() });
      var form = el('form', { novalidate: true }, top.concat(body, [notesField, attachSection, btn]));

      function collect() {
        var fields = {};
        ['title', 'date', 'mileage', 'vendor', 'notes', 'status', 'cost', 'expiryDate', 'partNumber', 'quantity', 'unitCost', 'shippingCost',
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

      function run() {
        var payload = { fields: collect() };
        if (state.entryId) { payload.id = state.entryId; payload.version = state.version; } else { payload.carId = car.id; payload.type = type; }
        if (isJob) {
          payload.parts = f.modeLump.checked ? [] : f.partRows.map(function (r) {
            return r.kind === 'existing'
              ? { purchaseId: r.purchaseId, quantity: r.quantity }
              : { name: r.name, quantity: r.quantity, unitCost: r.unitCost, shippingCost: r.shippingCost, partNumber: r.partNumber, vendor: r.vendor, currency: r.currency };
          });
          if (f.resolve && f.linkedIssueId.value) payload.resolveIssue = f.resolve.checked;
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
          return uploadStaged(entry.id).then(function () {
            if (reminderNote && !uploadFailed) FleetApp.setFlash('ok', reminderNote);
            FleetApp.go('/car/' + car.id + '/entry/' + entry.id);
          });
        });
      }

      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        UI.busy(btn, 'Saving…', run()).catch(function (e) {
          msg.replaceChildren(UI.notice('error', UI.errorText(e)));
          window.scrollTo(0, 0);
        });
      });

      root.replaceChildren(el('section', { class: 'card' }, [
        fmt.backLink(existing ? '#/car/' + car.id + '/entry/' + existing.id : '#/car/' + car.id + '/add', existing ? existing.title : 'Add an entry'),
        el('h1', { text: existing ? 'Edit ' + meta.label.toLowerCase() : 'Add ' + (type === 'Purchase' ? 'a purchased item' : type === 'Maintenance' ? 'maintenance' : 'a ' + meta.label.toLowerCase()) }),
        el('p', { class: 'muted', text: car.registration + ' · ' + car.make + ' ' + car.model + '. ' + meta.blurb }),
        msg, form,
      ]));
    }
  };
})();
