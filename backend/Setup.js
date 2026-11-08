/**
 * One-time (and safely repeatable) bootstrap.
 *
 * Run `setup` from the Apps Script editor as the app account. It:
 *   1. stores private settings (admin emails etc.) from Local.js in Script Properties
 *   2. creates the Drive folders: Fleet Manager / Uploads, Logs, Backups
 *   3. creates the "Fleet Manager DB" Google Sheet with one tab per record type
 *   4. seeds the settings and the initial admin users
 *   5. shares the Backups folder (view only) with BACKUP_SHARE_EMAIL
 *
 * It is idempotent: running it again only adds what is missing.
 */

const BASE_COLUMNS = ['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'version', 'deleted'];

// Tab name -> columns. Tabs marked `base: true` also get BASE_COLUMNS first.
const SCHEMA = {
  Users: { base: true, cols: ['name', 'email', 'status', 'role', 'requested_at', 'approved_by', 'approved_at', 'last_login'] },
  Tokens: { base: false, cols: ['hash', 'type', 'user_id', 'expires_at', 'used_at', 'attempts'] },
  Sessions: { base: false, cols: ['hash', 'user_id', 'created_at', 'last_seen', 'expires_at', 'revoked'] },
  Cars: {
    base: true,
    cols: ['registration', 'nickname', 'make', 'model', 'year', 'colour', 'vin', 'engine_code', 'gearbox_code', 'country', 'market', 'drive_side', 'import_date', 'fuel_capacity', 'currency', 'distance_unit',
      'photo_file_id', 'photo_thumb_file_id', 'guest_enabled', 'guest_secret', 'acquisition_cost', 'acquisition_currency', 'acquisition_date', 'owner_other', 'keeper_other', 'partsouq_url', 'status', 'current_odometer', 'odometer_updated_at', 'reminder_recipients', 'notes'],
  },
  // Which users own / are the registered keeper of which cars (one row per car, user and role).
  CarPeople: { base: true, cols: ['car_id', 'user_id', 'role'] },
  FluidSpecs: { base: true, cols: ['car_id', 'fluid', 'specification', 'capacity', 'notes', 'source', 'verify_flag'] },
  Entries: {
    base: true,
    cols: ['car_id', 'type', 'title', 'notes', 'date', 'mileage', 'cost', 'currency', 'vendor', 'status',
      'linked_issue_id', 'task_id', 'cost_mode', 'lump_sum_cost', 'labour_cost', 'labour_note', 'labour_hours',
      'other_cost', 'other_note', 'part_number', 'quantity', 'unit_cost', 'shipping_cost', 'product_url', 'expiry_date',
      'mileage_unit', 'labour_currency', 'other_currency', 'lump_currency', 'ref'],
  },
  // People who scanned a car's QR code: one row per guest name, kept for ever so a name is never reused.
  Guests: { base: true, cols: ['car_id', 'name', 'name_key', 'token_hash', 'expires_at', 'blocked', 'last_seen'] },
  // Documents kept against a whole car (logbook, insurance, import papers...); the files live in its Drive folder.
  CarDocuments: { base: true, cols: ['car_id', 'doc_type', 'note', 'drive_file_id', 'filename', 'mime', 'size'] },
  PartUsage: { base: true, cols: ['purchase_id', 'event_id', 'quantity_used'] },
  Attachments: { base: true, cols: ['car_id', 'entry_id', 'drive_file_id', 'filename', 'mime', 'size', 'thumb_file_id'] },
  Tasks: {
    base: true,
    cols: ['car_id', 'kind', 'name', 'interval_months', 'interval_distance', 'lead_days', 'lead_distance', 'due_date',
      'due_distance', 'assignees', 'last_done_date', 'last_done_distance', 'last_reminded_at', 'active', 'paused_reason'],
  },
  Locks: { base: false, cols: ['record_type', 'record_id', 'user_id', 'acquired_at', 'heartbeat_at'] },
  Audit: { base: false, cols: ['timestamp', 'user_id', 'user_email', 'action', 'record_type', 'record_id', 'summary', 'before', 'after'] },
  Settings: { base: false, cols: ['key', 'value'] },
};

// Bump this whenever SCHEMA changes. The next request after a deploy then adds any
// missing tabs/columns automatically (additive only), so setup need not be re-run.
const SCHEMA_VERSION = 17; // 17: every entry has a reference number such as M-0042 (16: image attachments get a small thumbnail (thumb_file_id) (15: every distance is in miles (14: car documents tab (13: Cars get market, drive_side, import_date and fuel_capacity columns (12: Cars get engine_code and gearbox_code columns (11: guest access is switched on for every car (10: guest access (every car gets a QR secret) (9: Repair entries become Maintenance; 8: the migration also creates the weekly reminder trigger)

/** Add any missing tabs and columns. Never renames or removes anything. */
function ensureSchema_(ss) {
  Object.keys(SCHEMA).forEach(function (name) { ensureTab_(ss, name, SCHEMA[name]); });
}

function migrateIfNeeded_() {
  if (propsSnapshot_().SCHEMA_VERSION === String(SCHEMA_VERSION)) return;
  const props = props_();
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    if (props.getProperty('SCHEMA_VERSION') === String(SCHEMA_VERSION)) return;
    ensureSchema_(SpreadsheetApp.openById(props.getProperty('DB_ID')));
    ensureReminderTrigger_();
    if (Number(props.getProperty('SCHEMA_VERSION') || 0) < 9) mergeRepairIntoMaintenance_();
    giveCarsGuestSecrets_();
    if (Number(props.getProperty('SCHEMA_VERSION') || 0) < 11) switchOnGuestAccessEverywhere_();
    if (Number(props.getProperty('SCHEMA_VERSION') || 0) < 15) convertEverythingToMiles_();
    if (Number(props.getProperty('SCHEMA_VERSION') || 0) < 17) numberExistingEntries_();
    Db.invalidateAll(); // the sheets were changed directly: nothing remembered about them can be trusted
    props.setProperty('SCHEMA_VERSION', String(SCHEMA_VERSION));
  } finally {
    lock.releaseLock();
  }
}

