// Search across the fleet, from the copy of the data saved on this phone (so it is instant and works offline): cars, log entries,
// files and documents, and reminders. Used by the box at the top of the Fleet page. The matching is plain and has no screens of its own
// (FleetSearch.find), so it can be tested without a browser.
(function (root) {
  'use strict';

  var TYPE_LABEL = { Issue: 'Issue', Maintenance: 'Maintenance', Purchase: 'Purchase' };

  function norm(s) { return String(s === null || s === undefined ? '' : s).toLowerCase(); }
  function compact(s) { return norm(s).replace(/[\s\-]+/g, ''); }

  /**
   * Every searchable thing from the saved data. `read(action, params)` gives a saved answer (FleetApi.peek) or undefined.
   * Returns { cars: [], entries: [], files: [], reminders: [] }, each item: { kind, text (what is searched), title, sub, id (the small
   * unique ID, or ''), carId, ... what is needed to open it }.
   */
  function collect(read) {
    var out = { cars: [], entries: [], files: [], reminders: [] };
    var list = read('listCars', {});
    var cars = (list && list.cars) || [];
    cars.forEach(function (c) {
      out.cars.push({
        kind: 'car', carId: c.id, title: c.registration, sub: [c.make, c.model, c.year ? '(' + c.year + ')' : ''].filter(Boolean).join(' '), id: c.registration,
        text: [c.registration, c.make, c.model, c.year, c.vin, c.engineCode, c.gearboxCode, c.colour, c.nickname, c.notes].join(' '),
      });
      var page = read('getCarPage', { id: c.id });
      if (!page) return;
      var reg = c.registration;
      (page.entries || []).forEach(function (e) {
        out.entries.push({
          kind: 'entry', type: e.type, carId: c.id, entryId: e.id, title: e.title, id: e.ref || '', date: e.date || '',
          sub: reg + (e.date ? ' · ' + e.date : ''),
          text: [e.title, e.notes, e.vendor, e.ref, e.partNumber, e.status, TYPE_LABEL[e.type], reg].join(' '),
        });
        var detail = read('getEntry', { id: e.id });
        ((detail && detail.attachments) || []).forEach(function (a) {
          out.files.push({
            kind: 'attachment', carId: c.id, fileId: a.id, mime: a.mime, filename: a.filename, title: a.filename, id: a.ref || '',
            sub: 'On ' + (e.ref || e.title) + ' · ' + reg, text: [a.filename, a.ref, e.title, e.ref, reg].join(' '),
          });
        });
      });
      (page.documents || []).forEach(function (d) {
        out.files.push({
          kind: 'document', carId: c.id, fileId: d.id, mime: d.mime, filename: d.filename, title: d.filename, id: d.ref || '',
          sub: (d.type || 'Document') + ' · ' + reg, text: [d.filename, d.ref, d.note, d.type, reg].join(' '),
        });
      });
      (page.tasks || []).forEach(function (t) {
        out.reminders.push({
          kind: 'reminder', carId: c.id, taskId: t.id, title: t.name, id: '', sub: reg + (t.dueDate ? ' · due ' + t.dueDate : ''),
          text: [t.name, t.kind === 'compliance' ? 'compliance' : 'maintenance', reg].join(' '),
        });
      });
    });
    return out;
  }

  /** Does the item match every word of the query? Capitals, spaces and hyphens do not matter ("mv56huh" finds MV56 HUH, "a00" finds A-0004). */
  function matches(item, words) {
    if (!item._lc) { item._lc = norm(item.text); item._cp = compact(item.text); }
    return words.every(function (w) { return item._lc.indexOf(w) !== -1 || (compact(w) && item._cp.indexOf(compact(w)) !== -1); });
  }

  /** Better first: the title or ID starts with the query, then the title contains it, then newer. */
  function score(item, q) {
    var t = norm(item.title), id = norm(item.id);
    var s = 0;
    if (t.indexOf(q) === 0 || id.indexOf(q) === 0) s += 4;
    else if (t.indexOf(q) !== -1 || id.indexOf(q) !== -1) s += 2;
    return s;
  }

  /** The matches for a query, in groups. Fewer than two characters finds nothing. */
  function find(data, query) {
    var q = norm(query).trim();
    var empty = { cars: [], entries: [], files: [], reminders: [], total: 0 };
    if (q.length < 2) return empty;
    var words = q.split(/\s+/).filter(Boolean);
    var res = { total: 0 };
    ['cars', 'entries', 'files', 'reminders'].forEach(function (g) {
      var hits = (data[g] || []).filter(function (i) { return matches(i, words); });
      hits.sort(function (a, b) { return (score(b, q) - score(a, q)) || String(b.date || '').localeCompare(String(a.date || '')) || String(a.title).localeCompare(String(b.title)); });
      res[g] = hits;
      res.total += hits.length;
    });
    return res;
  }

  var api = { collect: collect, find: find };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FleetSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
