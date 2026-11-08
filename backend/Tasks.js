/**
 * Reminders ("tasks") for a car: routine maintenance and compliance renewals.
 *
 * A task is due by DATE, by DISTANCE, or both ("whichever comes first"). It starts showing in the weekly email
 * once it is inside its heads-up window (lead days / lead distance) and keeps showing every week until it is
 * logged. Logging a Maintenance entry against it (or a Compliance renewal with its new expiry date) moves the
 * due date/distance forward by the repeat interval and clears the reminder.
 *
 * Distances are always in miles. Any approved user can add,
 * edit and pause reminders; only admins delete them.
 */

const TASK_KINDS = ['maintenance', 'compliance'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Sensible starting points (all editable). Distances are in miles.
const STANDARD_TASKS = [
  { name: 'Engine oil and filter', months: 6, mi: 6000 },
  { name: 'General service', months: 12, mi: 12000 },
  { name: 'Tyre inspection', months: 3 },
  { name: 'Coolant change', months: 24, mi: 25000 },
  { name: 'Brake fluid change', months: 24 },
  { name: 'Air filter', months: 12, mi: 12000 },
  { name: 'Cabin filter', months: 12, mi: 10000 },
  { name: 'Spark plugs', months: 48, mi: 36000 },
  { name: 'Gearbox oil', months: 48, mi: 36000 },
  { name: 'Battery check', months: 12 },
];

// ---------- dates and numbers ----------

function todayIso_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function isoParts_(iso) {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

function daysBetween_(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000);
}

/** Add whole months to an ISO date, keeping the day (or the month's last day if it is shorter). */
function addMonths_(iso, months) {
  const p = isoParts_(iso);
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const pad = function (n) { return ('0' + n).slice(-2); };
  return y + '-' + pad(m + 1) + '-' + pad(Math.min(p.d, last));
}

function fmtDateText_(iso) {
  if (!iso) return '';
  const p = isoParts_(iso);
  return p.d + ' ' + MONTH_ABBR[p.m - 1] + ' ' + p.y;
}

function thousands_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function plural_(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

// ---------- status and wording ----------

/** Work out where a task stands today, and how to say it. */
function describeTask_(t, car, today) {
  const unit = 'mi';
  const odo = car.current_odometer === '' || car.current_odometer === undefined ? null : Number(car.current_odometer);
  const dueDist = t.due_distance === '' || t.due_distance === undefined ? null : Number(t.due_distance);
  const daysLeft = t.due_date ? daysBetween_(today, t.due_date) : null;
  const distLeft = dueDist !== null && odo !== null ? dueDist - odo : null;
  const leadDays = numOr0_(t.lead_days);
  const leadDist = numOr0_(t.lead_distance);

  const overdue = (daysLeft !== null && daysLeft < 0) || (distLeft !== null && distLeft <= 0);
  const soon = (daysLeft !== null && daysLeft <= leadDays) || (distLeft !== null && distLeft <= leadDist);
  const active = isTrue_(t.active);
  const status = !active ? 'paused' : overdue ? 'overdue' : soon ? 'due_soon' : 'ok';

  const parts = [];
  if (daysLeft !== null) {
    if (daysLeft < 0) parts.push('overdue by ' + plural_(-daysLeft, 'day'));
    else if (daysLeft === 0) parts.push('due today');
    else parts.push('due in ' + plural_(daysLeft, 'day') + ' (' + fmtDateText_(t.due_date) + ')');
  }
  if (dueDist !== null) {
    if (distLeft === null) parts.push('due at ' + thousands_(dueDist) + ' ' + unit);
    else if (distLeft <= 0) parts.push('reached ' + thousands_(dueDist) + ' ' + unit + ' (' + thousands_(-distLeft) + ' ' + unit + ' over)');
    else parts.push('due at ' + thousands_(dueDist) + ' ' + unit + ' (' + thousands_(distLeft) + ' ' + unit + ' to go)');
  }
  return { status: status, daysLeft: daysLeft, distanceLeft: distLeft, text: parts.join(' · ') || 'no due date set' };
}

/** "6 months or 6,000 mi, whichever comes first" */
function intervalText_(t, unit) {
  const m = numOr0_(t.interval_months);
  const d = numOr0_(t.interval_distance);
  if (m && d) return plural_(m, 'month') + ' or ' + thousands_(d) + ' ' + unit + ', whichever comes first';
  if (m) return plural_(m, 'month');
  if (d) return thousands_(d) + ' ' + unit;
  return '';
}

function summarizeTask_(t, car, today) {
  const d = describeTask_(t, car, today);
  return {
    id: t.id, carId: t.car_id, kind: t.kind, name: t.name,
    intervalMonths: numOrNull_(t.interval_months), intervalDistance: numOrNull_(t.interval_distance),
    leadDays: numOr0_(t.lead_days), leadDistance: numOr0_(t.lead_distance),
    dueDate: t.due_date || '', dueDistance: numOrNull_(t.due_distance),
    lastDoneDate: t.last_done_date || '', lastDoneDistance: numOrNull_(t.last_done_distance),
    assignees: t.assignees ? String(t.assignees).split(',').filter(Boolean) : [],
    active: isTrue_(t.active), pausedReason: t.paused_reason || '',
    status: d.status, daysLeft: d.daysLeft, distanceLeft: d.distanceLeft, text: d.text,
    repeatText: intervalText_(t, 'mi'),
    distanceUnit: 'mi', version: Number(t.version || 1),
  };
}

function liveTasks_(carId) {
  return Db.all('Tasks').filter(function (t) { return t.car_id === carId && !isTrue_(t.deleted); });
}

function findTask_(id) {
  return Db.all('Tasks').filter(function (t) { return t.id === id && !isTrue_(t.deleted); })[0] || null;
}

const STATUS_ORDER = { overdue: 0, due_soon: 1, ok: 2, paused: 3 };

// ---------- validating input ----------

function parseIntBetween_(raw, min, max, errorCode) {
  const s = String(raw === null || raw === undefined ? '' : raw).replace(/[,\s]/g, '');
  if (s === '') return '';
  if (!/^\d{1,7}$/.test(s) || Number(s) < min || Number(s) > max) fail_(errorCode);
  return String(Number(s));
}

/** Approved users' ids from a list, in order, without duplicates. Anyone else is an error. */
function parseAssignees_(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw) || raw.length > 20) fail_('invalid_input');
  const users = usersById_();
  const seen = {};
  const out = [];
  raw.forEach(function (id) {
    const uid = cleanStr_(id, 64);
    if (!users[uid] || users[uid].status !== 'Approved') fail_('not_found');
    if (!seen[uid]) { seen[uid] = true; out.push(uid); }
  });
  return out;
}

