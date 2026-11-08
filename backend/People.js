/**
 * Who owns a car, and who is its registered keeper.
 *
 * Links live in the CarPeople tab: one row per (car, user, role) with role 'owner' or 'keeper'.
 * A car can have several of each. Rows are never deleted: un-ticking soft-deletes the row and
 * ticking again restores the same row.
 *
 * Permissions: any approved user can change their OWN links; admins can change anyone's.
 * (An owner or keeper who is not an app user is recorded as free text on the car itself.)
 */

const PEOPLE_ROLES = ['owner', 'keeper'];

function usersById_() {
  const map = {};
  Db.all('Users').forEach(function (u) { if (!isTrue_(u.deleted)) map[u.id] = u; });
  return map;
}

/** { owners: [{userId, name}], keepers: [...] } for one car, sorted by name. */
function peopleForCar_(carId, rows, users) {
  const out = { owners: [], keepers: [] };
  rows.forEach(function (r) {
    if (r.car_id !== carId || isTrue_(r.deleted)) return;
    const u = users[r.user_id];
    if (!u) return;
    (r.role === 'owner' ? out.owners : out.keepers).push({ userId: u.id, name: u.name });
  });
  const byName = function (a, b) { return a.name.localeCompare(b.name); };
  out.owners.sort(byName);
  out.keepers.sort(byName);
  return out;
}

/** Set or clear one role for one user on one car. Returns true if anything changed. */
function setRole_(rows, carId, userId, role, want, ctx) {
  const row = rows.filter(function (r) { return r.car_id === carId && r.user_id === userId && r.role === role; })[0];
  const now = nowIso_();
  if (want) {
    if (!row) {
      const fresh = {
        id: Utilities.getUuid(), created_at: now, created_by: ctx.user.id, updated_at: now, updated_by: ctx.user.id,
        version: 1, deleted: false, car_id: carId, user_id: userId, role: role,
      };
      Db.insert('CarPeople', fresh);
      rows.push(Object.assign({ _row: -1 }, fresh)); // keeps later lookups in this request consistent
      return true;
    }
    if (isTrue_(row.deleted)) {
      Db.update('CarPeople', row._row, { deleted: false, updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 });
      row.deleted = 'FALSE';
      return true;
    }
    return false;
  }
  if (row && !isTrue_(row.deleted)) {
    Db.update('CarPeople', row._row, { deleted: true, updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 });
    row.deleted = 'TRUE';
    return true;
  }
  return false;
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
  const parts = [];
  cars.forEach(function (c) {
    const roles = PEOPLE_ROLES.filter(function (role) {
      return rows.some(function (r) { return r.car_id === c.id && r.user_id === user.id && r.role === role && !isTrue_(r.deleted); });
    });
    if (roles.length) parts.push(roles.join('+') + ' of ' + c.registration);
  });
  return user.name + ': ' + (parts.length ? parts.join(', ') : 'no cars');
}

// ---------- actions ----------

/** Every car, with whether this user owns it and/or is its registered keeper. */
function getUserCars_(p, ctx) {
  const user = targetUser_(p, ctx);
  const rows = Db.all('CarPeople').filter(function (r) { return r.user_id === user.id && !isTrue_(r.deleted); });
  const has = function (carId, role) {
    return rows.some(function (r) { return r.car_id === carId && r.role === role; });
  };
  const cars = liveCars_()
    .sort(function (a, b) { return a.registration.localeCompare(b.registration); })
    .map(function (c) {
      return {
        carId: c.id, registration: c.registration, make: c.make, model: c.model, year: c.year ? Number(c.year) : null,
        owner: has(c.id, 'owner'), keeper: has(c.id, 'keeper'),
      };
    });
  return { user: { id: user.id, name: user.name }, cars: cars };
}

/**
 * Replace all of a user's links in one go. `cars` is [{carId, owner, keeper}]; any car not listed
 * (or with both false) ends up with no link for this user.
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
    wanted[carId] = { owner: e.owner === true, keeper: e.keeper === true };
  });

  const rows = Db.all('CarPeople');
  let changed = false;
  cars.forEach(function (c) {
    const w = wanted[c.id] || { owner: false, keeper: false };
    if (setRole_(rows, c.id, user.id, 'owner', w.owner, ctx)) changed = true;
    if (setRole_(rows, c.id, user.id, 'keeper', w.keeper, ctx)) changed = true;
  });
  if (changed) audit_(ctx.user, 'people_changed', 'User', user.id, describeUserCars_(user, cars, rows));
  return getUserCars_({ userId: user.id }, ctx);
}

/** A quick toggle from the car page: set or clear my own owner / keeper link for one car. */
function setMyCarRole_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const rows = Db.all('CarPeople');
  const a = setRole_(rows, car.id, ctx.user.id, 'owner', p.owner === true, ctx);
  const b = setRole_(rows, car.id, ctx.user.id, 'keeper', p.keeper === true, ctx);
  if (a || b) {
    audit_(ctx.user, 'people_changed', 'Car', car.id,
      ctx.user.name + ': ' + (p.owner === true ? 'owner' : 'not owner') + ', ' + (p.keeper === true ? 'registered keeper' : 'not registered keeper') + ' of ' + car.registration);
  }
  return { people: peopleForCar_(car.id, rows, usersById_()) };
}

/** Admin: set every owner and keeper of one car at once. `people` is [{userId, owner, keeper}]. */
function setCarPeople_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  if (!Array.isArray(p.people)) fail_('invalid_input');
  const users = usersById_();
  const wanted = {};
  p.people.forEach(function (e) {
    const uid = cleanStr_(e && e.userId, 64);
    if (!users[uid] || users[uid].status !== 'Approved') fail_('not_found');
    wanted[uid] = { owner: e.owner === true, keeper: e.keeper === true };
  });

  const rows = Db.all('CarPeople');
  const involved = {};
  rows.forEach(function (r) { if (r.car_id === car.id) involved[r.user_id] = true; });
  Object.keys(wanted).forEach(function (uid) { involved[uid] = true; });

  let changed = false;
  Object.keys(involved).forEach(function (uid) {
    const w = wanted[uid] || { owner: false, keeper: false };
    if (setRole_(rows, car.id, uid, 'owner', w.owner, ctx)) changed = true;
    if (setRole_(rows, car.id, uid, 'keeper', w.keeper, ctx)) changed = true;
  });
  const people = peopleForCar_(car.id, rows, users);
  if (changed) {
    audit_(ctx.user, 'people_changed', 'Car', car.id,
      car.registration + ': owners ' + (people.owners.map(function (x) { return x.name; }).join(', ') || 'none') +
      '; keepers ' + (people.keepers.map(function (x) { return x.name; }).join(', ') || 'none'));
  }
  return { people: people };
}