const DEFAULT_SETTINGS = {
  app_timezone: 'Europe/London',
  reminder_weekday: 'Monday',
  reminder_hour: '8',
  session_days: '30',
  magic_link_minutes: '15',
};

function setup() {
  const props = PropertiesService.getScriptProperties();

  // 1. Private settings from Local.js (git-ignored)
  if (typeof localConfig_ === 'function') {
    const cfg = localConfig_();
    Object.keys(cfg).forEach(function (k) { props.setProperty(k, cfg[k]); });
  }

  // 2. Drive folders
  const root = ensureFolder_(props, 'ROOT_FOLDER_ID', 'Fleet Manager', null);
  const uploads = ensureFolder_(props, 'UPLOADS_FOLDER_ID', 'Uploads', root);
  const logs = ensureFolder_(props, 'LOGS_FOLDER_ID', 'Logs', root);
  const backups = ensureFolder_(props, 'BACKUPS_FOLDER_ID', 'Backups', root);

  // 3. Database sheet
  let ss;
  const dbId = props.getProperty('DB_ID');
  if (dbId) {
    ss = SpreadsheetApp.openById(dbId);
  } else {
    ss = SpreadsheetApp.create('Fleet Manager DB');
    props.setProperty('DB_ID', ss.getId());
    DriveApp.getFileById(ss.getId()).moveTo(root);
  }
  ss.setSpreadsheetTimeZone('Europe/London');
  ensureSchema_(ss);
  props.setProperty('SCHEMA_VERSION', String(SCHEMA_VERSION));
  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);

  // 4. Seed settings + initial admins
  seedSettings_(ss);
  seedAdmins_(ss, props.getProperty('ADMIN_EMAILS'));

  // 5. Share backups (view only) with the owner's personal account
  const share = props.getProperty('BACKUP_SHARE_EMAIL');
  if (share) backups.addViewer(share);

  // 6. Secret salt for hashing tokens, and the trigger that writes the text event log
  salt_();
  ensureTrigger_('flushTextLog', 10);
  ensureReminderTrigger_();
  Db.invalidateAll();

  Logger.log('Setup complete.\nDB: ' + ss.getUrl() + '\nRoot folder: ' + root.getUrl());
}

function ensureFolder_(props, propKey, name, parent) {
  const id = props.getProperty(propKey);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ }
  }
  const folder = parent ? parent.createFolder(name) : DriveApp.createFolder(name);
  props.setProperty(propKey, folder.getId());
  return folder;
}

function ensureTab_(ss, name, def) {
  const wanted = (def.base ? BASE_COLUMNS : []).concat(def.cols);
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].filter(String) : [];
  // Additive only: append any missing headers, never rename or remove.
  const missing = wanted.filter(function (c) { return existing.indexOf(c) === -1; });
  if (missing.length) {
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, Math.max(existing.length + missing.length, 1)).setFontWeight('bold');
  // Keep every cell as plain text so dates, IDs and long numbers are never auto-converted.
  sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).setNumberFormat('@');
}

