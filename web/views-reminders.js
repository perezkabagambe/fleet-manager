// Reminders: the card on the car page, and the form to add or edit one.
(function () {
  'use strict';

  var el = UI.el;
  var Views = (window.Views = window.Views || {});
  var fmt = Views.fmt;

  var STATUS = {
    overdue: { label: 'Overdue', cls: 's-overdue' },
    due_soon: { label: 'Due soon', cls: 's-due_soon' },
    ok: { label: 'OK', cls: 's-ok' },
    paused: { label: 'Paused', cls: 's-paused' },
  };

  function statusChip(status) {
    var s = STATUS[status] || STATUS.ok;
    return el('span', { class: 'chip ' + s.cls, text: s.label });
  }

  // ---------- Reminders card (on the car page) ----------
  // `preloaded` (the car page's reminders) saves a request; after a change the card fetches its own.
  function card(car, preloaded) {
    var list = el('div', { class: 'history' }, [fmt.loading()]);
    var msg = el('div');
    var body = el('div');
    function row(t) {
      // The same layout as a log row: a picture with its tag beneath, then the name, when it is due, how often it repeats, and the status.
      // Every line is one line, cut off with "…" if it is too long.
      var renewal = t.kind === 'compliance';
      var link = el('a', { class: 'entry-row', href: '#/car/' + car.id + '/reminder/' + t.id }, [
        el('div', { class: 'entry-lead' }, [
          EntryUI.typeThumb(renewal ? 'Compliance' : 'Maintenance'),
          el('span', { class: 'chip ' + (renewal ? 't-compliance' : 't-maintenance'), text: renewal ? 'Compliance' : 'Maintenance' }),
        ]),
        el('div', { class: 'entry-main' }, [
          el('div', { class: 'entry-title', text: t.name }),
          el('div', { class: 'muted small-text entry-ref-line', text: t.active ? t.text : (t.pausedReason || 'Paused') }),
          t.repeatText ? el('div', { class: 'muted small-text entry-garage-line', text: 'Repeats every ' + t.repeatText }) : null,
          el('div', { class: 'entry-foot' }, [el('div', { class: 'entry-foot-tags' }, [statusChip(t.status)])]),
        ]),
      ]);
      return el('div', { class: 'entry-line' }, [link]);
    }

    function draw(tasks) {
      list.replaceChildren.apply(list, tasks.length ? tasks.map(row)
        : [el('p', { class: 'muted', text: 'No reminders yet. Add the standard set to start, or add your own.' })]);
    }
    function load() {
      return FleetApi.call('listTasks', { carId: car.id }).then(function (r) { draw(r.data.tasks); })
        .catch(function (e) { list.replaceChildren(UI.notice('error', UI.errorText(e))); });
    }

    var stdBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Add standard reminders' });
    stdBtn.addEventListener('click', function () {
      msg.replaceChildren();
      UI.busy(stdBtn, 'Adding…', FleetApi.call('addStandardTasks', { carId: car.id })).then(function (r) {
        msg.replaceChildren(UI.notice('ok', r.data.added ? r.data.added + ' reminders added. Edit any of them to suit this car.' : 'This car already has all the standard reminders.'));
        return load();
      }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
    });
    var mailBtn = el('button', { type: 'button', class: 'btn small secondary', text: 'Email me what is due now' });
    mailBtn.addEventListener('click', function () {
      msg.replaceChildren();
      UI.busy(mailBtn, 'Sending…', FleetApi.call('sendMyReminders')).then(function (r) {
        msg.replaceChildren(r.data.sent
          ? UI.notice('ok', 'Sent: ' + r.data.count + ' reminder' + (r.data.count === 1 ? '' : 's') + ' to your email. Check your junk folder if it does not arrive.')
          : UI.notice('ok', r.data.count ? 'The email could not be sent just now. Please try again later.' : 'Nothing is due for you right now.'));
      }).catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
    });

    body.append(
      el('a', { class: 'btn block', href: '#/car/' + car.id + '/reminder/new', text: 'Add reminder' }),
      el('div', { class: 'reminder-tools' }, [stdBtn, mailBtn]),
      msg, list
    );
    if (preloaded) draw(preloaded); else load();
    return el('section', { class: 'card' }, [
      el('h2', { text: 'Reminders' }),
      el('p', { class: 'section-note', text: 'Emailed to the car\'s owners/custodians every Monday while something is due.' }),
      body,
    ]);
  }
  window.RemindersUI = { card: card };

  // An older email linked to #/car/<id>/add/compliance?task=<id>: send it to that reminder, where renewing is done now.
  Views.oldRenewalLink = function (ctx, root) {
    var task = ctx.query && ctx.query.task;
    location.replace('#/car/' + ctx.params.id + (task ? '/reminder/' + task : ''));
  };

  // ---------- add / edit a reminder ----------
  Views.reminderForm = function (ctx, root) {
    var carId = ctx.params.id;
    var tid = ctx.params.tid || '';
    root.replaceChildren(el('section', { class: 'card' }, [fmt.loading()]));

    var calls = [FleetApi.call('getCar', { id: carId }), FleetApi.call('listApprovedUsers'), FleetApi.call('listTasks', { carId: carId })];
    if (tid) calls.push(FleetApi.call('listRenewals', { carId: carId }));
    Promise.all(calls).then(function (res) {
      var task = tid ? res[2].data.tasks.filter(function (t) { return t.id === tid; })[0] : null;
      if (tid && !task) { fmt.notFound(root); return; }
      build(res[0].data.car, res[1].data.users, task, res[3] ? res[3].data.renewals.filter(function (r) { return r.taskId === tid; }) : []);
    }).catch(function (e) {
      if (e.code === 'not_found') fmt.notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function build(car, users, task, renewals) {
      var unit = 'miles';
      var t = task || { kind: 'maintenance', assignees: [], active: true };
      var f = {};
      var msg = el('div');
      function text(name, value, attrs) {
        f[name] = el('input', Object.assign({ type: 'text', name: name, value: value === null || value === undefined ? '' : String(value), autocomplete: 'off' }, attrs || {}));
        return f[name];
      }
      function num(name, value, label, hint) { return UI.field(label, text(name, value, { inputmode: 'numeric' }), hint); }

      // the two kinds of reminder, each with a note saying what it is for
      var KINDS = [
        { value: 'maintenance', label: 'Regular maintenance', note: 'Servicing and checks that come round again, by date or distance. For example engine oil and filter, tyre check, brake fluid, spark plugs.' },
        { value: 'compliance', label: 'Compliance', note: 'Legal renewals that run out on a date. For example MOT, insurance, road tax.' },
      ];
      var kindValue = t.kind;
      var kindBox = el('div', { class: 'kind-picker', role: 'radiogroup', 'aria-label': 'Type of reminder' });
      KINDS.forEach(function (k) {
        var radio = el('input', { type: 'radio', name: 'kind', value: k.value });
        radio.checked = k.value === kindValue;
        radio.addEventListener('change', function () { if (radio.checked) kindValue = k.value; });
        kindBox.append(el('label', { class: 'kind-option' }, [radio, el('span', {}, [el('span', { class: 'kind-name', text: k.label }), el('span', { class: 'kind-note', text: k.note })])]));
      });
      // ----- Mark renewed (compliance reminders only): what was done, the new expiry date, and optionally the cost and a certificate -----
      function renewBox() {
        var today = new Date().toISOString().slice(0, 10);
        var rmsg = el('div');
        var doneIn = el('input', { type: 'date', name: 'renewDate', value: today, max: today, required: true });
        var expiryIn = el('input', { type: 'date', name: 'renewExpiry', required: true });
        var costIn = el('input', { type: 'text', name: 'renewCost', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Cost' });
        var curIn = el('select', { 'aria-label': 'Currency' }, fmt.currencyOptions.map(function (o) { return el('option', { value: o[0], text: o[1], selected: o[0] === (car.currency || 'GBP') }); }));
        var noteIn = el('input', { type: 'text', name: 'renewNotes', maxlength: '200', autocomplete: 'off', placeholder: 'e.g. Passed with no advisories' });
        var fileIn = el('input', { type: 'file', name: 'renewFile', accept: 'image/*,application/pdf' });
        var go = el('button', { type: 'submit', class: 'btn block', text: 'Mark renewed' });
        var box = el('form', { class: 'renew-box', novalidate: true }, [
          el('h2', { text: 'Mark renewed' }),
          el('p', { class: 'section-note', text: 'Done it? Record when, and the new expiry date. The reminder then waits until it is due again.' }),
          rmsg,
          UI.field('Date done *', doneIn),
          UI.field('New expiry date *', expiryIn, 'When it runs out next.'),
          el('div', { class: 'field' }, [el('label', { text: 'Cost (optional)' }), el('div', { class: 'odo-row' }, [costIn, curIn])]),
          UI.field('Note (optional)', noteIn),
          UI.field('Certificate or receipt (optional)', fileIn, 'Kept with this car\'s documents.'),
          go,
        ]);
        box.addEventListener('submit', function (ev) {
          ev.preventDefault();
          rmsg.replaceChildren();
          var file = fileIn.files && fileIn.files[0];
          var fields = { date: doneIn.value, expiryDate: expiryIn.value, cost: costIn.value, currency: curIn.value, notes: noteIn.value };
          UI.busy(go, 'Saving…', FleetApi.call('renewTask', { id: task.id, fields: fields }).then(function (r) {
            var next = r.data.task;
            var done = 'Renewed. ' + next.name + ' is ' + next.text + '.';
            if (!file) return done;
            return Photos.prepareAttachment(file).then(function (a) {
              return FleetApi.call('uploadCarDocument', { carId: car.id, type: 'Other', note: task.name + ' renewed ' + fields.date, mime: a.mime, data: a.data, filename: a.filename }, { timeoutMs: 240000 });
            }).then(function () { return done; }, function (e) { return done + ' The file could not be saved: ' + UI.errorText(e); });
          })).then(function (text) {
            FleetApp.setFlash('ok', text);
            FleetApp.go('/car/' + car.id);
          }).catch(function (e) { rmsg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
        var past = renewals.length ? el('div', { class: 'renew-history' }, [
          el('div', { class: 'field-label one-line', text: 'Past renewals' }),
          el('ul', { class: 'plain-list' }, renewals.map(function (r) {
            var day = function (iso) { return fmt.date(iso + 'T12:00:00Z'); };
            return el('li', { text: day(r.date) + ' · until ' + day(r.expiryDate) + (r.cost === null ? '' : ' · ' + fmt.money(r.cost, r.currency)) });
          })),
        ]) : null;
        return el('div', {}, [box, past]);
      }

      // who is told
      // a searchable drop-down; the chosen people show as chips
      var who = UI.searchMulti(users.map(function (u) { return { value: u.id, label: u.name }; }), { values: t.assignees, placeholder: 'Add a person…', ariaLabel: 'Add a person to remind', emptyText: 'No one chosen: it goes to the car\'s owners/custodians.' });

      var pause = el('input', { type: 'checkbox' });
      pause.checked = !t.active;
      var pauseReason = text('pausedReason', t.pausedReason, { maxlength: '120', placeholder: 'e.g. Car in storage' });

      var fields = [
        UI.field('What is it? *', text('name', t.name, { maxlength: '80', placeholder: 'e.g. Engine oil and filter', required: true })),
        UI.field('Type', kindBox),
        el('div', { class: 'form-section' }, [
          el('h2', { text: 'How often' }),
          num('intervalMonths', t.intervalMonths, 'Repeats every (months)', 'Leave blank if it does not repeat by date.'),
          num('intervalDistance', t.intervalDistance, 'Or every (' + unit + ')', 'Leave blank if it does not repeat by distance. If you set both, whichever comes first.'),
          num('leadDays', t.leadDays || '', 'Start reminding me this many days ahead', 'Default 14 for regular maintenance, 28 for compliance.'),
          num('leadDistance', t.leadDistance || '', 'And this many ' + unit + ' ahead', 'Default 300.'),
        ]),
        el('div', { class: 'form-section' }, [
          el('h2', { text: 'When is it next due?' }),
          UI.field('Next due date', text('dueDate', t.dueDate, { type: 'date' }), 'Leave blank to work it out from the repeat and when it was last done (or from today).'),
          num('dueDistance', t.dueDistance, 'Next due at (' + unit + ')', 'Leave blank to work it out from the car\'s odometer.'),
        ]),
      ];
      if (!task) {
        fields.push(el('div', { class: 'form-section' }, [
          el('h2', { text: 'When was it last done? (optional)' }),
          UI.field('Date', text('lastDoneDate', '', { type: 'date', max: new Date().toISOString().slice(0, 10) })),
          num('lastDoneDistance', '', 'At (' + unit + ')'),
        ]));
      } else if (task.lastDoneDate) {
        fields.push(el('p', { class: 'muted', text: 'Last done ' + task.lastDoneDate + (task.lastDoneDistance !== null ? ' at ' + fmt.num(task.lastDoneDistance) + ' ' + unit : '') + '.' }));
      }
      fields.push(
        el('div', { class: 'form-section' }, [
          el('h2', { text: 'Who is reminded?' }),
          el('p', { class: 'section-note', text: 'Choose the people who should get the email for this reminder. If you choose no one, it goes to this car\'s owners/custodians. If the car has none, it goes to the admins.' }),
          who,
        ]),
        el('div', { class: 'form-section' }, [
          el('label', { class: 'check' }, [pause, el('span', { text: 'Pause this reminder' })]),
          UI.field('Why paused (optional)', pauseReason),
        ])
      );

      var btn = el('button', { type: 'submit', class: 'btn block big save-gap', text: task ? 'Save changes' : 'Add reminder' });
      var form = el('form', { novalidate: true }, fields.concat([btn]));
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        msg.replaceChildren();
        var vals = {};
        ['name', 'intervalMonths', 'intervalDistance', 'leadDays', 'leadDistance', 'dueDate', 'dueDistance', 'lastDoneDate', 'lastDoneDistance', 'pausedReason'].forEach(function (k) { if (f[k]) vals[k] = f[k].value; });
        vals.kind = kindValue;
        vals.assignees = who.values();
        vals.active = !pause.checked;
        var payload = { carId: car.id, fields: vals };
        if (task) { payload.id = task.id; payload.version = task.version; }
        UI.busy(btn, 'Saving…', FleetApi.call('saveTask', payload))
          .then(function () { FleetApp.go('/car/' + car.id); })
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); window.scrollTo(0, 0); });
      });

      var deleteBtn = null;
      if (task && FleetAuth.isAdmin()) {
        deleteBtn = el('button', { type: 'button', class: 'btn block danger-outline', text: 'Delete reminder' });
        deleteBtn.addEventListener('click', function () {
          UI.confirm('Delete the reminder "' + task.name + '"? Past entries are not affected.', { okLabel: 'Delete', danger: true }).then(function (yes) {
            if (!yes) return;
            UI.busy(deleteBtn, 'Deleting…', FleetApi.call('deleteTask', { id: task.id }))
              .then(function () { FleetApp.go('/car/' + car.id); })
              .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
          });
        });
      }

      root.replaceChildren(el('section', { class: 'card' }, [
        fmt.backLink('#/car/' + car.id, car.registration),
        el('h1', { text: task ? 'Edit reminder' : 'Add a reminder' }),
        task ? el('p', { class: 'muted', text: task.text }) : el('p', { class: 'muted', text: car.registration + ' · ' + car.make + ' ' + car.model }),
        msg, task && task.kind === 'compliance' ? renewBox() : null, form,
        deleteBtn ? el('div', { class: 'entry-actions' }, [deleteBtn]) : null,
      ]));
    }
  };
})();
