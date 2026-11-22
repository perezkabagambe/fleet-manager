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

// ---------- reference numbers ----------
// Every entry has a short reference that is unique across the whole app: a letter for its type and a running
// number for that type, like M-0042 (Maintenance), I-0017 (Issue), P-0123 (Purchase), C-0008 (Compliance).
// A reference never changes and is never reused, even after the entry is deleted.
const REF_LETTERS = { Maintenance: 'M', Issue: 'I', Purchase: 'P', Compliance: 'C' };

function refNumber_(ref, letter) {
  const m = /^([MIPCA])-(\d+)$/.exec(String(ref || ''));
  return m && m[1] === letter ? Number(m[2]) : 0;
}

function formatRef_(letter, n) {
  return letter + '-' + (n < 10000 ? ('000' + n).slice(-4) : String(n));
}

/**
 * The next reference for an entry type. The last number used is kept in the script properties, and every existing
 * entry (deleted ones too) is checked as well, so even if the counter were ever lost no reference is handed out twice.
 * Always called inside the script lock (every action that creates an entry holds it).
 */
function nextEntryRef_(type) {
  const letter = REF_LETTERS[type];
  if (!letter) return '';
  const key = 'REF_' + letter;
  let top = Number(props_().getProperty(key) || 0);
  Db.all('Entries').forEach(function (e) { top = Math.max(top, refNumber_(e.ref, letter)); });
  const next = top + 1;
  props_().setProperty(key, String(next));
  return formatRef_(letter, next);
}
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

// ---------- purchase items ----------
// A purchase can hold several items (one order, several parts). Items live in the PurchaseItems tab. A purchase with no
// rows there (every purchase made before this existed, and parts bought inline on a maintenance entry) has ONE item,
// described by the purchase's own columns, whose id is the purchase's id. Everything that tracks stock works on items:
// each item looks like a purchase row (title, part_number, quantity, unit_cost, shipping_cost, currency, date).

const MAX_PURCHASE_ITEMS = 30;

function itemFromRow_(r, entry) {
  return {
    id: r.id, entry_id: entry.id, car_id: entry.car_id, title: r.name, part_number: r.part_number || '', quantity: r.quantity, unit_cost: r.unit_cost,
    shipping_cost: r.id === entry.id ? (entry.shipping_cost || '') : '', // an older purchase's own item keeps the shipping it was saved with
    currency: entry.currency, date: entry.date, vendor: entry.vendor, _entry: entry,
  };
}

/** The items of a purchase entry. `rows` are its live PurchaseItems rows (none for a single-item purchase). */
function purchaseItemsOf_(entry, rows) {
  if (rows && rows.length) {
    return rows.slice().sort(function (a, b) { return (numOr0_(a.position) - numOr0_(b.position)) || (a._row - b._row); })
      .map(function (r) { return itemFromRow_(r, entry); });
  }
  return [{
    id: entry.id, entry_id: entry.id, car_id: entry.car_id, title: entry.title, part_number: entry.part_number || '', quantity: entry.quantity, unit_cost: entry.unit_cost,
    shipping_cost: entry.shipping_cost || '', currency: entry.currency, date: entry.date, vendor: entry.vendor, _entry: entry,
  }];
}

/** The name a purchase gets when the person did not give one: its first item, and how many more there are. */
function derivedPurchaseTitle_(items) {
  return cleanStr_(items[0].name + (items.length > 1 ? ' + ' + (items.length - 1) + ' more' : ''), 120);
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
    id: e.id, ref: e.ref || '', carId: e.car_id, type: e.type, title: e.title, notes: e.notes, date: e.date,
    mileage: numOrNull_(e.mileage), mileageUnit: e.mileage === '' ? '' : 'mi', vendor: e.vendor, currency: e.currency || 'GBP',
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
  const rowsByEntry = {};
  Db.all('PurchaseItems').forEach(function (r) {
    if (r.car_id === carId && !isTrue_(r.deleted)) (rowsByEntry[r.entry_id] = rowsByEntry[r.entry_id] || []).push(r);
  });
  const purchasesById = {}; // item id -> item (see purchaseItemsOf_)
  const itemsByEntry = {};
  entries.forEach(function (e) {
    if (e.type !== 'Purchase') return;
    itemsByEntry[e.id] = purchaseItemsOf_(e, rowsByEntry[e.id]);
    itemsByEntry[e.id].forEach(function (i) { purchasesById[i.id] = i; });
  });
  const usage = liveUsage_(entries.filter(function (e) { return JOB_TYPES.indexOf(e.type) !== -1; }), Db.all('PartUsage'));
  return { entries: entries, purchasesById: purchasesById, itemsByEntry: itemsByEntry, usage: usage, used: usedQuantities_(usage, '') };
}

