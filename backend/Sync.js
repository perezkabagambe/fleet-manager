/**
 * Keeping the phones' saved copies fresh.
 *
 * Each phone saves everything it has seen. To know whether a saved car is still current it asks `getChanges`,
 * which returns one short revision string per car. A revision is a fingerprint of every stored value that the
 * car's screens are built from (the car, its fluids, entries, reminders, documents, attachments, people and part
 * usage), so it changes when any of those changes, however the change was made. The phone then downloads only the
 * cars whose revision is different, with `getCarBundle` (everything for one car in one request, no photos).
 */

// Tab -> the columns that go into the fingerprint (null: all of them). Tabs not listed here never reach a car screen.
const SYNC_TABS_ = {
  Entries: null, EntryLinks: null, TaskRenewals: null, CarPhotos: null, PurchaseItems: null, Tasks: null, FluidSpecs: null, CarDocuments: null, Attachments: null, CarPeople: null,
  Guests: ['id', 'name'], // a guest's name is shown on the entries they added; their last_seen changes constantly and must not count
};

function fingerprintFeed_(state, text) {
  let a = state.a;
  let b = state.b;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = Math.imul(b + code, 2246822519) >>> 0;
    b ^= b >>> 15;
  }
  state.a = a;
  state.b = b >>> 0;
}

function fingerprintText_(state) {
  return ('00000000' + state.a.toString(16)).slice(-8) + ('00000000' + state.b.toString(16)).slice(-8);
}

function rowText_(tab, row, cols) {
  const out = [tab];
  for (let i = 0; i < cols.length; i++) out.push(row[cols[i]] === undefined ? '' : row[cols[i]]);
  return out.join('\u0001') + '\u0002';
}

/** carId -> revision, for every car (deleted ones too). */
function carRevisions_() {
  const seed = { a: 2166136261, b: 374761393 };
  // names shown on car screens: people, and who added an entry
  Db.all('Users').forEach(function (u) { fingerprintFeed_(seed, rowText_('U', u, ['id', 'name', 'deleted'])); });

  const states = {};
  function stateFor(carId) {
    return states[carId] || (states[carId] = { a: seed.a, b: seed.b });
  }
  const baseCols = BASE_COLUMNS;
  Db.all('Cars').forEach(function (c) {
    fingerprintFeed_(stateFor(c.id), rowText_('Cars', c, baseCols.concat(SCHEMA.Cars.cols)));
  });
  Object.keys(SYNC_TABS_).forEach(function (tab) {
    const cols = SYNC_TABS_[tab] || baseCols.concat(SCHEMA[tab].cols);
    Db.all(tab).forEach(function (r) {
      if (r.car_id) fingerprintFeed_(stateFor(r.car_id), rowText_(tab, r, cols));
    });
  });
  // part usage belongs to a car through the entry it is recorded on
  const carOfEntry = {};
  Db.all('Entries').forEach(function (e) { carOfEntry[e.id] = e.car_id; });
  const usageCols = baseCols.concat(SCHEMA.PartUsage.cols);
  Db.all('PartUsage').forEach(function (u) {
    const carId = carOfEntry[u.event_id];
    if (carId) fingerprintFeed_(stateFor(carId), rowText_('PartUsage', u, usageCols));
  });

  const revs = {};
  Object.keys(states).forEach(function (id) { revs[id] = fingerprintText_(states[id]); });
  return revs;
}

/** { cars: { carId: revision }, fleet: revision of the whole list, today } for the cars this person can see. */
function getChanges_(p, ctx) {
  const isAdmin = ctx.user.role === 'admin';
  const revs = carRevisions_();
  const cars = {};
  const fleet = { a: 2166136261, b: 374761393 };
  Db.all('Cars')
    .filter(function (c) { return isAdmin || !isTrue_(c.deleted); })
    .sort(function (x, y) { return x.id < y.id ? -1 : 1; })
    .forEach(function (c) {
      cars[c.id] = revs[c.id] || '';
      fingerprintFeed_(fleet, c.id + ':' + cars[c.id] + '\u0002');
    });
  // what listCars returns also depends on who is asking
  fingerprintFeed_(fleet, ctx.user.id + (isAdmin ? ':admin' : ':user'));
  return { cars: cars, fleet: fingerprintText_(fleet), today: todayIso_() };
}

/**
 * Everything the car's read-only screens show, in one request and without any photos: the car page (which holds the
 * car, fluids, people, history, reminders, costs and documents) and the detail page of every entry.
 */
function getCarBundle_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  const rev = carRevisions_()[car.id] || ''; // taken first: if something changes while the rest is read, the next check simply notices
  const page = getCarPage_({ id: car.id }, ctx);
  const c = entryContext_(car.id);
  const guestNames = guestNamesById_();
  const byEntry = {};
  Db.all('Attachments').forEach(function (a) {
    if (a.car_id !== car.id || isTrue_(a.deleted)) return;
    (byEntry[a.entry_id] = byEntry[a.entry_id] || []).push(a);
  });
  const details = {};
  c.entries.forEach(function (e) { details[e.id] = buildEntryDetail_(e, car, c, guestNames, byEntry[e.id] || []); });
  return { rev: rev, today: todayIso_(), page: page, details: details };
}
