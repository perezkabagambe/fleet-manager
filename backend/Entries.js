/**
 * A car's history: Issues, Maintenance (servicing, checks, repairs and fixes), Compliance renewals and Purchases.
 *
 * Costs (see PLAN section 18):
 *  - Every entry carries its own currency, and each cost on a maintenance entry (labour, other costs, invoice
 *    total) can have its own, e.g. UK parts, Ugandan labour. Older entries without those fall back to the entry's currency.
 *  - A Purchase is bought stock (quantity x unit cost + shipping). Maintenance entries USE parts
 *    from purchases (PartUsage rows), so a part is only ever entered once and its money is counted once.
 *  - Job cost of a maintenance entry = parts used + labour + other costs, or one invoice total.
 *  - Spend (what actually left your pocket) counts purchases on their purchase date, plus labour/other
 *    on the event date, so fitting a part later never counts it twice.
 *
 * Any approved user can add and edit entries. Only admins delete (soft delete; stock is returned).
 */

const ENTRY_TYPES = ['Issue', 'Maintenance', 'Compliance', 'Purchase'];
const ISSUE_STATUSES = ['Not resolved', 'In-work', 'Resolved', 'Ignored'];
const JOB_TYPES = ['Maintenance'];
const MAX_PARTS = 30;

function numOr0_(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function numOrNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function findEntry_(id) {
  return Db.all('Entries').filter(function (e) { return e.id === id && !isTrue_(e.deleted); })[0] || null;
}

/** Positive quantity with up to 3 decimals (e.g. 4 or 4.5 litres). Returns a number, or fails. */
function parseQty_(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).replace(/[,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(s) || Number(s) <= 0) fail_('invalid_quantity');
  return Number(s);
}

function parseHours_(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).replace(/\s/g, '');
  if (s === '') return '';
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(s)) fail_('invalid_hours');
  return String(Number(s));
}

/** A full calendar date (day included). Today or earlier unless allowFuture. */
function parseFullDate_(raw, allowFuture) {
  const d = parseDate_(raw, allowFuture);
  if (d && d.length !== 10) fail_('invalid_date');
  return d;
}

// ---------- cost maths ----------

/** Total paid for a purchase: quantity x unit cost + shipping. */
function purchaseTotal_(p) {
  return numOr0_(p.quantity) * numOr0_(p.unit_cost) + numOr0_(p.shipping_cost);
}

/** Cost of one unit, including its share of the shipping. */
function unitLanded_(p) {
  const q = numOr0_(p.quantity);
  return q > 0 ? purchaseTotal_(p) / q : 0;
}

function addMoney_(map, currency, amount) {
  if (!amount) return;
  map[currency] = round2_((map[currency] || 0) + amount);
}

/** Live usage rows whose maintenance entry still exists. */
function liveUsage_(carEntries, usageRows) {
  const liveEvents = {};
  carEntries.forEach(function (e) { liveEvents[e.id] = true; });
  return usageRows.filter(function (u) { return !isTrue_(u.deleted) && liveEvents[u.event_id]; });
}

/** purchaseId -> quantity already used, optionally ignoring one event (the one being edited). */
function usedQuantities_(usage, excludeEventId) {
  const used = {};
  usage.forEach(function (u) {
    if (u.event_id === excludeEventId) return;
    used[u.purchase_id] = (used[u.purchase_id] || 0) + numOr0_(u.quantity_used);
  });
  return used;
}

/** What a maintenance entry cost, as { currency: amount }. */
function jobCost_(e, usage, purchasesById) {
  const out = {};
  if (e.cost_mode === 'lump') {
    addMoney_(out, e.lump_currency || e.currency, numOr0_(e.lump_sum_cost));
    return out;
  }
  addMoney_(out, e.labour_currency || e.currency, numOr0_(e.labour_cost));
  addMoney_(out, e.other_currency || e.currency, numOr0_(e.other_cost));
  usage.forEach(function (u) {
    if (u.event_id !== e.id) return;
    const p = purchasesById[u.purchase_id];
    if (p) addMoney_(out, p.currency, numOr0_(u.quantity_used) * unitLanded_(p));
  });
  return out;
}