/** One-off (version 9): the Repair entry type was merged into Maintenance. Costs, parts, photos and issue links stay as they are. */
function mergeRepairIntoMaintenance_() {
  let n = 0;
  Db.all('Entries').forEach(function (e) {
    if (e.type === 'Repair') { Db.update('Entries', e._row, { type: 'Maintenance' }); n++; }
  });
  if (n) audit_(null, 'entry_types_merged', 'Entries', '', n + ' Repair entr' + (n === 1 ? 'y' : 'ies') + ' changed to Maintenance');
}

/** One-off (version 11): guest access starts ON for every car. Admins can switch any car off afterwards, and that choice is kept. */
function switchOnGuestAccessEverywhere_() {
  Db.all('Cars').forEach(function (c) {
    if (!isTrue_(c.guest_enabled)) Db.update('Cars', c._row, { guest_enabled: true });
  });
}

/**
 * One-off (version 15): every distance in the app is in miles from now on. Anything stored in kilometres is
 * converted: a car's odometer, its entries' readings and its reminders' distances. Money is never touched.
 */
function convertEverythingToMiles_() {
  const kmCars = {};
  Db.all('Cars').forEach(function (c) {
    if (c.distance_unit === 'km') {
      kmCars[c.id] = true;
      const patch = { distance_unit: 'mi' };
      if (c.current_odometer !== '') patch.current_odometer = String(convertDistance_(c.current_odometer, 'km', 'mi'));
      Db.update('Cars', c._row, patch);
    } else if (c.distance_unit !== 'mi') {
      Db.update('Cars', c._row, { distance_unit: 'mi' });
    }
  });
  Db.all('Entries').forEach(function (e) {
    if (e.mileage === '') return;
    const unit = e.mileage_unit || (kmCars[e.car_id] ? 'km' : 'mi');
    const patch = { mileage_unit: 'mi' };
    if (unit === 'km') patch.mileage = String(convertDistance_(e.mileage, 'km', 'mi'));
    if (unit !== 'km' && e.mileage_unit === 'mi') return;
    Db.update('Entries', e._row, patch);
  });
  Db.all('Tasks').forEach(function (t) {
    if (!kmCars[t.car_id]) return;
    const patch = {};
    ['interval_distance', 'lead_distance', 'due_distance', 'last_done_distance'].forEach(function (k) {
      if (t[k] !== '') patch[k] = String(convertDistance_(t[k], 'km', 'mi'));
    });
    if (Object.keys(patch).length) Db.update('Tasks', t._row, patch);
  });
}

/** One-off (version 17): give every existing entry (deleted ones too, so a number is never reused) a reference, oldest first. */
function numberExistingEntries_() {
  const rows = Db.all('Entries').filter(function (e) { return !e.ref && REF_LETTERS[e.type]; })
    .sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)) || (a._row - b._row); });
  rows.forEach(function (e) { Db.update('Entries', e._row, { ref: nextEntryRef_(e.type) }); });
}

/** Every car has a secret for its QR code. */
function giveCarsGuestSecrets_() {
  Db.all('Cars').forEach(function (c) {
    if (!c.guest_secret) Db.update('Cars', c._row, { guest_secret: newGuestSecret_() });
  });
}

/** Create a repeating time trigger for `fn` if one doesn't exist yet. */
function ensureTrigger_(fn, everyMinutes) {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === fn; });
  if (!exists) ScriptApp.newTrigger(fn).timeBased().everyMinutes(everyMinutes).create();
}

function seedSettings_(ss) {
  const sheet = ss.getSheetByName('Settings');
  const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues() : [];
  const have = rows.map(function (r) { return r[0]; });
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (have.indexOf(k) === -1) sheet.appendRow([k, DEFAULT_SETTINGS[k]]);
  });
}

function seedAdmins_(ss, adminCsv) {
  if (!adminCsv) return;
  const sheet = ss.getSheetByName('Users');
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const emailCol = header.indexOf('email');
  const emails = sheet.getLastRow() > 1
    ? sheet.getRange(2, emailCol + 1, sheet.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]).toLowerCase(); })
    : [];
  const now = new Date().toISOString();
  adminCsv.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(String).forEach(function (email) {
    if (emails.indexOf(email) !== -1) return;
    const row = {
      id: Utilities.getUuid(), created_at: now, created_by: 'setup', updated_at: now, updated_by: 'setup',
      version: 1, deleted: false, name: email.split('@')[0], email: email, status: 'Approved', role: 'admin',
      requested_at: now, approved_by: 'setup', approved_at: now,
    };
    sheet.appendRow(header.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
  });
}
