/**
 * Who owns, or is the custodian of, a car.
 *
 * Links live in the CarPeople tab: one row per (car, user). A car can have several. The role
 * column holds 'owner'. Rows written by an earlier version with role 'keeper' (registered keeper)
 * are read as owner/custodian and tidied up the next time that user's link is changed.
 * Rows are never deleted: un-ticking soft-deletes and ticking again restores the same row.
 *
 * Permissions: any approved user can change their OWN links; admins can change anyone's.
 * (An owner/custodian who is not an app user is recorded as free text on the car itself.)
 */

function usersById_() {
  const map = {};
  Db.all('Users').forEach(function (u) { if (!isTrue_(u.deleted)) map[u.id] = u; });
  return map;
}

/** { owners: [{userId, name}] } for one car, sorted by name. Each user appears once. */
function peopleForCar_(carId, rows, users) {
  const seen = {};
  const owners = [];
  rows.forEach(function (r) {
    if (r.car_id !== carId || isTrue_(r.deleted)) return;
    const u = users[r.user_id];
    if (!u || seen[u.id]) return;
    seen[u.id] = true;
    owners.push({ userId: u.id, name: u.name });
  });
  owners.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { owners: owners };
}

function softDeleteLink_(row, ctx) {
  Db.update('CarPeople', row._row, {
    deleted: true, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(row.version || 1) + 1,
  });
  row.deleted = 'TRUE';
}

/** Make a user an owner/custodian of a car (want = true) or remove the link. True if anything changed. */
function setOwner_(rows, carId, userId, want, ctx) {
  const mine = rows.filter(function (r) { return r.car_id === carId && r.user_id === userId; });
  const live = mine.filter(function (r) { return !isTrue_(r.deleted); });
  const ownerRow = mine.filter(function (r) { return r.role === 'owner'; })[0];
  const now = nowIso_();
  let changed = false;

  if (want) {
    if (!ownerRow) {
      const fresh = {
        id: Utilities.getUuid(), created_at: now, created_by: ctx.user.id, updated_at: now, updated_by: ctx.user.id,
        version: 1, deleted: false, car_id: carId, user_id: userId, role: 'owner',
      };
      Db.insert('CarPeople', fresh);
      rows.push(Object.assign({ _row: -1 }, fresh));
      changed = true;
    } else if (isTrue_(ownerRow.deleted)) {
      Db.update('CarPeople', ownerRow._row, { deleted: false, updated_at: now, updated_by: ctx.user.id, version: Number(ownerRow.version || 1) + 1 });
      ownerRow.deleted = 'FALSE';
      changed = true;
    }
    // retire any old "registered keeper" row for the same person: they are one role now
    live.filter(function (r) { return r.role === 'keeper'; }).forEach(function (r) { softDeleteLink_(r, ctx); changed = true; });
  } else {
    live.forEach(function (r) { softDeleteLink_(r, ctx); changed = true; });
  }
  return changed;
}

function liveCars_() {
  return Db.all('Cars').filter(function (c) { return !isTrue_(c.deleted); });
}

/** The user an action is about: yourself by default, or anyone if you are an admin. */
function targetUser_(p, ctx) {
  const id = p.userId ? cleanStr_(p.userId, 64) : ctx.user.id;
  if (id !== ctx.user.id && ctx.user.role !== 'admin') fail_('forbidden');
  const user = findUserById_(id);
  if (!user || user.status !== 'Approved') fail_('not_found');
  return user;
}

function describeUserCars_(user, cars, rows) {
  const regs = cars.filter(function (c) {
    return rows.some(function (r) { return r.car_id === c.id && r.user_id === user.id && !isTrue_(r.deleted); });
  }).map(function (c) { return c.registration; });
  return user.name + ': ' + (regs.length ? 'owner/custodian of ' + regs.join(', ') : 'no cars');
}

// ---------- actions ----------

/** Every car, with whether this user is its owner/custodian. */
function getUserCars_(p, ctx) {
  const user = targetUser_(p, ctx);
  const rows = Db.all('CarPeople').filter(function (r) { return r.user_id === user.id && !isTrue_(r.deleted); });
  const cars = liveCars_()
    .sort(function (a, b) { return a.registration.localeCompare(b.registration); })
    .map(function (c) {
      return {
        carId: c.id, registration: c.registration, make: c.make, model: c.model, year: c.year ? Number(c.year) : null,
        owner: rows.some(function (r) { return r.car_id === c.id; }),
      };
    });
  return { user: { id: user.id, name: user.name }, cars: cars };
}

/**
 * Replace all of a user's links in one go. `cars` is [{carId, owner}]; any car not listed
 * (or with owner not true) ends up with no link for this user.
 */
function saveUserCars_(p, ctx) {
  const user = targetUser_(p, ctx);
  if (!Array.isArray(p.cars)) fail_('invalid_input');
  const cars = liveCars_();
  const ids = {};
  cars.forEach(function (c) { ids[c.id] = true; });
  const wanted = {};
  p.cars.forEach(function (e) {
    const carId = cleanStr_(e && e.carId, 64);
    if (!ids[carId]) fail_('not_found');
    wanted[carId] = e.owner === true;
  });

  const rows = Db.all('CarPeople');
  let changed = false;
  cars.forEach(function (c) {
    if (setOwner_(rows, c.id, user.id, wanted[c.id] === true, ctx)) changed = true;
  });
  if (changed) audit_(ctx.user, 'people_changed', 'User', user.id, describeUserCars_(user, cars, rows));
  return getUserCars_({ userId: user.id }, ctx);
}

/** A quick toggle from the car page: set or clear my own owner/custodian link for one car. */
function setMyCarRole_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const rows = Db.all('CarPeople');
  if (setOwner_(rows, car.id, ctx.user.id, p.owner === true, ctx)) {
    audit_(ctx.user, 'people_changed', 'Car', car.id,
      ctx.user.name + ': ' + (p.owner === true ? 'owner/custodian' : 'not owner/custodian') + ' of ' + car.registration);
  }
  return { people: peopleForCar_(car.id, rows, usersById_()) };
}

/** Admin: set every owner/custodian of one car at once. `people` is [{userId, owner}]. */
function setCarPeople_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  if (!Array.isArray(p.people)) fail_('invalid_input');
  const users = usersById_();
  const wanted = {};
  p.people.forEach(function (e) {
    const uid = cleanStr_(e && e.userId, 64);
    if (!users[uid] || users[uid].status !== 'Approved') fail_('not_found');
    wanted[uid] = e.owner === true;
  });

  const rows = Db.all('CarPeople');
  const involved = {};
  rows.forEach(function (r) { if (r.car_id === car.id) involved[r.user_id] = true; });
  Object.keys(wanted).forEach(function (uid) { involved[uid] = true; });

  let changed = false;
  Object.keys(involved).forEach(function (uid) {
    if (setOwner_(rows, car.id, uid, wanted[uid] === true, ctx)) changed = true;
  });
  const people = peopleForCar_(car.id, rows, users);
  if (changed) {
    audit_(ctx.user, 'people_changed', 'Car', car.id,
      car.registration + ': owners/custodians ' + (people.owners.map(function (x) { return x.name; }).join(', ') || 'none'));
  }
  return { people: people };
}