// ---------- shaping rows for the app ----------

function summarizeEntry_(e, guestNames) {
  return {
    guestName: guestNames && String(e.created_by).indexOf('guest:') === 0 ? (guestNames[String(e.created_by).slice(6)] || 'Guest') : '',
    id: e.id, carId: e.car_id, type: e.type, title: e.title, notes: e.notes, date: e.date,
    mileage: numOrNull_(e.mileage), mileageUnit: e.mileage_unit || '', vendor: e.vendor, currency: e.currency || 'GBP',
    status: e.status, linkedIssueId: e.linked_issue_id, costMode: e.cost_mode || 'itemised',
    lumpSumCost: numOrNull_(e.lump_sum_cost), lumpCurrency: e.lump_currency || e.currency || 'GBP',
    labourCost: numOrNull_(e.labour_cost), labourCurrency: e.labour_currency || e.currency || 'GBP', labourNote: e.labour_note,
    labourHours: numOrNull_(e.labour_hours), otherCost: numOrNull_(e.other_cost), otherCurrency: e.other_currency || e.currency || 'GBP', otherNote: e.other_note,
    cost: numOrNull_(e.cost), expiryDate: e.expiry_date || '',
    partNumber: e.part_number, quantity: numOrNull_(e.quantity), unitCost: numOrNull_(e.unit_cost),
    shippingCost: numOrNull_(e.shipping_cost), productUrl: e.product_url,
    taskId: e.task_id || '',
    version: Number(e.version || 1), createdBy: e.created_by, createdAt: e.created_at, updatedAt: e.updated_at,
  };
}

/** Everything the list needs for one car, computed once. */
function entryContext_(carId) {
  const entries = Db.all('Entries').filter(function (e) { return e.car_id === carId && !isTrue_(e.deleted); });
  const purchasesById = {};
  entries.forEach(function (e) { if (e.type === 'Purchase') purchasesById[e.id] = e; });
  const usage = liveUsage_(entries.filter(function (e) { return JOB_TYPES.indexOf(e.type) !== -1; }), Db.all('PartUsage'));
  return { entries: entries, purchasesById: purchasesById, usage: usage, used: usedQuantities_(usage, '') };
}

function purchaseStatus_(p, used) {
  const left = numOr0_(p.quantity) - (used || 0);
  if (!(used > 0)) return 'In stock';
  return left > 1e-9 ? 'Partly used' : 'Fitted';
}

function describeUsage_(u, purchasesById) {
  const p = purchasesById[u.purchase_id];
  if (!p) return null;
  const per = unitLanded_(p);
  return {
    purchaseId: p.id, name: p.title, partNumber: p.part_number, quantity: numOr0_(u.quantity_used),
    currency: p.currency, unitCost: round2_(per), cost: round2_(numOr0_(u.quantity_used) * per),
  };
}

// ---------- reading ----------

