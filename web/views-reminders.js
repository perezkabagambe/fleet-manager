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
  function card(car) {
    var list = el('div', { class: 'history' }, [fmt.loading()]);
    var msg = el('div');
    var body = el('div');

    function row(t) {
      return el('a', { class: 'entry-row', href: '#/car/' + car.id + '/reminder/' + t.id }, [
        el('div', { class: 'entry-main' }, [
          el('div', { class: 'entry-title', text: t.name }),
          el('div', { class: 'muted small-text', text: t.active ? t.text : (t.pausedReason || 'Paused') }),
          t.repeatText ? el('div', { class: 'muted small-text', text: 'Repeats every ' + t.repeatText }) : null,
        ]),
        el('div', { class: 'entry-tags' }, [statusChip(t.status), t.kind === 'compliance' ? el('span', { class: 'chip t-compliance', text: 'Renewal' }) : null]),
      ]);
    }

    function load() {
      return FleetApi.call('listTasks', { carId: car.id }).then(function (r) {
        var tasks = r.data.tasks;
        list.replaceChildren.apply(list, tasks.length ? tasks.map(row)
          : [el('p', { class: 'muted', text: 'No reminders yet. Add the standard set to start, or add your own.' })]);
      }).catch(function (e) { list.replaceChildren(UI.notice('error', UI.errorText(e))); });
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
      el('div', { class: 'btn-row' }, [el('a', { class: 'btn small', href: '#/car/' + car.id + '/reminder/new', text: 'Add reminder' }), stdBtn, mailBtn]),
      msg, list
    );
    load();
    return el('section', { class: 'card' }, [
      el('h2', { text: 'Reminders' }),
      el('p', { class: 'muted small-text', text: 'Emailed to the car\'s owners/custodians every Monday while something is due.' }),
      body,
    ]);
  }
  window.RemindersUI = { card: card };

  // ---------- add / edit a reminder ----------
  Views.reminderForm = function (ctx, root) {
    var carId = ctx.params.id;
    var tid = ctx.params.tid || '';
    root.replaceChildren(el('section', { class: 'card' }, [fmt.loading()]));

    var calls = [FleetApi.call('getCar', { id: carId }), FleetApi.call('listApprovedUsers'), FleetApi.call('listTasks', { carId: carId })];
    Promise.all(calls).then(function (res) {
      var task = tid ? res[2].data.tasks.filter(function (t) { return t.id === tid; })[0] : null;
      if (tid && !task) { fmt.notFound(root); return; }
      build(res[0].data.car, res[1].data.users, task);
    }).catch(function (e) {
      if (e.code === 'not_found') fmt.notFound(root);
      else if (e.code !== 'unauthorized') root.replaceChildren(el('section', { class: 'card' }, [UI.notice('error', UI.errorText(e))]));
    });

    function build(car, users, task) {
      var unit = car.distanceUnit || 'mi';
      var t = task || { kind: 'maintenance', assignees: [], active: true };
      var f = {};
      var msg = el('div');
      function text(name, value, attrs) {
        f[name] = el('input', Object.assign({ type: 'text', name: name, value: value === null || value === undefined ? '' : String(value), autocomplete: 'off' }, attrs || {}));
        return f[name];
      }
      function num(name, value, label, hint) { return UI.field(label, text(name, value, { inputmode: 'numeric' }), hint); }

      var kind = el('select', { name: 'kind' }, [['maintenance', 'Maintenance (servicing, checks)'], ['compliance', 'Renewal (MOT, insurance, road tax)']].map(function (o) {
        return el('option', { value: o[0], text: o[1], selected: o[0] === t.kind });
      }));
      f.kind = kind;

      // who is told
      var boxes = users.map(function (u) {
        var b = el('input', { type: 'checkbox' });
        b.checked = t.assignees.indexOf(u.id) !== -1;
        return { user: u, box: b };
      });
      var who = el('div', { class: 'stack' }, boxes.map(function (x) { return el('label', { class: 'check' }, [x.box, el('span', { text: x.user.name })]); }));

      var pause = el('input', { type: 'checkbox' });
      pause.checked = !t.active;
      var pauseReason = text('pausedReason', t.pausedReason, { maxlength: '120', placeholder: 'e.g. Car in storage' });

      var fields = [
        UI.field('What is it? *', text('name', t.name, { maxlength: '80', placeholder: 'e.g. Engine oil and filter', required: true })),
        UI.field('Type', kind),
        el('div', { class: 'form-section' }, [
          el('h2', { text: 'How often' }),
          num('intervalMonths', t.intervalMonths, 'Repeats every (months)', 'Leave blank if it does not repeat by date.'),
          num('intervalDistance', t.intervalDistance, 'Or every (' + unit + ')', 'Leave blank if it does not repeat by distance. If you set both, whichever comes first.'),
          num('leadDays', t.leadDays || '', 'Start reminding me this many days ahead', 'Default 14 (28 for renewals).'),
          num('leadDistance', t.leadDistance || '', 'And this many ' + unit + ' ahead', 'Default ' + (unit === 'km' ? '500' : '300') + '.'),
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
          el('p', { class: 'muted small-text', text: 'Tick no one to remind this car\'s owners/custodians (or the admins if it has none).' }),
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
        vals.kind = kind.value;
        vals.assignees = boxes.filter(function (x) { return x.box.checked; }).map(function (x) { return x.user.id; });
        vals.active = !pause.checked;
        var payload = { carId: car.id, fields: vals };
        if (task) { payload.id = task.id; payload.version = task.version; }
        UI.busy(btn, 'Saving…', FleetApi.call('saveTask', payload))
          .then(function () { FleetApp.go('/car/' + car.id); })
          .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); window.scrollTo(0, 0); });
      });

      var deleteBtn = null;
      if (task && FleetAuth.isAdmin()) {
        deleteBtn = el('button', { type: 'button', class: 'btn small danger', text: 'Delete reminder' });
        deleteBtn.addEventListener('click', function () {
          if (!window.confirm('Delete the reminder "' + task.name + '"? Past entries are not affected.')) return;
          UI.busy(deleteBtn, 'Deleting…', FleetApi.call('deleteTask', { id: task.id }))
            .then(function () { FleetApp.go('/car/' + car.id); })
            .catch(function (e) { msg.replaceChildren(UI.notice('error', UI.errorText(e))); });
        });
      }

      root.replaceChildren(el('section', { class: 'card' }, [
        fmt.backLink('#/car/' + car.id, car.registration),
        el('h1', { text: task ? 'Edit reminder' : 'Add a reminder' }),
        task ? el('p', { class: 'muted', text: task.text }) : el('p', { class: 'muted', text: car.registration + ' · ' + car.make + ' ' + car.model }),
        msg, form,
        deleteBtn ? el('div', { class: 'btn-row' }, [deleteBtn]) : null,
      ]));
    }
  };
})();
