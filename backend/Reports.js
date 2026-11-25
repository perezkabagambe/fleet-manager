/**
 * Saving from the review screen of an inspection or diagnostic report (or a quote, a described problem, photos of one).
 *
 * The person has checked what AI read (Receipts.js reads it). One save makes one Issue per problem they kept, all with the
 * same date, mileage and "who identified it", and optionally the maintenance entry when the document is also an invoice for
 * work done. A fee or quoted price for the whole report is shared: every issue it covers shows it, and a shared fee is
 * counted once. The report file is attached to every entry; photos go to the issue they show. The new issues are linked to
 * each other. Everything is checked before anything is written.
 */

/** Text added to an existing issue's notes, keeping within the notes limit (the older notes are never cut). */
function appendNotes_(old, heading, added) {
  const joined = [String(old || ''), heading + (added ? '\n' + added : '')].filter(Boolean).join('\n\n');
  return joined.slice(0, Math.max(2000, String(old || '').length));
}

/** Put one group id on the issues that share the same amount: { index: group } for amounts two or more of them share. */
function sharedAmountGroups_(issues, flag, amountKey, currencyKey) {
  const byAmount = {};
  issues.forEach(function (x, i) {
    if (!x[flag] || x.takes && !x.takes[amountKey] || x.fields[amountKey] === '' || x.fields[amountKey] === undefined) return;
    const k = Number(x.fields[amountKey]) + '|' + x.fields[currencyKey];
    (byAmount[k] = byAmount[k] || []).push(i);
  });
  const out = {};
  Object.keys(byAmount).forEach(function (k) {
    if (byAmount[k].length < 2) return;
    const id = Utilities.getUuid();
    byAmount[k].forEach(function (i) { out[i] = id; });
  });
  return out;
}

