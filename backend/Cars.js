/**
 * Cars and their fluid specifications.
 * Any approved user can add and edit cars; only admins can delete or restore them.
 * Edits are protected by a version check: saving fails with "conflict" if someone
 * else changed the car since the form was opened.
 */

const COUNTRIES = ['UK', 'UG'];
const CURRENCIES = ['GBP', 'UGX', 'USD', 'KES', 'EUR'];
const DISTANCE_UNITS = ['mi', 'km'];
const CAR_STATUSES = ['Active', 'Sold', 'Scrapped', 'Off-road'];
const MAX_ODOMETER = 9999999;
const KM_PER_MILE = 1.609344;

/** Convert a distance between 'mi' and 'km', rounded to a whole number. Currencies are never converted. */
function convertDistance_(value, from, to) {
  const n = Number(value);
  if (!isFinite(n) || from === to) return n;
  return Math.round(from === 'mi' ? n * KM_PER_MILE : n / KM_PER_MILE);
}

function summarizeCar_(c) {
  return {
    id: c.id,
    registration: c.registration,
    nickname: c.nickname,
    make: c.make,
    model: c.model,
    year: c.year ? Number(c.year) : null,
    colour: c.colour,
    vin: c.vin,
    country: c.country || 'UK',
    currency: c.currency || 'GBP',
    distanceUnit: c.distance_unit || 'mi',
    partsouqUrl: c.partsouq_url,
    status: c.status || 'Active',
    odometer: c.current_odometer === '' ? null : Number(c.current_odometer),
    odometerUpdatedAt: c.odometer_updated_at,
    photoId: c.photo_file_id || '',
    photoThumbId: c.photo_thumb_file_id || '',
    guestEnabled: isTrue_(c.guest_enabled),
    acquisitionCost: c.acquisition_cost === '' || c.acquisition_cost === undefined ? null : Number(c.acquisition_cost),
    // Older records have no separate currency: the price was in the car's own currency.
    acquisitionCurrency: c.acquisition_currency || c.currency || 'GBP',
    acquisitionDate: c.acquisition_date || '',
    ownerOther: c.owner_other || '',
    notes: c.notes,
    version: Number(c.version || 1),
    deleted: isTrue_(c.deleted),
    updatedAt: c.updated_at,
  };
}

function findCar_(id, includeDeleted) {
  return Db.all('Cars').filter(function (c) {
    return c.id === id && (includeDeleted || !isTrue_(c.deleted));
  })[0] || null;
}

function touch_(row, ctx, patch) {
  return Object.assign(patch, {
    updated_at: nowIso_(),
    updated_by: ctx.user.id,
    version: Number(row.version || 1) + 1,
  });
}

function oneOf_(value, list, fallback, errorCode) {
  const v = cleanStr_(value, 20);
  if (!v) return fallback;
  if (list.indexOf(v) === -1) fail_(errorCode);
  return v;
}

/** Validate and normalise the editable car fields. Throws an API error on bad input. */
function parseCarInput_(f, existing) {
  const out = {};
  out.registration = cleanStr_(f.registration, 20).toUpperCase();
  if (!out.registration) fail_('registration_required');
  out.make = cleanStr_(f.make, 40);
  if (!out.make) fail_('make_required');
  out.model = cleanStr_(f.model, 40);
  if (!out.model) fail_('model_required');
  out.nickname = cleanStr_(f.nickname, 40);
  out.colour = cleanStr_(f.colour, 30);

  const yearRaw = cleanStr_(f.year, 6);
  if (!yearRaw) fail_('year_required');
  const y = Number(yearRaw);
  if (!/^\d{4}$/.test(yearRaw) || y < 1900 || y > new Date().getFullYear() + 1) fail_('invalid_year');
  out.year = String(y);

  const vin = cleanStr_(f.vin, 30).toUpperCase().replace(/\s+/g, '');
  if (vin && !/^[A-Z0-9-]{5,25}$/.test(vin)) fail_('invalid_vin');
  out.vin = vin;

  out.country = oneOf_(f.country, COUNTRIES, 'UK', 'invalid_country');
  // The car has no fixed "currency for costs": every cost carries its own. This is only the
  // starting default for new costs. It is not asked for, so an edit keeps whatever the car has.
  const defaultCurrency = out.country === 'UG' ? 'UGX' : 'GBP';
  out.currency = oneOf_(f.currency, CURRENCIES, existing && existing.currency ? existing.currency : defaultCurrency, 'invalid_currency');
  out.distance_unit = oneOf_(f.distanceUnit, DISTANCE_UNITS, out.country === 'UG' ? 'km' : 'mi', 'invalid_unit');
  out.status = oneOf_(f.status, CAR_STATUSES, 'Active', 'invalid_status');

  // Any secure link to a parts catalogue (PartSouq is the usual one). The column keeps its original name, partsouq_url.
  const url = parseHttpsUrl_(f.partsouqUrl, 'invalid_catalogue_url');
  out.partsouq_url = url;

  out.current_odometer = parseOdometer_(f.odometer);
  out.acquisition_cost = parseMoney_(f.acquisitionCost);
  // The price may be in a different currency from the car's running costs (e.g. bought in GBP, run in UGX).
  out.acquisition_currency = out.acquisition_cost === ''
    ? ''
    : oneOf_(f.acquisitionCurrency, CURRENCIES, out.currency, 'invalid_currency');
  out.acquisition_date = parseDate_(f.acquisitionDate);
  out.notes = cleanText_(f.notes, 2000);
  // An owner/custodian who is not an app user (a company, a relative...). Free text.
  // (The old keeper_other column is left untouched and unused.)
  out.owner_other = cleanStr_(f.ownerOther, 80);
  return out;
}