function listEntries_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  const c = entryContext_(car.id);
  const attachments = {};
  Db.all('Attachments').forEach(function (a) {
    if (a.car_id === car.id && !isTrue_(a.deleted)) attachments[a.entry_id] = (attachments[a.entry_id] || 0) + 1;
  });
  const guestNames = guestNamesById_();
  const entries = c.entries.map(function (e) {
    const s = summarizeEntry_(e, guestNames);
    s.attachmentCount = attachments[e.id] || 0;
    if (JOB_TYPES.indexOf(e.type) !== -1) {
      s.jobCost = jobCost_(e, c.usage, c.purchasesById);
      s.partsUsed = c.usage.filter(function (u) { return u.event_id === e.id; }).length;
    }
    if (e.type === 'Purchase') {
      const used = c.used[e.id] || 0;
      s.total = round2_(purchaseTotal_(e));
      s.used = used;
      s.remaining = round2_(numOr0_(e.quantity) - used);
      s.stockStatus = purchaseStatus_(e, used);
    }
    return s;
  }).sort(function (a, b) {
    return (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  return { entries: entries };
}

function getEntry_(p, ctx) {
  const e = findEntry_(cleanStr_(p.id, 64));
  if (!e) fail_('not_found');
  const car = findCar_(e.car_id, ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  const c = entryContext_(car.id);
  const out = { entry: summarizeEntry_(e, guestNamesById_()), car: { id: car.id, registration: car.registration, distanceUnit: car.distance_unit || 'mi', currency: car.currency || 'GBP' } };

  out.attachments = Db.all('Attachments')
    .filter(function (a) { return a.entry_id === e.id && !isTrue_(a.deleted); })
    .map(function (a) { return { id: a.id, filename: a.filename, mime: a.mime, size: Number(a.size || 0) }; });

  if (e.task_id) {
    const t = findTask_(e.task_id);
    if (t) out.reminder = { id: t.id, name: t.name };
  }

  if (JOB_TYPES.indexOf(e.type) !== -1) {
    out.parts = c.usage.filter(function (u) { return u.event_id === e.id; })
      .map(function (u) { return describeUsage_(u, c.purchasesById); }).filter(Boolean);
    out.jobCost = jobCost_(e, c.usage, c.purchasesById);
    if (e.linked_issue_id) {
      const issue = c.entries.filter(function (x) { return x.id === e.linked_issue_id; })[0];
      if (issue) out.linkedIssue = { id: issue.id, title: issue.title, status: issue.status };
    }
  }
  if (e.type === 'Issue') {
    out.fixedBy = c.entries.filter(function (x) { return x.type === 'Maintenance' && x.linked_issue_id === e.id; })
      .map(function (x) { return { id: x.id, title: x.title, date: x.date }; });
  }
  if (e.type === 'Purchase') {
    const used = c.used[e.id] || 0;
    out.stock = { used: used, remaining: round2_(numOr0_(e.quantity) - used), status: purchaseStatus_(e, used), total: round2_(purchaseTotal_(e)), perUnit: round2_(unitLanded_(e)) };
    out.usedIn = c.usage.filter(function (u) { return u.purchase_id === e.id; }).map(function (u) {
      const ev = c.entries.filter(function (x) { return x.id === u.event_id; })[0];
      return ev ? { id: ev.id, title: ev.title, type: ev.type, date: ev.date, quantity: numOr0_(u.quantity_used) } : null;
    }).filter(Boolean);
  }
  return out;
}

/** Purchased items still in stock, for the parts picker. When editing an event, its own parts count as available. */
function listPurchases_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const c = entryContext_(car.id);
  const eventId = cleanStr_(p.eventId, 64);
  const used = usedQuantities_(c.usage, eventId);
  const own = {};
  c.usage.forEach(function (u) { if (eventId && u.event_id === eventId) own[u.purchase_id] = numOr0_(u.quantity_used); });
  const issues = c.entries.filter(function (e) { return e.type === 'Issue'; })
    .map(function (e) { return { id: e.id, title: e.title, status: e.status, date: e.date }; })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });
  const purchases = c.entries.filter(function (e) { return e.type === 'Purchase'; })
    .map(function (e) {
      const left = round2_(numOr0_(e.quantity) - (used[e.id] || 0));
      return {
        id: e.id, name: e.title, partNumber: e.part_number, currency: e.currency, date: e.date,
        quantity: numOr0_(e.quantity), available: left, unitCost: round2_(unitLanded_(e)), usedHere: own[e.id] || 0,
      };
    })
    .filter(function (x) { return x.available > 0 || x.usedHere > 0; })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });
  return { purchases: purchases, issues: issues };
}

// ---------- validating input ----------

