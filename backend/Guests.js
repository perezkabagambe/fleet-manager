/**
 * Guest access: a garage or mechanic scans a car's QR code and can record work without an account.
 *
 * How it is kept safe:
 *  - Guest actions are a separate set (auth: 'guest'). A guest token is only accepted by those actions, and
 *    a normal session token is never accepted by them. A guest can touch ONE car and nothing else.
 *  - Guest access is ON for every car by default; an admin can switch it off per car. Each car has its own secret in its QR
 *    code; an admin can replace it (old stickers then stop working) or switch access off at any time.
 *  - A guest must give a name. Names are unique across every guest that has ever existed (ignoring case,
 *    spaces and punctuation) and can never match a person who has an account. The name is bound to a private
 *    token on that phone. Sessions last 14 days.
 *  - Guests add Maintenance and Purchase entries (JPEG photos only, up to 3 per entry) and may delete only their
 *    own entries. They cannot edit, so nothing a garage did can be silently changed later.
 *  - Guests see the car's maintenance history and their own entries. They never see purchases made by others,
 *    parts, owners, users, fluid specs or any costs (except what they themselves entered).
 *  - Every guest entry is stored against the guest ("Guest: name") and appears flagged on the timeline;
 *    admins can delete any entry and block a guest name.
 *  - Abuse limits: daily caps on new guest names and on guest entries per car, rate limits on lookups,
 *    a honeypot field, and the usual size limits.
 */

const GUEST_DAYS = 14;
const GUEST_ENTRY_TYPES = ['Maintenance', 'Purchase'];
const MAX_GUEST_PHOTOS = 3;
const MAX_GUEST_NAMES_PER_DAY = 30;
const MAX_GUEST_ENTRIES_PER_CAR_PER_DAY = 40;