function parseTaskInput_(f, car, existing) {
  const out = {};
  out.name = cleanStr_(f.name, 80);
  if (!out.name) fail_('name_required');
  out.kind = oneOf_(f.kind, TASK_KINDS, existing ? existing.kind : 'maintenance', 'invalid_kind');
  out.interval_months = parseIntBetween_(f.intervalMonths, 1, 240, 'invalid_interval');
  out.interval_distance = parseIntBetween_(f.intervalDistance, 1, MAX_ODOMETER, 'invalid_interval');
  out.lead_days = parseIntBetween_(f.leadDays, 0, 365, 'invalid_lead') || (out.kind === 'compliance' ? '28' : '14');
  out.lead_distance = parseIntBetween_(f.leadDistance, 0, 100000, 'invalid_lead') || '300';
  out.due_date = parseFullDate_(f.dueDate, true);
  out.due_distance = parseIntBetween_(f.dueDistance, 0, MAX_ODOMETER, 'invalid_odometer');
  out.last_done_date = parseFullDate_(f.lastDoneDate, false);
  out.last_done_distance = parseIntBetween_(f.lastDoneDistance, 0, MAX_ODOMETER, 'invalid_odometer');
  return out;
}

/** If no due date/distance was given, work them out from the last time it was done (or from now). */
function fillInitialDue_(input, car) {
  const today = todayIso_();
  if (!input.due_date && input.interval_months) {
    input.due_date = addMonths_(input.last_done_date || today, Number(input.interval_months));
  }
  if (input.due_distance === '' && input.interval_distance) {
    const base = input.last_done_distance !== '' ? Number(input.last_done_distance)
      : (car.current_odometer !== '' && car.current_odometer !== undefined ? Number(car.current_odometer) : null);
    if (base !== null) input.due_distance = String(base + Number(input.interval_distance));
  }
}

function sameName_(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

// ---------- actions ----------

function listTasks_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  const today = todayIso_();
  const tasks = liveTasks_(car.id).map(function (t) { return summarizeTask_(t, car, today); }).sort(function (a, b) {
    return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.name.localeCompare(b.name);
  });
  return { tasks: tasks, distanceUnit: 'mi' };
}

/** Names of approved users, so anyone can pick who gets a reminder. */
function listApprovedUsers_() {
  return {
    users: Db.all('Users')
      .filter(function (u) { return !isTrue_(u.deleted) && u.status === 'Approved'; })
      .map(function (u) { return { id: u.id, name: u.name }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); }),
  };
}