function parseEntryInput_(f, type, car) {
  const out = {};
  out.title = cleanStr_(f.title, 120);
  if (!out.title) fail_('title_required');
  out.notes = cleanText_(f.notes, 2000);
  const date = parseFullDate_(f.date, false);
  if (!date) fail_('date_required');
  out.date = date;
  out.mileage = parseOdometer_(f.mileage);
  // The reading's own unit (miles or km). It is only kept when there is a reading.
  out.mileage_unit = out.mileage === '' ? '' : oneOf_(f.mileageUnit, DISTANCE_UNITS, car.distance_unit || 'mi', 'invalid_unit');
  out.vendor = cleanStr_(f.vendor, 80);
  out.currency = oneOf_(f.currency, CURRENCIES, car.currency || (car.country === 'UG' ? 'UGX' : 'GBP'), 'invalid_currency');

  if (type === 'Issue') {
    out.status = oneOf_(f.status, ISSUE_STATUSES, 'Not resolved', 'invalid_status');
    out.cost = parseMoney_(f.cost);
  } else if (type === 'Compliance') {
    out.cost = parseMoney_(f.cost);
    out.expiry_date = parseFullDate_(f.expiryDate, true);
  } else if (type === 'Purchase') {
    out.part_number = cleanStr_(f.partNumber, 60);
    out.quantity = String(parseQty_(f.quantity));
    out.unit_cost = parseMoney_(f.unitCost);
    if (out.unit_cost === '') fail_('unit_cost_required');
    out.shipping_cost = parseMoney_(f.shippingCost);
    out.product_url = parseHttpsUrl_(f.productUrl, 'invalid_url');
  } else {
    // Maintenance
    out.cost_mode = oneOf_(f.costMode, ['itemised', 'lump'], 'itemised', 'invalid_cost_mode');
    out.lump_sum_cost = parseMoney_(f.lumpSumCost);
    out.labour_cost = parseMoney_(f.labourCost);
    out.labour_note = cleanStr_(f.labourNote, 80);
    out.labour_hours = parseHours_(f.labourHours);
    out.other_cost = parseMoney_(f.otherCost);
    out.other_note = cleanStr_(f.otherNote, 80);
    // each cost can be in its own currency; one is only stored when that cost has an amount
    const costCurrency = function (amount, raw) { return amount === '' ? '' : oneOf_(raw, CURRENCIES, out.currency, 'invalid_currency'); };
    out.lump_currency = costCurrency(out.lump_sum_cost, f.lumpCurrency);
    out.labour_currency = costCurrency(out.labour_cost, f.labourCurrency);
    out.other_currency = costCurrency(out.other_cost, f.otherCurrency);
    out.linked_issue_id = cleanStr_(f.linkedIssueId, 64);
  }
  return out;
}

/**
 * Work out what the parts list means without writing anything: which existing purchases are used
 * (and how many) and which new purchases to create. Fails if stock would go negative.
 */
function planParts_(partsIn, car, eventDate, eventCurrency, eventId, c) {
  if (!Array.isArray(partsIn) || partsIn.length > MAX_PARTS) fail_('invalid_input');
  const planned = {};
  const create = [];
  partsIn.forEach(function (it) {
    if (it && it.purchaseId) {
      const pu = c.purchasesById[cleanStr_(it.purchaseId, 64)];
      if (!pu) fail_('not_found');
      planned[pu.id] = (planned[pu.id] || 0) + parseQty_(it.quantity);
    } else {
      const name = cleanStr_(it && it.name, 120);
      if (!name) fail_('part_name_required');
      const unit = parseMoney_(it.unitCost);
      if (unit === '') fail_('unit_cost_required');
      create.push({
        name: name, quantity: parseQty_(it.quantity), unitCost: unit, shipping: parseMoney_(it.shippingCost),
        partNumber: cleanStr_(it.partNumber, 60), vendor: cleanStr_(it.vendor, 80),
        currency: oneOf_(it.currency, CURRENCIES, eventCurrency, 'invalid_currency'),
      });
    }
  });
  const used = usedQuantities_(c.usage, eventId);
  Object.keys(planned).forEach(function (id) {
    const available = numOr0_(c.purchasesById[id].quantity) - (used[id] || 0);
    if (planned[id] > available + 1e-9) fail_('not_enough_stock');
  });
  return { use: planned, create: create };
}

