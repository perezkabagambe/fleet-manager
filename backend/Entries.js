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

const ENTRY_TYPES = ['Issue', 'Maintenance', 'Purchase'];

// ---------- reference numbers ----------
// Every entry has a short reference that is unique across the whole app: a letter for its type and a running
// number for that type, like M-0042 (Maintenance), I-0017 (Issue), P-0123 (Purchase).
// (There used to be Compliance entries, C-0008. They were replaced by compliance reminders; their numbers are never used again.)
// A reference never changes and is never reused, even after the entry is deleted.
const REF_LETTERS = { Maintenance: 'M', Issue: 'I', Purchase: 'P' };

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

/** The garage or person shown for an entry: for an issue identified by an app user, that user's current name. */
function entryVendor_(e) {
  if (e.identified_by) {
    const u = usersById_()[e.identified_by];
    return u ? u.name : '';
  }
  return e.vendor;
}

/** How many live entries share each shared fee and each shared quote: { fee: { group: n }, quote: { group: n } }. */
function sharedGroups_(entries) {
  const out = { fee: {}, quote: {} };
  entries.forEach(function (e) {
    if (e.fee_group) out.fee[e.fee_group] = (out.fee[e.fee_group] || 0) + 1;
    if (e.quote_group) out.quote[e.quote_group] = (out.quote[e.quote_group] || 0) + 1;
  });
  return out;
}

