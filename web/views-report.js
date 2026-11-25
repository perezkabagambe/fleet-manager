// The review screen for an inspection or diagnostic report (or a quote, a described problem, photos of one). Whatever way it
// arrived (email, share, the AI Inbox, or from "Add an issue"), it ends here: the person checks what AI read, then saves.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var SOMEONE_ELSE = '__else__';
  var SAVE_TIMEOUT_MS = 200000;
  var STATUSES = ['Not resolved', 'In-work', 'Resolved', 'Ignored'];

  function fmt() { return Views.fmt; }
  function day(iso) { return iso ? fmt().date(iso + 'T12:00:00Z') : ''; }
  function plate(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function count(n, one) { return n + ' ' + one + (n === 1 ? '' : 's'); }
  function money(amount, currency) {
    var n = Number(String(amount).replace(/[,\s]/g, ''));
    return amount === '' || isNaN(n) ? '' : fmt().money(n, currency);
  }
  function input(attrs, value, onInput) {
    var i = el('input', Object.assign({ type: 'text', autocomplete: 'off' }, attrs));
    i.value = value === null || value === undefined ? '' : value;
    if (onInput) i.addEventListener('input', function () { onInput(i.value); });
    return i;
  }
  function choose(options, value, onChange, attrs) {
    var s = el('select', attrs || {}, options.map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === value }); }));
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function amountField(label, value, currency, onValue, onCurrency, hint) {
    var amount = input({ inputmode: 'decimal', placeholder: '0.00', 'aria-label': label }, value, onValue);
    var cur = choose(fmt().currencyOptions, currency, onCurrency, { 'aria-label': 'Currency of ' + label.toLowerCase() });
    var hintBox = el('div', { class: 'hint', text: hint || '' });
    var node = el('div', { class: 'field' }, [el('label', { text: label }), el('div', { class: 'odo-row' }, [amount, cur]), hintBox]);
    return { node: node, input: amount, hint: hintBox };
  }

  Views.reportReview = function (ctx, root) {
    var id = ctx.params.id;
    root.replaceChildren(el('section', { class: 'card' }, [fmt().loading()]));
    Promise.all([FleetApi.call('getInboxItem', { id: id }), FleetApi.call('listCars'), FleetApi.call('listApprovedUsers')]).then(function (res) {
      build(res[0].data.receipt, res[1].data.cars || [], res[2].data.users || []);
    }).catch(function (e) {
      if (e.code === 'not_found') fmt().notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function build(receipt, cars, users) {
      if (receipt.status === 'Approved' || receipt.status === 'Dismissed') { FleetApp.go('/inbox/' + receipt.id); return; }
      var data = receipt.data || {};
      if (ctx.query.as === 'Maintenance') receipt = Object.assign({}, receipt, { kind: 'Maintenance' }); // "this is an invoice": propose its maintenance entry too
      var carOf = function (carId) { return cars.filter(function (c) { return c.id === carId; })[0] || null; };
      var plateCar = data.registration ? cars.filter(function (c) { return plate(c.registration) === plate(data.registration); })[0] : null;
      var firstCar = carOf(receipt.carId) || plateCar || null;
      var state = ReportDraft.fromReading(receipt, { currency: firstCar ? firstCar.currency : 'GBP', formatDate: day });
      state.receiptId = receipt.id;
      state.carId = firstCar ? firstCar.id : '';
      var me = (FleetAuth.getUser() || {}).id;
      // who identified it: the garage named on the report, otherwise the person looking at it
      state.identifiedBy = state.vendor ? '' : (users.some(function (u) { return u.id === me; }) ? me : '');
      state.identifiedText = state.vendor;
      state.updateOdometer = true;
      var existing = []; // the chosen car's entries (for duplicates and links)
      var files = receipt.files || [];
      var fileName = function (n) { return files[n] ? files[n].filename : 'File ' + (n + 1); };
      var isPhoto = function (n) { return !!files[n] && /^image\//.test(files[n].mime); };

      var msg = el('div');
      var saveMsg = el('div');
      var plateBox = el('div');
      var odoBox = el('div');
      var feesBox = el('div');
      var summaryBox = el('div', { class: 'report-summary' });
      var maintenanceBox = el('div');
      var issuesBox = el('div', { class: 'report-issues' });
      var filesBox = el('div');
      var saveBtn = el('button', { type: 'button', class: 'btn block big', text: 'Save' });

      function openFile(n) {
        Viewer.show({ mime: files[n].mime, filename: files[n].filename, load: function () { return FleetApi.call('getReceiptFile', { id: receipt.id, index: n }, { timeoutMs: 240000 }).then(function (r) { return r.data; }); } });
      }

      // ----- what every issue shares -----
      function drawPlate() {
        var car = carOf(state.carId);
        var kids = [];
        if (data.registration && car) {
          if (plate(car.registration) === plate(data.registration)) kids.push(el('p', { class: 'report-ok', text: '✓ The number plate on the report, ' + data.registration + ', matches this car.' }));
          else {
            var line = el('div', { class: 'notice warn' }, [el('span', { text: 'The report shows ' + data.registration + ', but you picked ' + car.registration + '. ' })]);
            if (plateCar) {
              var swap = el('button', { type: 'button', class: 'linklike', text: 'Switch to ' + plateCar.registration });
              swap.addEventListener('click', function () { carSelect.value = plateCar.id; pickCar(plateCar.id); });
              line.append(swap);
            }
            kids.push(line);
          }
        } else if (!car && data.registration) kids.push(el('p', { class: 'muted small-text', text: 'The report shows ' + data.registration + ', which is not a car here.' }));
        plateBox.replaceChildren.apply(plateBox, kids);
      }
      function drawOdometer() {
        var car = carOf(state.carId);
        var reading = Number(String(state.mileage).replace(/[,\s]/g, ''));
        if (!car || !(reading > Number(car.odometer || 0))) { odoBox.replaceChildren(); return; }
        var tick = el('input', { type: 'checkbox' });
        tick.checked = state.updateOdometer;
        tick.addEventListener('change', function () { state.updateOdometer = tick.checked; });
        odoBox.replaceChildren(el('label', { class: 'check' }, [tick, el('span', { text: 'Update the car\'s Odometer Log to ' + fmt().num(reading) + ' mi' })]));
      }
      function pickCar(carId) {
        state.carId = carId;
        existing = [];
        state.issues.forEach(function (i) { i.linkIds = []; i.duplicate = null; });
        drawPlate(); drawOdometer(); drawAll();
        var car = carOf(carId);
        FleetApp.setBanner({ subtitle: car ? car.registration + ' · ' + car.make + ' ' + car.model : 'Choose the car' });
        if (!car) return;
        FleetApi.call('listEntries', { carId: carId }).then(function (r) {
          if (state.carId !== carId) return;
          existing = r.data.entries;
          ReportDraft.markDuplicates(state, existing);
          drawAll();
        }).catch(function (e) { msg.replaceChildren(UI.notice('error', 'The car\'s log could not be loaded, so duplicates are not checked. ' + UI.errorText(e))); });
      }
      var carSelect = UI.searchSelect(cars.map(function (c) { return { value: c.id, label: c.registration + ' · ' + c.make + ' ' + c.model }; }), { value: state.carId, placeholder: 'Choose a vehicle…', ariaLabel: 'Vehicle', searchPlaceholder: 'Search cars…' });
      carSelect.addEventListener('change', function () { pickCar(carSelect.value); });

      var dateIn = input({ type: 'date', max: new Date().toISOString().slice(0, 10), required: true }, state.date, function (v) { state.date = v; markMissing(); });
      var mileIn = input({ inputmode: 'numeric', placeholder: 'miles', required: true }, state.mileage, function (v) { state.mileage = v; markMissing(); drawOdometer(); });
      var dateHint = data.date ? 'Read from the report' : 'Not in the report: please enter it';
      var mileHint = data.mileage !== null && data.mileage !== undefined ? 'Read from the report' : 'Not in the report: please enter it';
      function markMissing() {
        dateIn.classList.toggle('missing-input', !state.date);
        mileIn.classList.toggle('missing-input', !String(state.mileage).trim());
      }

      var other = input({ maxlength: '80', placeholder: 'Name of the person or garage', 'aria-label': 'Name of the person or garage' }, state.identifiedText, function (v) { state.identifiedText = v; });
      var otherBox = el('div', { class: 'identified-other' }, [other]);
      var who = UI.searchSelect(users.map(function (u) { return { value: u.id, label: u.name + (u.id === me ? ' (me)' : '') }; }).concat([{ value: SOMEONE_ELSE, label: 'Someone else or a garage…' }]),
        { value: state.identifiedBy || SOMEONE_ELSE, ariaLabel: 'Garage or who identified the issue', searchPlaceholder: 'Search people…' });
      otherBox.hidden = !!state.identifiedBy;
      who.addEventListener('change', function () {
        state.identifiedBy = who.value === SOMEONE_ELSE ? '' : who.value;
        otherBox.hidden = !!state.identifiedBy;
        if (!state.identifiedBy) other.focus();
      });

      function drawFiles() {
        filesBox.replaceChildren(el('div', { class: 'field-label', text: files.length > 1 ? 'Files (' + files.length + ')' : 'Report file' }),
          el('div', { class: 'report-files' }, files.map(function (f, n) {
            var owners = state.issues.filter(function (i) { return i.files.indexOf(n) !== -1; });
            var view = el('button', { type: 'button', class: 'linklike', text: 'View' });
            view.addEventListener('click', function () { openFile(n); });
            return el('div', { class: 'report-file' }, [
              el('div', { class: 'report-file-main' }, [el('div', { class: 'report-file-name', text: f.filename }),
                el('div', { class: 'muted small-text', text: owners.length ? 'Attached to ' + (owners.length === 1 ? 'one issue: ' + (owners[0].title || 'untitled') : count(owners.length, 'issue')) : 'Will be attached to every entry saved here' })]),
              view,
            ]);
          })));
      }

      // ----- one fee or quote for the whole report -----
      var feesOpen = !!(state.fee || state.quote);
      var feeCurrency = state.currency;
      function drawFees() {
        if (!feesOpen) {
          var add = el('button', { type: 'button', class: 'btn small secondary', text: '+ Add a fee or quote for the whole report' });
          add.addEventListener('click', function () { feesOpen = true; drawFees(); });
          feesBox.replaceChildren(el('p', { class: 'muted small-text', text: 'No single fee or quoted price for the whole report was found.' }), add);
          return;
        }
        var setCurrency = function (v) {
          feeCurrency = v;
          state.issues.forEach(function (i) { if (i.sharedFee) i.currency = v; if (i.sharedQuote) i.quoteCurrency = v; });
          drawFees(); drawIssues();
        };
        var fee = amountField('Inspection fee (whole report)', state.fee, feeCurrency, function (v) { ReportDraft.setReportAmount(state, 'fee', v); state.issues.forEach(function (i) { if (i.sharedFee) i.currency = feeCurrency; }); drawIssues(); }, setCurrency, 'Money spent. Counted once.');
        var quote = amountField('Quoted repair (whole report)', state.quote, feeCurrency, function (v) { ReportDraft.setReportAmount(state, 'quote', v); state.issues.forEach(function (i) { if (i.sharedQuote) i.quoteCurrency = feeCurrency; }); drawIssues(); }, setCurrency, 'Not counted in costs.');
        feesBox.replaceChildren(fee.node, quote.node, el('p', { class: 'muted small-text', text: 'Each issue shows a shared amount in brackets. Change it on one issue and that issue has its own amount.' }));
      }

      // ----- the maintenance entry of an invoice that also lists faults -----
      function drawMaintenance() {
        var m = state.maintenance;
        if (!m) { maintenanceBox.replaceChildren(); return; }
        var tick = el('input', { type: 'checkbox', 'aria-label': 'Save the maintenance entry' });
        tick.checked = m.keep;
        tick.addEventListener('change', function () { m.keep = tick.checked; drawSummary(); drawMaintenance(); });
        var total = amountField('Invoice total', m.total, m.currency, function (v) { m.total = v; }, function (v) { m.currency = v; }, 'Counted in costs. You can add parts and labour by editing the entry afterwards.');
        var notes = el('textarea', { rows: '3', maxlength: '2000', 'aria-label': 'Notes' });
        notes.value = m.notes;
        notes.addEventListener('input', function () { m.notes = notes.value; });
        maintenanceBox.replaceChildren(el('div', { class: 'report-card' + (m.keep ? '' : ' off') }, [
          el('label', { class: 'check report-head' }, [tick, el('span', {}, [el('span', { class: 'chip t-maintenance', text: 'Maintenance' }), el('span', { class: 'report-title', text: ' The work on the invoice' })])]),
          m.keep ? el('div', {}, [
            UI.field('Title *', input({ maxlength: '120' }, m.title, function (v) { m.title = v; })),
            total.node,
            UI.field('Garage or who did the work', input({ maxlength: '80' }, m.vendor, function (v) { m.vendor = v; })),
            UI.field('Notes', notes),
          ]) : null,
        ]));
      }

      // ----- the issues -----
      function statusOfCodes(i) {
        var all = (i.codes || []).map(function (c) { return c.status; }).filter(Boolean).filter(function (s, n, a) { return a.indexOf(s) === n; });
        return i.stored ? 'Stored only' : all.join(', ');
      }
      function amountsLine(i) {
        var out = [];
        if (money(i.cost, i.currency)) out.push('Inspection fee ' + LinkedIssues.shared(money(i.cost, i.currency), ReportDraft.isShared(state, i, 'sharedFee')));
        if (money(i.quoteCost, i.quoteCurrency)) out.push('Quoted ' + LinkedIssues.shared(money(i.quoteCost, i.quoteCurrency), ReportDraft.isShared(state, i, 'sharedQuote')));
        return out.join(' · ');
      }

      function duplicateBlock(i) {
        if (!i.duplicate) return null;
        var d = i.duplicate;
        var name = 'dup-' + i.key;
        var options = [['append', 'Add these notes to ' + (d.ref || 'that issue')], ['new', 'Create a new issue anyway'], ['skip', 'Skip it']];
        return el('div', { class: 'report-dup' }, [
          el('div', { class: 'report-flag' }, [el('span', { text: 'Looks like ' }), el('a', { href: '#/car/' + state.carId + '/entry/' + d.id, target: '_blank', rel: 'noopener', text: (d.ref ? d.ref + ' ' : '') + '“' + d.title + '”' })]),
          el('div', { role: 'radiogroup' }, options.map(function (o) {
            var r = el('input', { type: 'radio', name: name, value: o[0] });
            r.checked = i.duplicateChoice === o[0];
            r.addEventListener('change', function () { if (r.checked) { i.duplicateChoice = o[0]; drawAll(); } });
            return el('label', { class: 'check' }, [r, el('span', { text: o[1] })]);
          })),
        ]);
      }

      function photoBlock(i) {
        var photos = files.map(function (f, n) { return n; }).filter(isPhoto);
        if (!photos.length || state.issues.length < 1) return null;
        var mine = i.files.slice();
        var rows = mine.map(function (n) {
          var view = el('button', { type: 'button', class: 'linklike', text: fileName(n) });
          view.addEventListener('click', function () { openFile(n); });
          var move = choose([['', 'Move to…'], ['*', 'Every entry']].concat(state.issues.filter(function (o) { return o !== i; }).map(function (o) { return [o.key, o.title || 'Untitled issue']; })), '', function (v) {
            if (!v) return;
            i.files = i.files.filter(function (x) { return x !== n; });
            var target = state.issues.filter(function (o) { return o.key === v; })[0];
            if (target && target.files.indexOf(n) === -1) target.files.push(n);
            drawAll();
          }, { 'aria-label': 'Move ' + fileName(n) });
          return el('div', { class: 'report-photo' }, [view, move]);
        });
        var rest = photos.filter(function (n) { return mine.indexOf(n) === -1; });
        var add = rest.length ? choose([['', 'Add a photo to this issue…']].concat(rest.map(function (n) { return [String(n), fileName(n)]; })), '', function (v) {
          if (v === '') return;
          i.files.push(Number(v));
          drawAll();
        }, { 'aria-label': 'Add a photo to this issue' }) : null;
        return el('div', { class: 'field' }, [el('div', { class: 'field-label', text: 'Photos of this problem' })].concat(rows, [add, el('div', { class: 'hint', text: 'A photo on no particular issue is attached to every entry.' })]));
      }

      function linkBlock(i) {
        var others = state.issues.filter(function (o) { return o !== i; }).map(function (o) { return { id: o.key, title: o.title || 'Untitled issue', status: '' }; });
        var onCar = existing.filter(function (e) { return e.type === 'Issue'; }).map(function (e) { return { id: e.id, ref: e.ref, title: e.title, status: e.status }; });
        var selected = Object.keys(i.linkTo).map(function (k) { return { id: k }; }).concat(i.linkIds.map(function (x) { return { id: x }; }));
        return LinkedIssues.editor({
          choices: others.concat(onCar), selected: selected,
          onChange: function (value) {
            var ids = value.map(function (v) { return v.issueId; });
            state.issues.forEach(function (o) { if (o !== i) ReportDraft.setLinked(state, i, o.key, ids.indexOf(o.key) !== -1); });
            i.linkIds = ids.filter(function (x) { return x.indexOf('new:') !== 0; });
          },
        }).node;
      }

      function issueCard(i, n) {
        var appending = i.duplicate && i.duplicateChoice === 'append';
        var skipped = i.duplicate && i.duplicateChoice === 'skip';
        var tick = el('input', { type: 'checkbox', 'aria-label': 'Save this issue' });
        tick.checked = i.keep;
        tick.addEventListener('change', function () { i.keep = tick.checked; drawAll(); });
        var title = el('div', { class: 'report-title', text: i.title || 'Untitled issue' });
        var amounts = el('div', { class: 'small-text report-amounts', text: amountsLine(i) });
        var status = statusOfCodes(i);
        var head = el('button', { type: 'button', class: 'report-open', 'aria-expanded': i.open ? 'true' : 'false' }, [
          el('span', { class: 'report-main' }, [
            title,
            i.system ? el('span', { class: 'muted small-text', text: i.system }) : null,
            i.codes.length || status ? el('span', { class: 'report-chips' }, i.codes.map(function (c) { return el('span', { class: 'report-code', text: c.code }); }).concat(status ? [el('span', { class: 'report-state' + (i.stored ? ' stored' : ''), text: status })] : [])) : null,
            amounts,
          ]),
          el('span', { class: 'report-chev', 'aria-hidden': 'true', text: i.open ? '⌄' : '›' }),
        ]);
        head.addEventListener('click', function () { i.open = !i.open; drawIssues(); });

        var body = null;
        if (i.open) {
          var notes = el('textarea', { rows: '7', maxlength: '2000', 'aria-label': 'Notes' });
          notes.value = i.notes;
          notes.addEventListener('input', function () { i.notes = notes.value; });
          var fee = amountField('Inspection fee', i.cost, i.currency, function (v) { ReportDraft.setIssueAmount(i, 'fee', v); fee.hint.textContent = 'Counted in costs'; amounts.textContent = amountsLine(i); }, function (v) { i.currency = v; i.sharedFee = false; amounts.textContent = amountsLine(i); }, ReportDraft.isShared(state, i, 'sharedFee') ? 'Shared. Counted once.' : 'Counted in costs');
          var quote = amountField('Quoted repair cost', i.quoteCost, i.quoteCurrency, function (v) { ReportDraft.setIssueAmount(i, 'quote', v); quote.hint.textContent = 'Never counted'; amounts.textContent = amountsLine(i); }, function (v) { i.quoteCurrency = v; i.sharedQuote = false; amounts.textContent = amountsLine(i); }, ReportDraft.isShared(state, i, 'sharedQuote') ? 'Shared quote. Never counted.' : 'Never counted');
          var tip = null;
          if (i.tip) {
            var use = el('button', { type: 'button', class: 'linklike', text: 'Add to notes' });
            use.addEventListener('click', function () {
              var line = 'AI tip (not from the report): ' + i.tip;
              if (i.notes.indexOf(line) === -1) i.notes = (i.notes ? i.notes + '\n\n' : '') + line;
              drawIssues();
            });
            tip = el('div', { class: 'report-tip' }, [el('strong', { text: 'AI tip, not from the report' }), el('p', { text: i.tip }), el('p', { class: 'muted small-text', text: 'AI can be wrong. Check it before acting on it.' }), use]);
          }
          var others = state.issues.filter(function (o) { return o !== i; });
          var combine = others.length ? choose([['', 'Combine with another issue…']].concat(others.map(function (o) { return [o.key, o.title || 'Untitled issue']; })), '', function (v) {
            var other = state.issues.filter(function (o) { return o.key === v; })[0];
            if (!other) return;
            UI.confirm('Combine "' + (other.title || 'Untitled issue') + '" into "' + (i.title || 'Untitled issue') + '"? Their notes, codes, photos and amounts are put together.', { okLabel: 'Combine' }).then(function (yes) {
              if (yes) { ReportDraft.combine(state, i, other); ReportDraft.markDuplicates(state, existing); }
              drawAll();
            });
          }, { 'aria-label': 'Combine with another issue' }) : null;
          body = el('div', { class: 'report-body' }, appending ? [
            el('p', { class: 'section-note', text: 'These notes will be added to the existing issue. Its title, date and mileage stay as they are. It takes this report\'s fee or quote only if it has none; otherwise they are written in its notes.' }),
            UI.field('Notes to add', notes), photoBlock(i), tip, linkBlock(i),
          ] : [
            UI.field('Title *', input({ maxlength: '120' }, i.title, function (v) { i.title = v; title.textContent = v || 'Untitled issue'; })),
            UI.field('Status', choose(STATUSES.map(function (s) { return [s, s]; }), i.status, function (v) { i.status = v; })),
            UI.field('Notes', notes),
            el('div', { class: 'report-money' }, [fee.node, quote.node]),
            photoBlock(i), tip, linkBlock(i),
            combine ? el('div', { class: 'field' }, [combine]) : null,
          ]);
        }
        return el('div', { class: 'report-card' + (i.keep && !skipped ? '' : ' off') + (i.duplicate ? ' dup' : '') + (i.open ? ' open' : '') }, [
          el('div', { class: 'report-head' }, [tick, head]),
          duplicateBlock(i), body,
        ]);
      }

      function drawIssues() {
        issuesBox.replaceChildren.apply(issuesBox, state.issues.map(issueCard));
        drawSummary();
      }

      function drawSummary() {
        var codes = state.issues.reduce(function (n, i) { return n + i.codes.length; }, 0);
        var dups = state.issues.filter(function (i) { return i.duplicate; }).length;
        var stored = state.issues.filter(function (i) { return i.stored; }).length;
        summaryBox.replaceChildren(
          el('strong', { text: state.issues.length ? count(state.issues.length, 'issue') + ' found' : 'No issues were found. Add one by hand, or go back.' }),
          el('div', { class: 'muted small-text', text: [codes ? count(codes, 'fault code') : '', stored ? count(stored, 'issue') + ' with only stored codes (unticked)' : '', data.summary || ''].filter(Boolean).join(' · ') }),
          el('div', { class: 'muted small-text', text: !state.carId ? '' : dups ? count(dups, 'issue') + ' may already be on this car: check the yellow ones.' : state.issues.length > 1 ? 'The issues are linked to each other.' : '' }));
        var n = ReportDraft.kept(state).length;
        var job = state.maintenance && state.maintenance.keep;
        saveBtn.textContent = n && job ? 'Save ' + count(n, 'issue') + ' and the maintenance' : job ? 'Save the maintenance entry' : n ? 'Save ' + count(n, 'issue') : 'Save';
      }

      function drawAll() { drawIssues(); drawFiles(); drawMaintenance(); }

      var addBtn = el('button', { type: 'button', class: 'btn block secondary', text: '+ Add an issue AI missed' });
      addBtn.addEventListener('click', function () { ReportDraft.addIssue(state); drawAll(); });

      saveBtn.addEventListener('click', function () {
        saveMsg.replaceChildren();
        var wrong = ReportDraft.problems(state);
        if (wrong.length) { saveMsg.replaceChildren(UI.notice('error', wrong.join(' '))); markMissing(); return; }
        var payload = ReportDraft.payload(state);
        UI.busy(saveBtn, 'Saving… this can take a minute', FleetApi.call('saveReport', payload, { timeoutMs: SAVE_TIMEOUT_MS })).then(function (r) {
          var made = r.data.entries.filter(function (e) { return e.created && e.type === 'Issue'; }).length;
          var added = r.data.entries.filter(function (e) { return !e.created; }).length;
          var job = r.data.entries.filter(function (e) { return e.type === 'Maintenance'; }).length;
          var said = [made ? count(made, 'issue') + ' saved' : '', added ? 'notes added to ' + count(added, 'issue') : '', job ? 'the maintenance entry saved' : ''].filter(Boolean).join(', ');
          Views.invalidateCars();
          if (window.InboxUI) InboxUI.refreshCount();
          FleetApp.setFlash('ok', said.charAt(0).toUpperCase() + said.slice(1) + '.');
          if (Views.openCarSections) Views.openCarSections(r.data.carId, { 'Maintenance & Issues Log': true });
          FleetApp.go('/car/' + r.data.carId);
        }).catch(function (e) { saveMsg.replaceChildren(UI.notice('error', UI.errorText(e))); });
      });
      var later = el('a', { class: 'report-later', href: '#/inbox', text: 'Save later (it stays in the AI Inbox)' });

      root.replaceChildren(el('section', { class: 'card report-page' }, [
        fmt().backLink('#/inbox/' + receipt.id, 'AI Inbox'),
        el('h1', { text: 'Review the report' }),
        el('p', { class: 'section-note', text: 'AI read this. It can get things wrong, so check everything before you save. Nothing is on the car yet.' }),
        receipt.status !== 'Pending' ? UI.notice('info', receipt.note || 'This has not been read by AI yet. You can add the issues by hand.') : null,
        msg,
        el('div', { class: 'report-box' }, [
          el('h2', { text: 'Applies to every issue' }),
          el('div', { class: 'field' }, [el('label', { text: 'Vehicle *' }), carSelect]),
          plateBox,
          el('div', { class: 'field-pair' }, [UI.field('Date *', dateIn, dateHint), UI.field('Mileage *', mileIn, mileHint)]),
          odoBox,
          el('div', { class: 'field' }, [el('label', { text: 'Garage or who identified the issue' }), who, otherBox,
            el('div', { class: 'hint', text: state.vendor ? 'Read from the report' : 'The report names no garage, so this starts as you.' })]),
          filesBox,
        ]),
        el('div', { class: 'report-box' }, [el('h2', { text: 'Fees and quotes' }), feesBox]),
        summaryBox, maintenanceBox, issuesBox, addBtn, saveMsg, saveBtn, later,
      ]));
      drawFees(); drawAll(); drawPlate(); drawOdometer(); markMissing();
      FleetApp.setBanner({ subtitle: firstCar ? firstCar.registration + ' · ' + firstCar.make + ' ' + firstCar.model : 'Choose the car' });
      if (firstCar) pickCar(firstCar.id);
    }
  };
})();