function baseColumns_(ctx) {
  const now = nowIso_();
  return { id: Utilities.getUuid(), created_at: now, created_by: ctx.user.id, updated_at: now, updated_by: ctx.user.id, version: 1, deleted: false };
}

// ---------- saving ----------

/**
 * Create (carId + type) or update (id + version) an entry. For a maintenance entry, `parts` is the full
 * list wanted: [{purchaseId, quantity}] to use stock, or [{name, quantity, unitCost, ...}] to buy-and-use.
 * Optional flags: resolveIssue (maintenance linked to an issue) and updateOdometer (raise the car's odometer).
 */
function saveEntry_(p, ctx) {
  let existing = null;
  let carId = cleanStr_(p.carId, 64);
  let type = cleanStr_(p.type, 20);
  if (type === 'Repair') type = 'Maintenance'; // "Repair" was merged into Maintenance; an older open copy of the app may still send it
  if (p.id) {
    existing = findEntry_(cleanStr_(p.id, 64));
    if (!existing) fail_('not_found');
    if (Number(existing.version || 1) !== Number(p.version)) fail_('conflict');
    carId = existing.car_id;
    type = existing.type; // an entry's type never changes
  } else if (ENTRY_TYPES.indexOf(type) === -1) {
    fail_('invalid_type');
  }
  const car = findCar_(carId, false);
  if (!car) fail_('not_found');

  const input = parseEntryInput_(p.fields || {}, type, car);
  const c = entryContext_(car.id);
  const isJob = JOB_TYPES.indexOf(type) !== -1;
  if (!isJob && p.parts && p.parts.length) fail_('invalid_input');

  if (input.linked_issue_id) {
    const issue = c.entries.filter(function (e) { return e.id === input.linked_issue_id && e.type === 'Issue'; })[0];
    if (!issue) fail_('not_found');
  }
  const plan = isJob ? planParts_(p.parts || [], car, input.date, input.currency, existing ? existing.id : '', c) : null;

  // A maintenance entry can be logged against a reminder; a compliance renewal keeps one for its expiry date.
  let linkedTask = null;
  const taskId = cleanStr_(p.taskId, 64);
  if (taskId && (type === 'Maintenance' || type === 'Compliance')) {
    linkedTask = findTask_(taskId);
    if (!linkedTask || linkedTask.car_id !== car.id) fail_('not_found');
  }

  if (type === 'Purchase' && existing) {
    const used = c.used[existing.id] || 0;
    if (Number(input.quantity) < used - 1e-9) fail_('quantity_below_used');
  }

  // ---- all checks passed: write ----
  const now = nowIso_();
  let row;
  if (existing) {
    const before = {};
    const after = {};
    Object.keys(input).forEach(function (k) {
      if (String(existing[k]) !== String(input[k])) { before[k] = existing[k]; after[k] = input[k]; }
    });
    const patch = Object.assign({}, input, { updated_at: now, updated_by: ctx.user.id, version: Number(existing.version || 1) + 1 });
    Db.update('Entries', existing._row, patch);
    row = Object.assign({}, existing, patch);
    audit_(ctx.user, 'entry_updated', 'Entry', existing.id, type + ' "' + input.title + '" on ' + car.registration + ': ' + (Object.keys(after).join(', ') || 'parts'), before, after);
  } else {
    row = Object.assign(baseColumns_(ctx), { car_id: car.id, type: type }, input);
    Db.insert('Entries', row);
    audit_(ctx.user, 'entry_created', 'Entry', row.id, type + ' "' + input.title + '" added to ' + car.registration);
  }

  if (isJob) applyParts_(row, plan, car, ctx);

  const extras = {};
  if (type === 'Maintenance' && p.resolveIssue === true && input.linked_issue_id) {
    const issue = Db.all('Entries').filter(function (e) { return e.id === input.linked_issue_id; })[0];
    if (issue && issue.status !== 'Resolved') {
      Db.update('Entries', issue._row, { status: 'Resolved', updated_at: now, updated_by: ctx.user.id, version: Number(issue.version || 1) + 1 });
      audit_(ctx.user, 'issue_status_changed', 'Entry', issue.id, 'Issue "' + issue.title + '": ' + issue.status + ' to Resolved (maintenance "' + input.title + '")');
      extras.issueResolved = true;
    }
  }
  // The reading may be in the other unit (km on a miles car): convert it into the car's unit.
  const carUnit = car.distance_unit || 'mi';
  if (p.updateOdometer === true && input.mileage !== '') {
    const readingUnit = input.mileage_unit || carUnit;
    const reading = convertDistance_(input.mileage, readingUnit, carUnit);
    if (reading > Number(car.current_odometer || 0)) {
      const patch = touch_(car, ctx, { current_odometer: String(reading), odometer_updated_at: now });
      Db.update('Cars', car._row, patch);
      audit_(ctx.user, 'odometer_updated', 'Car', car.id, car.registration + ': ' + (car.current_odometer || 'not set') + ' to ' + reading + ' ' + carUnit +
        (readingUnit !== carUnit ? ' (converted from ' + input.mileage + ' ' + readingUnit + ')' : '') + ' (from ' + type.toLowerCase() + ')');
      car.current_odometer = String(reading); // so the reminder below is worded from the new reading
      extras.odometerUpdated = true;
    }
  }

  let updatedTask = null;
  if (type === 'Maintenance' && linkedTask && !existing) {
    updatedTask = completeTask_(linkedTask, car, { date: input.date, mileage: input.mileage, unit: input.mileage_unit }, ctx);
  } else if (type === 'Compliance' && input.expiry_date) {
    updatedTask = ensureComplianceTask_(row, car, ctx, linkedTask);
  }
  if (updatedTask) {
    const stored = Db.all('Entries').filter(function (e) { return e.id === row.id; })[0];
    if (stored && stored.task_id !== updatedTask.id) Db.update('Entries', stored._row, { task_id: updatedTask.id });
    row.task_id = updatedTask.id; // so the entry returned to the app already carries its reminder
    const d = describeTask_(updatedTask, car, todayIso_());
    extras.reminder = { id: updatedTask.id, name: updatedTask.name, status: d.status, text: d.text };
  }
  return Object.assign({ entry: summarizeEntry_(row) }, extras);
}

