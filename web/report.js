// The thinking behind the review screen for an inspection or diagnostic report: turning what AI read into the issues to check,
// spotting likely duplicates, combining two issues, and building what is saved. No screens here (views-report.js), so it can be
// tested without a browser.
(function (root) {
  'use strict';

  var CODE_RE = /\b[PBCU][0-9][0-9A-F]{3}\b/g;
  var STOP = { the: 1, a: 1, an: 1, and: 1, or: 1, of: 1, to: 1, in: 1, on: 1, at: 1, is: 1, with: 1, for: 1, fault: 1, faulty: 1, issue: 1, problem: 1, system: 1, circuit: 1 };

  function amountText(v) { return v === null || v === undefined || v === '' ? '' : String(v); }
  function codesIn(text) { return (String(text || '').toUpperCase().match(CODE_RE) || []).filter(function (c, i, all) { return all.indexOf(c) === i; }); }
  function words(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 1 && !STOP[w]; }).map(function (w) { return w.length > 3 ? w.replace(/s$/, '') : w; });
  }

  /** The notes an issue is saved with: what the document said about it, its fault codes, and where they came from. */
  function composeNotes(issue, source) {
    var parts = [];
    if (issue.notes) parts.push(issue.notes);
    if (issue.codes && issue.codes.length) {
      parts.push('Fault codes:\n' + issue.codes.map(function (c) {
        return c.code + (c.description ? ' · ' + c.description : '') + (c.system ? ' (' + c.system + ')' : '') + (c.status ? ' [' + c.status + ']' : '');
      }).join('\n'));
    }
    if (source) parts.push(source);
    return parts.join('\n\n').slice(0, 2000);
  }

  function sourceLine(data, dateText) {
    var from = data.vendor ? 'From a report by ' + data.vendor : 'From a report';
    return from + (data.reportRef ? ', reference ' + data.reportRef : '') + (dateText ? ', ' + dateText : '') + '.';
  }

  var nextKey = 0;
  function blankIssue(currency) {
    nextKey += 1;
    return {
      key: 'new:' + nextKey, keep: true, title: '', notes: '', system: '', codes: [], stored: false, tip: '', status: 'Not resolved',
      cost: '', currency: currency, quoteCost: '', quoteCurrency: currency, sharedFee: false, sharedQuote: false,
      files: [], linkTo: {}, linkIds: [], duplicate: null, duplicateChoice: 'append', open: false,
    };
  }

  /**
   * The starting point of the review. `receipt` is the Inbox item (with .data and .files); `defaults`: { currency, formatDate(iso) }.
   * Returns { date, mileage, currency, vendor, registration, issues, fee, quote, maintenance }.
   */
  function fromReading(receipt, defaults) {
    var data = (receipt && receipt.data) || {};
    var currency = data.currency || receipt.currency || (defaults && defaults.currency) || 'GBP';
    var files = (receipt && receipt.files) || [];
    var isPhoto = function (i) { return !!files[i] && /^image\//.test(files[i].mime); };
    var dateText = data.date ? (defaults && defaults.formatDate ? defaults.formatDate(data.date) : data.date) : '';
    var source = sourceLine(data, dateText);
    var fee = amountText(data.inspectionFee);
    var quote = amountText(data.quotedTotal);
    var issues = (data.issues || []).map(function (i) {
      var x = blankIssue(currency);
      x.title = i.title || '';
      x.system = i.system || '';
      x.codes = i.codes || [];
      x.stored = !!i.stored;
      x.keep = !x.stored; // stored or old codes start unticked
      x.tip = i.tip || '';
      x.notes = composeNotes(i, source);
      x.cost = amountText(i.inspectionFee);
      x.quoteCost = amountText(i.quotedCost);
      if (!x.cost && fee) { x.cost = fee; x.sharedFee = true; }
      if (!x.quoteCost && quote) { x.quoteCost = quote; x.sharedQuote = true; }
      x.files = (i.photos || []).map(function (n) { return n - 1; }).filter(isPhoto);
      return x;
    });
    var maintenance = null;
    var isInvoice = receipt.kind === 'Maintenance' || data.kind === 'Maintenance';
    if (isInvoice && issues.length) {
      maintenance = { keep: true, title: data.title || 'Garage invoice', total: amountText(data.total), currency: currency, notes: data.work || '', vendor: data.vendor || '' };
    }
    return {
      date: data.date || '', mileage: amountText(data.mileage), currency: currency, vendor: data.vendor || '', registration: data.registration || '',
      source: source, issues: issues, fee: fee, quote: quote, maintenance: maintenance,
    };
  }

  /** An open issue already on the car that looks like this one: it shares a fault code, or most of the words of its title. */
  function duplicateOf(issue, existing) {
    var codes = issue.codes.map(function (c) { return c.code; });
    if (!codes.length) codes = codesIn(issue.title + ' ' + issue.notes);
    var mine = words(issue.title);
    var best = null;
    var bestScore = 0;
    (existing || []).forEach(function (e) {
      if (e.type !== 'Issue' || e.status === 'Resolved' || e.status === 'Ignored') return;
      var theirs = codesIn(e.title + ' ' + e.notes);
      var score = codes.some(function (c) { return theirs.indexOf(c) !== -1; }) ? 2 : 0;
      if (!score && mine.length) {
        var other = words(e.title);
        var both = mine.filter(function (w) { return other.indexOf(w) !== -1; }).length;
        var share = both / Math.max(mine.length, other.length);
        if (both >= 2 && share >= 0.6) score = share;
      }
      if (score > bestScore) { best = { id: e.id, ref: e.ref || '', title: e.title }; bestScore = score; }
    });
    return best;
  }

  function markDuplicates(state, existing) {
    state.issues.forEach(function (i) {
      var hit = duplicateOf(i, existing);
      if (!hit) { i.duplicate = null; return; }
      if (!i.duplicate || i.duplicate.id !== hit.id) i.duplicateChoice = 'append';
      i.duplicate = hit;
    });
  }

  /** The issues that will be saved (ticked, and not skipped as duplicates). */
  function kept(state) {
    return state.issues.filter(function (i) { return i.keep && !(i.duplicate && i.duplicateChoice === 'skip'); });
  }

  function addIssue(state) {
    var x = blankIssue(state.currency);
    x.notes = state.source || '';
    if (state.fee) { x.cost = state.fee; x.sharedFee = true; }
    if (state.quote) { x.quoteCost = state.quote; x.sharedQuote = true; }
    x.open = true;
    state.issues.push(x);
    return x;
  }

  /** Link or unlink two new issues (it counts both ways). */
  function setLinked(state, a, bKey, on) {
    var b = state.issues.filter(function (i) { return i.key === bKey; })[0];
    if (!b) return;
    if (on) { a.linkTo[b.key] = true; b.linkTo[a.key] = true; } else { delete a.linkTo[b.key]; delete b.linkTo[a.key]; }
  }

  /** Put `other` into `into` (one problem AI split in two), and remove `other`. */
  function combine(state, into, other) {
    if (!into || !other || into === other) return;
    var have = into.codes.map(function (c) { return c.code; });
    into.codes = into.codes.concat(other.codes.filter(function (c) { return have.indexOf(c.code) === -1; }));
    var extra = String(other.notes || '').split('\n\n').filter(function (p) { return String(into.notes || '').indexOf(p) === -1; }).join('\n\n');
    into.notes = [into.notes, extra ? other.title + ':\n' + extra : other.title].filter(Boolean).join('\n\n').slice(0, 2000);
    [['cost', 'sharedFee', 'currency'], ['quoteCost', 'sharedQuote', 'quoteCurrency']].forEach(function (k) {
      var a = into[k[0]], b = other[k[0]];
      if (!b) return;
      if (!a) { into[k[0]] = b; into[k[1]] = other[k[1]]; into[k[2]] = other[k[2]]; }
      else if (!(into[k[1]] && other[k[1]]) && into[k[2]] === other[k[2]] && !isNaN(Number(a)) && !isNaN(Number(b))) { into[k[0]] = String(Math.round((Number(a) + Number(b)) * 100) / 100); into[k[1]] = false; }
    });
    into.files = into.files.concat(other.files.filter(function (f) { return into.files.indexOf(f) === -1; }));
    into.keep = into.keep || other.keep;
    into.stored = into.stored && other.stored;
    into.tip = [into.tip, other.tip].filter(function (t, n, all) { return t && all.indexOf(t) === n; }).join(' ');
    other.linkIds.forEach(function (id) { if (into.linkIds.indexOf(id) === -1) into.linkIds.push(id); });
    state.issues.forEach(function (i) { delete i.linkTo[other.key]; });
    state.issues.splice(state.issues.indexOf(other), 1);
  }

  /** A change to the whole report's fee or quote reaches every issue still sharing it. */
  function setReportAmount(state, which, value) {
    var key = which === 'fee' ? 'cost' : 'quoteCost';
    var flag = which === 'fee' ? 'sharedFee' : 'sharedQuote';
    var had = state[which];
    state[which] = value;
    state.issues.forEach(function (i) {
      if (i[flag]) { i[key] = value; if (!value) i[flag] = false; } else if (!had && value && !i[key]) { i[key] = value; i[flag] = true; }
    });
  }

  /** An amount typed on one issue takes it out of the shared group. */
  function setIssueAmount(issue, which, value) {
    issue[which === 'fee' ? 'cost' : 'quoteCost'] = value;
    issue[which === 'fee' ? 'sharedFee' : 'sharedQuote'] = false;
  }

  function isShared(state, issue, flag) { return !!issue[flag] && kept(state).filter(function (i) { return i[flag]; }).length > 1; }

  /** What stops it being saved, in words ([] when it can be). */
  function problems(state) {
    var out = [];
    if (!state.carId) out.push('Choose the car.');
    if (!state.date) out.push('Enter the date.');
    if (String(state.mileage).trim() === '') out.push('Enter the mileage.');
    var list = kept(state);
    if (!list.length && !(state.maintenance && state.maintenance.keep)) out.push('Keep at least one entry.');
    if (list.some(function (i) { return !(i.duplicate && i.duplicateChoice === 'append') && !i.title.trim(); })) out.push('Give every issue a title.');
    if (state.maintenance && state.maintenance.keep && !state.maintenance.title.trim()) out.push('Give the maintenance entry a title.');
    return out;
  }

  /** What saveReport is sent. */
  function payload(state) {
    var list = kept(state);
    var at = {};
    list.forEach(function (i, n) { at[i.key] = n; });
    return {
      receiptId: state.receiptId || undefined, carId: state.carId, date: state.date, mileage: String(state.mileage).trim(),
      updateOdometer: !!state.updateOdometer, identifiedBy: state.identifiedBy || '', vendor: state.identifiedBy ? '' : (state.identifiedText || ''),
      issues: list.map(function (i) {
        return {
          title: i.title, notes: i.notes, status: i.status, cost: i.cost, currency: i.currency, quoteCost: i.quoteCost, quoteCurrency: i.quoteCurrency,
          sharedFee: i.sharedFee, sharedQuote: i.sharedQuote, files: i.files.slice(), appendTo: i.duplicate && i.duplicateChoice === 'append' ? i.duplicate.id : '',
          linkTo: Object.keys(i.linkTo).filter(function (k) { return at[k] !== undefined; }).map(function (k) { return at[k]; }), linkIds: i.linkIds.slice(),
        };
      }),
      maintenance: state.maintenance && state.maintenance.keep ? { title: state.maintenance.title, total: state.maintenance.total, currency: state.maintenance.currency, notes: state.maintenance.notes, vendor: state.maintenance.vendor } : null,
    };
  }

  var api = {
    fromReading: fromReading, composeNotes: composeNotes, codesIn: codesIn, duplicateOf: duplicateOf, markDuplicates: markDuplicates, kept: kept, addIssue: addIssue,
    setLinked: setLinked, combine: combine, setReportAmount: setReportAmount, setIssueAmount: setIssueAmount, isShared: isShared, problems: problems, payload: payload,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReportDraft = api;
})(typeof window !== 'undefined' ? window : globalThis);