/** '' or a secure https link with a real host name and no embedded password; otherwise the given error. */
function parseHttpsUrl_(raw, errorCode) {
  const url = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!url) return '';
  if (url.length > 500 || !/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(:\d{1,5})?([\/?#][^\s<>"']*)?$/i.test(url)) fail_(errorCode);
  return url;
}

/** '' (not given) or a non-negative amount with at most 2 decimals, e.g. 4500 or 4500.50. */
function parseMoney_(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).replace(/[£$€,\s]/g, '');
  if (s === '') return '';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) fail_('invalid_cost');
  return String(Number(s));
}

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function monthFromName_(name) {
  if (name.length < 3) return 0;
  for (let i = 0; i < 12; i++) {
    if (MONTH_NAMES[i].indexOf(name) === 0) return i + 1;
  }
  return 0;
}

/**
 * An approximate or exact date, never in the future. Accepted forms (UK order, day first):
 *   2021 · Mar 2021 · March 2021 · 03/2021 · 2021-03 · 12/03/2021 · 12 Mar 2021 · 2021-03-12
 * Stored as YYYY, YYYY-MM or YYYY-MM-DD, so the precision the person knew is kept. '' if not given.
 * Dates in the future are rejected unless allowFuture is true (e.g. an expiry date).
 */
function parseDate_(raw, allowFuture) {
  const s = cleanStr_(raw, 24).toLowerCase().replace(/,/g, '');
  if (s === '') return '';
  let y = 0, m = 0, d = 0, g;
  if ((g = /^(\d{4})$/.exec(s))) { y = +g[1]; }
  else if ((g = /^(\d{4})-(\d{1,2})$/.exec(s))) { y = +g[1]; m = +g[2]; }
  else if ((g = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { y = +g[1]; m = +g[2]; d = +g[3]; }
  else if ((g = /^(\d{1,2})[\/.-](\d{4})$/.exec(s))) { m = +g[1]; y = +g[2]; }
  else if ((g = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s))) { d = +g[1]; m = +g[2]; y = +g[3]; }
  else if ((g = /^([a-z]{3,9})\.? (\d{4})$/.exec(s))) { m = monthFromName_(g[1]); y = +g[2]; if (!m) fail_('invalid_date'); }
  else if ((g = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.? (\d{4})$/.exec(s))) { d = +g[1]; m = monthFromName_(g[2]); y = +g[3]; if (!m) fail_('invalid_date'); }
  else fail_('invalid_date');

  if (y < 1900) fail_('invalid_date');
  if (m && (m < 1 || m > 12)) fail_('invalid_date');
  if (d) {
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) fail_('invalid_date');
  }
  const pad = function (n) { return ('0' + n).slice(-2); };
  const out = String(y) + (m ? '-' + pad(m) : '') + (d ? '-' + pad(d) : '');
  const today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (!allowFuture && out > today.slice(0, out.length)) fail_('invalid_date');
  return out;
}

/** '' (not set) or a whole number of miles/km. */
function parseOdometer_(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).replace(/[,\s]/g, '');
  if (s === '') return '';
  if (!/^\d{1,7}$/.test(s) || Number(s) > MAX_ODOMETER) fail_('invalid_odometer');
  return String(Number(s));
}