/** A purchase as a whole: its items, total price, how much has been used, and its stock status. */
function purchaseSummary_(e, c) {
  const items = c.itemsByEntry[e.id] || purchaseItemsOf_(e, []);
  let total = 0;
  let quantity = 0;
  let used = 0;
  let allUsed = true;
  items.forEach(function (i) {
    total += purchaseTotal_(i);
    quantity += numOr0_(i.quantity);
    const u = c.used[i.id] || 0;
    used += u;
    if (numOr0_(i.quantity) - u > 1e-9) allUsed = false;
  });
  return { items: items, total: round2_(total), quantity: quantity, used: used, remaining: round2_(quantity - used), status: !(used > 0) ? 'In stock' : allUsed ? 'Fitted' : 'Partly used' };
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
  const firstImage = {}; // the first photo attached to each entry: it is the entry's thumbnail
  Db.all('Attachments').forEach(function (a) {
    if (a.car_id !== car.id || isTrue_(a.deleted)) return;
    attachments[a.entry_id] = (attachments[a.entry_id] || 0) + 1;
    if (a.mime === 'image/jpeg' && !firstImage[a.entry_id]) firstImage[a.entry_id] = a;
  });
  const guestNames = guestNamesById_();
  const rowOf = {};
  const entries = c.entries.map(function (e) {
    const s = summarizeEntry_(e, guestNames);
    rowOf[e.id] = e._row;
    s.attachmentCount = attachments[e.id] || 0;
    const fi = firstImage[e.id];
    s.thumbAttachmentId = fi && fi.thumb_file_id ? fi.id : '';
    if (JOB_TYPES.indexOf(e.type) !== -1) {
      s.jobCost = jobCost_(e, c.usage, c.purchasesById);
      s.partsUsed = c.usage.filter(function (u) { return u.event_id === e.id; }).length;
    }
    if (e.type === 'Purchase') {
      const ps = purchaseSummary_(e, c);
      s.total = ps.total;
      s.used = ps.used;
      s.remaining = ps.remaining;
      s.stockStatus = ps.status;
      s.itemCount = ps.items.length;
    }
    return s;
  }).sort(function (a, b) {
    // newest date first; for the same date the one added last first (and, if added in the same instant, the later row)
    return (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || '') || (rowOf[b.id] - rowOf[a.id]);
  });
  return { entries: entries };
}

function getEntry_(p, ctx) {
  const e = findEntry_(cleanStr_(p.id, 64));
  if (!e) fail_('not_found');
  const car = findCar_(e.car_id, ctx.user.role === 'admin');
  if (!car) fail_('not_found');
  const c = entryContext_(car.id);
  const attachments = Db.all('Attachments').filter(function (a) { return a.entry_id === e.id && !isTrue_(a.deleted); });
  return buildEntryDetail_(e, car, c, guestNamesById_(), attachments);
}

