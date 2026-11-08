'use strict';
// Runs the real backend source in Node with in-memory stand-ins for the Google
// Apps Script services (Sheets, Cache, Properties, Mail, Drive, UrlFetch, ...).

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKEND = path.join(__dirname, '..', 'backend');
const SOURCES = ['Util.js', 'Db.js', 'Audit.js', 'Email.js', 'Auth.js', 'Users.js', 'Cars.js', 'Code.js', 'Version.js', 'Setup.js'];

function makeSheet(header) {
  const rows = [header.slice()];
  return {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getMaxRows: () => 1000,
    getMaxColumns: () => Math.max(rows[0].length, 26),
    setFrozenRows: () => {},
    getRange: (r, c, nr, nc) => ({
      setFontWeight() {},
      setNumberFormat() {},
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) row.push(rows[r - 1 + i][c - 1 + j] === undefined ? '' : rows[r - 1 + i][c - 1 + j]);
          out.push(row);
        }
        return out;
      },
      setValues: (vals) => {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) rows[r - 1 + i][c - 1 + j] = vals[i][j];
      },
    }),
    appendRow: (arr) => rows.push(arr.slice()),
    deleteRow: (n) => rows.splice(n - 1, 1),
    _rows: rows,
  };
}

function createEnv() {
  let offsetMs = 0;
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...a) {
      if (a.length === 0) super(RealDate.now() + offsetMs);
      else super(...a);
    }
    static now() { return RealDate.now() + offsetMs; }
  }

  const props = {};
  const cache = {};
  const outbox = [];
  const sleeps = [];
  const files = {};
  const state = { tokeninfo: null, mailQuota: 100 };

  const sandbox = {
    console: { log() {}, error() {}, warn() {} },
    Date: FakeDate,
    JSON, Math, Object, Array, String, Number, parseInt, encodeURIComponent,
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          const e = cache[k];
          if (!e) return null;
          if (e.exp < FakeDate.now()) { delete cache[k]; return null; }
          return e.v;
        },
        put: (k, v, ttl) => { cache[k] = { v: String(v), exp: FakeDate.now() + (ttl || 600) * 1000 }; },
        remove: (k) => { delete cache[k]; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_alg, value) => Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      sleep: (ms) => sleeps.push(ms),
      formatDate: (d, _tz, fmt) => {
        const iso = new RealDate(d).toISOString();
        return fmt === 'yyyy-MM-dd' ? iso.slice(0, 10) : fmt === 'yyyy-MM' ? iso.slice(0, 7) : iso;
      },
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (s) => ({ setMimeType() { return this; }, getContent: () => s }),
    },
    MailApp: {
      getRemainingDailyQuota: () => state.mailQuota,
      sendEmail: (m) => { outbox.push(m); },
    },
    UrlFetchApp: {
      fetch: () => {
        const r = state.tokeninfo;
        if (!r) throw new Error('no tokeninfo mock');
        return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) };
      },
    },
    DriveApp: {
      getFolderById: () => ({
        createFile: (name, content) => {
          const id = 'file-' + Object.keys(files).length;
          files[id] = { name, content };
          return {
            getId: () => id,
            getBlob: () => ({ getDataAsString: () => files[id].content }),
            setContent: (c) => { files[id].content = c; },
          };
        },
      }),
      getFileById: (id) => {
        if (!files[id]) throw new Error('not found');
        return {
          getId: () => id,
          getBlob: () => ({ getDataAsString: () => files[id].content }),
          setContent: (c) => { files[id].content = c; },
        };
      },
    },
    SpreadsheetApp: null,
  };

  const sheets = {};
  sandbox.SpreadsheetApp = {
    openById: () => ({ getSheetByName: (n) => sheets[n] || null }),
  };

  const ctx = vm.createContext(sandbox);
  const src = SOURCES.map((f) => fs.readFileSync(path.join(BACKEND, f), 'utf8')).join('\n');
  vm.runInContext(src, ctx, { filename: 'backend-bundle.js' });

  // Build the sheet tabs from the real schema.
  const SCHEMA = vm.runInContext('SCHEMA', ctx);
  const BASE = vm.runInContext('BASE_COLUMNS', ctx);
  Object.keys(SCHEMA).forEach((name) => {
    sheets[name] = makeSheet((SCHEMA[name].base ? BASE : []).concat(SCHEMA[name].cols));
  });
  props.SCHEMA_VERSION = String(vm.runInContext('SCHEMA_VERSION', ctx));
  props.DB_ID = 'db';
  props.LOGS_FOLDER_ID = 'logs';
  props.HASH_SALT = 'test-salt';

  function call(action, params) {
    const res = ctx.doPost({ postData: { contents: JSON.stringify(Object.assign({ action }, params || {})) } });
    return JSON.parse(res.getContent());
  }

  function seedUser(fields) {
    const now = new RealDate().toISOString();
    const u = Object.assign({
      id: crypto.randomUUID(), created_at: now, created_by: 'test', updated_at: now, updated_by: 'test', version: 1,
      deleted: false, name: 'Test', email: 't@example.com', status: 'Approved', role: 'user', requested_at: now,
    }, fields);
    vm.runInContext('Db', ctx).insert('Users', u);
    return u;
  }

  /** Pull the sign-in link token and the code out of the most recent login email to `email`. */
  function lastLoginMail(email) {
    const m = outbox.filter((x) => x.to === email && /sign-in link/.test(x.subject)).pop();
    if (!m) return null;
    return { token: /verify\?t=([0-9a-f]+)/.exec(m.body)[1], code: /code in the app: (\d{6})/.exec(m.body)[1], mail: m };
  }

  /** Full sign-in for a seeded user; returns the session token. */
  function signInAs(email) {
    call('requestLogin', { email });
    const l = lastLoginMail(email);
    return call('verifyLink', { token: l.token }).data.session.token;
  }

  return {
    ctx, call, seedUser, lastLoginMail, signInAs, outbox, sleeps, files, props, sheets, state,
    advance: (ms) => { offsetMs += ms; },
  };
}

module.exports = { createEnv };
