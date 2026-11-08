'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createEnv } = require('./harness');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

function setup(carFields) {
  const env = createEnv();
  const adminU = env.seedUser({ name: 'Admin One', email: 'admin@example.com', role: 'admin' });
  const samU = env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const annU = env.seedUser({ name: 'Ann', email: 'ann@example.com', role: 'user' });
  const admin = env.signInAs('admin@example.com');
  const sam = env.signInAs('sam@example.com');
  const ann = env.signInAs('ann@example.com');
  const car = env.call('saveCar', { token: sam, fields: Object.assign({ registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000' }, carFields || {}) }).data.car;
  const task = (fields, extra, token) => env.call('saveTask', Object.assign({ token: token || sam, carId: car.id, fields }, extra || {}));
  const tasks = (token) => env.call('listTasks', { token: token || sam, carId: car.id }).data.tasks;
  const entry = (type, fields, extra, token) => env.call('saveEntry', Object.assign({ token: token || sam, carId: car.id, type, fields }, extra || {}));
  const mails = () => env.outbox.filter((m) => /Fleet Manager: /.test(m.subject));
  return { env, admin, sam, ann, adminU, samU, annU, car, task, tasks, entry, mails };
}

// ---------- access and basics ----------

test('reminder actions need a session; only admins delete', () => {
  const { env, sam, car, task } = setup();
  const t = task({ name: 'Oil', intervalMonths: '6' }).data.task;
  ['listTasks', 'saveTask', 'deleteTask', 'addStandardTasks', 'listApprovedUsers', 'sendMyReminders']
    .forEach((a) => assert.equal(env.call(a, { carId: car.id, id: t.id }).error, 'unauthorized', a));
  assert.equal(env.call('deleteTask', { token: sam, id: t.id }).error, 'forbidden');
});

test('any user can add, edit and pause a reminder; an admin deletes it', () => {
  const { env, admin, sam, ann, car, task, tasks } = setup();
  const t = task({ name: 'Oil', intervalMonths: '6' }).data.task;
  const edit = env.call('saveTask', { token: ann, carId: car.id, id: t.id, version: t.version, fields: { name: 'Oil change', intervalMonths: '6', dueDate: day(40) } });
  assert.equal(edit.data.task.name, 'Oil change');
  const paused = env.call('saveTask', { token: sam, carId: car.id, id: t.id, version: 2, fields: { name: 'Oil change', intervalMonths: '6', dueDate: day(40), active: false, pausedReason: 'Car in storage' } });
  assert.equal(paused.data.task.status, 'paused');
  assert.equal(paused.data.task.pausedReason, 'Car in storage');
  assert.equal(env.call('deleteTask', { token: admin, id: t.id }).ok, true);
  assert.equal(tasks().length, 0);
  assert.equal(env.call('deleteTask', { token: admin, id: t.id }).error, 'not_found');
});

test('a stale version is a conflict', () => {
  const { env, sam, car, task } = setup();
  const t = task({ name: 'Oil', intervalMonths: '6' }).data.task;
  assert.equal(env.call('saveTask', { token: sam, carId: car.id, id: t.id, version: 99, fields: { name: 'Oil', intervalMonths: '6', dueDate: day(10) } }).error, 'conflict');
});

// ---------- validating ----------

test('a reminder needs a name, a sensible interval and something to be due by', () => {
  const { env, sam, car, task, tasks } = setup();
  const bad = (fields, code) => assert.equal(task(fields).error, code, code + ' ' + JSON.stringify(fields));
  bad({ name: '  ', intervalMonths: '6' }, 'name_required');
  bad({ name: 'X', kind: 'weekly' }, 'invalid_kind');
  bad({ name: 'X', intervalMonths: '0' }, 'invalid_interval');
  bad({ name: 'X', intervalMonths: '999' }, 'invalid_interval');
  bad({ name: 'X', intervalMonths: 'abc' }, 'invalid_interval');
  bad({ name: 'X', intervalDistance: '-5', intervalMonths: '6' }, 'invalid_interval');
  bad({ name: 'X', intervalMonths: '6', leadDays: '400' }, 'invalid_lead');
  bad({ name: 'X', dueDate: 'next week' }, 'invalid_date');
  bad({ name: 'X', dueDate: '2030-02-30' }, 'invalid_date');
  bad({ name: 'X' }, 'task_needs_due');                        // nothing to be due by
  bad({ name: 'X', intervalMonths: '6', assignees: ['nobody'] }, 'not_found');
  bad({ name: 'X', intervalMonths: '6', assignees: 'sam' }, 'invalid_input');
  assert.equal(task({ name: 'Oil', intervalMonths: '6' }).ok, true);
  bad({ name: ' oil ', intervalMonths: '3' }, 'duplicate_task');   // same name, same car, same kind
  assert.equal(task({ name: 'Oil', kind: 'compliance', dueDate: day(30) }).ok, true, 'same name as a different kind is fine');
  assert.equal(tasks().length, 2);
  assert.equal(env.call('saveTask', { token: sam, carId: 'nope', fields: { name: 'X', intervalMonths: '6' } }).error, 'not_found');
});

test('reminder recipients must be approved users', () => {
  const { env, admin, samU, annU, task } = setup();
  const pending = env.seedUser({ email: 'p@example.com', status: 'Pending', name: 'Pending' });
  assert.equal(task({ name: 'X', intervalMonths: '6', assignees: [pending.id] }).error, 'not_found');
  const ok = task({ name: 'X', intervalMonths: '6', assignees: [samU.id, annU.id, samU.id] }).data.task;
  assert.deepEqual(ok.assignees, [samU.id, annU.id], 'duplicates removed');
  assert.ok(admin);
  assert.deepEqual(env.call('listApprovedUsers', { token: admin }).data.users.map((u) => u.name), ['Admin One', 'Ann', 'Sam']);
  assert.ok(!JSON.stringify(env.call('listApprovedUsers', { token: admin }).data).includes('@'), 'names only, no emails');
});

// ---------- due dates ----------

test('adding months keeps the day, or the end of a shorter month', () => {
  const { env } = setup();
  const add = vm.runInContext('addMonths_', env.ctx);
  assert.equal(add('2025-01-31', 1), '2025-02-28');
  assert.equal(add('2024-01-31', 1), '2024-02-29');
  assert.equal(add('2025-11-15', 3), '2026-02-15');
  assert.equal(add('2025-03-31', 12), '2026-03-31');
  assert.equal(add('2025-12-01', 1), '2026-01-01');
});

test('the first due date comes from the interval: from now, or from when it was last done', () => {
  const { env, task } = setup({ odometer: '50000' });
  const add = vm.runInContext('addMonths_', env.ctx);
  const today = day(0);
  const fresh = task({ name: 'Oil', intervalMonths: '6', intervalDistance: '6000' }).data.task;
  assert.equal(fresh.dueDate, add(today, 6));
  assert.equal(fresh.dueDistance, 56000, 'from the odometer');

  const past = task({ name: 'Coolant', intervalMonths: '24', intervalDistance: '25000', lastDoneDate: '2025-01-31', lastDoneDistance: '40000' }).data.task;
  assert.equal(past.dueDate, '2027-01-31');
  assert.equal(past.dueDistance, 65000, 'from the mileage it was last done at');

  const explicit = task({ name: 'Tyres', intervalMonths: '3', dueDate: '2026-12-25', dueDistance: '52000' }).data.task;
  assert.equal(explicit.dueDate, '2026-12-25', 'what you type wins');
  assert.equal(explicit.dueDistance, 52000);

  const oneOff = task({ name: 'Insurance', kind: 'compliance', dueDate: day(100) }).data.task;
  assert.equal(oneOff.intervalMonths, null);
});

test('heads-up defaults: 14 days / 300 mi for maintenance, 28 days for compliance', () => {
  const { task } = setup();
  const m = task({ name: 'Oil', intervalMonths: '6' }).data.task;
  assert.equal(m.leadDays, 14);
  assert.equal(m.leadDistance, 300);
  const c = task({ name: 'MOT', kind: 'compliance', dueDate: day(200) }).data.task;
  assert.equal(c.leadDays, 28);
  const own = task({ name: 'Tyres', intervalMonths: '3', leadDays: '0', leadDistance: '1000' }).data.task;
  assert.equal(own.leadDays, 0, 'zero is allowed');
  assert.equal(own.leadDistance, 1000);
});

// ---------- status ----------

test('status follows the date: ok, due soon (inside the heads-up window), due today, overdue', () => {
  const { task } = setup();
  const make = (name, dueDate) => task({ name, intervalMonths: '12', dueDate, leadDays: '14' }).data.task;
  assert.equal(make('a', day(60)).status, 'ok');
  assert.equal(make('b', day(14)).status, 'due_soon', 'exactly at the edge of the window');
  assert.equal(make('c', day(15)).status, 'ok');
  const today = make('d', day(0));
  assert.equal(today.status, 'due_soon');
  assert.match(today.text, /due today/);
  const late = make('e', day(-12));
  assert.equal(late.status, 'overdue');
  assert.match(late.text, /overdue by 12 days/);
  assert.match(make('f', day(-1)).text, /overdue by 1 day$/);
  assert.match(make('g', day(9)).text, /^due in 9 days \(\d+ \w+ \d{4}\)$/);
});

test('status follows the distance too, and whichever comes first wins', () => {
  const { env, sam, car, task } = setup({ odometer: '50000' });
  // 700 miles to go: outside the 300 mile window
  let t = task({ name: 'Oil', intervalMonths: '12', dueDate: day(300), dueDistance: '50700' }).data.task;
  assert.equal(t.status, 'ok');
  assert.match(t.text, /due at 50,700 mi \(700 mi to go\)/);
  env.call('updateOdometer', { token: sam, id: car.id, odometer: '50450' });
  t = env.call('listTasks', { token: sam, carId: car.id }).data.tasks[0];
  assert.equal(t.status, 'due_soon', 'within 300 miles, though the date is far off');
  env.call('updateOdometer', { token: sam, id: car.id, odometer: '50800' });
  t = env.call('listTasks', { token: sam, carId: car.id }).data.tasks[0];
  assert.equal(t.status, 'overdue');
  assert.match(t.text, /reached 50,700 mi \(100 mi over\)/);
});

test('a task with no known odometer is judged by its date alone; paused tasks are neither due nor overdue', () => {
  const { task } = setup({ odometer: '' });
  const t = task({ name: 'Oil', intervalMonths: '6', intervalDistance: '6000', dueDate: day(100), dueDistance: '6000' }).data.task;
  assert.equal(t.status, 'ok');
  const p = task({ name: 'Old', intervalMonths: '6', dueDate: day(-30), active: false }).data.task;
  assert.equal(p.status, 'paused');
});

test('the list shows the most urgent first', () => {
  const { task, tasks } = setup();
  task({ name: 'Later', intervalMonths: '12', dueDate: day(200) });
  task({ name: 'Soon', intervalMonths: '12', dueDate: day(5) });
  task({ name: 'Late', intervalMonths: '12', dueDate: day(-3) });
  task({ name: 'Paused', intervalMonths: '12', dueDate: day(-300), active: false });
  assert.deepEqual(tasks().map((t) => t.name), ['Late', 'Soon', 'Later', 'Paused']);
});

// ---------- standard reminders ----------

test('standard reminders are added once, count from today, and are in miles', () => {
  const { env, sam, car, tasks } = setup({ odometer: '50000' });
  const first = env.call('addStandardTasks', { token: sam, carId: car.id });
  assert.equal(first.data.added, 10);
  assert.equal(env.call('addStandardTasks', { token: sam, carId: car.id }).data.added, 0, 'nothing twice');
  const oil = tasks().find((t) => t.name === 'Engine oil and filter');
  assert.equal(oil.intervalMonths, 6);
  assert.equal(oil.intervalDistance, 6000, 'miles');
  assert.equal(oil.dueDistance, 56000);
  assert.ok(tasks().every((t) => t.status === 'ok'), 'none start overdue');
  assert.equal(tasks().find((t) => t.name === 'Tyre inspection').intervalDistance, null, 'date-only ones have no distance');
});

test('a renamed standard reminder is not added a second time', () => {
  const { env, sam, car, tasks } = setup();
  env.call('addStandardTasks', { token: sam, carId: car.id });
  const t = tasks().find((x) => x.name === 'Coolant change');
  env.call('saveTask', { token: sam, carId: car.id, id: t.id, version: t.version, fields: { name: 'Radiator flush', intervalMonths: '24', dueDate: day(300) } });
  assert.equal(env.call('addStandardTasks', { token: sam, carId: car.id }).data.added, 1, 'only the renamed one comes back');
});

// ---------- logging work moves the reminder on ----------

test('logging maintenance against a reminder moves the next due date and distance forward', () => {
  const { env, sam, car, task, entry, tasks } = setup({ odometer: '50000' });
  const t = task({ name: 'Engine oil and filter', intervalMonths: '6', intervalDistance: '6000', dueDate: day(-10), dueDistance: '49000' }).data.task;
  assert.equal(tasks()[0].status, 'overdue');
  const r = entry('Maintenance', { title: 'Oil and filter change', date: '2025-01-31', mileage: '51000', labourCost: '45' }, { taskId: t.id });
  assert.equal(r.ok, true);
  assert.equal(r.data.reminder.name, 'Engine oil and filter');
  assert.equal(r.data.entry.taskId, t.id);
  const after = tasks()[0];
  assert.equal(after.lastDoneDate, '2025-01-31');
  assert.equal(after.lastDoneDistance, 51000);
  assert.equal(after.dueDate, '2025-07-31', 'six months on');
  assert.equal(after.dueDistance, 57000, '6,000 miles on from the reading');
  assert.ok(env.sheets.Audit._rows.slice(1).some((a) => a[3] === 'task_completed'));
  assert.ok(sam && car);
});

test('the reading is in miles; with no reading the odometer is used', () => {
  const { task, entry, tasks } = setup({ odometer: '50000' });
  const t = task({ name: 'Oil', intervalMonths: '6', intervalDistance: '6000', dueDate: day(5) }).data.task;
  entry('Maintenance', { title: 'Oil change', date: '2025-03-01', mileage: '55923', mileageUnit: 'km' }, { taskId: t.id });
  assert.equal(tasks()[0].lastDoneDistance, 55923, 'a unit sent by an old phone is ignored');
  assert.equal(tasks()[0].dueDistance, 61923);

  const u = task({ name: 'Tyres', intervalMonths: '3', intervalDistance: '10000', dueDate: day(5) }).data.task;
  entry('Maintenance', { title: 'Tyre check', date: '2025-03-02' }, { taskId: u.id });
  const tyres = tasks().find((x) => x.id === u.id);
  assert.equal(tyres.lastDoneDistance, 50000, 'no reading given: the car\'s odometer');
  assert.equal(tyres.dueDistance, 60000);
});

test('a date-only reminder moves by its months; a distance-only one by its distance', () => {
  const { task, entry, tasks } = setup();
  const a = task({ name: 'Battery', intervalMonths: '12', dueDate: day(5) }).data.task;
  const b = task({ name: 'Brakes', intervalDistance: '20000', dueDistance: '50200' }).data.task;
  entry('Maintenance', { title: 'Battery check', date: '2025-06-15' }, { taskId: a.id });
  entry('Maintenance', { title: 'Brake check', date: '2025-06-15', mileage: '50300' }, { taskId: b.id });
  assert.equal(tasks().find((t) => t.id === a.id).dueDate, '2026-06-15');
  assert.equal(tasks().find((t) => t.id === b.id).dueDistance, 70300);
  assert.equal(tasks().find((t) => t.id === b.id).dueDate, '', 'no date was ever set');
});

test('logging clears the "reminded" mark so it starts fresh', () => {
  const { env, task, entry } = setup();
  const t = task({ name: 'Oil', intervalMonths: '6', dueDate: day(-5) }).data.task;
  env.ctx.sendWeeklyReminders();
  const header = () => env.sheets.Tasks._rows[0];
  const row = () => env.sheets.Tasks._rows.find((r) => r[0] === t.id);
  assert.notEqual(row()[header().indexOf('last_reminded_at')], '');
  entry('Maintenance', { title: 'Oil change', date: '2025-06-01' }, { taskId: t.id });
  assert.equal(row()[header().indexOf('last_reminded_at')], '');
});

test('a reminder from another car cannot be used; editing the entry later does not reset it again', () => {
  const { env, sam, task, entry, tasks } = setup();
  const t = task({ name: 'Oil', intervalMonths: '6', dueDate: day(5) }).data.task;
  const other = env.call('saveCar', { token: sam, fields: { registration: 'OTHER 1', make: 'Ford', model: 'Ka', year: '2010' } }).data.car;
  assert.equal(env.call('saveEntry', { token: sam, carId: other.id, type: 'Maintenance', fields: { title: 'x', date: '2025-01-01' }, taskId: t.id }).error, 'not_found');
  const e = entry('Maintenance', { title: 'Oil change', date: '2025-06-01' }, { taskId: t.id }).data.entry;
  const due = tasks()[0].dueDate;
  env.call('saveEntry', { token: sam, id: e.id, version: e.version, fields: { title: 'Oil change (edited)', date: '2025-09-01' } });
  assert.equal(tasks()[0].dueDate, due, 'an edit does not move the reminder again');
});

test('a compliance renewal with an expiry date keeps a reminder for it', () => {
  const { env, task, entry, tasks } = setup();
  const r = entry('Compliance', { title: 'MOT', date: '2025-11-01', cost: '54.85', expiryDate: '2026-11-01' });
  assert.equal(r.data.reminder.name, 'MOT');
  let list = tasks();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'compliance');
  assert.equal(list[0].dueDate, '2026-11-01');
  assert.equal(list[0].leadDays, 28);
  assert.equal(r.data.entry.taskId, list[0].id);

  // the next renewal updates the same reminder (matched by name), not a second one
  entry('Compliance', { title: ' mot ', date: '2026-10-20', expiryDate: '2027-11-01' });
  list = tasks();
  assert.equal(list.length, 1);
  assert.equal(list[0].dueDate, '2027-11-01');
  assert.equal(list[0].lastDoneDate, '2026-10-20');

  // no expiry date: no reminder is made or changed
  entry('Compliance', { title: 'Parking permit', date: '2026-10-21' });
  assert.equal(tasks().length, 1);

  // an existing reminder can be named explicitly, and its repeat interval is not needed
  const ins = task({ name: 'Car insurance', kind: 'compliance', dueDate: day(10) }).data.task;
  entry('Compliance', { title: 'Insurance renewed', date: '2026-10-22', expiryDate: '2027-10-22' }, { taskId: ins.id });
  assert.equal(tasks().find((t) => t.id === ins.id).dueDate, '2027-10-22');
  assert.equal(tasks().length, 2);
  assert.ok(env.sheets.Audit._rows.slice(1).some((a) => a[3] === 'task_created'));
});

test('correcting the expiry date on a renewal updates its reminder', () => {
  const { env, sam, entry, tasks } = setup();
  const e = entry('Compliance', { title: 'MOT', date: '2025-11-01', expiryDate: '2026-11-01' }).data.entry;
  env.call('saveEntry', { token: sam, id: e.id, version: e.version, fields: { title: 'MOT', date: '2025-11-01', expiryDate: '2026-10-31' } });
  assert.equal(tasks().length, 1);
  assert.equal(tasks()[0].dueDate, '2026-10-31');
});

// ---------- who gets the email ----------

test('reminders go to the chosen people, else the car\'s owners/custodians, else the admins', () => {
  const { env, admin, sam, samU, annU, task, mails } = setup();
  const overdue = (name, extra) => task(Object.assign({ name, intervalMonths: '6', dueDate: day(-5) }, extra || {}));

  overdue('Chosen', { assignees: [annU.id] });
  env.ctx.sendWeeklyReminders();
  assert.deepEqual(mails().map((m) => m.to), ['ann@example.com'], 'the chosen person only');

  env.outbox.length = 0;
  env.call('setMyCarRole', { token: sam, carId: env.call('listCars', { token: sam }).data.cars[0].id, owner: true });
  env.call('deleteTask', { token: admin, id: env.call('listTasks', { token: sam, carId: env.call('listCars', { token: sam }).data.cars[0].id }).data.tasks[0].id });
  overdue('Default');
  env.ctx.sendWeeklyReminders();
  assert.deepEqual(mails().map((m) => m.to), ['sam@example.com'], 'the owner/custodian');

  // nobody owns it: the admins hear about it
  env.outbox.length = 0;
  env.call('setMyCarRole', { token: sam, carId: env.call('listCars', { token: sam }).data.cars[0].id, owner: false });
  env.ctx.sendWeeklyReminders();
  assert.deepEqual(mails().map((m) => m.to), ['admin@example.com']);
  assert.ok(samU);
});

test('revoked or pending users are never emailed', () => {
  const { env, admin, samU, annU, task, mails } = setup();
  task({ name: 'Oil', intervalMonths: '6', dueDate: day(-5), assignees: [samU.id, annU.id] });
  env.call('setUserStatus', { token: admin, userId: samU.id, status: 'Revoked' });
  env.ctx.sendWeeklyReminders();
  assert.deepEqual(mails().map((m) => m.to), ['ann@example.com']);
});

// ---------- the weekly email ----------

test('one email per person lists everything due, most urgent first, with a link for each', () => {
  const { env, samU, car, task, mails } = setup({ odometer: '50000' });
  const mine = [samU.id];
  const oil = task({ name: 'Engine oil and filter', intervalMonths: '6', intervalDistance: '6000', dueDate: day(-12), dueDistance: '49000', lastDoneDate: '2025-03-01', lastDoneDistance: '43000', assignees: mine }).data.task;
  const tyres = task({ name: 'Tyre inspection', intervalMonths: '3', dueDate: day(6), assignees: mine }).data.task;
  const mot = task({ name: 'MOT', kind: 'compliance', dueDate: day(20), assignees: mine }).data.task;
  task({ name: 'Far away', intervalMonths: '12', dueDate: day(120), assignees: mine });
  assert.equal(env.ctx.sendWeeklyReminders(), 1);

  const m = mails();
  assert.equal(m.length, 1, 'one email, not one per reminder');
  assert.equal(m[0].to, 'sam@example.com');
  assert.match(m[0].subject, /1 overdue, 2 due soon/);
  const html = m[0].htmlBody;
  const order = ['Engine oil and filter', 'MOT', 'Tyre inspection'].map((n) => html.indexOf(n));
  assert.ok(order[0] > -1 && order[0] < Math.min(order[1], order[2]), 'overdue first');
  assert.ok(!html.includes('Far away'), 'only what needs attention');
  assert.ok(html.includes('AB12 CDE'));
  assert.match(m[0].body, /Overdue by 12 days/);
  // deep links into the app
  assert.ok(html.includes('#/car/' + car.id + '/add/maintenance?task=' + oil.id));
  assert.ok(html.includes('#/car/' + car.id + '/add/maintenance?task=' + tyres.id));
  assert.ok(html.includes('#/car/' + car.id + '/add/compliance?task=' + mot.id), 'renewals go to the compliance form');
  // what happens next, in words
  assert.match(html, /remind you again in 6 months or 6,000 mi, whichever comes first/);
  assert.match(html, /remind you again in 3 months\./);
  assert.match(html, /new expiry date, Fleet Manager will remind you again before that date/);
  assert.match(html, /Last done 1 Mar 2025 at 43,000 mi/);
  assert.match(m[0].body, /Log this maintenance: https:\/\/.*#\/car\//);
});

test('nothing due means no email; paused, sold, scrapped and deleted things are left out', () => {
  const { env, admin, sam, car, task, mails } = setup();
  const t = task({ name: 'Fine', intervalMonths: '12', dueDate: day(200) }).data.task;
  assert.equal(env.ctx.sendWeeklyReminders(), 0);
  assert.equal(mails().length, 0);

  task({ name: 'Paused', intervalMonths: '12', dueDate: day(-9), active: false });
  const gone = task({ name: 'Gone', intervalMonths: '12', dueDate: day(-9) }).data.task;
  env.call('deleteTask', { token: admin, id: gone.id });
  assert.equal(env.ctx.sendWeeklyReminders(), 0);

  const live = task({ name: 'Live', intervalMonths: '12', dueDate: day(-9) }).data.task;
  env.call('saveCar', { token: sam, id: car.id, version: car.version, fields: { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000', status: 'Sold' } });
  assert.equal(env.ctx.sendWeeklyReminders(), 0, 'a sold car is not nagged about');
  env.call('saveCar', { token: sam, id: car.id, version: 2, fields: { registration: 'AB12 CDE', make: 'Toyota', model: 'Hilux', year: '2015', odometer: '50000', status: 'Active' } });
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(env.ctx.sendWeeklyReminders(), 0, 'nor a deleted one');
  env.call('restoreCar', { token: admin, id: car.id });
  assert.equal(env.ctx.sendWeeklyReminders(), 1);
  assert.ok(t && live);
});

test('each person gets their own email with only their cars\' reminders', () => {
  const { env, sam, samU, annU, task, mails } = setup();
  const second = env.call('saveCar', { token: sam, fields: { registration: 'SECOND 1', make: 'Ford', model: 'Ka', year: '2010', odometer: '1000' } }).data.car;
  task({ name: 'Oil', intervalMonths: '6', dueDate: day(-1), assignees: [samU.id] });
  env.call('saveTask', { token: sam, carId: second.id, fields: { name: 'Brakes', intervalMonths: '6', dueDate: day(-1), assignees: [annU.id, samU.id] } });
  assert.equal(env.ctx.sendWeeklyReminders(), 2);
  const bySam = mails().find((m) => m.to === 'sam@example.com');
  const byAnn = mails().find((m) => m.to === 'ann@example.com');
  assert.ok(bySam.htmlBody.includes('Oil') && bySam.htmlBody.includes('Brakes'));
  assert.ok(byAnn.htmlBody.includes('Brakes') && !byAnn.htmlBody.includes('Oil'));
});

test('a reminder is marked as sent, the audit trail records the run, and a mail failure does not crash', () => {
  const { env, task, mails } = setup();
  const t = task({ name: 'Oil', intervalMonths: '6', dueDate: day(-1) }).data.task;
  env.ctx.sendWeeklyReminders();
  const header = env.sheets.Tasks._rows[0];
  const row = env.sheets.Tasks._rows.find((r) => r[0] === t.id);
  assert.match(row[header.indexOf('last_reminded_at')], /^\d{4}-/);
  assert.ok(env.sheets.Audit._rows.slice(1).some((a) => a[3] === 'reminders_sent'));

  env.outbox.length = 0;
  env.state.mailQuota = 0;     // Gmail's daily limit reached
  assert.equal(env.ctx.sendWeeklyReminders(), 0);
  assert.equal(mails().length, 0);
});

test('task names and car details are escaped in the email', () => {
  const { task, mails, env } = setup();
  task({ name: '<img src=x onerror=alert(1)>Oil', intervalMonths: '6', dueDate: day(-1) });
  env.ctx.sendWeeklyReminders();
  assert.ok(!mails()[0].htmlBody.includes('<img'));
  assert.ok(mails()[0].htmlBody.includes('&lt;img'));
});

test('"email me what is due now" sends only to the person asking', () => {
  const { env, sam, ann, samU, annU, task, mails } = setup();
  task({ name: 'Oil', intervalMonths: '6', dueDate: day(-1), assignees: [samU.id, annU.id] });
  const r = env.call('sendMyReminders', { token: sam });
  assert.deepEqual(r.data, { sent: true, count: 1 });
  assert.deepEqual(mails().map((m) => m.to), ['sam@example.com']);
  const none = env.call('sendMyReminders', { token: env.signInAs('admin@example.com') });
  assert.deepEqual(none.data, { sent: false, count: 0 }, 'the admin has nothing due');
  assert.ok(ann);
});

// ---------- the weekly trigger ----------

test('the Monday 8am London trigger is created once, by the migration or by setup', () => {
  const { env, sam } = setup();
  assert.equal(env.triggers.length, 0);
  env.props.SCHEMA_VERSION = '7';
  env.call('listCars', { token: sam });
  assert.equal(env.triggers.length, 1);
  assert.deepEqual(env.triggers[0], { fn: 'sendWeeklyReminders', day: 'MONDAY', hour: 8, tz: 'Europe/London' });
  env.ctx.ensureReminderTrigger_();
  env.ctx.ensureReminderTrigger_();
  assert.equal(env.triggers.length, 1, 'safe to call again');
});

test('changing a due date by hand starts the reminders for it afresh', () => {
  const { env, sam, car, task } = setup();
  const t = task({ name: 'Oil', intervalMonths: '6', dueDate: day(-3) }).data.task;
  env.ctx.sendWeeklyReminders();
  const header = env.sheets.Tasks._rows[0];
  const row = () => env.sheets.Tasks._rows.find((r) => r[0] === t.id);
  assert.notEqual(row()[header.indexOf('last_reminded_at')], '');
  env.call('saveTask', { token: sam, carId: car.id, id: t.id, version: t.version, fields: { name: 'Oil', intervalMonths: '6', dueDate: day(30) } });
  assert.equal(row()[header.indexOf('last_reminded_at')], '');
});

test('reminders on a deleted car are visible to admins only', () => {
  const { env, admin, sam, car, task } = setup();
  task({ name: 'Oil', intervalMonths: '6', dueDate: day(5) });
  env.call('deleteCar', { token: admin, id: car.id });
  assert.equal(env.call('listTasks', { token: sam, carId: car.id }).error, 'not_found');
  assert.equal(env.call('listTasks', { token: admin, carId: car.id }).ok, true);
  assert.equal(env.call('saveTask', { token: sam, carId: car.id, fields: { name: 'X', intervalMonths: '6' } }).error, 'not_found');
});

test('the reminder wording after logging uses the odometer the entry has just set', () => {
  const { task, entry } = setup({ odometer: '50000' });
  const t = task({ name: 'Oil', intervalMonths: '6', intervalDistance: '6000', dueDate: day(5) }).data.task;
  const r = entry('Maintenance', { title: 'Oil', date: '2025-06-01', mileage: '52000' }, { taskId: t.id, updateOdometer: true });
  assert.match(r.data.reminder.text, /due at 58,000 mi \(6,000 mi to go\)/);
});

// ---------- Sheets turning a date cell into a real Date ----------

test('a due date that Sheets has turned into a Date still reads as yyyy-mm-dd (no "NaN days")', () => {
  const { env, car, task, tasks } = setup();
  const t = task({ name: 'Insurance', kind: 'compliance', intervalMonths: '12', dueDate: day(200) }).data.task;
  const sheet = env.sheets.Tasks;
  const col = sheet._rows[0].indexOf('due_date');
  const dueIso = day(200);
  sheet._rows[1][col] = vm.runInContext('new Date("' + dueIso + 'T00:00:00Z")', env.ctx); // (built inside the backend's own realm) // what Sheets hands back for an auto-converted date cell
  env.invalidate(); // the sheet was edited by hand, outside the app
  const got = tasks().filter((x) => x.id === t.id)[0];
  assert.equal(got.dueDate, dueIso);
  assert.ok(!/NaN/.test(got.text), got.text);
  assert.match(got.text, /^due in 200 days/);
  assert.equal(got.status, 'ok');
});
