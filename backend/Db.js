/**
 * Minimal table access over the Google Sheet "database".
 * Every cell is treated as text (booleans are "TRUE"/"FALSE"); callers convert.
 * Rows are never deleted by normal operations, so a row number stays valid
 * for the duration of one request.
 */
const Db = (function () {
  let ss = null;

  // ---------- speed: remember tables ----------
  // Reading a whole tab from Google Sheets is the slow part of most requests, and a request often needs the same
  // tab several times. So a table is read at most once per request, and the busy tabs are also kept in the script
  // cache between requests. Safety rules:
  //  - every write through Db (insert / update) forgets that table at once (and gives it a new "generation", so
  //    no other request can be served the old copy), and a cached copy never lives longer than CACHE_TTL seconds,
  //    so even an edit made by hand in the Sheet shows up within two minutes;
  //  - callers always get their own copies of the rows, so changing one never changes what the next caller sees;
  //  - tabs holding security records (sessions, login codes) and the audit log are never cached;
  //  - the whole thing can be switched off by setting the script property DB_CACHE to "off".
  const CACHED = { Cars: 1, Entries: 1, Users: 1, CarPeople: 1, FluidSpecs: 1, PartUsage: 1, Attachments: 1, CarDocuments: 1, Tasks: 1, Guests: 1 };
  const CACHE_TTL = 600;
  // The script cache holds at most 100 KB (bytes, not characters) per value. A character can take up to 3 bytes
  // (£, accented letters, Luganda names), so a piece is at most 30,000 characters.
  const CHUNK = 30000;
  const MAX_CHUNKS = 60;
  let memo = {}; // this request's copy of each table: { header, values }
  let shared = null; // null = not looked up yet this request
  let prefetched = null; // this request's view of the script cache: { gens: {tab: generation}, first: {tab: first piece} }

  function sharedOn_() {
    if (shared === null) {
      try { shared = propsSnapshot_().DB_CACHE !== 'off'; } catch (e) { shared = false; }
    }
    return shared;
  }

  function cacheable_(name) { return !!CACHED[name] && sharedOn_(); }

  function genKey_(name) { return 'dbgen:' + name; }

  function dataKey_(name, gen) { return 'db:' + SCHEMA_VERSION + ':' + name + ':' + gen; }

  /**
   * One round trip to the script cache for every busy tab: each tab's current generation, and the first piece of
   * its remembered copy under that generation (a tab that fits in one piece is complete in that one fetch).
   * Never throws: any trouble just means "read the sheets".
   */
  function prefetch_() {
    if (prefetched) return prefetched;
    prefetched = { gens: {}, first: {} };
    if (!sharedOn_()) return prefetched;
    try {
      const cache = CacheService.getScriptCache();
      const names = Object.keys(CACHED);
      const gens = cache.getAll(names.map(genKey_));
      const fresh = {};
      const keys = [];
      names.forEach(function (n) {
        const g = gens[genKey_(n)];
        if (g) {
          prefetched.gens[n] = g;
          keys.push(dataKey_(n, g) + ':0');
        } else {
          const made = Utilities.getUuid(); // never seen (or evicted): start a new generation, nothing is remembered under it yet
          fresh[genKey_(n)] = made;
          prefetched.gens[n] = made;
        }
      });
      if (Object.keys(fresh).length) cache.putAll(fresh, 21600);
      const got = keys.length ? cache.getAll(keys) : {};
      names.forEach(function (n) {
        const first = got[dataKey_(n, prefetched.gens[n]) + ':0'];
        prefetched.first[n] = typeof first === 'string' ? first : null;
      });
    } catch (e) {
      prefetched = { gens: {}, first: {} };
    }
    return prefetched;
  }

  /** The shared copy of a table, or null. */
  function fromShared_(name) {
    try {
      const p = prefetch_();
      const gen = p.gens[name];
      const first = p.first[name];
      if (!gen || !first) return null;
      const bar = first.indexOf('|');
      const n = Number(first.slice(0, bar));
      if (!(n >= 1 && n <= MAX_CHUNKS)) return null;
      let json = first.slice(bar + 1);
      if (n > 1) {
        const base = dataKey_(name, gen);
        const keys = [];
        for (let i = 1; i < n; i++) keys.push(base + ':' + i);
        const got = CacheService.getScriptCache().getAll(keys);
        for (let j = 0; j < keys.length; j++) {
          if (typeof got[keys[j]] !== 'string') return null; // a missing piece: never trust half a table
          json += got[keys[j]];
        }
      }
      const t = JSON.parse(json);
      return t && Array.isArray(t.header) && Array.isArray(t.values) ? t : null;
    } catch (e) { return null; }
  }

  function toShared_(name, t) {
    try {
      const gen = prefetch_().gens[name];
      if (!gen) return;
      const json = JSON.stringify(t);
      const n = Math.max(1, Math.ceil(json.length / CHUNK));
      if (n > MAX_CHUNKS) return; // too big to keep: it is simply read each time
      const base = dataKey_(name, gen);
      const put = {};
      for (let i = 0; i < n; i++) put[base + ':' + i] = (i === 0 ? n + '|' : '') + json.slice(i * CHUNK, (i + 1) * CHUNK);
      CacheService.getScriptCache().putAll(put, CACHE_TTL);
    } catch (e) { /* not kept: fine */ }
  }

  /** A table has changed: forget it here, and make every other request forget it too. */
  function changed_(name) {
    delete memo[name];
    if (!CACHED[name]) return;
    const made = Utilities.getUuid();
    try {
      CacheService.getScriptCache().put(genKey_(name), made, 21600);
      if (prefetched) { prefetched.gens[name] = made; prefetched.first[name] = null; }
    } catch (e) {
      if (prefetched) { delete prefetched.gens[name]; prefetched.first[name] = null; } // nothing is remembered for it this request
      try { CacheService.getScriptCache().remove(genKey_(name)); } catch (e2) { shared = false; }
    }
  }

  /** Forget everything (after setup or a schema change, which write to the sheets directly). */
  function invalidateAll() {
    Object.keys(CACHED).forEach(changed_);
    memo = {};
  }

  /** Start of a request: nothing is remembered from an earlier one. */
  function resetRequest() {
    memo = {};
    shared = null;
    prefetched = null;
    propsSnap_ = null;
  }

  // ---------- reading and writing ----------

  function sheet_(name) {
    if (!ss) ss = SpreadsheetApp.openById(props_().getProperty('DB_ID'));
    const sh = ss.getSheetByName(name);
    if (!sh) throw new Error('Missing sheet: ' + name);
    return sh;
  }

  /**
   * Sheets turns a cell that looks like a date into a real Date. Give those back as the plain "yyyy-mm-dd"
   * they were typed as (midnight in the spreadsheet's time zone), and anything with a time as a full timestamp.
   */
  function str_(v) {
    if (v instanceof Date) {
      let zone = TZ;
      try { zone = ss && ss.getSpreadsheetTimeZone ? ss.getSpreadsheetTimeZone() : TZ; } catch (e) { zone = TZ; }
      const local = Utilities.formatDate(v, zone, "yyyy-MM-dd'T'HH:mm:ss");
      return local.slice(11) === '00:00:00' ? local.slice(0, 10) : v.toISOString();
    }
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function cell_(v) {
    if (v === true) return 'TRUE';
    if (v === false) return 'FALSE';
    return str_(v);
  }

  function header_(sh) {
    return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(str_);
  }

  /** Read a table straight from the sheet: one call for the header and every row. */
  function readSheet_(name) {
    const all = sheet_(name).getDataRange().getValues();
    if (!all.length) return { header: [], values: [] };
    const header = all[0].map(str_);
    const values = all.slice(1).map(function (row) {
      const out = [];
      for (let j = 0; j < header.length; j++) out.push(str_(row[j]));
      return out;
    });
    return { header: header, values: values };
  }

  function table_(name) {
    if (memo[name]) return memo[name];
    let t = cacheable_(name) ? fromShared_(name) : null;
    if (!t) {
      t = readSheet_(name);
      if (cacheable_(name)) toShared_(name, t);
    }
    memo[name] = t;
    return t;
  }

  /** All data rows as objects (string values) with a `_row` sheet row number. Each caller gets its own copies. */
  function all(name) {
    const t = table_(name);
    const header = t.header;
    return t.values.map(function (vals, i) {
      const o = { _row: i + 2 };
      for (let j = 0; j < header.length; j++) o[header[j]] = vals[j] === undefined ? '' : vals[j];
      return o;
    });
  }

  function insert(name, obj) {
    const sh = sheet_(name);
    const header = header_(sh);
    // Write as text so Sheets never reinterprets "2027-11-08" as a date.
    const range = sh.getRange(sh.getLastRow() + 1, 1, 1, header.length);
    range.setNumberFormat('@');
    range.setValues([header.map(function (h) { return cell_(obj[h]); })]);
    changed_(name);
  }

  /** Merge `patch` into the row; unknown columns are ignored. */
  function update(name, rowNum, patch) {
    const sh = sheet_(name);
    const header = header_(sh);
    const range = sh.getRange(rowNum, 1, 1, header.length);
    const cur = range.getValues()[0];
    Object.keys(patch).forEach(function (k) {
      const j = header.indexOf(k);
      if (j >= 0) cur[j] = patch[k];
    });
    range.setNumberFormat('@');
    range.setValues([cur.map(cell_)]);
    changed_(name);
  }

  /** Delete rows matching `predicate` (bottom-up so row numbers stay valid). Only for tabs that are never cached. */
  function prune(name, predicate) {
    if (CACHED[name]) throw new Error('prune is not allowed on ' + name);
    const sh = sheet_(name);
    all(name)
      .filter(predicate)
      .map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (n) { sh.deleteRow(n); });
    delete memo[name];
  }

  return { all: all, insert: insert, update: update, prune: prune, invalidateAll: invalidateAll, resetRequest: resetRequest };
})();

function isTrue_(v) {
  return String(v).toUpperCase() === 'TRUE';
}