function saveReport_(p, ctx) {
  let receipt = null;
  if (p.receiptId) {
    receipt = findReceipt_(cleanStr_(p.receiptId, 64));
    if (!receipt) fail_('not_found');
    if (receipt.status === 'Approved' || receipt.status === 'Dismissed') fail_('receipt_closed');
  }
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const date = parseFullDate_(p.date, false);
  if (!date) fail_('date_required');
  if (parseOdometer_(p.mileage) === '') fail_('mileage_required');
  const mileage = String(p.mileage);

  const wanted = Array.isArray(p.issues) ? p.issues : [];
  const maintenance = p.maintenance || null;
  if (wanted.length > MAX_REPORT_ISSUES) fail_('invalid_input');
  if (!wanted.length && !maintenance) fail_('nothing_to_save');

  const files = receipt ? receiptFiles_(receipt) : [];
  const c = entryContext_(car.id);
  const openIssue = function (id) {
    const hit = c.entries.filter(function (e) { return e.id === id && e.type === 'Issue'; })[0];
    if (!hit) fail_('not_found');
    return hit;
  };

  // ---- check everything first ----
  const claimed = {}; // file index -> true: a photo some issue says shows it
  const issues = wanted.map(function (w) {
    w = w || {};
    const x = {
      fields: {
        title: w.title, notes: w.notes, status: w.status, date: date, mileage: mileage, cost: w.cost, currency: w.currency,
        quoteCost: w.quoteCost === undefined ? '' : w.quoteCost, quoteCurrency: w.quoteCurrency,
        identifiedBy: p.identifiedBy || '', vendor: p.identifiedBy ? '' : p.vendor,
      },
      appendTo: cleanStr_(w.appendTo, 64),
      sharedFee: w.sharedFee === true, sharedQuote: w.sharedQuote === true,
      files: (Array.isArray(w.files) ? w.files : []).map(Number).filter(function (n) { return n >= 0 && n < files.length && n === Math.floor(n); }),
      linkNew: (Array.isArray(w.linkTo) ? w.linkTo : []).map(Number).filter(function (n) { return n >= 0 && n < wanted.length && n === Math.floor(n); }),
      linkIds: (Array.isArray(w.linkIds) ? w.linkIds : []).slice(0, MAX_LINKS).map(function (id) { return openIssue(cleanStr_(id, 64)).id; }),
    };
    x.files.forEach(function (n) { claimed[n] = true; });
    if (x.appendTo) {
      // Adding to an issue already on the car: it takes this report's fee or quote only where it has none, so nothing it holds is overwritten.
      const target = openIssue(x.appendTo);
      const base = car.currency || (car.country === 'UG' ? 'UGX' : 'GBP');
      x.fields.cost = parseMoney_(x.fields.cost);
      x.fields.quoteCost = parseMoney_(x.fields.quoteCost);
      x.fields.currency = oneOf_(x.fields.currency, CURRENCIES, base, 'invalid_currency');
      x.fields.quoteCurrency = oneOf_(x.fields.quoteCurrency, CURRENCIES, base, 'invalid_currency');
      x.takes = { cost: x.fields.cost !== '' && String(target.cost) === '', quoteCost: x.fields.quoteCost !== '' && String(target.quote_cost || '') === '' };
    } else {
      const parsed = parseEntryInput_(x.fields, 'Issue', car, null);
      x.fields.cost = parsed.cost; x.fields.currency = parsed.currency; x.fields.quoteCost = parsed.quote_cost; x.fields.quoteCurrency = parsed.quote_currency || parsed.currency;
    }
    return x;
  });
  let job = null;
  if (maintenance) {
    job = {
      title: maintenance.title, notes: maintenance.notes, date: date, mileage: mileage, vendor: maintenance.vendor, currency: maintenance.currency,
      costMode: 'lump', lumpSumCost: maintenance.total, lumpCurrency: maintenance.currency,
    };
    parseEntryInput_(job, 'Maintenance', car, null);
  }

  // ---- write ----
  const feeGroups = sharedAmountGroups_(issues, 'sharedFee', 'cost', 'currency');
  const quoteGroups = sharedAmountGroups_(issues, 'sharedQuote', 'quoteCost', 'quoteCurrency');
  const saved = []; // { id, created, files }
  issues.forEach(function (x, i) {
    if (x.appendTo) {
      const row = findEntry_(x.appendTo);
      const heading = 'Added from a report dated ' + fmtDateText_(date) + ' at ' + thousands_(Number(String(mileage).replace(/[,\s]/g, ''))) + ' mi: ' + cleanStr_(x.fields.title, 120);
      const kept = []; // amounts on this report that the issue could not take, because it already has its own: they are written down
      if (x.fields.cost !== '' && !x.takes.cost) kept.push('Inspection fee on this report: ' + x.fields.currency + ' ' + x.fields.cost);
      if (x.fields.quoteCost !== '' && !x.takes.quoteCost) kept.push('Quoted repair cost on this report: ' + x.fields.quoteCurrency + ' ' + x.fields.quoteCost);
      const patch = { notes: appendNotes_(row.notes, heading, [cleanText_(x.fields.notes, 2000)].concat(kept).filter(Boolean).join('\n')), updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(row.version || 1) + 1 };
      if (x.takes.cost) Object.assign(patch, { cost: x.fields.cost, currency: x.fields.currency, fee_group: feeGroups[i] || '' });
      if (x.takes.quoteCost) Object.assign(patch, { quote_cost: x.fields.quoteCost, quote_currency: x.fields.quoteCurrency, quote_group: quoteGroups[i] || '' });
      Db.update('Entries', row._row, patch);
      audit_(ctx.user, 'entry_updated', 'Entry', row.id, 'Issue "' + row.title + '" on ' + car.registration + ': notes added from a report');
      saved.push({ id: row.id, created: false, files: x.files });
      return;
    }
    const made = saveEntry_({ carId: car.id, type: 'Issue', fields: x.fields }, ctx).entry;
    if (feeGroups[i] || quoteGroups[i]) {
      Db.update('Entries', findEntry_(made.id)._row, { fee_group: feeGroups[i] || '', quote_group: quoteGroups[i] || '' });
    }
    saved.push({ id: made.id, created: true, files: x.files });
  });
  let jobId = '';
  if (job) jobId = saveEntry_({ carId: car.id, type: 'Maintenance', fields: job }, ctx).entry.id;

  // links between the issues, and to issues already on the car (one row per pair, whichever side asked)
  const linked = {};
  Db.all('EntryLinks').forEach(function (l) { if (!isTrue_(l.deleted)) { linked[l.entry_id + '|' + l.issue_id] = true; linked[l.issue_id + '|' + l.entry_id] = true; } });
  const link = function (a, b) {
    if (a === b || linked[a + '|' + b]) return;
    linked[a + '|' + b] = linked[b + '|' + a] = true;
    Db.insert('EntryLinks', Object.assign(baseColumns_(ctx), { car_id: car.id, entry_id: a, issue_id: b, resolves: '' }));
  };
  issues.forEach(function (x, i) {
    x.linkNew.forEach(function (n) { link(saved[i].id, saved[n].id); });
    x.linkIds.forEach(function (id) { link(saved[i].id, id); });
  });

  // the report file(s) go on every entry; a photo that shows a particular problem goes only on that issue
  const everywhere = files.map(function (f, n) { return n; }).filter(function (n) { return !claimed[n]; });
  const targets = saved.concat(jobId ? [{ id: jobId, files: [] }] : []);
  targets.forEach(function (t) {
    const entry = findEntry_(t.id);
    everywhere.concat(t.files).forEach(function (n) { attachReceiptFile_(entry, car, files[n], ctx); });
  });

  if (p.updateOdometer === true) {
    const reading = Number(String(mileage).replace(/[,\s]/g, ''));
    const fresh = findCar_(car.id, false);
    if (reading > Number(fresh.current_odometer || 0)) {
      Db.update('Cars', fresh._row, touch_(fresh, ctx, { current_odometer: String(reading), odometer_updated_at: nowIso_() }));
      audit_(ctx.user, 'odometer_updated', 'Car', car.id, car.registration + ': ' + (fresh.current_odometer || 'not set') + ' to ' + reading + ' mi (from a report)');
    }
  }
  if (receipt) {
    const row = findReceipt_(receipt.id);
    const now = nowIso_();
    Db.update('Inbox', row._row, { status: 'Approved', entry_id: targets[0].id, car_id: car.id, handled_by: ctx.user.id, handled_at: now, updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 });
  }
  audit_(ctx.user, 'report_saved', 'Car', car.id, car.registration + ': ' + plural_(saved.length, 'issue') + (jobId ? ' and a maintenance entry' : '') + ' saved from a report');
  const done = entryContext_(car.id);
  const byId = {};
  done.entries.forEach(function (e) { byId[e.id] = e; });
  return { carId: car.id, entries: targets.map(function (t) { const s = summarizeEntry_(byId[t.id], null, done.groups); s.created = t.created !== false; return s; }) };
}
