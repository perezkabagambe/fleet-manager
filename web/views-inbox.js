// The receipt Inbox: add a photo or PDF of a receipt, see what is waiting for review, check what the AI read from it,
// and send it to the normal entry form (pre-filled) to be corrected and saved. Nothing is added to a car by itself.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var UPLOAD_TIMEOUT_MS = 240000;
  var READ_TIMEOUT_MS = 90000; // the AI can take a while to answer

  var KIND_LABEL = { Purchase: 'Parts purchase', Maintenance: 'Garage invoice' };
  var STATUS_LABEL = { New: 'Not read yet', Pending: 'Ready to check', Queued: 'Waiting to be read', Unreadable: 'Needs filling in by hand', Approved: 'Added', Dismissed: 'Dismissed' };

  function fmt() { return Views.fmt; }

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  // ---------- how many are waiting (the number on the menu) ----------
  var count = 0;
  function setCount(n) {
    count = n;
    window.dispatchEvent(new CustomEvent('fleet:inbox-count', { detail: { count: n } }));
  }
  function refreshCount() {
    if (!FleetAuth.hasSession() || !FleetAuth.getUser()) return Promise.resolve();
    return FleetApi.call('getInboxCount').then(function (r) { setCount(r.data.count); }).catch(function () { /* the menu just keeps its old number */ });
  }

  // ---------- looking at the stored receipt ----------
  /** A "View receipt" button: a photo is shown on the page, a PDF is saved/opened by the phone. */
  function viewer(receipt, onError) {
    var shown = Viewer.canShow(receipt.mime); // a photo or PDF is shown in the app; anything else is saved to the phone
    var btn = el('button', { type: 'button', class: 'btn small secondary', text: shown ? 'View the receipt' : 'Download the receipt' });
    var holder = el('div');
    btn.addEventListener('click', function () {
      var go = Viewer.show({ mime: receipt.mime, filename: receipt.filename, load: function () { return FleetApi.call('getReceiptFile', { id: receipt.id }, { timeoutMs: UPLOAD_TIMEOUT_MS }).then(function (r) { return r.data; }); } });
      if (!shown) UI.busy(btn, 'Loading…', go).catch(function (e) { if (onError) onError(e); });
    });
    return el('div', { class: 'receipt-view' }, [el('div', { class: 'attach-actions' }, [btn]), holder]);
  }

  /** The receipt as shown at the top of the entry form while it is being checked. */
  function panel(receipt) {
    var box = el('div');
    // a receipt whose lines do not add up to its total is a sign something was misread
    var d = receipt.data || {};
    var sum = 0;
    var complete = (d.items || []).length > 0;
    (d.items || []).forEach(function (i) { if (i.unitCost === null || i.unitCost === undefined) complete = false; else sum += i.quantity * i.unitCost; });
    var mismatch = receipt.kind === 'Purchase' && complete && receipt.total !== null && Math.abs(sum - receipt.total) > 0.011
      ? 'The items read from the receipt add up to ' + fmt().money(Math.round(sum * 100) / 100, receipt.currency || 'GBP') + ', but its total reads ' + fmt().money(receipt.total, receipt.currency || 'GBP') + '. Something may have been missed or misread (for example VAT or a discount).' : '';
    var seen = el('div', { class: 'receipt-banner' }, [
      el('div', { class: 'attach-title', text: 'Checking a receipt' }),
      el('p', { class: 'section-note', text: 'The boxes below were filled in from it by the AI. Check them against the receipt and correct anything that is wrong. When you save, the receipt is attached to the entry.' }),
      mismatch ? UI.notice('warn', mismatch) : null,
      receipt.duplicateOf ? UI.notice('warn', 'This looks like the same order as another receipt in the Inbox. Check it has not been added already.') : null,
      viewer(receipt, function (e) { box.replaceChildren(UI.notice('error', UI.errorText(e))); }),
      box,
    ]);
    return seen;
  }

  // ---------- the Inbox list ----------
  Views.inbox = function (ctx, root) {
    var msg = el('div');
    var listBox = el('div', { class: 'stack' });
    var recentBox = el('div');
    var fileBox = el('div');
    root.replaceChildren(el('section', { class: 'card' }, [
      el('div', { class: 'page-head' }, [el('h1', { text: 'Receipt Inbox' })]),
      el('p', { class: 'section-note', text: 'Receipts waiting to be checked. Nothing is added to a vehicle\'s log until someone has looked at it and saved it.' }),
      msg, fileBox, listBox, recentBox,
    ]));

    var cars = [];
    var reading = true;
    FleetApp.setBanner({ title: 'Receipt Inbox', icon: 'inbox', action: null });
    var flash = FleetApp.takeFlash();
    if (flash) msg.append(UI.notice(flash.kind === 'ok' ? 'ok' : 'info', flash.text)); // e.g. "3 receipts added"

    function addBlock() {
      var carSelect = el('select', { name: 'carId' }, [el('option', { value: '', text: 'Not sure yet (the AI will try to tell)' })].concat(
        cars.map(function (c) { return el('option', { value: c.id, text: c.registration + ' · ' + c.make + ' ' + c.model, selected: c.id === ctx.query.car }); })));
      var file = el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, class: 'file-input', 'aria-label': 'Choose photos or PDFs of receipts' });
      var go = el('button', { type: 'button', class: 'btn block', text: 'Add this receipt' });
      var status = el('div');
      file.addEventListener('change', function () {
        var n = file.files ? file.files.length : 0;
        go.textContent = n > 1 ? 'Add these ' + n + ' receipts' : 'Add this receipt';
      });
      go.addEventListener('click', function () {
        var files = file.files ? Array.prototype.slice.call(file.files) : [];
        if (!files.length) { status.replaceChildren(UI.notice('error', 'Choose a photo or a PDF first.')); return; }
        status.replaceChildren(UI.waiting(reading ? 'Adding the receipt and reading it with AI… this can take up to a minute.' : 'Adding the receipt…'));
        // each file becomes its own receipt, added one after another
        var done = [];
        var failed = [];
        var chain = Promise.resolve();
        var label = go.textContent;
        files.forEach(function (f, i) {
          chain = chain.then(function () {
            return send(f, carSelect.value, function (t) {
              var label2 = files.length > 1 ? 'Receipt ' + (i + 1) + ' of ' + files.length + ': ' + t : t;
              go.textContent = label2;
              var w = status.querySelector('.ai-wait-text');
              if (w) w.textContent = label2 + (/Reading/.test(t) ? ' with AI… this can take up to a minute.' : '');
            }).then(function (r) { done.push(r); }, function (e) { failed.push({ name: f.name || 'a file', error: e }); });
          });
        });
        UI.busy(go, 'Adding…', chain.then(function () { go.textContent = label; })).then(function () {
          status.replaceChildren();
          if (failed.length) {
            status.replaceChildren.apply(status, (done.length ? [UI.notice('ok', done.length + ' receipt' + (done.length === 1 ? ' was' : 's were') + ' added. They are in the list below.')] : [])
              .concat(failed.map(function (x) { return UI.notice('error', x.name + ': ' + UI.errorText(x.error)); })));
            refreshCount();
            return; // stay here so the problems stay in view
          }
          if (!done.length) return;
          if (done.length === 1) {
            var r = done[0];
            FleetApp.setFlash(r.status === 'Pending' ? 'ok' : 'info', r.status === 'Pending' ? 'The receipt was read. Check what it says, then fill in the entry.' : (r.note || 'The receipt was saved.'));
            FleetApp.go('/inbox/' + r.id);
          } else {
            FleetApp.setFlash('ok', done.length + ' receipts added. Open each one to check it.');
            FleetApp.go('/inbox');
          }
        });
      });
      return el('details', { class: 'copy-section', open: !!ctx.query.car || undefined }, [
        el('summary', { text: 'Add receipts (photos or PDFs)' }),
        el('p', { class: 'muted small-text', text: reading
          ? 'Take a photo, or choose one or more photos or PDFs. Each is read automatically and then waits here for you to check it.'
          : 'Take a photo, or choose a photo or PDF. Automatic reading is not switched on yet, so you will fill the details in yourself.' }),
        el('div', { class: 'field' }, [el('label', { text: 'Which vehicle is it for?' }), carSelect]),
        el('div', { class: 'field' }, [el('label', { text: 'Receipt' }), file]),
        status, go,
      ]);
    }

    /** Store the file, then have it read. Resolves to the receipt (read, or kept for filling in by hand). */
    function send(f, carId, progress) {
      return Photos.prepareAttachment(f).then(function (a) {
        if (a.mime !== 'image/jpeg' && a.mime !== 'application/pdf') throw new FleetApi.ApiError('invalid_attachment', 'Not a photo or PDF');
        return FleetApi.call('uploadReceipt', { carId: carId, mime: a.mime, data: a.data, filename: a.filename }, { timeoutMs: UPLOAD_TIMEOUT_MS });
      }).then(function (r) {
        progress('Reading the receipt…');
        return FleetApi.call('readReceipt', { id: r.data.receipt.id }, { timeoutMs: READ_TIMEOUT_MS }).then(function (x) { return x.data.receipt; }, function () {
          return r.data.receipt; // saved; reading can be tried again from its page
        });
      }).then(function (r) { refreshCount(); return r; });
    }

    function row(r) {
      var title = r.vendor || r.subject || r.filename;
      var bits = [KIND_LABEL[r.kind] || '', r.date ? when(r.date) : '', r.total !== null ? fmt().money(r.total, r.currency || 'GBP') : '', r.car || ''].filter(Boolean);
      return el('a', { class: 'inbox-row', href: '#/inbox/' + r.id }, [
        el('div', { class: 'inbox-title', text: title }),
        el('div', { class: 'muted small-text', text: bits.join(' · ') || 'Not read yet' }),
        el('div', { class: 'inbox-meta' }, [
          el('span', { class: 'chip ' + (r.status === 'Pending' ? 'active' : 'pending'), text: STATUS_LABEL[r.status] || r.status }),
          el('span', { class: 'muted small-text', text: (r.source === 'email' ? 'Emailed' : 'Added') + (r.sender ? ' by ' + r.sender : '') + ' · ' + when(r.receivedAt) }),
        ]),
      ]);
    }

    Promise.all([FleetApi.call('listInbox'), FleetApi.call('listCars')]).then(function (res) {
      var data = res[0].data;
      cars = res[1].data.cars || [];
      reading = data.reading;
      setCount(data.open.length);
      FleetApp.setBanner({ subtitle: data.open.length ? data.open.length + (data.open.length === 1 ? ' receipt waiting to be checked' : ' receipts waiting to be checked') : 'Nothing waiting' });
      fileBox.replaceChildren(addBlock());
      listBox.replaceChildren.apply(listBox, data.open.length ? data.open.map(row) : [el('p', { class: 'muted', text: 'Nothing is waiting. Add a receipt above' + (data.reading ? '' : ', or email one once that is switched on') + '.' })]);
      if (data.recent.length) {
        recentBox.replaceChildren(el('details', { class: 'copy-section' }, [el('summary', { text: 'Recently handled (' + data.recent.length + ')' }), el('div', { class: 'stack' }, data.recent.map(row))]));
      }
    }).catch(function (e) {
      if (e.code !== 'unauthorized') msg.replaceChildren(UI.notice('error', UI.errorText(e)));
    });
  };

  // ---------- one receipt ----------
  Views.receipt = function (ctx, root) {
    var id = ctx.params.id;
    var flash = FleetApp.takeFlash();
    root.replaceChildren(el('section', { class: 'card' }, [fmt().loading()]));
    Promise.all([FleetApi.call('getInboxItem', { id: id }), FleetApi.call('listCars')]).then(function (res) {
      build(res[0].data.receipt, res[1].data.cars || []);
    }).catch(function (e) {
      if (e.code === 'not_found') fmt().notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function build(r, cars) {
      var msg = el('div');
      if (flash) msg.append(UI.notice(flash.kind === 'ok' ? 'ok' : 'info', flash.text));
      var d = r.data || {};
      var open = r.status === 'New' || r.status === 'Pending' || r.status === 'Queued' || r.status === 'Unreadable';

      // Everything that was read from the receipt, including what was not found.
      var money = function (n) { return n === null || n === undefined ? '' : fmt().money(n, r.currency || 'GBP'); };
      var rows = [];
      function line(label, value, extra) {
        rows.push(el('dt', { text: label }), el('dd', { class: value ? '' : 'muted', text: value || 'Not found on the receipt' }));
        if (extra) rows.push(extra);
      }
      var carName = '';
      cars.forEach(function (c) { if (c.id === r.carId) carName = c.registration + ' · ' + c.make + ' ' + c.model; });
      line('Looks like', KIND_LABEL[r.kind] || '');
      line('Title it would get', d.title);
      line('Shop or garage', r.vendor);
      line('Date', r.date ? when(r.date) : '');
      line('Currency', r.currency);
      line('Total', money(r.total));
      line('Order or invoice number', d.orderNumber);
      line('Vehicle registration on it', d.registration);
      line('Vehicle described', d.vehicle);
      line('Mileage on it', d.mileage ? fmt().num(d.mileage) + ' mi' : '');
      line('Work described', d.work);
      line('Vehicle chosen', carName ? carName + (r.source === 'email' || d.registration ? '' : '') : '');
      line('How sure the AI is', d.confidence);
      line('AI summary', d.summary);

      var itemList = d.items || [];
      var sum = 0;
      var complete = itemList.length > 0;
      var table = null;
      if (itemList.length) {
        var body = itemList.map(function (i) {
          var known = i.unitCost !== null && i.unitCost !== undefined;
          var lineTotal = known ? Math.round(i.quantity * i.unitCost * 100) / 100 : null;
          if (known) sum += i.quantity * i.unitCost; else complete = false;
          return el('tr', {}, [el('td', { text: i.name }), el('td', { text: i.partNumber || '' }), el('td', { class: 'num', text: String(i.quantity) }),
            el('td', { class: 'num', text: known ? money(i.unitCost) : '?' }), el('td', { class: 'num', text: known ? money(lineTotal) : '?' })]);
        });
        table = el('div', { class: 'receipt-table-wrap' }, [el('table', { class: 'receipt-table' }, [
          el('thead', {}, [el('tr', {}, ['Item', 'Part no.', 'Qty', 'Each', 'Line'].map(function (h) { return el('th', { text: h }); }))]),
          el('tbody', {}, body),
        ])]);
      }
      var itemsNote = !itemList.length ? 'No individual items were found.'
        : complete ? 'Items add up to ' + money(Math.round(sum * 100) / 100) + (r.total !== null ? (Math.abs(sum - r.total) > 0.011 ? ', but the total reads ' + money(r.total) + ' (a difference of ' + money(Math.round(Math.abs(sum - r.total) * 100) / 100) + ').' : ', which matches the total.') : '.')
        : 'Some items have no price, so they cannot be added up.';
      var raw = el('details', { class: 'copy-section' }, [el('summary', { text: 'Show the raw data the AI returned' }), el('pre', { class: 'diag-pre', text: JSON.stringify(d, null, 2) })]);

      var carSelect = el('select', { name: 'carId' }, [el('option', { value: '', text: 'Choose a vehicle…' })].concat(
        cars.map(function (c) { return el('option', { value: c.id, text: c.registration + ' · ' + c.make + ' ' + c.model, selected: c.id === r.carId }); })));
      var kindSelect = el('select', { name: 'kind' }, [
        el('option', { value: 'Purchase', text: 'A parts purchase (receipt for things bought)', selected: r.kind !== 'Maintenance' }),
        el('option', { value: 'Maintenance', text: 'A garage invoice (work done on the vehicle)', selected: r.kind === 'Maintenance' }),
      ]);
      var go = el('button', { type: 'button', class: 'btn block big', text: 'Fill in the entry from this receipt' });
      go.addEventListener('click', function () {
        if (!carSelect.value) { msg.replaceChildren(UI.notice('error', 'Choose which vehicle this is for.')); return; }
        FleetApp.go('/car/' + carSelect.value + '/add/' + kindSelect.value.toLowerCase(), { inbox: r.id });
      });

      var again = null;
      if (r.status !== 'Pending' && open) {
        again = el('button', { type: 'button', class: 'btn small secondary', text: 'Try reading it again' });
        again.addEventListener('click', function () {
          msg.replaceChildren(UI.waiting('Reading the receipt with AI… this can take up to a minute.'));
          UI.busy(again, 'Reading…', FleetApi.call('readReceipt', { id: r.id }, { timeoutMs: READ_TIMEOUT_MS })).then(function () {
            refreshCount();
            FleetApp.go('/inbox/' + r.id);
          }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
      }
      var dismiss = null;
      if (open && FleetAuth.isAdmin()) {
        dismiss = el('button', { type: 'button', class: 'btn small danger', text: 'Dismiss this receipt' });
        dismiss.addEventListener('click', function () {
          UI.confirm('Dismiss this receipt? It is removed from the Inbox and its file goes to the Drive bin.', { okLabel: 'Dismiss', danger: true }).then(function (yes) {
            if (!yes) return;
            UI.busy(dismiss, 'Dismissing…', FleetApi.call('dismissReceipt', { id: r.id })).then(function () {
              refreshCount();
              FleetApp.go('/inbox');
            }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
          });
        });
      }

      var done = null;
      if (r.status === 'Approved') done = el('p', {}, [el('span', { text: 'This receipt was added as an entry. ' }), r.entryId && r.carId ? el('a', { href: '#/car/' + r.carId + '/entry/' + r.entryId, text: 'Open the entry' }) : null]);
      else if (r.status === 'Dismissed') done = el('p', { class: 'muted', text: 'This receipt was dismissed.' });

      root.replaceChildren(el('section', { class: 'card' }, [
        fmt().backLink('#/inbox', 'Receipt Inbox'),
        el('h1', { text: r.vendor || r.subject || 'Receipt' }),
        el('p', { class: 'muted small-text', text: (STATUS_LABEL[r.status] || r.status) + ' · ' + (r.source === 'email' ? 'Emailed' : 'Added') + (r.sender ? ' by ' + r.sender : '') + ' · ' + when(r.receivedAt) + ' · ' + r.filename + ' (' + kb(r.size) + ')' }),
        msg,
        r.note ? UI.notice(r.status === 'Pending' ? 'warn' : 'info', r.note) : null,
        viewer(r, function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); }),
        r.status === 'New' ? null : el('h2', { text: 'What was read from it' }),
        r.status === 'New' ? null : el('dl', { class: 'details' }, rows),
        r.status === 'New' ? null : el('div', { class: 'field-label', text: 'Items' }),
        r.status === 'New' ? null : table,
        r.status === 'New' ? null : el('p', { class: 'muted small-text', text: itemsNote }),
        r.status === 'New' ? null : raw,
        d.kind || r.status === 'Pending' ? el('p', { class: 'section-note', text: 'The AI can get things wrong. You will check every box on the next screen before anything is saved.' }) : null,
        done,
        open ? el('div', { class: 'stack' }, [
          el('div', { class: 'field' }, [el('label', { text: 'Which vehicle is it for?' }), carSelect]),
          el('div', { class: 'field' }, [el('label', { text: 'What kind of entry should it become?' }), kindSelect]),
          go,
          el('div', { class: 'btn-row' }, [again, dismiss]),
        ]) : null,
      ]));
    }
  };

  window.InboxUI = { panel: panel, refreshCount: refreshCount, getCount: function () { return count; } };
})();