/** What the entry page shows. `c` is entryContext_(car.id) and `attachments` the entry's live attachment rows, so a whole car can be built in one pass. */
function buildEntryDetail_(e, car, c, guestNames, attachments) {
  const out = { entry: summarizeEntry_(e, guestNames), car: { id: car.id, registration: car.registration, distanceUnit: 'mi', currency: car.currency || 'GBP' } };

  out.attachments = attachments.map(attachmentShape_);

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
    const ps = purchaseSummary_(e, c);
    out.items = ps.items.map(function (i) {
      const used = c.used[i.id] || 0;
      return {
        id: i.id, name: i.title, partNumber: i.part_number, quantity: numOr0_(i.quantity), unitCost: numOrNull_(i.unit_cost),
        lineTotal: round2_(purchaseTotal_(i)), used: used, remaining: round2_(numOr0_(i.quantity) - used), status: purchaseStatus_(i, used),
      };
    });
    out.stock = { used: ps.used, remaining: ps.remaining, status: ps.status, total: ps.total, perUnit: ps.items.length === 1 ? round2_(unitLanded_(ps.items[0])) : null };
    const names = {};
    ps.items.forEach(function (i) { names[i.id] = i.title; });
    out.usedIn = c.usage.filter(function (u) { return names[u.purchase_id] !== undefined; }).map(function (u) {
      const ev = c.entries.filter(function (x) { return x.id === u.event_id; })[0];
      if (!ev) return null;
      const line = { id: ev.id, title: ev.title, type: ev.type, date: ev.date, quantity: numOr0_(u.quantity_used) };
      if (ps.items.length > 1) line.item = names[u.purchase_id];
      return line;
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
  const purchases = Object.keys(c.purchasesById).map(function (id) { return c.purchasesById[id]; })
    .map(function (i) {
      const left = round2_(numOr0_(i.quantity) - (used[i.id] || 0));
      const out = {
        id: i.id, name: i.title, partNumber: i.part_number, currency: i.currency, date: i.date,
        quantity: numOr0_(i.quantity), available: left, unitCost: round2_(unitLanded_(i)), usedHere: own[i.id] || 0,
      };
      // an item from an order with several items says which order it is from
      if (c.itemsByEntry[i.entry_id].length > 1) out.from = (i._entry.ref ? i._entry.ref + ' ' : '') + i._entry.title;
      return out;
    })
    .filter(function (x) { return x.available > 0 || x.usedHere > 0; })
    .sort(function (a, b) { return b.date.localeCompare(a.date); });
  return { purchases: purchases, issues: issues };
}

// ---------- validating input ----------

/**
 * The items of a purchase from the request: p.items = [{ id?, name, partNumber, quantity, unitCost }]. An older copy of the
 * app sends one item in the fields instead. `current` are the purchase's existing items (when editing it).
 */
function purchaseItemsFromInput_(p, current) {
  const f = p.fields || {};
  let raw = p.items;
  const compat = !Array.isArray(raw);
  if (compat) raw = [{ name: f.title, partNumber: f.partNumber, quantity: f.quantity, unitCost: f.unitCost }];
  if (!raw.length || raw.length > MAX_PURCHASE_ITEMS) fail_('invalid_input');
  const known = {};
  current.forEach(function (i) { known[i.id] = true; });
  const seen = {};
  return raw.map(function (it, n) {
    it = it || {};
    const name = cleanStr_(it.name, 120);
    if (!name) fail_('item_name_required');
    const quantity = parseQty_(it.quantity);
    const unitCost = parseMoney_(it.unitCost);
    if (unitCost === '') fail_('unit_cost_required');
    let id = cleanStr_(it.id, 64);
    if (compat && current.length === 1) id = current[0].id; // an older app editing a single-item purchase
    if (!known[id] || seen[id]) id = ''; // only the purchase's own items can be addressed; anything else is a new item
    if (id) seen[id] = true;
    return { id: id, name: name, partNumber: cleanStr_(it.partNumber, 60), quantity: quantity, unitCost: unitCost, position: n };
  });
}

function parseEntryInput_(f, type, car, items) {
  const out = {};
  out.title = cleanStr_(f.title, 120);
  if (!out.title && type === 'Purchase' && items) out.title = derivedPurchaseTitle_(items); // a purchase with no name of its own is named after its items
  if (!out.title) fail_('title_required');
  out.notes = cleanText_(f.notes, 2000);
  const date = parseFullDate_(f.date, false);
  if (!date) fail_('date_required');
  out.date = date;
  out.mileage = parseOdometer_(f.mileage);
  out.mileage_unit = out.mileage === '' ? '' : 'mi'; // readings are always in miles
  out.vendor = cleanStr_(f.vendor, 80);
  out.currency = oneOf_(f.currency, CURRENCIES, car.currency || (car.country === 'UG' ? 'UGX' : 'GBP'), 'invalid_currency');

  if (type === 'Issue') {
    out.status = oneOf_(f.status, ISSUE_STATUSES, 'Not resolved', 'invalid_status');
    out.cost = parseMoney_(f.cost);
  } else if (type === 'Compliance') {
    out.cost = parseMoney_(f.cost);
    out.expiry_date = parseFullDate_(f.expiryDate, true);
  } else if (type === 'Purchase') {
    // The items are saved in PurchaseItems. The purchase's own columns mirror them: exactly the item when there is one,
    // the total quantity when there are several (a price each means nothing then).
    const single = items.length === 1;
    out.part_number = single ? items[0].partNumber : '';
    out.quantity = String(single ? items[0].quantity : round2_(items.reduce(function (s, i) { return s + i.quantity; }, 0)));
    out.unit_cost = single ? items[0].unitCost : '';
    // (no shipping field any more: an older phone that still sends one is ignored, and an existing value is left alone)
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
        name: name, quantity: parseQty_(it.quantity), unitCost: unit, shipping: '',
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

  const c = entryContext_(car.id);
  const currentItems = existing && type === 'Purchase' ? (c.itemsByEntry[existing.id] || []) : [];
  const items = type === 'Purchase' ? purchaseItemsFromInput_(p, currentItems) : null;
  const input = parseEntryInput_(p.fields || {}, type, car, items);
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
    // an item that has been used cannot be removed, and cannot be bought fewer times than it has been used
    const wanted = {};
    items.forEach(function (it) { if (it.id) wanted[it.id] = it; });
    currentItems.forEach(function (cur) {
      const used = c.used[cur.id] || 0;
      if (!wanted[cur.id]) { if (used > 0) fail_('item_in_use'); } else if (wanted[cur.id].quantity < used - 1e-9) fail_('quantity_below_used');
    });
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
    row = Object.assign(baseColumns_(ctx), { car_id: car.id, type: type, ref: nextEntryRef_(type) }, input);
    Db.insert('Entries', row);
    audit_(ctx.user, 'entry_created', 'Entry', row.id, type + ' "' + input.title + '" added to ' + car.registration);
  }

  if (isJob) applyParts_(row, plan, car, ctx);
  if (type === 'Purchase') savePurchaseItems_(row, items, ctx);

  const extras = {};
  if (type === 'Maintenance' && p.resolveIssue === true && input.linked_issue_id) {
    const issue = Db.all('Entries').filter(function (e) { return e.id === input.linked_issue_id; })[0];
    if (issue && issue.status !== 'Resolved') {
      Db.update('Entries', issue._row, { status: 'Resolved', updated_at: now, updated_by: ctx.user.id, version: Number(issue.version || 1) + 1 });
      audit_(ctx.user, 'issue_status_changed', 'Entry', issue.id, 'Issue "' + issue.title + '": ' + issue.status + ' to Resolved (maintenance "' + input.title + '")');
      extras.issueResolved = true;
    }
  }
  if (p.updateOdometer === true && input.mileage !== '') {
    const reading = Number(input.mileage);
    if (reading > Number(car.current_odometer || 0)) {
      const patch = touch_(car, ctx, { current_odometer: String(reading), odometer_updated_at: now });
      Db.update('Cars', car._row, patch);
      audit_(ctx.user, 'odometer_updated', 'Car', car.id, car.registration + ': ' + (car.current_odometer || 'not set') + ' to ' + reading + ' mi (from ' + type.toLowerCase() + ')');
      car.current_odometer = String(reading); // so the reminder below is worded from the new reading
      extras.odometerUpdated = true;
    }
  }

  let updatedTask = null;
  if (type === 'Maintenance' && linkedTask && !existing) {
    updatedTask = completeTask_(linkedTask, car, { date: input.date, mileage: input.mileage }, ctx);
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

/** Make the PurchaseItems rows of a purchase match `items` (parsed by purchaseItemsFromInput_). An item keeps its id for life, so parts used from it stay linked. */
function savePurchaseItems_(entry, items, ctx) {
  const rows = Db.all('PurchaseItems').filter(function (r) { return r.entry_id === entry.id; });
  const byId = {};
  rows.forEach(function (r) { byId[r.id] = r; });
  const keep = {};
  const now = nowIso_();
  const taken = {}; // ids already in use for this purchase
  items.forEach(function (it) { if (it.id) taken[it.id] = true; });
  rows.forEach(function (r) { taken[r.id] = true; });
  items.forEach(function (it, n) {
    // An item with no id is new. The first new item of a purchase takes the purchase's own id (as a single-item purchase
    // always has, so a part can be used by that id); an older purchase's item also gets its row under that id, keeping its usage linked.
    let id = it.id;
    if (!id) {
      if (!taken[entry.id]) { id = entry.id; taken[id] = true; } else id = Utilities.getUuid();
    }
    keep[id] = true;
    const fields = { name: it.name, part_number: it.partNumber, quantity: String(it.quantity), unit_cost: it.unitCost, position: String(n) };
    const row = byId[id];
    if (!row) {
      Db.insert('PurchaseItems', Object.assign(baseColumns_(ctx), { id: id, car_id: entry.car_id, entry_id: entry.id }, fields));
      return;
    }
    const differs = isTrue_(row.deleted) || Object.keys(fields).some(function (k) { return String(row[k]) !== String(fields[k]); });
    if (differs) Db.update('PurchaseItems', row._row, Object.assign({}, fields, { deleted: false, updated_at: now, updated_by: ctx.user.id, version: Number(row.version || 1) + 1 }));
  });
  rows.forEach(function (r) {
    if (!keep[r.id] && !isTrue_(r.deleted)) Db.update('PurchaseItems', r._row, { deleted: true, updated_at: now, updated_by: ctx.user.id, version: Number(r.version || 1) + 1 });
  });
}

/** Create the inline purchases and make PartUsage match the plan exactly. */
function applyParts_(event, plan, car, ctx) {
  const use = Object.assign({}, plan.use);
  plan.create.forEach(function (n) {
    const purchase = Object.assign(baseColumns_(ctx), {
      car_id: car.id, type: 'Purchase', ref: nextEntryRef_('Purchase'), title: n.name, notes: 'Bought for ' + event.type.toLowerCase() + ' "' + event.title + '"',
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

const ENTRY_BIN_DAYS = 30; // a deleted entry can be restored for this long

/** Admin only. Soft delete: the entry goes to the recycle bin (restorable for 30 days), hidden everywhere, and parts it used return to stock. */
function deleteEntry_(p, ctx) {
  const e = findEntry_(cleanStr_(p.id, 64));
  if (!e) fail_('not_found');
  if (e.type === 'Purchase') {
    const c = entryContext_(e.car_id);
    (c.itemsByEntry[e.id] || []).forEach(function (i) { if ((c.used[i.id] || 0) > 0) fail_('purchase_in_use'); });
  }
  const now = nowIso_();
  Db.update('Entries', e._row, { deleted: true, deleted_at: now, updated_at: now, updated_by: ctx.user.id, version: Number(e.version || 1) + 1 });
  audit_(ctx.user, 'entry_deleted', 'Entry', e.id, e.type + ' "' + e.title + '" deleted (in the recycle bin for ' + ENTRY_BIN_DAYS + ' days)');
  return { done: true, restorableDays: ENTRY_BIN_DAYS };
}

/** When a deleted entry was deleted (entries deleted before the bin existed use the time they were last changed). */
function deletedAt_(e) { return Date.parse(e.deleted_at || e.updated_at) || 0; }

/** Admin only: a car's recycle bin: the entries deleted in the last 30 days, newest first. */
function listDeletedEntries_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), true);
  if (!car) fail_('not_found');
  const names = {};
  Db.all('Users').forEach(function (u) { names[u.id] = u.name; });
  const limit = ENTRY_BIN_DAYS * 86400000;
  const entries = Db.all('Entries').filter(function (e) { return e.car_id === car.id && isTrue_(e.deleted) && ENTRY_TYPES.indexOf(e.type) !== -1 && Date.now() - deletedAt_(e) <= limit; })
    .sort(function (a, b) { return deletedAt_(b) - deletedAt_(a); })
    .map(function (e) {
      const at = deletedAt_(e);
      return { id: e.id, ref: e.ref || '', type: e.type, title: e.title, date: e.date, vendor: e.vendor,
        deletedAt: new Date(at).toISOString(), deletedBy: String(e.updated_by).indexOf('guest:') === 0 ? 'a guest' : (names[e.updated_by] || ''),
        daysLeft: Math.max(0, Math.ceil((limit - (Date.now() - at)) / 86400000)) };
    });
  return { entries: entries, days: ENTRY_BIN_DAYS };
}

/**
 * Admin only: bring a deleted entry back (within 30 days). A maintenance entry takes its parts out of stock again, so it
 * is refused if those parts have been used elsewhere since.
 */
function restoreEntry_(p, ctx) {
  const id = cleanStr_(p.id, 64);
  const e = Db.all('Entries').filter(function (x) { return x.id === id; })[0];
  if (!e || !isTrue_(e.deleted)) fail_('not_found');
  if (Date.now() - deletedAt_(e) > ENTRY_BIN_DAYS * 86400000) fail_('restore_expired');
  const car = findCar_(e.car_id, false);
  if (!car) fail_('not_found');
  if (JOB_TYPES.indexOf(e.type) !== -1) {
    const c = entryContext_(car.id); // live entries only: this one is still deleted
    Db.all('PartUsage').filter(function (u) { return u.event_id === e.id && !isTrue_(u.deleted); }).forEach(function (u) {
      const item = c.purchasesById[u.purchase_id];
      if (!item || numOr0_(u.quantity_used) > numOr0_(item.quantity) - (c.used[u.purchase_id] || 0) + 1e-9) fail_('not_enough_stock');
    });
  }
  const now = nowIso_();
  const patch = { deleted: false, deleted_at: '', updated_at: now, updated_by: ctx.user.id, version: Number(e.version || 1) + 1 };
  Db.update('Entries', e._row, patch);
  audit_(ctx.user, 'entry_restored', 'Entry', e.id, e.type + ' "' + e.title + '" restored from the recycle bin');
  return { entry: summarizeEntry_(Object.assign({}, e, patch)) };
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
    if (e.type === 'Purchase') add(e.currency, e.date, 'parts', purchaseSummary_(e, c).total);
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