/** "Bob's Garage" and "bobs  garage" count as the same name. */
function guestNameKey_(name) {
  return String(name === null || name === undefined ? '' : name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function newGuestSecret_() {
  return randomToken_().slice(0, 40);
}

/** Does this guest link belong to a car that currently has guest access on? Returns the car row or null. */
function guestCarFor_(carId, secret) {
  const car = findCar_(cleanStr_(carId, 64), false);
  const given = cleanStr_(secret, 80);
  if (!car || !isTrue_(car.guest_enabled) || !car.guest_secret || !given) return null;
  // compare hashes so the check does not leak how much of the secret matched
  return hash_(given) === hash_(car.guest_secret) ? car : null;
}

function guestCarPublic_(car) {
  return { id: car.id, registration: car.registration, make: car.make, model: car.model, year: car.year ? Number(car.year) : null, colour: car.colour, distanceUnit: car.distance_unit || 'mi', country: car.country || 'UK' };
}

// ---------- public actions ----------

/** What the landing page shows before the guest has entered a name. */
function guestInfo_(p) {
  if (!rateLimit_('guestinfo:' + cleanStr_(p.carId, 40), 120, 3600)) fail_('try_later');
  const car = guestCarFor_(p.carId, p.secret);
  if (!car) fail_('guest_unavailable');
  return { car: guestCarPublic_(car), days: GUEST_DAYS };
}

function guestJoin_(p) {
  if (p.website) fail_('guest_unavailable'); // honeypot: real people never fill it in
  if (!rateLimit_('guestjoin:' + cleanStr_(p.carId, 40), 20, 3600)) fail_('try_later');
  const car = guestCarFor_(p.carId, p.secret);
  if (!car) fail_('guest_unavailable');

  const name = cleanStr_(p.name, 40);
  const key = guestNameKey_(name);
  if (!name || key.length < 2) fail_('guest_name_required');
  if (/^guest:/i.test(name)) fail_('guest_name_taken');

  // never the same as a person with an account, and never one a guest has used before (even long ago)
  const users = usersById_();
  const clash = Object.keys(users).some(function (id) { return guestNameKey_(users[id].name) === key; });
  const reused = Db.all('Guests').some(function (g) { return g.name_key === key; });
  if (clash || reused) fail_('guest_name_taken');

  if (!dailyCap_('guest_names', MAX_GUEST_NAMES_PER_DAY)) fail_('try_later');

  const token = randomToken_();
  const now = nowIso_();
  const expiresAt = isoIn_(GUEST_DAYS * 24 * 3600 * 1000);
  const row = {
    id: Utilities.getUuid(), created_at: now, created_by: 'guest', updated_at: now, updated_by: 'guest', version: 1, deleted: false,
    car_id: car.id, name: name, name_key: key, token_hash: hash_(token), expires_at: expiresAt, blocked: false, last_seen: now,
  };
  Db.insert('Guests', row);
  audit_({ id: 'guest:' + row.id, email: 'guest: ' + name }, 'guest_joined', 'Car', car.id, 'Guest "' + name + '" joined ' + car.registration);
  return { guestToken: token, expiresAt: expiresAt, name: name, car: guestCarPublic_(car) };
}

// ---------- guest session ----------

/** Resolve a guest token to { id, name, car, expiresAt }, or null. */
function authenticateGuest_(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const h = hash_(token);
  const row = Db.all('Guests').filter(function (g) { return g.token_hash === h && !isTrue_(g.deleted); })[0];
  if (!row || isTrue_(row.blocked) || Date.parse(row.expires_at) < Date.now()) return null;
  const car = findCar_(row.car_id, false);
  if (!car) return null;
  if (!isTrue_(car.guest_enabled)) fail_('guest_disabled');
  return { id: row.id, name: row.name, car: car, expiresAt: row.expires_at, row: row };
}

function guestUser_(g) {
  return { id: 'guest:' + g.id, name: 'Guest: ' + g.name, email: 'guest: ' + g.name, role: 'guest' };
}

function guestMe_(p, ctx) {
  return { name: ctx.guest.name, expiresAt: ctx.guest.expiresAt, car: guestCarPublic_(ctx.guest.car) };
}

// ---------- what a guest may see ----------

function guestEntryShape_(e, ctx, attachmentCount) {
  const mine = e.created_by === ctx.user.id;
  const out = {
    id: e.id, type: e.type, title: e.title, notes: e.notes, date: e.date, vendor: e.vendor,
    mileage: numOrNull_(e.mileage), mileageUnit: e.mileage_unit || '', mine: mine,
    attachmentCount: mine ? attachmentCount : 0,
  };
  if (mine) {
    // what they entered themselves
    out.currency = e.currency || 'GBP';
    if (e.type === 'Maintenance') {
      out.totalCost = e.cost_mode === 'lump' ? numOrNull_(e.lump_sum_cost) : null;
      out.totalCurrency = e.lump_currency || e.currency || 'GBP';
    } else {
      out.quantity = numOrNull_(e.quantity);
      out.unitCost = numOrNull_(e.unit_cost);
      out.partNumber = e.part_number;
    }
  }
  return out;
}

function guestListEntries_(p, ctx) {
  const car = ctx.guest.car;
  const counts = {};
  Db.all('Attachments').forEach(function (a) {
    if (a.car_id === car.id && !isTrue_(a.deleted)) counts[a.entry_id] = (counts[a.entry_id] || 0) + 1;
  });
  const guestNames = guestNamesById_();
  const entries = Db.all('Entries')
    .filter(function (e) {
      if (e.car_id !== car.id || isTrue_(e.deleted)) return false;
      return e.type === 'Maintenance' || e.created_by === ctx.user.id; // other people's purchases etc. are never shown
    })
    .map(function (e) {
      const s = guestEntryShape_(e, ctx, counts[e.id] || 0);
      s.guestName = e.created_by.indexOf('guest:') === 0 ? (guestNames[e.created_by.slice(6)] || '') : '';
      return s;
    })
    .sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  return { entries: entries, car: guestCarPublic_(car) };
}

// ---------- what a guest may do ----------

/** Only these fields are passed on; everything else a guest sends is ignored. */
function guestFields_(type, f) {
  f = f || {};
  const out = {
    title: f.title, date: f.date, notes: f.notes, vendor: f.vendor,
    mileage: f.mileage, mileageUnit: f.mileageUnit,
  };
  if (type === 'Maintenance') {
    if (f.totalCost !== undefined && String(f.totalCost).trim() !== '') {
      out.costMode = 'lump';
      out.lumpSumCost = f.totalCost;
      out.lumpCurrency = f.totalCurrency;
      out.currency = f.totalCurrency;
    }
  } else {
    out.partNumber = f.partNumber;
    out.quantity = f.quantity;
    out.unitCost = f.unitCost;
    out.currency = f.currency;
  }
  return out;
}

function guestSaveEntry_(p, ctx) {
  const type = cleanStr_(p.type, 20);
  if (GUEST_ENTRY_TYPES.indexOf(type) === -1) fail_('invalid_type');
  if (!rateLimit_('guestentry:' + ctx.guest.id, 30, 3600)) fail_('try_later');
  if (!dailyCap_('guest_entries:' + ctx.guest.car.id, MAX_GUEST_ENTRIES_PER_CAR_PER_DAY)) fail_('try_later');
  // add only: no editing, no parts, no odometer, no reminders, no issue links
  const res = saveEntry_({ carId: ctx.guest.car.id, type: type, fields: guestFields_(type, p.fields) }, ctx);
  const e = findEntry_(res.entry.id);
  return { entry: guestEntryShape_(e, ctx, 0) };
}

function guestOwnEntry_(id, ctx) {
  const e = findEntry_(cleanStr_(id, 64));
  if (!e || e.car_id !== ctx.guest.car.id || e.created_by !== ctx.user.id) fail_('not_found');
  return e;
}

function guestDeleteEntry_(p, ctx) {
  const e = guestOwnEntry_(p.id, ctx);
  return deleteEntry_({ id: e.id }, ctx);
}

function guestUploadAttachment_(p, ctx) {
  const e = guestOwnEntry_(p.entryId, ctx);
  if (cleanStr_(p.mime, 40) !== 'image/jpeg') fail_('invalid_attachment'); // photos only
  const have = Db.all('Attachments').filter(function (a) { return a.entry_id === e.id && !isTrue_(a.deleted); }).length;
  if (have >= MAX_GUEST_PHOTOS) fail_('too_many_attachments');
  return uploadAttachment_({ entryId: e.id, mime: 'image/jpeg', data: p.data, filename: p.filename }, ctx);
}

/** A guest can look at photos on their own entries only (other people's attachments may be invoices). */
function guestGetAttachment_(p, ctx) {
  const found = liveAttachment_(cleanStr_(p.id, 64));
  if (!found || found.entry.created_by !== ctx.user.id || found.entry.car_id !== ctx.guest.car.id) fail_('not_found');
  return getAttachment_({ id: found.att.id }, ctx);
}

function guestListAttachments_(p, ctx) {
  const e = guestOwnEntry_(p.entryId, ctx);
  return {
    attachments: Db.all('Attachments')
      .filter(function (a) { return a.entry_id === e.id && !isTrue_(a.deleted); })
      .map(function (a) { return { id: a.id, filename: a.filename, mime: a.mime, size: Number(a.size || 0) }; }),
  };
}

// ---------- admin ----------

function guestNamesById_() {
  const out = {};
  Db.all('Guests').forEach(function (g) { out[g.id] = g.name; });
  return out;
}

function guestState_(car) {
  return { enabled: isTrue_(car.guest_enabled), secret: car.guest_secret || '' };
}

function setGuestAccess_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const enabled = p.enabled === true;
  const patch = { guest_enabled: enabled };
  if (!car.guest_secret) patch.guest_secret = newGuestSecret_();
  touch_(car, ctx, patch);
  Db.update('Cars', car._row, patch);
  audit_(ctx.user, enabled ? 'guest_access_on' : 'guest_access_off', 'Car', car.id, 'Guest access ' + (enabled ? 'switched on' : 'switched off') + ' for ' + car.registration);
  return guestState_(Object.assign({}, car, patch));
}

/** A fresh secret: printed QR codes made before this stop working for guests. */
function replaceGuestSecret_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const patch = { guest_secret: newGuestSecret_() };
  touch_(car, ctx, patch);
  Db.update('Cars', car._row, patch);
  audit_(ctx.user, 'guest_secret_replaced', 'Car', car.id, 'Guest QR code replaced for ' + car.registration);
  return guestState_(Object.assign({}, car, patch));
}