/** Readings may only go up, unless an admin explicitly forces a correction. */
function checkOdometer_(existing, newOdo, p, ctx) {
  if (newOdo === '' || !existing || existing.current_odometer === '') return;
  if (Number(newOdo) < Number(existing.current_odometer)) {
    if (ctx.user.role !== 'admin' || !p.forceOdometer) fail_('odometer_lower');
  }
}

function normReg_(r) {
  return String(r).replace(/\s+/g, '').toUpperCase();
}

function findDuplicates_(input, excludeId) {
  const out = [];
  Db.all('Cars').forEach(function (c) {
    if (isTrue_(c.deleted) || c.id === excludeId) return;
    if (normReg_(c.registration) === normReg_(input.registration)) {
      out.push({ type: 'registration', carId: c.id, label: c.registration + ' (' + c.make + ' ' + c.model + ')' });
    } else if (input.vin && c.vin && c.vin === input.vin) {
      out.push({ type: 'vin', carId: c.id, label: c.registration + ' (' + c.make + ' ' + c.model + ')' });
    }
  });
  return out;
}

// ---------- actions ----------

function listCars_(p, ctx) {
  const all = Db.all('Cars');
  const byReg = function (a, b) { return a.registration.localeCompare(b.registration); };
  // Which cars this user owns / is custodian of, so the fleet screen can badge them.
  const mine = {};
  Db.all('CarPeople').forEach(function (r) {
    if (r.user_id !== ctx.user.id || isTrue_(r.deleted)) return;
    mine[r.car_id] = { owner: true };
  });
  return {
    mine: mine,
    cars: all.filter(function (c) { return !isTrue_(c.deleted); }).map(summarizeCar_).sort(byReg),
    deleted: ctx.user.role === 'admin'
      ? all.filter(function (c) { return isTrue_(c.deleted); }).map(summarizeCar_).sort(byReg)
      : [],
  };
}

