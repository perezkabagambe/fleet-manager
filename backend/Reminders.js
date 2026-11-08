/**
 * The weekly reminder digest.
 *
 * Every Monday morning (London time) each person gets ONE email listing every reminder they are responsible
 * for that is overdue or inside its heads-up window, across all their cars. A reminder keeps appearing each
 * week until it is logged. Who is responsible: the people picked on the reminder, otherwise the car's
 * owners/custodians, otherwise the admins (so it never goes to nobody).
 *
 * Cars that are Sold or Scrapped, paused reminders and deleted cars/reminders are skipped.
 */

const REMINDER_WEEKDAY_HOUR = 8;

/** People who should hear about this reminder. */
function recipientsFor_(task, car, usersById, carPeople) {
  let ids = task.assignees ? String(task.assignees).split(',').filter(Boolean) : [];
  if (!ids.length) {
    ids = carPeople.filter(function (r) { return r.car_id === car.id && !isTrue_(r.deleted); }).map(function (r) { return r.user_id; });
  }
  if (!ids.length) {
    ids = Object.keys(usersById).filter(function (id) { return usersById[id].role === 'admin'; });
  }
  const seen = {};
  return ids.filter(function (id) {
    const u = usersById[id];
    if (!u || u.status !== 'Approved' || seen[id]) return false;
    seen[id] = true;
    return true;
  }).map(function (id) { return usersById[id]; });
}

/** { userId: { user, items: [{task, car, desc}] } } for everything that needs attention today. */
function collectDigests_(onlyUserId) {
  const today = todayIso_();
  const users = usersById_();
  const carPeople = Db.all('CarPeople');
  const cars = {};
  Db.all('Cars').forEach(function (c) { if (!isTrue_(c.deleted) && c.status !== 'Sold' && c.status !== 'Scrapped') cars[c.id] = c; });
  const byUser = {};
  Db.all('Tasks').forEach(function (t) {
    if (isTrue_(t.deleted) || !isTrue_(t.active)) return;
    const car = cars[t.car_id];
    if (!car) return;
    const desc = describeTask_(t, car, today);
    if (desc.status !== 'overdue' && desc.status !== 'due_soon') return;
    recipientsFor_(t, car, users, carPeople).forEach(function (u) {
      if (onlyUserId && u.id !== onlyUserId) return;
      (byUser[u.id] = byUser[u.id] || { user: u, items: [] }).items.push({ task: t, car: car, desc: desc });
    });
  });
  Object.keys(byUser).forEach(function (id) {
    byUser[id].items.sort(function (a, b) {
      return (STATUS_ORDER[a.desc.status] - STATUS_ORDER[b.desc.status]) || a.car.registration.localeCompare(b.car.registration) || a.task.name.localeCompare(b.task.name);
    });
  });
  return byUser;
}

function logLink_(task) {
  const path = task.kind === 'compliance' ? 'compliance' : 'maintenance';
  return SITE_URL + '#/car/' + task.car_id + '/add/' + path + '?task=' + task.id;
}

/** What happens once it is done, in plain words. */
function afterText_(task, car) {
  if (task.kind === 'compliance') {
    return 'Once you record the renewal with its new expiry date, Fleet Manager will remind you again before that date.';
  }
  const every = intervalText_(task, car.distance_unit || 'mi');
  return every
    ? 'Once you record it, Fleet Manager will remind you again in ' + every + '.'
    : 'Once you record it, this reminder is cleared.';
}

function sendDigestEmail_(entry) {
  const items = entry.items;
  const overdue = items.filter(function (i) { return i.desc.status === 'overdue'; }).length;
  const soon = items.length - overdue;
  const subject = 'Fleet Manager: ' + (overdue ? overdue + ' overdue' + (soon ? ', ' + soon + ' due soon' : '') : plural_(soon, 'reminder') + ' due soon');

  let html = '<p>Hi ' + esc_(entry.user.name) + ', here is what needs attention on your cars.</p>';
  let text = 'Hi ' + entry.user.name + ',\n\nHere is what needs attention on your cars.\n';
  items.forEach(function (i) {
    const t = i.task;
    const car = i.car;
    const link = logLink_(t);
    const label = t.kind === 'compliance' ? 'Record the renewal' : 'Log this maintenance';
    const last = t.last_done_date ? 'Last done ' + fmtDateText_(t.last_done_date) + (t.last_done_distance ? ' at ' + thousands_(Number(t.last_done_distance)) + ' ' + (car.distance_unit || 'mi') : '') + '.' : '';
    const colour = i.desc.status === 'overdue' ? '#b3261e' : '#6b4a00';
    html += '<div style="border:1px solid #d9e0e6;border-radius:10px;padding:12px 14px;margin:14px 0">' +
      '<div style="font-weight:700;font-size:16px">' + esc_(t.name) + '</div>' +
      '<div style="color:#5d6b79">' + esc_(car.registration) + ' · ' + esc_(car.make + ' ' + car.model) + '</div>' +
      '<div style="color:' + colour + ';font-weight:600;margin-top:6px">' + esc_(capitalise_(i.desc.text)) + '</div>' +
      (last ? '<div style="color:#5d6b79;font-size:13px">' + esc_(last) + '</div>' : '') +
      button_(link, label) +
      '<div style="color:#5d6b79;font-size:13px">' + esc_(afterText_(t, car)) + '</div></div>';
    text += '\n- ' + t.name + ' (' + car.registration + '): ' + capitalise_(i.desc.text) + '\n  ' + last + '\n  ' + label + ': ' + link + '\n  ' + afterText_(t, car) + '\n';
  });
  html += '<p style="color:#5d6b79;font-size:13px">You get this email every Monday while something is due. You will be asked to sign in first if you are not already.</p>';
  return sendMail_(entry.user.email, subject, layout_('Your car reminders', html), text);
}

function capitalise_(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** The weekly time-based trigger target. */
function sendWeeklyReminders() {
  const digests = collectDigests_('');
  const ids = Object.keys(digests);
  let sent = 0;
  const now = nowIso_();
  ids.forEach(function (id) {
    if (!sendDigestEmail_(digests[id])) return;
    sent++;
    digests[id].items.forEach(function (i) {
      const row = Db.all('Tasks').filter(function (t) { return t.id === i.task.id; })[0];
      if (row) Db.update('Tasks', row._row, { last_reminded_at: now });
    });
  });
  if (ids.length) audit_(null, 'reminders_sent', 'Reminders', '', sent + ' reminder email(s) sent for ' + ids.reduce(function (n, id) { return n + digests[id].items.length; }, 0) + ' item(s)');
  return sent;
}

/** "Email me what is due now": the same digest, only for the person asking, any day. */
function sendMyReminders_(p, ctx) {
  const digests = collectDigests_(ctx.user.id);
  const mine = digests[ctx.user.id];
  if (!mine) return { sent: false, count: 0 };
  const ok = sendDigestEmail_(mine);
  return { sent: ok, count: mine.items.length };
}

/** Create the Monday 8am trigger if it is not there yet. Safe to call any number of times. */
function ensureReminderTrigger_() {
  try {
    const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'sendWeeklyReminders'; });
    if (!exists) {
      ScriptApp.newTrigger('sendWeeklyReminders').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(REMINDER_WEEKDAY_HOUR).inTimezone(TZ).create();
    }
  } catch (e) {
    console.error('could not create the reminder trigger: ' + (e && e.message));
  }
}
