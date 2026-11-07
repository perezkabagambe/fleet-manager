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
    cols: ['registration', 'nickname', 'make', 'model', 'year', 'colour', 'vin', 'country', 'currency', 'distance_unit',
      'photo_file_id', 'partsouq_url', 'status', 'current_odometer', 'odometer_updated_at', 'reminder_recipients', 'notes'],
  },
  FluidSpecs: { base: true, cols: ['car_id', 'fluid', 'specification', 'capacity', 'notes', 'source', 'verify_flag'] },
  Entries: {
    base: true,
    cols: ['car_id', 'type', 'title', 'notes', 'date', 'mileage', 'cost', 'currency', 'vendor', 'status',
      'linked_issue_id', 'task_id', 'cost_mode', 'lump_sum_cost', 'labour_cost', 'labour_note', 'labour_hours',
      'other_cost', 'other_note', 'part_number', 'quantity', 'unit_cost', 'shipping_cost', 'product_url'],
  },
  PartUsage: { base: true, cols: ['purchase_id', 'event_id', 'quantity_used'] },
  Attachments: { base: true, cols: ['car_id', 'entry_id', 'drive_file_id', 'filename', 'mime', 'size'] },
  Tasks: {
    base: true,
    cols: ['car_id', 'kind', 'name', 'interval_months', 'interval_distance', 'lead_days', 'lead_distance', 'due_date',
      'due_distance', 'assignees', 'last_done_date', 'last_done_distance', 'last_reminded_at', 'active', 'paused_reason'],
  },
  Locks: { base: false, cols: ['record_type', 'record_id', 'user_id', 'acquired_at', 'heartbeat_at'] },
  Audit: { base: false, cols: ['timestamp', 'user_id', 'user_email', 'action', 'record_type', 'record_id', 'summary', 'before', 'after'] },
  Settings: { base: false, cols: ['key', 'value'] },
};

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
  Object.keys(SCHEMA).forEach(function (name) { ensureTab_(ss, name, SCHEMA[name]); });
  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);

  // 4. Seed settings + initial admins
  seedSettings_(ss);
  seedAdmins_(ss, props.getProperty('ADMIN_EMAILS'));

  // 5. Share backups (view only) with the owner's personal account
  const share = props.getProperty('BACKUP_SHARE_EMAIL');
  if (share) backups.addViewer(share);

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