function saveTask_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  let existing = null;
  if (p.id) {
    existing = findTask_(cleanStr_(p.id, 64));
    if (!existing || existing.car_id !== car.id) fail_('not_found');
    if (Number(existing.version || 1) !== Number(p.version)) fail_('conflict');
  }
  const f = p.fields || {};
  const input = parseTaskInput_(f, car, existing);
  const assignees = parseAssignees_(f.assignees);
  if (!existing) fillInitialDue_(input, car);
  if (input.due_date === '' && input.due_distance === '') fail_('task_needs_due');
  if (liveTasks_(car.id).some(function (t) { return t.id !== (existing && existing.id) && sameName_(t.name, input.name) && t.kind === input.kind; })) fail_('duplicate_task');

  const now = nowIso_();
  const row = Object.assign({}, input, { assignees: assignees.join(','), active: f.active === false ? false : true, paused_reason: f.active === false ? cleanStr_(f.pausedReason, 120) : '' });
  if (existing) {
    // Changing the due date or distance by hand restarts the reminders for it.
    const moved = String(existing.due_date) !== String(input.due_date) || String(existing.due_distance) !== String(input.due_distance);
    const patch = Object.assign({}, row, { updated_at: now, updated_by: ctx.user.id, version: Number(existing.version || 1) + 1 });
    if (moved) patch.last_reminded_at = '';
    Db.update('Tasks', existing._row, patch);
    audit_(ctx.user, 'task_updated', 'Task', existing.id, car.registration + ': reminder "' + input.name + '" updated');
    return { task: summarizeTask_(Object.assign({}, existing, patch), car, todayIso_()) };
  }
  const fresh = Object.assign(baseColumns_(ctx), { car_id: car.id, last_reminded_at: '' }, row);
  Db.insert('Tasks', fresh);
  audit_(ctx.user, 'task_created', 'Task', fresh.id, car.registration + ': reminder "' + input.name + '" added');
  return { task: summarizeTask_(fresh, car, todayIso_()) };
}

/** Admin only. */
function deleteTask_(p, ctx) {
  const t = findTask_(cleanStr_(p.id, 64));
  if (!t) fail_('not_found');
  Db.update('Tasks', t._row, { deleted: true, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(t.version || 1) + 1 });
  audit_(ctx.user, 'task_deleted', 'Task', t.id, 'Reminder "' + t.name + '" deleted');
  return { done: true };
}

/** Add the standard maintenance reminders this car does not already have. They start counting from today. */
function addStandardTasks_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const today = todayIso_();
  const have = liveTasks_(car.id);
  const odo = car.current_odometer === '' ? null : Number(car.current_odometer);
  let added = 0;
  STANDARD_TASKS.forEach(function (s) {
    if (have.some(function (t) { return sameName_(t.name, s.name); })) return;
    const dist = s.mi;
    const row = Object.assign(baseColumns_(ctx), {
      car_id: car.id, kind: 'maintenance', name: s.name, interval_months: String(s.months), interval_distance: dist ? String(dist) : '',
      lead_days: '14', lead_distance: '300',
      due_date: addMonths_(today, s.months), due_distance: dist && odo !== null ? String(odo + dist) : '',
      assignees: '', active: true, last_reminded_at: '',
    });
    Db.insert('Tasks', row);
    added++;
  });
  if (added) audit_(ctx.user, 'task_created', 'Car', car.id, car.registration + ': ' + added + ' standard reminders added');
  return { added: added };
}

// ---------- completing a task from an entry ----------

/**
 * Called when a Maintenance entry is logged for a reminder, or a Compliance renewal sets a new expiry date.
 * Moves the next due date / distance forward and clears the reminder. Returns the updated task row.
 */
function completeTask_(task, car, done, ctx) {
  let lastDist = '';
  if (done.mileage !== '' && done.mileage !== undefined) lastDist = Number(done.mileage);
  else if (car.current_odometer !== '' && car.current_odometer !== undefined) lastDist = Number(car.current_odometer);

  const patch = { last_done_date: done.date, last_done_distance: lastDist === '' ? '' : String(lastDist), last_reminded_at: '' };
  const months = numOr0_(task.interval_months);
  const dist = numOr0_(task.interval_distance);

  if (task.kind === 'compliance') {
    if (done.expiryDate) patch.due_date = done.expiryDate;
    else if (months) patch.due_date = addMonths_(done.date, months);
  } else {
    if (months) patch.due_date = addMonths_(done.date, months);
    if (dist && lastDist !== '') patch.due_distance = String(lastDist + dist);
  }
  Object.assign(patch, { updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(task.version || 1) + 1 });
  Db.update('Tasks', task._row, patch);
  audit_(ctx.user, 'task_completed', 'Task', task.id, car.registration + ': "' + task.name + '" done on ' + done.date +
    (patch.due_date ? ', next due ' + patch.due_date : '') + (patch.due_distance ? ' / ' + patch.due_distance + ' mi' : ''));
  return Object.assign({}, task, patch);
}

/** A compliance renewal with an expiry date keeps a reminder for it: reuse the one with that name, or create it. */
function ensureComplianceTask_(entry, car, ctx, explicitTask) {
  const done = { date: entry.date, mileage: entry.mileage, expiryDate: entry.expiry_date };
  let task = explicitTask || liveTasks_(car.id).filter(function (t) { return t.kind === 'compliance' && sameName_(t.name, entry.title); })[0];
  if (task) return completeTask_(task, car, done, ctx);
  const row = Object.assign(baseColumns_(ctx), {
    car_id: car.id, kind: 'compliance', name: cleanStr_(entry.title, 80), interval_months: '', interval_distance: '',
    lead_days: '28', lead_distance: '300', due_date: entry.expiry_date, due_distance: '',
    last_done_date: entry.date, last_done_distance: '', assignees: '', active: true, last_reminded_at: '',
  });
  Db.insert('Tasks', row);
  audit_(ctx.user, 'task_created', 'Task', row.id, car.registration + ': reminder "' + row.name + '" added from the ' + entry.title + ' renewal');
  return row;
}
