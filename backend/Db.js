/**
 * Minimal table access over the Google Sheet "database".
 * Every cell is treated as text (booleans are "TRUE"/"FALSE"); callers convert.
 * Rows are never deleted by normal operations, so a row number stays valid
 * for the duration of one request.
 */
const Db = (function () {
  let ss = null;

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

  /** All data rows as objects (string values) with a `_row` sheet row number. */
  function all(name) {
    const sh = sheet_(name);
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return [];
    const header = header_(sh);
    const values = sh.getRange(2, 1, lastRow - 1, header.length).getValues();
    return values.map(function (vals, i) {
      const o = { _row: i + 2 };
      header.forEach(function (h, j) { o[h] = str_(vals[j]); });
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
  }

  /** Delete rows matching `predicate` (bottom-up so row numbers stay valid). */
  function prune(name, predicate) {
    const sh = sheet_(name);
    all(name)
      .filter(predicate)
      .map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (n) { sh.deleteRow(n); });
  }

  return { all: all, insert: insert, update: update, prune: prune };
})();

function isTrue_(v) {
  return String(v).toUpperCase() === 'TRUE';
}