/** Create the inline purchases and make PartUsage match the plan exactly. */
function applyParts_(event, plan, car, ctx) {
  const use = Object.assign({}, plan.use);
  plan.create.forEach(function (n) {
    const purchase = Object.assign(baseColumns_(ctx), {
      car_id: car.id, type: 'Purchase', title: n.name, notes: 'Bought for ' + event.type.toLowerCase() + ' "' + event.title + '"',
      date: event.date, vendor: n.vendor, currency: n.currency, part_number: n.partNumber,
      quantity: String(n.quantity), unit_cost: n.unitCost, shipping_cost: n.shipping,
    });
    Db.insert('Entries', purchase);
    audit_(ctx.user, 'entry_created', 'Entry', purchase.id, 'Purchase "' + n.name + '" added to ' + car.registration + ' with ' + event.type.toLowerCase() + ' "' + event.title + '"');
    use[purchase.id] = n.quantity;
  });

  const rows = Db.all('PartUsage').filter(function (u) { return u.event_id === event.id; });
  const now = nowIso_();
  Object.keys(use).forEach(function (purchaseId) {
    const row = rows.filter(function (u) { return u.purchase_id === purchaseId; })[0];
    if (!row) {
      Db.insert('PartUsage', Object.assign(baseColumns_(ctx), { purchase_id: purchaseId, event_id: event.id, quantity_used: String(use[purchaseId]) }));
    } else if (isTrue_(row.deleted) || numOr0_(row.quantity_used) !== use[purchaseId]) {
      Db.update('PartUsage', row._row, { deleted: false, quantity_used: String(use[purchaseId]), updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 });
    }
  });
  rows.forEach(function (row) {
    if (!use[row.purchase_id] && !isTrue_(row.deleted)) {
      Db.update('PartUsage', row._row, { deleted: true, updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 });
    }
  });
}

