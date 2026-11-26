// The AI Inbox: add reports, invoices and receipts (upload, share from the phone, or email), see what is waiting for review,
// check what the AI read, and go on to review it. A report or problem goes to the review screen (views-report.js); an invoice or
// receipt can also go to the normal entry form, pre-filled. Nothing is added to a car by itself.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var UPLOAD_TIMEOUT_MS = 240000;
  var READ_TIMEOUT_MS = 90000; // the AI can take a while to answer

  var KIND_LABEL = { Purchase: 'Parts purchase', Maintenance: 'Garage invoice', Issue: 'Report or problem' };
  var KIND_CHOICES = [['Issue', 'Issue (report, quote or problem)'], ['Maintenance', 'Maintenance or garage invoice'], ['Purchase', 'Purchase receipt']];
  var MAX_FILES = 8;
  var STATUS_LABEL = { New: 'Not read yet', Pending: 'Ready to check', Queued: 'Waiting to be read', Unreadable: 'Needs filling in by hand', Approved: 'Added', Dismissed: 'Dismissed' };

  function fmt() { return Views.fmt; }

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  // ---------- files shared to the app from another app (the phone's share sheet) ----------
  // The service worker keeps each shared file in this cache; the AI Inbox picks them up and sends them for reading.
  var SHARED_CACHE = 'fm-shared-v1';
  function readShared() {
    if (!window.caches) return Promise.resolve([]);
    return caches.open(SHARED_CACHE).then(function (cache) {
      return cache.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) {
          return cache.match(k).then(function (res) {
            if (!res) return null;
            return res.blob().then(function (b) {
              var name = 'shared-file';
              try { name = decodeURIComponent(res.headers.get('X-File-Name') || name); } catch (e) { /* keep the plain name */ }
              return { key: k, file: new File([b], name, { type: res.headers.get('Content-Type') || b.type || '' }) };
            });
          });
        }));
      });
    }).then(function (list) { return list.filter(Boolean); }).catch(function () { return []; });
  }
  function dropShared(key) {
    return caches.open(SHARED_CACHE).then(function (cache) { return cache.delete(key); }).catch(function () { /* it is only a cache */ });
  }

  // ---------- sending files to be read: one way for every route (AI Inbox, share, "Add an issue") ----------
  function asReceiptFile(f) {
    return Photos.prepareAttachment(f).then(function (a) {
      if (a.mime !== 'image/jpeg' && a.mime !== 'application/pdf') throw new FleetApi.ApiError('invalid_attachment', 'Not a photo or PDF');
      return a;
    });
  }
  function readIt(receipt) {
    return FleetApi.call('readReceipt', { id: receipt.id }, { timeoutMs: READ_TIMEOUT_MS }).then(function (x) { return x.data.receipt; }, function () {
      return receipt; // saved; reading can be tried again from its page
    });
  }
  /**
   * Store the files and have AI read them. For an issue, all the files are ONE item (a report in several pages, or photos of
   * faults); otherwise each file is its own invoice or receipt. Resolves to { done: [receipt], failed: [{ name, error }] }.
   */
  function send(files, carId, kind, progress) {
    var done = [];
    var failed = [];
    var groups = kind === 'Issue' ? [files] : files.map(function (f) { return [f]; });
    if (kind === 'Issue' && files.length > MAX_FILES) return Promise.resolve({ done: [], failed: [{ name: files.length + ' files', error: new FleetApi.ApiError('too_many_files', 'Too many files') }] });
    var chain = Promise.resolve();
    groups.forEach(function (group, g) {
      var lead = groups.length > 1 ? 'File ' + (g + 1) + ' of ' + groups.length + ': ' : '';
      chain = chain.then(function () {
        var receipt = null;
        progress(lead + 'Adding the file' + (group.length > 1 ? 's' : '') + '…');
        var each = Promise.resolve();
        group.forEach(function (f) {
          each = each.then(function () {
            return asReceiptFile(f).then(function (a) {
              var body = { mime: a.mime, data: a.data, thumb: a.thumb, filename: a.filename };
              if (!receipt) return FleetApi.call('uploadReceipt', Object.assign({ carId: carId, kind: kind || undefined }, body), { timeoutMs: UPLOAD_TIMEOUT_MS }).then(function (r) { receipt = r.data.receipt; });
              return FleetApi.call('addReceiptFile', Object.assign({ id: receipt.id }, body), { timeoutMs: UPLOAD_TIMEOUT_MS }).then(function (r) { receipt = r.data.receipt; });
            }).catch(function (e) { failed.push({ name: f.name || 'a file', error: e }); });
          });
        });
        return each.then(function () {
          if (!receipt) return null;
          progress(lead + 'Reading with AI… this can take up to a minute.');
          return readIt(receipt).then(function (r) { done.push(r); });
        });
      });
    });
    return chain.then(function () { refreshCount(); return { done: done, failed: failed }; });
  }

  /**
   * Where to go for an item that has just been read: a report (or an invoice that lists faults) goes to its review screen, a
   * receipt or invoice for a known car to its filled-in entry form, and anything else to its own page in the Inbox.
   */
  function destination(r) {
    if (r.status === 'Pending' && (r.kind === 'Issue' || (r.kind === 'Maintenance' && r.issueCount))) return '/inbox/' + r.id + '/review';
    if (r.status === 'Pending' && r.carId && (r.kind === 'Purchase' || r.kind === 'Maintenance')) return '/car/' + r.carId + '/add/' + r.kind.toLowerCase() + '?inbox=' + r.id;
    return '/inbox/' + r.id;
  }
  function openResult(done) {
    if (done.length === 1) {
      var r = done[0];
      if (r.status !== 'Pending') { if (!r.note) FleetApp.setFlash('info', 'It was saved in the AI Inbox.'); } // its own page shows why
      else if (destination(r) === '/inbox/' + r.id) FleetApp.setFlash('ok', 'It was read. Check what it says, then draft the entry.');
      FleetApp.go(destination(r));
    } else {
      FleetApp.setFlash('ok', done.length + ' files added. Open each one to check it.');
      FleetApp.go('/inbox');
    }
  }

  // ---------- the "Add with AI" face, the same on the AI Inbox and on a car's page ----------
  var ADD_WITH_AI = 'Use AI to rapidly process inspection reports, garage invoices or purchase receipts.';
  /** The icon and words of an "Add with AI" button. `foot` is a last line, such as where it goes. */
  function addWithAi(foot) {
    return [FleetApp.icon('inbox', 30), el('span', { class: 'ai-add-text' }, [
      el('span', { class: 'ai-add-title' }, [el('strong', { text: 'Add with AI' }), el('span', { class: 'ai-add-tag', text: 'Generally faster' })]),
      el('span', { class: 'ai-add-what', text: ADD_WITH_AI }),
      foot ? el('span', { class: 'ai-add-foot', text: foot }) : null,
    ])];
  }

  // ---------- emailing instead ----------
  // A car's addresses: simple (from the registration, for your own email) and public (a short reference, for anyone). Asked for once
  var addresses = {};
  function addressesFor(car) {
    var key = car.id + '|' + car.registration;
    if (!addresses[key]) addresses[key] = FleetApi.call('getReceiptAddress', { carId: car.id }).then(function (r) { return r.data; }).catch(function (e) { delete addresses[key]; throw e; });
    return addresses[key];
  }

  function addressRow(label, who, address) {
    if (!address) return null;
    var at = address.indexOf('@'); // a long address breaks before the @, not in the middle of a word
    return el('div', { class: 'email-addr' }, [
      el('div', { class: 'email-who' }, [el('strong', { text: label }), el('span', { class: 'muted', text: who })]),
      UI.copyValueButton(address, 'Copy the ' + label.toLowerCase()),
      el('a', { href: 'mailto:' + address }, [document.createTextNode(address.slice(0, at)), el('wbr'), document.createTextNode(address.slice(at))]),
    ]);
  }

  /** "Or email it to the car's address": closed until asked for; the addresses are those of the vehicle chosen in the form. */
  function emailOption(cars, carPick) {
    var body = el('div', { class: 'email-body' });
    var box = el('details', { class: 'email-option' }, [el('summary', { text: 'Or email it to the car\'s address' }), body]);
    var showing = '';
    function say(text) { return el('li', {}, [el('strong', { text: text[0] }), document.createTextNode(text[1] || '')]); }
    function draw() {
      if (!box.open) return;
      var car = cars.filter(function (c) { return c.id === carPick.value; })[0];
      showing = car ? car.id : '';
      if (!car) { body.replaceChildren(el('p', { text: 'Choose a vehicle above to see its email addresses.' })); return; }
      body.replaceChildren(fmt().loading());
      addressesFor(car).then(function (a) {
        if (showing !== car.id) return; // another vehicle was chosen meanwhile
        if (!a.address && !a.privateAddress) { body.replaceChildren(el('p', { text: 'Email isn\'t set up yet.' })); return; }
        body.replaceChildren.apply(body, [
          el('p', { text: 'In the subject, say which it is:' }),
          el('ul', {}, [say(['Inspection report', ' (AI logs the issues)']), say(['Garage invoice']), say(['Purchase'])]),
          addressRow('Simple address', 'Only from your own email', a.address),
          addressRow('Public address', 'Anyone can use it: share it with your garage', a.privateAddress),
          el('p', { class: 'muted small-text', text: 'Tap an address to start an email.' }),
        ].filter(Boolean));
      }).catch(function (e) { if (showing === car.id) body.replaceChildren(UI.notice('error', UI.errorText(e))); });
    }
    box.addEventListener('toggle', draw);
    carPick.addEventListener('change', draw);
    return el('div', {}, [el('p', { class: 'or-rule', text: 'or' }), box]);
  }

  /** Under "Read it with AI": what happens next, and how many reads are left when there are not many. */
  function readNote() {
    var left = el('strong', { class: 'reads-left', hidden: true });
    FleetApi.call('getReceiptStatus').then(function (r) {
      if (!r.data.available || r.data.remaining > 5) return;
      left.textContent = r.data.remaining ? r.data.remaining + ' AI read' + (r.data.remaining === 1 ? '' : 's') + ' left today.' : 'No AI reads left today. What you add now will be read tomorrow.';
      left.hidden = false;
    }).catch(function () { /* the count is only a courtesy */ });
    return el('p', { class: 'muted small-text center read-note' }, [document.createTextNode('You check everything before it\'s saved.'), left]);
  }

  /**
   * "Which vehicle, and what is it?" then read it. `preset` are files already chosen (shared from the phone); without them the
   * form asks for them. onSent() runs once they are all stored.
   */
  function uploadForm(cars, carId, preset, onSent) {
    function carOptions() { return cars.map(function (c) { return { value: c.id, label: c.registration + ' · ' + c.make + ' ' + c.model }; }); }
    var carPick = UI.searchSelect(carOptions(), { value: carId || '', placeholder: 'Choose a vehicle…', ariaLabel: 'Which vehicle is it for?', searchPlaceholder: 'Search cars…' });
    var kindPick = el('select', { name: 'kind' }, [el('option', { value: '', text: 'Choose…' })].concat(KIND_CHOICES.map(function (k) { return el('option', { value: k[0], text: k[1] }); })));
    var file = preset ? null : el('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, class: 'file-input', 'aria-label': 'Choose photos or PDFs' });
    var hint = el('div', { class: 'hint' });
    function explain() {
      hint.textContent = kindPick.value === 'Issue' ? 'All the files are read together as one report. Photos of a fault are fine, even with no writing.'
        : kindPick.value ? 'Each file is read as its own ' + (kindPick.value === 'Purchase' ? 'receipt.' : 'invoice.') : '';
    }
    kindPick.addEventListener('change', explain);
    var status = el('div');
    var go = el('button', { type: 'button', class: 'btn block', text: 'Read it with AI' });
    go.addEventListener('click', function () {
      var files = preset || (file.files ? Array.prototype.slice.call(file.files) : []);
      var wrong = !carPick.value ? 'Choose which vehicle this is for.' : !kindPick.value ? 'Choose what it is.' : !files.length ? 'Choose a photo or a PDF first.' : '';
      if (wrong) { status.replaceChildren(UI.notice('error', wrong)); return; }
      var wait = UI.waiting('Adding…');
      status.replaceChildren(wait);
      UI.busy(go, 'Working…', send(files, carPick.value, kindPick.value, function (t) { var w = wait.querySelector('.ai-wait-text'); if (w) w.textContent = t; })).then(function (out) {
        status.replaceChildren.apply(status, out.failed.map(function (x) { return UI.notice('error', x.name + ': ' + UI.errorText(x.error)); }));
        if (out.done.length && onSent) onSent();
        if (out.done.length && !out.failed.length) openResult(out.done);
        else if (out.done.length) status.append(el('a', { class: 'btn block secondary', href: '#' + destination(out.done[0]), text: 'Carry on with what was added' }));
      }).catch(function (e) { status.replaceChildren(UI.notice('error', UI.errorText(e))); });
    });
    var form = el('div', {}, [
      el('div', { class: 'field' }, [el('label', { text: 'Which vehicle is it for?' }), carPick]),
      el('div', { class: 'field' }, [el('label', { text: 'What is it?' }), kindPick, hint]),
      preset ? null : el('div', { class: 'field' }, [el('label', { text: 'Photos or PDFs' }), file]),
      status, go, readNote(),
      preset ? null : emailOption(cars, carPick), // files shared from the phone are already chosen
    ]);
    form.setCars = function () { carPick.setOptions(carOptions()); }; // `cars` was filled again in place
    return form;
  }

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
  function viewer(receipt, onError, name) {
    var shown = Viewer.canShow(receipt.mime); // a photo or PDF is shown in the app; anything else is saved to the phone
    var btn = el('button', { type: 'button', class: 'btn small secondary', text: (shown ? 'View ' : 'Download ') + (name || (receipt.kind === 'Issue' ? 'the report' : 'the receipt')) });
    var holder = el('div');
    btn.addEventListener('click', function () {
      var go = Viewer.show({ mime: receipt.mime, filename: receipt.filename, load: function () { return FleetApi.call('getReceiptFile', { id: receipt.id, index: receipt.index || 0 }, { timeoutMs: UPLOAD_TIMEOUT_MS }).then(function (r) { return r.data; }); } });
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
      receipt.duplicateOf ? UI.notice('warn', 'This looks like the same order as another receipt in the AI Inbox. Check it has not been added already.') : null,
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
    var sharedBox = el('div');
    var waitingHead = el('h2', { class: 'ai-lead', hidden: true });
    root.replaceChildren(el('div', { class: 'ai-page' }, [
      msg, sharedBox, fileBox,
      el('p', { class: 'muted small-text center ai-promise', text: 'Nothing goes into a car\'s log until someone checks it and saves it.' }),
      waitingHead, listBox, recentBox,
    ]));

    var cars = []; // one list, filled again in place, so the forms see a newer answer
    var forms = [];
    var reading = true;
    var intro = el('p', { class: 'muted small-text', hidden: true });
    FleetApp.setBanner({ title: 'AI Inbox', icon: 'inbox', action: null });
    var flash = FleetApp.takeFlash();
    if (flash) msg.append(UI.notice(flash.kind === 'ok' ? 'ok' : 'info', flash.text)); // e.g. "3 receipts added"

    function explainAdding() { // only needed when AI cannot read: otherwise the button says it all
      intro.hidden = reading;
      intro.textContent = 'Take a photo, or choose a photo or PDF. Automatic reading is not switched on yet, so you will fill the details in yourself.';
    }
    function newForm(carId, preset, onSent) {
      var form = uploadForm(cars, carId, preset, onSent);
      forms.push(form);
      return form;
    }
    function addBlock() {
      explainAdding();
      return el('details', { class: 'ai-card', open: !!ctx.query.car || undefined }, [
        el('summary', {}, addWithAi('')),
        el('div', { class: 'ai-card-body' }, [intro, newForm(ctx.query.car, null, null)]),
      ]);
    }
    // The forms are drawn once (so a chosen file is never lost); a newer list of cars only refreshes their pickers
    function showCars(data) {
      cars.length = 0;
      Array.prototype.push.apply(cars, data.cars || []);
      if (!forms.length) { fileBox.replaceChildren(addBlock()); checkShared(); }
      else forms.forEach(function (f) { f.setCars(); });
    }

    // Files shared to the app: ask which vehicle and what they are, then read them
    function checkShared() {
      readShared().then(function (items) {
        if (!items.length) {
          if (ctx.query.shared) sharedBox.replaceChildren(UI.notice('info', 'No shared file was found. Share it again, or add it below.'));
          return;
        }
        var drop = function () { return Promise.all(items.map(function (it) { return dropShared(it.key); })); };
        var discard = el('button', { type: 'button', class: 'linklike', text: 'Discard what was shared' });
        discard.addEventListener('click', function () { drop().then(function () { sharedBox.replaceChildren(); }); });
        sharedBox.replaceChildren(el('div', { class: 'report-box shared-box' }, [
          el('h2', { text: items.length > 1 ? items.length + ' shared files' : 'Shared file' }),
          el('p', { class: 'muted small-text', text: items.map(function (it) { return it.file.name; }).join(', ') }),
          newForm('', items.map(function (it) { return it.file; }), drop),
          discard,
        ]));
      });
    }

    function row(r) {
      var title = r.vendor || r.subject || r.filename;
      var bits = [KIND_LABEL[r.kind] || '', r.issueCount ? r.issueCount + ' issue' + (r.issueCount === 1 ? '' : 's') : '', r.date ? when(r.date) : '', r.total !== null && r.kind !== 'Issue' ? fmt().money(r.total, r.currency || 'GBP') : '', r.car || ''].filter(Boolean);
      return el('a', { class: 'inbox-row', href: '#/inbox/' + r.id }, [
        el('div', { class: 'inbox-title', text: title }),
        el('div', { class: 'muted small-text', text: bits.join(' · ') || 'Not read yet' }),
        el('div', { class: 'inbox-meta' }, [
          el('span', { class: 'chip ' + (r.status === 'Pending' ? 'active' : 'pending'), text: STATUS_LABEL[r.status] || r.status }),
          el('span', { class: 'muted small-text', text: (r.source === 'email' ? 'Emailed' : 'Added') + (r.sender ? ' by ' + r.sender : '') + ' · ' + when(r.receivedAt) }),
        ]),
      ]);
    }

    function showItems(data, saved) {
      reading = data.reading;
      explainAdding();
      if (!saved) setCount(data.open.length); // the number on the menu is only ever set from a fresh answer
      FleetApp.setBanner({ subtitle: data.open.length ? data.open.length + ' waiting to be checked' : 'Nothing waiting' });
      waitingHead.hidden = !data.open.length;
      waitingHead.replaceChildren(document.createTextNode('Waiting to be checked'), el('span', { class: 'ai-count', text: String(data.open.length) }));
      listBox.replaceChildren.apply(listBox, data.open.length ? data.open.map(row) : [el('p', { class: 'muted', text: 'Nothing is waiting. Add something above' + (data.reading ? '' : ', or email it once that is switched on') + '.' })]);
      var wasOpen = !!recentBox.querySelector('details[open]');
      recentBox.replaceChildren();
      if (data.recent.length) {
        recentBox.append(el('details', { class: 'ai-recent', open: wasOpen || undefined }, [el('summary', { text: 'Recently handled (' + data.recent.length + ')' }), el('div', { class: 'stack' }, data.recent.map(row))]));
      }
    }
    function failed(e) {
      if (e.code === 'unauthorized') return;
      if (e.hadSaved) msg.replaceChildren(UI.notice('warn', 'Showing what was saved on this phone. ' + UI.errorText(e)));
      else msg.replaceChildren(UI.notice('error', UI.errorText(e)));
      if (!e.hadSaved) listBox.replaceChildren();
    }

    // each part appears as soon as it is known: what the phone saved last time first, then the fresh answer
    listBox.replaceChildren(fmt().loading());
    FleetApi.seen('listCars', {}, showCars).catch(failed);
    FleetApi.seen('listInbox', {}, showItems).catch(failed);
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
      var wasRead = !!(d.confidence || d.kind || d.documentType || (d.issues || []).length || (d.items || []).length || r.vendor); // nothing to show until AI has read it

      // Everything that was read from the receipt, including what was not found.
      var money = function (n) { return n === null || n === undefined ? '' : fmt().money(n, r.currency || 'GBP'); };
      // What the AI read, as small tiles (a label above its value) rather than one long cramped list. A missing value says so.
      var facts = [];
      function fact(label, value, wide) {
        facts.push(el('div', { class: 'fact' + (wide ? ' wide' : '') + (value ? '' : ' missing') }, [
          el('div', { class: 'fact-label', text: label }),
          el('div', { class: 'fact-value', text: value || 'Not found' }),
        ]));
      }
      var carName = '';
      cars.forEach(function (c) { if (c.id === r.carId) carName = c.registration + ' · ' + c.make + ' ' + c.model; });
      var isReport = r.kind === 'Issue';
      fact('Shop or garage', r.vendor);
      fact('Date', r.date ? when(r.date) : '');
      if (!isReport) { fact('Total', money(r.total)); fact('Order or invoice no.', d.orderNumber); } else fact('Report reference', d.reportRef);
      fact('Registration on it', d.registration);
      fact('Mileage on it', d.mileage ? fmt().num(d.mileage) + ' mi' : '');
      if (d.title) fact('Entry title it would get', d.title, true);
      if (d.vehicle) fact('Vehicle described', d.vehicle, true);
      if (d.work) fact('Work described', d.work, true);
      if (d.summary) fact('AI summary', d.summary, true);
      var readoutHead = el('div', { class: 'readout-head' }, [
        KIND_LABEL[r.kind] ? el('span', { class: 'chip ' + (r.kind === 'Maintenance' ? 't-maintenance' : r.kind === 'Issue' ? 't-issue' : 't-purchase'), text: KIND_LABEL[r.kind] }) : el('span', { class: 'chip', text: 'Type not clear' }),
        d.confidence ? el('span', { class: 'chip conf-' + d.confidence, text: 'AI confidence: ' + d.confidence }) : null,
      ]);

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

      var found = d.issues || [];
      var carSelect = el('select', { name: 'carId' }, [el('option', { value: '', text: 'Choose a vehicle…' })].concat(
        cars.map(function (c) { return el('option', { value: c.id, text: c.registration + ' · ' + c.make + ' ' + c.model, selected: c.id === r.carId }); })));
      var guess = r.kind || (found.length ? 'Issue' : 'Purchase');
      var kindSelect = el('select', { name: 'kind' }, KIND_CHOICES.map(function (k) { return el('option', { value: k[0], text: k[1], selected: k[0] === guess }); }));
      var next = el('div', { class: 'stack' });
      var issuesText = function () { return found.length + ' issue' + (found.length === 1 ? '' : 's'); };
      function draftEntry(kind) {
        if (!carSelect.value) { msg.replaceChildren(UI.notice('error', 'Choose which vehicle this is for.')); return; }
        FleetApp.go('/car/' + carSelect.value + '/add/' + kind.toLowerCase(), { inbox: r.id });
      }
      function review(as) {
        var go2 = function () { FleetApp.go('/inbox/' + r.id + '/review', as ? { as: as } : undefined); };
        if (carSelect.value && carSelect.value !== r.carId) { // keep the vehicle chosen here for the review
          FleetApi.call('setReceiptCar', { id: r.id, carId: carSelect.value }).then(go2, function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        } else go2();
      }
      function button(text, cls, onClick) {
        var b = el('button', { type: 'button', class: cls, text: text });
        b.addEventListener('click', function () { onClick(b); });
        return b;
      }
      function readAs(kind, b) {
        msg.replaceChildren(UI.waiting('Reading with AI… this can take up to a minute.'));
        UI.busy(b, 'Reading…', FleetApi.call('readReceipt', { id: r.id, kind: kind }, { timeoutMs: READ_TIMEOUT_MS })).then(function (x) {
          refreshCount();
          openResult([x.data.receipt]);
        }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      }
      // The buttons when there is nothing from AI to use: ask AI (again), or type it in.
      function askOrType(kind) {
        return [
          button(r.status === 'New' ? 'Process with AI' : '\u21bb Retry AI processing', 'btn block big', function (b) { readAs(kind, b); }),
          el('p', { class: 'small-text muted center btn-caption', text: 'You check what AI finds before anything is saved.' }),
          el('p', { class: 'or-rule', text: 'or' }),
          kind === 'Issue' ? button('Add the issues by hand', 'btn block secondary', function () { review(''); })
            : button('Fill in the entry by hand', 'btn block secondary', function () { draftEntry(kind); }),
        ];
      }
      function drawNext() {
        var kind = kindSelect.value;
        var kids = [];
        var asking = !wasRead || (kind === 'Issue' && !found.length); // not read yet, or read without finding any issues
        if (asking) kids = askOrType(kind);
        else if (kind === 'Issue') kids.push(button('Review ' + issuesText() + '\u00a0→', 'btn block big draft-btn', function () { review(''); }));
        else if (kind === 'Maintenance' && found.length) {
          kids.push(button('Review the invoice and ' + issuesText() + '\u00a0→', 'btn block big draft-btn', function () { review('Maintenance'); }));
          kids.push(button('Draft just the maintenance entry', 'btn block secondary', function () { draftEntry('Maintenance'); }));
        } else {
          kids.push(button('Draft an entry from this ' + (kind === 'Purchase' ? 'receipt' : 'invoice') + '\u00a0→', 'btn block big draft-btn', function () { draftEntry(kind); }));
        }
        if (!asking && r.status !== 'Pending') kids.push(button('\u21bb Retry AI processing', 'btn block secondary', function (b) { readAs(kind, b); }));
        next.replaceChildren.apply(next, kids);
      }
      kindSelect.addEventListener('change', drawNext);
      drawNext();

      var dismiss = null;
      if (open && FleetAuth.isAdmin()) {
        dismiss = el('button', { type: 'button', class: 'linklike quiet-danger', text: 'Dismiss this upload' });
        dismiss.addEventListener('click', function () {
          UI.confirm('Dismiss this? It is removed from the Inbox and its files go to the Drive bin.', { okLabel: 'Dismiss', danger: true }).then(function (yes) {
            if (!yes) return;
            UI.busy(dismiss, 'Dismissing…', FleetApi.call('dismissReceipt', { id: r.id })).then(function () {
              refreshCount();
              FleetApp.go('/inbox');
            }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
          });
        });
      }

      var done = null;
      if (r.status === 'Approved') done = el('p', {}, [el('span', { text: 'This has been added to the log. ' }), r.entryId && r.carId ? el('a', { href: '#/car/' + r.carId + '/entry/' + r.entryId, text: 'Open the entry' }) : null]);
      else if (r.status === 'Dismissed') done = el('p', { class: 'muted', text: 'This was dismissed.' });

      root.replaceChildren(el('section', { class: 'card' }, [
        fmt().backLink('#/inbox', 'AI Inbox'),
        el('h1', { text: r.vendor || r.subject || r.filename }),
        el('p', { class: 'muted small-text', text: (STATUS_LABEL[r.status] || r.status) + ' · ' + (r.source === 'email' ? 'Emailed' : 'Added') + (r.sender ? ' by ' + r.sender : '') + ' · ' + when(r.receivedAt) + ' · ' + r.filename + ' (' + kb(r.size) + ')' }),
        msg,
        r.note ? UI.notice(r.status === 'Pending' ? 'warn' : 'info', r.note) : null,
        r.problem ? el('p', { class: 'muted small-text', text: 'For admins. Google said: ' + r.problem }) : null,
        (r.files || []).length > 1 ? el('div', { class: 'stack' }, r.files.map(function (f) { return viewer({ id: r.id, index: f.index, mime: f.mime, filename: f.filename }, function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); }, f.filename); }))
          : viewer(r, function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); }),
        !wasRead ? null : el('h2', { text: 'What AI read from it' }),
        !wasRead ? null : readoutHead,
        !wasRead ? null : el('div', { class: 'facts' }, facts),
        !wasRead || !found.length ? null : el('h3', { class: 'readout-items', text: 'Issues found (' + found.length + ')' }),
        !wasRead || !found.length ? null : el('ul', { class: 'plain-list' }, found.map(function (i) { return el('li', { text: i.title + (i.codes && i.codes.length ? ' (' + i.codes.map(function (c) { return c.code; }).join(', ') + ')' : '') }); })),
        !wasRead || isReport ? null : el('h3', { class: 'readout-items', text: 'Items' }),
        !wasRead || isReport ? null : table,
        !wasRead || isReport ? null : el('p', { class: 'muted small-text', text: itemsNote }),
        d.kind || r.status === 'Pending' ? el('p', { class: 'section-note', text: 'The AI can get things wrong. You will check everything on the next screen before anything is saved.' }) : null,
        done,
        open ? el('div', { class: 'stack' }, [
          el('div', { class: 'field' }, [el('label', { text: 'Which vehicle is it for?' }), carSelect]),
          el('div', { class: 'field' }, [el('label', { text: 'What is it?' }), kindSelect]),
          next,
          dismiss ? el('div', { class: 'inbox-foot' }, [dismiss]) : null,
        ]) : null,
      ]));
    }
  };

  window.InboxUI = { addWithAi: addWithAi, panel: panel, send: send, destination: destination, openResult: openResult, refreshCount: refreshCount, getCount: function () { return count; } };
})();