function getCar_(p, ctx) {
  const car = findCar_(cleanStr_(p.id, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  return {
    car: Object.assign(summarizeCar_(car), { guestSecret: car.guest_secret || '' }),
    fluids: listFluids_(car.id),
    people: peopleForCar_(car.id, Db.all('CarPeople'), usersById_()),
  };
}

/**
 * Create (no id) or update (id + version) a car. If the registration or VIN already
 * exists, nothing is saved and the warnings are returned; resend with force: true to save anyway.
 */
function saveCar_(p, ctx) {
  let existing = null;
  if (p.id) {
    existing = findCar_(cleanStr_(p.id, 64), false);
    if (!existing) fail_('not_found');
    if (Number(existing.version || 1) !== Number(p.version)) fail_('conflict');
  }
  const input = parseCarInput_(p.fields || {}, existing);
  const dupes = findDuplicates_(input, existing ? existing.id : '');
  if (dupes.length && !p.force) return { saved: false, warnings: dupes };
  // If the car's unit is being switched, compare the new reading with the old one converted into the new unit.
  const oldUnit = existing ? (existing.distance_unit || 'mi') : input.distance_unit;
  const comparable = existing && oldUnit !== input.distance_unit && existing.current_odometer !== ''
    ? Object.assign({}, existing, { current_odometer: String(convertDistance_(existing.current_odometer, oldUnit, input.distance_unit)) })
    : existing;
  checkOdometer_(comparable, input.current_odometer, p, ctx);

  const now = nowIso_();
  if (!existing) {
    const row = Object.assign({
      id: Utilities.getUuid(), created_at: now, created_by: ctx.user.id, updated_at: now, updated_by: ctx.user.id,
      version: 1, deleted: false, odometer_updated_at: input.current_odometer === '' ? '' : now,
      guest_enabled: true, guest_secret: newGuestSecret_(), // guest access is on for every new car; an admin can switch it off
    }, input);
    Db.insert('Cars', row);
    audit_(ctx.user, 'car_created', 'Car', row.id, 'Added ' + row.registration + ' ' + row.make + ' ' + row.model);
    return { saved: true, car: summarizeCar_(row) };
  }

  const before = {};
  const after = {};
  Object.keys(input).forEach(function (k) {
    if (String(existing[k]) !== String(input[k])) { before[k] = existing[k]; after[k] = input[k]; }
  });
  if (!Object.keys(after).length) return { saved: true, car: summarizeCar_(existing), unchanged: true };

  const patch = Object.assign({}, input);
  if (after.current_odometer !== undefined) patch.odometer_updated_at = now;
  touch_(existing, ctx, patch);
  Db.update('Cars', existing._row, patch);
  audit_(ctx.user, 'car_updated', 'Car', existing.id,
    'Updated ' + input.registration + ': ' + Object.keys(after).join(', '), before, after);
  return { saved: true, car: summarizeCar_(Object.assign({}, existing, patch)) };
}

function updateOdometer_(p, ctx) {
  const car = findCar_(cleanStr_(p.id, 64), false);
  if (!car) fail_('not_found');
  const odo = parseOdometer_(p.odometer);
  if (odo === '') fail_('invalid_odometer');
  checkOdometer_(car, odo, p, ctx);
  const patch = touch_(car, ctx, { current_odometer: odo, odometer_updated_at: nowIso_() });
  Db.update('Cars', car._row, patch);
  audit_(ctx.user, 'odometer_updated', 'Car', car.id, car.registration + ': ' + (car.current_odometer || 'not set') + ' to ' + odo,
    { current_odometer: car.current_odometer }, { current_odometer: odo });
  return { car: summarizeCar_(Object.assign({}, car, patch)) };
}

function deleteCar_(p, ctx) {
  const car = findCar_(cleanStr_(p.id, 64), false);
  if (!car) fail_('not_found');
  Db.update('Cars', car._row, touch_(car, ctx, { deleted: true }));
  audit_(ctx.user, 'car_deleted', 'Car', car.id, 'Deleted ' + car.registration + ' ' + car.make + ' ' + car.model);
  return { done: true };
}

function restoreCar_(p, ctx) {
  const car = findCar_(cleanStr_(p.id, 64), true);
  if (!car || !isTrue_(car.deleted)) fail_('not_found');
  Db.update('Cars', car._row, touch_(car, ctx, { deleted: false }));
  audit_(ctx.user, 'car_restored', 'Car', car.id, 'Restored ' + car.registration + ' ' + car.make + ' ' + car.model);
  return { car: summarizeCar_(Object.assign({}, car, { deleted: 'FALSE' })) };
}

// ---------- fluids ----------

function listFluids_(carId) {
  return Db.all('FluidSpecs')
    .filter(function (f) { return f.car_id === carId && !isTrue_(f.deleted); })
    .map(function (f) {
      return {
        id: f.id, fluid: f.fluid, specification: f.specification, capacity: f.capacity,
        notes: f.notes, source: f.source,
      };
    });
}

function cleanFluid_(it) {
  const out = {
    fluid: cleanStr_(it.fluid, 40),
    specification: cleanStr_(it.specification, 120),
    capacity: cleanStr_(it.capacity, 40),
    notes: cleanStr_(it.notes, 200),
    source: cleanStr_(it.source, 120),
  };
  if (!out.fluid) fail_('fluid_name_required');
  return out;
}

/** Replace the car's fluid list with `fluids` (rows keep their id; missing rows are removed). */
function saveFluids_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  if (!Array.isArray(p.fluids) || p.fluids.length > 40) fail_('invalid_input');

  const existing = Db.all('FluidSpecs').filter(function (f) { return f.car_id === car.id && !isTrue_(f.deleted); });
  const keep = {};
  let added = 0, changed = 0, removed = 0;
  const now = nowIso_();

  p.fluids.forEach(function (it) {
    const clean = cleanFluid_(it);
    const row = it.id ? existing.filter(function (f) { return f.id === it.id; })[0] : null;
    if (row) {
      keep[row.id] = true;
      const differs = Object.keys(clean).some(function (k) { return String(row[k]).toUpperCase() !== String(clean[k]).toUpperCase(); });
      if (differs) {
        Db.update('FluidSpecs', row._row, Object.assign({}, clean, { updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 }));
        changed++;
      }
    } else {
      Db.insert('FluidSpecs', Object.assign({
        id: Utilities.getUuid(), created_at: now, created_by: ctx.user.id, updated_at: now, updated_by: ctx.user.id,
        version: 1, deleted: false, car_id: car.id,
      }, clean));
      added++;
    }
  });
  existing.forEach(function (row) {
    if (!keep[row.id]) {
      Db.update('FluidSpecs', row._row, { deleted: true, updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 });
      removed++;
    }
  });
  if (added || changed || removed) {
    audit_(ctx.user, 'fluids_saved', 'Car', car.id,
      car.registration + ' fluids: ' + added + ' added, ' + changed + ' changed, ' + removed + ' removed');
  }
  return { fluids: listFluids_(car.id) };
}