/** `groups` (sharedGroups_ of the car's live entries) says whether an amount is shared with another issue; without it, it reads as not shared. */
function summarizeEntry_(e, guestNames, groups) {
  return {
    guestName: guestNames && String(e.created_by).indexOf('guest:') === 0 ? (guestNames[String(e.created_by).slice(6)] || 'Guest') : '',
    id: e.id, ref: e.ref || '', carId: e.car_id, type: e.type, title: e.title, notes: e.notes, date: e.date,
    mileage: numOrNull_(e.mileage), mileageUnit: e.mileage === '' ? '' : 'mi', vendor: entryVendor_(e), identifiedBy: e.identified_by || '', currency: e.currency || 'GBP',
    status: e.status, costMode: e.cost_mode || 'itemised',
    lumpSumCost: numOrNull_(e.lump_sum_cost), lumpCurrency: e.lump_currency || e.currency || 'GBP',
    labourCost: numOrNull_(e.labour_cost), labourCurrency: e.labour_currency || e.currency || 'GBP', labourNote: e.labour_note,
    labourHours: numOrNull_(e.labour_hours), otherCost: numOrNull_(e.other_cost), otherCurrency: e.other_currency || e.currency || 'GBP', otherNote: e.other_note,
    cost: numOrNull_(e.cost), feeShared: !!(groups && e.fee_group && groups.fee[e.fee_group] > 1),
    quoteCost: numOrNull_(e.quote_cost), quoteCurrency: e.quote_currency || e.currency || 'GBP', quoteShared: !!(groups && e.quote_group && groups.quote[e.quote_group] > 1),
    aiTips: tipsOf_(e),
    partNumber: e.part_number, quantity: numOrNull_(e.quantity), unitCost: numOrNull_(e.unit_cost),
    shippingCost: numOrNull_(e.shipping_cost), productUrl: e.product_url,
    taskId: e.task_id || '',
    version: Number(e.version || 1), createdBy: e.created_by, createdByName: creatorName_(e.created_by, guestNames && String(e.created_by).indexOf('guest:') === 0 ? (guestNames[String(e.created_by).slice(6)] || '') : ''), createdAt: e.created_at, updatedAt: e.updated_at,
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
  return { entries: entries, purchasesById: purchasesById, itemsByEntry: itemsByEntry, usage: usage, used: usedQuantities_(usage, ''), links: liveLinks_(carId, entries), groups: sharedGroups_(entries) };
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

// ---------- linked issues ----------
// Any entry can have a list of linked issues. A link is one EntryLinks row (entry -> issue); between two issues it counts both
// ways. A maintenance entry's link can say it `resolves` the issue. Links to or from a deleted entry are kept but not shown,
// so restoring the entry brings them back.

const MAX_LINKS = 40;

/** A car's links whose two ends are both live entries. */
function liveLinks_(carId, entries) {
  const live = {};
  entries.forEach(function (e) { live[e.id] = e; });
  return Db.all('EntryLinks').filter(function (l) { return l.car_id === carId && !isTrue_(l.deleted) && live[l.entry_id] && live[l.issue_id]; });
}

/** The issues linked to an entry: [{ id, ref, title, status, date, resolves }], oldest reference first. */
function linkedIssuesOf_(entry, c) {
  const byId = {};
  c.entries.forEach(function (e) { byId[e.id] = e; });
  const found = {};
  c.links.forEach(function (l) {
    if (l.entry_id === entry.id) found[l.issue_id] = found[l.issue_id] || isTrue_(l.resolves);
    else if (entry.type === 'Issue' && l.issue_id === entry.id && byId[l.entry_id].type === 'Issue') found[l.entry_id] = found[l.entry_id] || false;
  });
  return Object.keys(found).map(function (id) {
    const i = byId[id];
    return { id: i.id, ref: i.ref || '', title: i.title, status: i.status, date: i.date, resolves: found[id] };
  }).sort(function (a, b) { return String(a.ref).localeCompare(String(b.ref)); });
}

/** The reports that found an issue: Entries.found_in holds a "reportId:date" for each, separated by spaces. */
function reportsOf_(entry) { return String(entry.found_in || '').split(' ').filter(Boolean); }

/**
 * "Found at the same time": for each report that found an issue, the other issues it found. It says nothing about the faults
 * being related (that is what the links are for, which only a person makes).
 * [{ date, issues: [{ id, ref, title, status }] }], oldest report first; a report with no other live issue is left out.
 */
function foundWithOf_(issue, c) {
  return reportsOf_(issue).map(function (report) {
    const others = c.entries.filter(function (e) { return e.id !== issue.id && e.type === 'Issue' && reportsOf_(e).indexOf(report) !== -1; })
      .map(function (e) { return { id: e.id, ref: e.ref || '', title: e.title, status: e.status }; })
      .sort(function (a, b) { return String(a.ref).localeCompare(String(b.ref)); });
    return { date: report.split(':')[1] || '', issues: others };
  }).filter(function (g) { return g.issues.length; }).sort(function (a, b) { return a.date.localeCompare(b.date); });
}

/** The maintenance and purchase entries that link to an issue. */
function relatedToIssue_(issue, c) {
  const byId = {};
  c.entries.forEach(function (e) { byId[e.id] = e; });
  return c.links.filter(function (l) { return l.issue_id === issue.id && byId[l.entry_id].type !== 'Issue'; }).map(function (l) {
    const e = byId[l.entry_id];
    return { id: e.id, ref: e.ref || '', type: e.type, title: e.title, date: e.date, resolves: isTrue_(l.resolves) };
  }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
}

/**
 * What a save asks of the links: [{ issueId, resolves }] to make the list exactly that, or null to leave it alone.
 * `links` is the whole list. An older copy of the app sends a maintenance entry's single `linkedIssueId` (with resolveIssue):
 * that only ever adds that link, so it can never take the others away.
 */
function parseLinks_(p, type, existing, c) {
  const issueOf = function (id) {
    const hit = c.entries.filter(function (e) { return e.id === id && e.type === 'Issue'; })[0];
    if (!hit || (existing && hit.id === existing.id)) fail_('not_found');
    return hit;
  };
  if (p.links !== undefined && p.links !== null) {
    if (!Array.isArray(p.links) || p.links.length > MAX_LINKS) fail_('invalid_input');
    const seen = {};
    return p.links.map(function (l) {
      const issue = issueOf(cleanStr_(l && l.issueId, 64));
      return { issueId: issue.id, resolves: type === 'Maintenance' && !!(l && l.resolves === true) };
    }).filter(function (l) { if (seen[l.issueId]) return false; seen[l.issueId] = true; return true; });
  }
  const single = cleanStr_(p.fields && p.fields.linkedIssueId, 64);
  if (!single || type !== 'Maintenance') return null;
  issueOf(single);
  const keep = (existing ? linkedIssuesOf_(existing, c) : []).filter(function (x) { return x.id !== single; }).map(function (x) { return { issueId: x.id, resolves: x.resolves }; });
  return keep.concat([{ issueId: single, resolves: p.resolveIssue === true }]);
}

/** Make an entry's links exactly `wanted`, and resolve the issues a maintenance entry says it resolved. Returns true if any issue changed to Resolved. */
function saveLinks_(entry, wanted, c, ctx) {
  const now = nowIso_();
  const types = {};
  c.entries.forEach(function (e) { types[e.id] = e.type; });
  types[entry.id] = entry.type;
  const want = {};
  wanted.forEach(function (w) { want[w.issueId] = w; });
  const have = {};
  Db.all('EntryLinks').forEach(function (l) {
    if (isTrue_(l.deleted) || l.car_id !== entry.car_id || !types[l.entry_id] || !types[l.issue_id]) return; // links to deleted entries are left as they are
    const out = l.entry_id === entry.id;
    const back = entry.type === 'Issue' && l.issue_id === entry.id && types[l.entry_id] === 'Issue';
    if (!out && !back) return;
    const other = out ? l.issue_id : l.entry_id;
    const w = want[other];
    if (!w || have[other]) {
      Db.update('EntryLinks', l._row, { deleted: true, updated_at: now, updated_by: ctx.user.id, version: Number(l.version || 1) + 1 });
      return;
    }
    have[other] = true;
    if (isTrue_(l.resolves) !== w.resolves) Db.update('EntryLinks', l._row, { resolves: w.resolves ? 'TRUE' : '', updated_at: now, updated_by: ctx.user.id, version: Number(l.version || 1) + 1 });
  });
  wanted.forEach(function (w) {
    if (!have[w.issueId]) Db.insert('EntryLinks', Object.assign(baseColumns_(ctx), { car_id: entry.car_id, entry_id: entry.id, issue_id: w.issueId, resolves: w.resolves ? 'TRUE' : '' }));
  });
  let resolved = false;
  wanted.filter(function (w) { return w.resolves; }).forEach(function (w) {
    const issue = Db.all('Entries').filter(function (e) { return e.id === w.issueId && !isTrue_(e.deleted); })[0];
    if (!issue || issue.status === 'Resolved') return;
    Db.update('Entries', issue._row, { status: 'Resolved', updated_at: now, updated_by: ctx.user.id, version: Number(issue.version || 1) + 1 });
    audit_(ctx.user, 'issue_status_changed', 'Entry', issue.id, 'Issue "' + issue.title + '": ' + issue.status + ' to Resolved (maintenance "' + entry.title + '")');
    resolved = true;
  });
  return resolved;
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
    const s = summarizeEntry_(e, guestNames, c.groups);
    s.linkedIssueIds = linkedIssuesOf_(e, c).map(function (x) { return x.id; });
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
  const out = { entry: summarizeEntry_(e, guestNames, c.groups), car: { id: car.id, registration: car.registration, distanceUnit: 'mi', currency: car.currency || 'GBP' } };
  out.entry.linkedIssueIds = linkedIssuesOf_(e, c).map(function (x) { return x.id; });
  out.linkedIssues = linkedIssuesOf_(e, c);

  out.attachments = attachments.map(attachmentShape_);

  if (e.task_id) {
    const t = findTask_(e.task_id);
    if (t) out.reminder = { id: t.id, name: t.name };
  }

  if (JOB_TYPES.indexOf(e.type) !== -1) {
    out.parts = c.usage.filter(function (u) { return u.event_id === e.id; })
      .map(function (u) { return describeUsage_(u, c.purchasesById); }).filter(Boolean);
    out.jobCost = jobCost_(e, c.usage, c.purchasesById);
  }
  if (e.type === 'Issue') {
    out.foundWith = foundWithOf_(e, c);
    out.related = relatedToIssue_(e, c); // the maintenance and purchases that link to this issue
    out.fixedBy = out.related.filter(function (x) { return x.type === 'Maintenance'; }).map(function (x) { return { id: x.id, title: x.title, date: x.date, resolves: x.resolves }; });
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
    .map(function (e) { return { id: e.id, ref: e.ref || '', title: e.title, status: e.status, date: e.date }; })
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
    out.cost = parseMoney_(f.cost); // the inspection fee: money spent, so it counts in the car's costs
    // The quoted repair cost: only what a repair would cost, so it never counts. A request that does not mention it leaves it as it was.
    if (f.quoteCost !== undefined) {
      out.quote_cost = parseMoney_(f.quoteCost);
      out.quote_currency = out.quote_cost === '' ? '' : oneOf_(f.quoteCurrency, CURRENCIES, out.currency, 'invalid_currency');
    }
    // Who identified the issue: a user of the app (kept as their id, so their name is always their current one), or free text
    // in `vendor` for someone else or a garage outside the app. A request that does not say leaves it as it was.
    if (f.identifiedBy !== undefined) {
      const by = cleanStr_(f.identifiedBy, 64);
      if (by && !usersById_()[by]) fail_('not_found');
      out.identified_by = by;
      if (by) out.vendor = '';
    }
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

  const wantedLinks = parseLinks_(p, type, existing, c); // null: this request does not change the links
  // a tip asked for while editing is kept with the issue unless the person discarded it
  if (p.aiTip && existing && type === 'Issue') input.ai_tips = tipsWith_(existing, [provenTip_(existing.id, p.aiTip)], 'asked', todayIso_());
  const plan = isJob ? planParts_(p.parts || [], car, input.date, input.currency, existing ? existing.id : '', c) : null;

  // A maintenance entry can be logged against a reminder.
  let linkedTask = null;
  const taskId = cleanStr_(p.taskId, 64);
  if (taskId && type === 'Maintenance') {
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
    // changing a shared amount on one issue takes that issue out of the group: its new amount counts on its own
    const differs = function (k) { return input[k] !== undefined && String(existing[k] === undefined ? '' : existing[k]) !== String(input[k]); };
    if (existing.fee_group && (differs('cost') || (String(existing.cost) !== '' && differs('currency')))) input.fee_group = '';
    if (existing.quote_group && (differs('quote_cost') || differs('quote_currency'))) input.quote_group = '';
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
  if (wantedLinks) {
    const resolved = saveLinks_(row, wantedLinks, c, ctx);
    if (resolved) extras.issueResolved = true;
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

/**
 * Admin only: delete several entries at once (each goes to the recycle bin, like a single delete). One that cannot be deleted
 * (a purchase whose items were used in maintenance, say) is left alone and reported; the rest are still deleted.
 */
function deleteEntries_(p, ctx) {
  const ids = (Array.isArray(p.ids) ? p.ids : []).map(function (x) { return cleanStr_(x, 64); }).filter(Boolean);
  if (!ids.length) fail_('not_found');
  if (ids.length > 100) fail_('too_many');
  const failed = [];
  let deleted = 0;
  ids.forEach(function (id) {
    try {
      deleteEntry_({ id: id }, ctx);
      deleted++;
    } catch (e) {
      if (!(e && e.apiError)) throw e; // a real fault is not hidden
      failed.push({ id: id, error: e.apiError });
    }
  });
  return { deleted: deleted, failed: failed, restorableDays: ENTRY_BIN_DAYS };
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
      return { id: e.id, ref: e.ref || '', type: e.type, title: e.title, date: e.date, vendor: entryVendor_(e),
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
 * labour, other costs and invoice totals on the maintenance date; issue costs and renewals of compliance reminders on their own dates.
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
  const counted = {}; // shared fees already counted
  c.entries.forEach(function (e) {
    if (e.type === 'Purchase') add(e.currency, e.date, 'parts', purchaseSummary_(e, c).total);
    else if (e.type === 'Issue') {
      if (e.fee_group) { if (counted[e.fee_group]) return; counted[e.fee_group] = true; }
      add(e.currency, e.date, 'issues', numOr0_(e.cost)); // the quoted repair cost is never spent money
    }
    else if (e.cost_mode === 'lump') add(e.lump_currency || e.currency, e.date, 'invoices', numOr0_(e.lump_sum_cost));
    else {
      add(e.labour_currency || e.currency, e.date, 'labour', numOr0_(e.labour_cost));
      add(e.other_currency || e.currency, e.date, 'other', numOr0_(e.other_cost));
    }
  });
  // renewals of compliance reminders (MOT, insurance, road tax) count as 'compliance'
  renewalsOfCar_(car.id).forEach(function (r) { add(r.currency, r.date, 'compliance', numOr0_(r.cost)); });
  const list = Object.keys(buckets).sort().map(function (cur) {
    const b = buckets[cur];
    return {
      currency: cur, total: b.total, categories: b.categories,
      years: Object.keys(b.years).sort().reverse().map(function (y) { return b.years[y]; }),
    };
  });
  return { currencies: list };
}