function listGuests_(p) {
  const carId = cleanStr_(p.carId, 64);
  if (!findCar_(carId, true)) fail_('not_found');
  const entries = Db.all('Entries').filter(function (e) { return e.car_id === carId && !isTrue_(e.deleted) && e.created_by.indexOf('guest:') === 0; });
  const now = Date.now();
  return {
    guests: Db.all('Guests')
      .filter(function (g) { return g.car_id === carId && !isTrue_(g.deleted); })
      .map(function (g) {
        return {
          id: g.id, name: g.name, joinedAt: g.created_at, expiresAt: g.expires_at, blocked: isTrue_(g.blocked),
          active: !isTrue_(g.blocked) && Date.parse(g.expires_at) >= now,
          entries: entries.filter(function (e) { return e.created_by === 'guest:' + g.id; }).length,
        };
      })
      .sort(function (a, b) { return b.joinedAt.localeCompare(a.joinedAt); }),
  };
}

function setGuestBlocked_(p, ctx) {
  const g = Db.all('Guests').filter(function (x) { return x.id === cleanStr_(p.id, 64) && !isTrue_(x.deleted); })[0];
  if (!g) fail_('not_found');
  const blocked = p.blocked === true;
  Db.update('Guests', g._row, { blocked: blocked, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(g.version || 1) + 1 });
  audit_(ctx.user, blocked ? 'guest_blocked' : 'guest_unblocked', 'Car', g.car_id, 'Guest "' + g.name + '" ' + (blocked ? 'blocked' : 'unblocked'));
  return { done: true, blocked: blocked };
}
