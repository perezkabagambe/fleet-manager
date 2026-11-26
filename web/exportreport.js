// The PDF for "Export vehicle data": the sections of a car the person ticked, fully expanded, as one document.
// Pure: it takes data that has already been fetched and returns the PDF bytes (see export.js for the fetching).
(function (root) {
  'use strict';

  var ABOUT = 'This is an export of your vehicle\'s data from Fleet Manager by Potentia Motus.';
  var ABOUT_FILES = ' Every document, photo or PDF listed here has been saved in its own folder, named after its unique reference in this document. ' +
    'For example, the file A-0002 is in the folder A-0002.';
  var INTRO = ABOUT + ABOUT_FILES;

  // What can be ticked, as the export options open: everything but AI tips and what the car cost to buy.
  var DEFAULTS = {
    vehicle: true, buyCost: false, odometer: true, reminders: true, fluids: true, carFiles: true,
    issues: true, maintenance: true, purchases: true, entryFiles: true, aiTips: false, costs: true,
  };
  var TYPE_TICK = { Issue: 'issues', Maintenance: 'maintenance', Purchase: 'purchases' };
  // each cost category belongs to something that can be ticked: running totals only add up what is in the export
  var COST_TICK = { parts: 'purchases', labour: 'maintenance', other: 'maintenance', invoices: 'maintenance', issues: 'issues', compliance: 'reminders' };
  var COST_SOURCES = [['issues', 'Issues'], ['maintenance', 'Maintenance'], ['purchases', 'Purchased items'], ['reminders', 'reminder renewals']];

  function ticks(chosen) { return Object.assign({}, DEFAULTS, chosen || {}); }
  function anyEntries(inc) { return inc.issues || inc.maintenance || inc.purchases; }
  function wantsType(inc, type) { return !TYPE_TICK[type] || !!inc[TYPE_TICK[type]]; }
  /** What will really be in the export: { content (anything at all), entryFiles, aiTips, files (a zip rather than just the PDF) }. */
  function effective(chosen) {
    var inc = ticks(chosen);
    var entryFiles = inc.entryFiles && anyEntries(inc);
    return {
      content: !!(inc.vehicle || inc.buyCost || inc.odometer || inc.reminders || inc.fluids || inc.carFiles || inc.costs || anyEntries(inc)),
      entryFiles: !!entryFiles, aiTips: !!(inc.aiTips && inc.issues), files: !!(inc.carFiles || entryFiles),
    };
  }

  function list(words) { return words.length > 1 ? words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1] : words[0] || ''; }

  /** What the running totals will add up: { all, none, covers, leftOut } (the last two in words). */
  function totalsCover(chosen) {
    var inc = ticks(chosen);
    var of = function (on) { return list(COST_SOURCES.filter(function (s) { return !!inc[s[0]] === on; }).map(function (s) { return s[1]; })); };
    var covers = of(true);
    var leftOut = of(false);
    return { all: !leftOut, none: !covers, covers: covers, leftOut: leftOut.charAt(0).toUpperCase() + leftOut.slice(1) };
  }

  /** The car's costs with only the categories of what is in the export, added up again. */
  function filterCosts(costs, chosen) {
    var inc = ticks(chosen);
    var round = function (n) { return Math.round(n * 100) / 100; };
    function pick(categories) {
      var out = { categories: {}, total: 0 };
      Object.keys(categories || {}).forEach(function (k) {
        if (COST_TICK[k] && !inc[COST_TICK[k]]) return;
        out.categories[k] = categories[k];
        out.total = round(out.total + Number(categories[k] || 0));
      });
      return out;
    }
    var currencies = ((costs && costs.currencies) || []).map(function (b) {
      var years = (b.years || []).map(function (y) { return Object.assign({ year: y.year }, pick(y.categories)); }).filter(function (y) { return Object.keys(y.categories).length; });
      return Object.assign({ currency: b.currency, years: years }, pick(b.categories));
    }).filter(function (b) { return Object.keys(b.categories).length; });
    return { currencies: currencies };
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function money(n, currency) {
    if (n === null || n === undefined || n === '') return '';
    try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP' }).format(n); } catch (e) { return (currency || '') + ' ' + n; }
  }
  function num(n) { return n === null || n === undefined ? '' : Number(n).toLocaleString('en-GB'); }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function day(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
  }
  function precise(s) { // YYYY, YYYY-MM or YYYY-MM-DD, shown at the precision that is known
    if (!s) return '';
    var p = String(s).split('-');
    if (p.length === 1) return p[0];
    if (p.length === 2) return MONTHS[Number(p[1]) - 1] + ' ' + p[0];
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
  }
  function moneyList(obj) { // { GBP: 12.5, UGX: 4000 } -> "£12.50, UGX 4,000"
    return Object.keys(obj || {}).map(function (c) { return money(obj[c], c); }).join(', ');
  }
  function kind(mime) { return mime === 'image/jpeg' ? 'Photo' : mime === 'application/pdf' ? 'PDF' : 'File'; }

  /**
   * input: { car, people, fluids, entries, details, tasks, costs, documents, carPhoto (JPEG bytes or null),
   *          thumbs ({ attachmentId: JPEG bytes }), missing ({ id: true } for files that could not be saved),
   *          exportedBy, exportedAt (Date), include (what was ticked: see DEFAULTS) }
   */
  function build(input) {
    var car = input.car;
    var title = car.make + ' ' + car.model + (car.year ? ' (' + car.year + ')' : '');
    var exportedAt = input.exportedAt || new Date();
    var missing = input.missing || {};
    var inc = ticks(input.include);
    var has = effective(inc);
    var doc = PdfKit.create({ footer: 'Fleet Manager by Potentia Motus  ·  ' + car.registration + '  ·  exported ' + day(exportedAt.toISOString()) });

    // ----- the top of the document -----
    doc.text('FLEET MANAGER BY POTENTIA MOTUS', { size: 9, bold: true, color: [0.35, 0.4, 0.45], after: 4 });
    doc.text('Vehicle data export', { size: 22, bold: true, color: [0.06, 0.24, 0.37], after: 2 });
    doc.text(car.registration + '  ·  ' + title, { size: 13, bold: true, after: 8 });
    doc.text(has.files ? INTRO : ABOUT, { size: 10.5, after: 6 });
    doc.text('Exported on ' + day(exportedAt.toISOString()) + (input.exportedBy ? ' by ' + input.exportedBy : '') + '.', { size: 9.5, color: [0.35, 0.4, 0.45], after: 8 });
    if (inc.vehicle && input.carPhoto) doc.image(input.carPhoto, { maxWidth: 300, maxHeight: 200 });

    // ----- vehicle details -----
    var boughtFor = ['Acquisition cost', car.acquisitionCost === null || car.acquisitionCost === undefined ? 'Not recorded' : money(car.acquisitionCost, car.acquisitionCurrency || car.currency)];
    if (inc.vehicle) {
      doc.heading('Vehicle details', 1);
      var owners = (input.people && input.people.owners || []).map(function (o) { return o.name; }).concat(car.ownerOther ? [car.ownerOther] : []);
      var rows = [
        ['Registration', car.registration], ['Make and model', title], ['Status', car.status], ['Colour', car.colour], ['VIN / chassis', car.vin],
        ['Engine code', car.engineCode], ['Transmission', car.transmission], ['Fuel type', car.fuelType], ['Gearbox code', car.gearboxCode], ['Location', car.country === 'UG' ? 'Uganda' : 'United Kingdom'],
        ['Market', car.market], ['Drive', car.driveSide === 'LHD' ? 'Left-hand drive (LHD)' : car.driveSide === 'RHD' ? 'Right-hand drive (RHD)' : ''],
        ['Engine size', car.engineSize === null || car.engineSize === undefined ? '' : car.engineSize + ' litres'],
        ['Fuel capacity', car.fuelCapacity === null || car.fuelCapacity === undefined ? '' : car.fuelCapacity + ' litres'],
        ['Imported', precise(car.importDate)], ['Acquired', precise(car.acquisitionDate)],
        inc.buyCost ? boughtFor : ['', ''],
        ['Owner / custodian', owners.length ? owners.join(', ') : 'Not recorded'],
        ['Default currency', car.currency], ['Parts catalogues', (car.catalogues && car.catalogues.length ? car.catalogues.map(function (c) { return c.url; }) : [car.partsouqUrl]).filter(Boolean).join(', ')],
        ['Guest access (QR code)', car.guestEnabled ? 'On' : 'Off'], ['Notes', car.notes],
      ];
      rows.forEach(function (r) { if (r[1]) doc.kv(r[0], r[1], { labelWidth: 130 }); });
    } else if (inc.buyCost) {
      doc.heading('What the car cost to buy', 1);
      doc.kv(boughtFor[0], boughtFor[1], { labelWidth: 130 });
    }

    if (inc.odometer) {
      // ----- odometer log -----
      doc.heading('Odometer Log', 1);
      doc.kv('Current reading', car.odometer === null || car.odometer === undefined ? 'Not set' : num(car.odometer) + ' mi', { labelWidth: 130 });
      if (car.odometerUpdatedAt) doc.kv('Last updated', day(car.odometerUpdatedAt), { labelWidth: 130 });
    }

    if (anyEntries(inc)) {
      // ----- maintenance and issues -----
      var entries = (input.entries || []).filter(function (e) { return wantsType(inc, e.type); });
      doc.heading('Maintenance & Issues Log', 1);
      doc.text(entries.length ? entries.length + (entries.length === 1 ? ' entry' : ' entries') + ', newest first.' : 'No entries.', { size: 10, color: [0.35, 0.4, 0.45], after: 4 });
      entries.forEach(function (summary, i) {
        doc.keepTogether(function () {
          if (i > 0 && !doc.atTop()) { doc.spacer(8); doc.rule(); doc.spacer(4); } // a line and some space between entries (not at the top of a page)
          entryBlock(doc, summary, (input.details || {})[summary.id], input, inc);
        });
      });
    }

    if (inc.reminders) {
      // ----- reminders -----
      doc.heading('Reminders', 1);
      var tasks = input.tasks || [];
      if (!tasks.length) doc.text('No reminders.', { size: 10, color: [0.35, 0.4, 0.45] });
      tasks.forEach(function (t) {
        doc.need(70);
        doc.text(t.name + (t.kind === 'compliance' ? '  (compliance)' : ''), { bold: true, size: 10.5, after: 1 });
        doc.kv('Status', t.active ? (t.text || t.status) : (t.pausedReason || 'Paused'), { indent: 8, labelWidth: 105 });
        if (t.repeatText) doc.kv('Repeats every', t.repeatText, { indent: 8, labelWidth: 105 });
        if (t.lastDoneDate) doc.kv('Last done', day(t.lastDoneDate) + (t.lastDoneDistance !== null && t.lastDoneDistance !== undefined ? ' at ' + num(t.lastDoneDistance) + ' mi' : ''), { indent: 8, labelWidth: 105 });
        if (t.dueDate) doc.kv('Next due date', day(t.dueDate), { indent: 8, labelWidth: 105 });
        if (t.dueDistance !== null && t.dueDistance !== undefined) doc.kv('Next due at', num(t.dueDistance) + ' mi', { indent: 8, labelWidth: 105 });
        doc.spacer(3);
      });
    }

    if (inc.fluids) {
      // ----- fluids, bulbs and specifications -----
      doc.heading('Fluids, Bulbs & Specifications', 1);
      var fluids = (input.fluids || []).filter(function (f) { return f.kind !== 'bulb'; });
      var bulbs = (input.fluids || []).filter(function (f) { return f.kind === 'bulb'; });
      function specList(list, heading, capLabel) {
        doc.heading(heading, 2);
        if (!list.length) { doc.text('None recorded.', { size: 10, color: [0.35, 0.4, 0.45] }); return; }
        list.forEach(function (f) {
          doc.text(f.fluid, { bold: true, size: 10.5, after: 1 });
          if (f.specification) doc.kv('Specification', f.specification, { indent: 8, labelWidth: 95 });
          if (f.capacity) doc.kv(capLabel, f.capacity, { indent: 8, labelWidth: 95 });
          if (f.notes) doc.kv('Notes', f.notes, { indent: 8, labelWidth: 95 });
          doc.spacer(2);
        });
      }
      specList(fluids, 'Fluids', 'Capacity');
      specList(bulbs, 'Bulbs', 'How many');
    }

    if (inc.carFiles) {
      // ----- documents -----
      doc.heading('Documents', 1);
      var docs = input.documents || [];
      if (!docs.length) doc.text('No documents.', { size: 10, color: [0.35, 0.4, 0.45] });
      docs.forEach(function (d) {
        doc.need(70);
        doc.text((d.ref ? d.ref + '   ' : '') + d.type, { bold: true, size: 10.5, after: 1, mono: false });
        doc.kv('File', d.filename + '  ·  ' + kind(d.mime) + '  ·  ' + kb(d.size) + (d.createdAt ? '  ·  added ' + day(d.createdAt) : ''), { indent: 8, labelWidth: 70 });
        if (d.note) doc.kv('Note', d.note, { indent: 8, labelWidth: 70 });
        if (d.ref) doc.kv('Saved in', missing[d.id] ? 'Not included: the file could not be downloaded' : 'Folder ' + d.ref, { indent: 8, labelWidth: 70 });
        doc.spacer(3);
      });
    }

    // ----- costs -----
    if (inc.costs) {
      doc.heading('Costs', 1);
      var cover = totalsCover(inc);
      var currencies = filterCosts(input.costs, inc).currencies;
      if (!currencies.length) doc.text(cover.all ? 'No costs recorded.' : 'No costs recorded for what is in this export.', { size: 10, color: [0.35, 0.4, 0.45] });
      currencies.forEach(function (b) {
        doc.text('Spent in ' + b.currency + ': ' + money(b.total, b.currency), { bold: true, size: 11, after: 2 });
        Object.keys(b.categories).forEach(function (c) { doc.kv(c.charAt(0).toUpperCase() + c.slice(1), money(b.categories[c], b.currency), { indent: 8, labelWidth: 95 }); });
        if (b.years && b.years.length) {
          doc.text('By year', { bold: true, size: 10, after: 1, indent: 8 });
          b.years.forEach(function (y) {
            doc.kv(y.year, money(y.total, b.currency) + '  (' + Object.keys(y.categories).map(function (c) { return c + ' ' + money(y.categories[c], b.currency); }).join(', ') + ')', { indent: 16, labelWidth: 50 });
          });
        }
        doc.spacer(4);
      });
      if (!cover.all) doc.text(cover.none ? 'There are no totals: no entry types or reminders are in this export.' : 'These totals cover only ' + cover.covers + '. Not included: ' + cover.leftOut + '.', { size: 10, bold: true, after: 3 });
      doc.text('Each cost is counted once, when the money was spent.', { size: 9, color: [0.4, 0.4, 0.4] });
    }

    if (inc.vehicle) {
      doc.spacer(8);
      doc.text('Car details last changed ' + day(car.updatedAt) + '.', { size: 9, color: [0.4, 0.4, 0.4] });
    }
    return doc.finish({ title: 'Vehicle data export - ' + car.registration, date: exportedAt });
  }

  // each type of entry has its own soft tint and a darker accent (the type is also written out in capitals)
  var TYPE_STYLE = {
    Maintenance: { tint: [0.90, 0.96, 0.92], accent: [0.10, 0.50, 0.29] },
    Issue: { tint: [0.98, 0.91, 0.90], accent: [0.70, 0.15, 0.12] },
    Purchase: { tint: [1.00, 0.96, 0.84], accent: [0.52, 0.36, 0.00] },
  };

  /** One entry. With running costs unticked no amount is printed; lines about things left out of the export are left out too. */
  function entryBlock(doc, summary, d, input, inc) {
    var e = d ? d.entry : summary;
    var missing = input.missing || {};
    var costs = inc.costs;
    doc.need(90); // a heading never sits alone at the bottom of a page
    var style = TYPE_STYLE[e.type] || TYPE_STYLE.Maintenance;
    doc.banner({ text: (e.ref ? e.ref + '   ' : '') + e.title, label: e.type, tint: style.tint, accent: style.accent });
    var kv = function (label, value) { if (value !== '' && value !== null && value !== undefined) doc.kv(label, value, { indent: 8, labelWidth: 105 }); };
    var given = function (v) { return v !== null && v !== undefined; };
    var used = (d && d.usedIn || []).filter(function (u) { return wantsType(inc, u.type || 'Maintenance'); });
    kv('Date', day(e.date));
    kv('Mileage', e.mileage === null || e.mileage === undefined ? '' : num(e.mileage) + ' mi');
    kv('Vendor', e.vendor);
    if (e.guestName) kv('Added by', 'Guest: ' + e.guestName);

    if (e.type === 'Issue') {
      kv('Status', e.status);
      var shared = function (text, is) { return is && text ? '(' + text + ') shared' : text; };
      if (costs) {
        kv('Inspection fee', e.cost ? shared(money(e.cost, e.currency), e.feeShared) : '');
        kv('Quoted repair', e.quoteCost ? shared(money(e.quoteCost, e.quoteCurrency), e.quoteShared) : '');
      }
      if (inc.maintenance && d && d.fixedBy && d.fixedBy.length) kv('Fixed by', d.fixedBy.map(function (f) { return f.title + ' (' + day(f.date) + ')'; }).join('; '));
    } else if (e.type === 'Purchase') {
      if (d && d.items && d.items.length) {
        // every item of the purchase on its own line, with what has been used
        d.items.forEach(function (i, n) {
          var price = costs ? i.quantity + ' x ' + money(i.unitCost, e.currency) + ' = ' + money(i.lineTotal, e.currency) : 'quantity ' + i.quantity;
          kv(d.items.length > 1 ? 'Item ' + (n + 1) : 'Item', i.name + (i.partNumber ? ' [' + i.partNumber + ']' : '') + '  ·  ' + price + '  ·  used ' + i.used + ', ' + i.remaining + ' left');
        });
      } else {
        kv('Part number', e.partNumber);
        kv('Quantity', e.quantity === null || e.quantity === undefined ? '' : String(e.quantity));
        if (costs) {
          kv('Unit cost', given(e.unitCost) ? money(e.unitCost, e.currency) : '');
          kv('Shipping', e.shippingCost ? money(e.shippingCost, e.currency) : '');
        }
      }
      if (d && d.stock) {
        if (costs) kv('Total', money(d.stock.total, e.currency));
        kv('Stock', d.stock.status + ' (used ' + d.stock.used + ', ' + d.stock.remaining + ' left)');
      }
      kv('Item link', e.productUrl);
      if (used.length) kv('Used in', used.map(function (u) { return u.title + ' x ' + u.quantity + (u.item ? ' (' + u.item + ')' : ''); }).join('; '));
    } else { // Maintenance
      if (e.costMode === 'lump') {
        if (costs) kv('Invoice total', given(e.lumpSumCost) ? money(e.lumpSumCost, e.lumpCurrency) : '');
      } else {
        var work = [e.labourNote ? '(' + e.labourNote + ')' : '', e.labourHours ? e.labourHours + ' h' : ''].filter(Boolean).join(', ');
        kv('Labour', costs ? (e.labourCost ? money(e.labourCost, e.labourCurrency) + (e.labourNote ? ' (' + e.labourNote + ')' : '') + (e.labourHours ? ', ' + e.labourHours + ' h' : '') : '') : work);
        kv('Other costs', costs ? (e.otherCost ? money(e.otherCost, e.otherCurrency) + (e.otherNote ? ' (' + e.otherNote + ')' : '') : '') : '');
        if (!costs) kv('Other work', e.otherNote);
        if (d && d.parts && d.parts.length) {
          kv('Parts used', d.parts.map(function (p) { return p.name + (p.partNumber ? ' [' + p.partNumber + ']' : '') + ' x ' + p.quantity + (costs ? ' = ' + money(p.cost, p.currency) : ''); }).join('; '));
        }
      }
      if (costs && d && d.jobCost && Object.keys(d.jobCost).length) kv('Total job cost', moneyList(d.jobCost));
      if (inc.reminders && d && d.reminder) kv('Reminder', d.reminder.name);
    }
    if (inc.issues && d && d.linkedIssues && d.linkedIssues.length) {
      kv('Related issues', d.linkedIssues.map(function (i) { return (i.ref ? i.ref + ' ' : '') + i.title + (i.resolves ? ' (resolved by this)' : ''); }).join('; '));
    }
    if (inc.issues && d && d.foundWith && d.foundWith.length) {
      kv('Found at the same time', d.foundWith.map(function (g) {
        return 'Report of ' + day(g.date) + ': ' + g.issues.map(function (i) { return (i.ref ? i.ref + ' ' : '') + i.title; }).join(', ');
      }).join('; ') + ' (the faults are not necessarily related)');
    }
    kv('Notes', e.notes);
    if (inc.aiTips && e.type === 'Issue') {
      (e.aiTips || []).forEach(function (t) { kv('AI tip', t.text + ' (AI\'s own advice, not from a report or garage. It can be wrong.)'); });
    }

    var files = (inc.entryFiles && d && d.attachments) || [];
    if (files.length) {
      var hasPics = files.some(function (a) { return input.thumbs && input.thumbs[a.id]; });
      doc.need(26 + files.length * 14 + (hasPics ? 110 : 0)); // the file list and its pictures stay together
      doc.text('Files (' + files.length + ')', { bold: true, size: 10, after: 1, indent: 8 });
      files.forEach(function (a) {
        var note = missing[a.id] ? '  ·  NOT INCLUDED: could not be downloaded' : '  ·  folder ' + (a.ref || '');
        doc.text((a.ref || '') + '   ' + a.filename + '  ·  ' + kind(a.mime) + '  ·  ' + kb(a.size) + note, { size: 9.5, indent: 16, after: 1 });
      });
      var pics = files.filter(function (a) { return input.thumbs && input.thumbs[a.id]; }).map(function (a) { return { bytes: input.thumbs[a.id], caption: a.ref || '' }; });
      if (pics.length) { doc.spacer(2); doc.pictures(pics, { indent: 16, size: 84 }); }
    }
    doc.spacer(4);
  }

  root.ExportReport = { build: build, INTRO: INTRO, ABOUT: ABOUT, DEFAULTS: DEFAULTS, ticks: ticks, effective: effective, wantsType: wantsType, totalsCover: totalsCover, filterCosts: filterCosts };
})(typeof window !== 'undefined' ? window : globalThis);