/** Any user can move an issue through its statuses. */
function setIssueStatus_(p, ctx) {
  const e = findEntry_(cleanStr_(p.id, 64));
  if (!e || e.type !== 'Issue') fail_('not_found');
  const status = cleanStr_(p.status, 20);
  if (ISSUE_STATUSES.indexOf(status) === -1) fail_('invalid_status');
  if (status === e.status) return { entry: summarizeEntry_(e) };
  const patch = { status: status, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(e.version || 1) + 1 };
  Db.update('Entries', e._row, patch);
  audit_(ctx.user, 'issue_status_changed', 'Entry', e.id, 'Issue "' + e.title + '": ' + e.status + ' to ' + status, { status: e.status }, { status: status });
  return { entry: summarizeEntry_(Object.assign({}, e, patch)) };
}

/** Admin only. Soft delete: the entry is hidden, parts it used return to stock, the audit trail keeps it. */
function deleteEntry_(p, ctx) {
  const e = findEntry_(cleanStr_(p.id, 64));
  if (!e) fail_('not_found');
  if (e.type === 'Purchase') {
    const car = entryContext_(e.car_id);
    if ((car.used[e.id] || 0) > 0) fail_('purchase_in_use');
  }
  Db.update('Entries', e._row, { deleted: true, updated_at: nowIso_(), updated_by: ctx.user.id, version: Number(e.version || 1) + 1 });
  audit_(ctx.user, 'entry_deleted', 'Entry', e.id, e.type + ' "' + e.title + '" deleted');
  return { done: true };
}

// ---------- costs ----------

/**
 * What a car has cost, per currency, counting every cost once. Purchases count on their purchase date;
 * labour, other costs and invoice totals on the maintenance date; issue and compliance costs on their own dates.
 */
function getCarCosts_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  const c = entryContext_(car.id);
  const buckets = {};
  function add(currency, date, category, amount) {
    if (!amount) return;
    const b = buckets[currency] = buckets[currency] || { currency: currency, total: 0, categories: {}, years: {} };
    const year = (date || '').slice(0, 4) || 'Unknown';
    const y = b.years[year] = b.years[year] || { year: year, total: 0, categories: {} };
    b.total = round2_(b.total + amount);
    y.total = round2_(y.total + amount);
    b.categories[category] = round2_((b.categories[category] || 0) + amount);
    y.categories[category] = round2_((y.categories[category] || 0) + amount);
  }
  c.entries.forEach(function (e) {
    if (e.type === 'Purchase') add(e.currency, e.date, 'parts', purchaseTotal_(e));
    else if (e.type === 'Issue') add(e.currency, e.date, 'issues', numOr0_(e.cost));
    else if (e.type === 'Compliance') add(e.currency, e.date, 'compliance', numOr0_(e.cost));
    else if (e.cost_mode === 'lump') add(e.lump_currency || e.currency, e.date, 'invoices', numOr0_(e.lump_sum_cost));
    else {
      add(e.labour_currency || e.currency, e.date, 'labour', numOr0_(e.labour_cost));
      add(e.other_currency || e.currency, e.date, 'other', numOr0_(e.other_cost));
    }
  });
  const list = Object.keys(buckets).sort().map(function (cur) {
    const b = buckets[cur];
    return {
      currency: cur, total: b.total, categories: b.categories,
      years: Object.keys(b.years).sort().reverse().map(function (y) { return b.years[y]; }),
    };
  });
  return { currencies: list };
}
