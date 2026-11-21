// The PDF for "Export all vehicle data": every section of a car, fully expanded, as one document.
// Pure: it takes data that has already been fetched and returns the PDF bytes (see export.js for the fetching).
(function (root) {
  'use strict';

  var INTRO = 'This is an export of all your vehicle\'s data from Fleet Manager by Potentia Motus. ' +
    'Every document, photo or PDF listed here has been saved in its own folder, named after its unique reference in this document. ' +
    'For example, the file A-0002 is in the folder A-0002.';

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
   *          exportedBy, exportedAt (Date) }
   */
  function build(input) {
    var car = input.car;
    var title = car.make + ' ' + car.model + (car.year ? ' (' + car.year + ')' : '');
    var exportedAt = input.exportedAt || new Date();
    var missing = input.missing || {};
    var doc = PdfKit.create({ footer: 'Fleet Manager by Potentia Motus  ·  ' + car.registration + '  ·  exported ' + day(exportedAt.toISOString()) });

    // ----- the top of the document -----
    doc.text('FLEET MANAGER BY POTENTIA MOTUS', { size: 9, bold: true, color: [0.35, 0.4, 0.45], after: 4 });
    doc.text('Vehicle data export', { size: 22, bold: true, color: [0.06, 0.24, 0.37], after: 2 });
    doc.text(car.registration + '  ·  ' + title, { size: 13, bold: true, after: 8 });
    doc.text(INTRO, { size: 10.5, after: 6 });
    doc.text('Exported on ' + day(exportedAt.toISOString()) + (input.exportedBy ? ' by ' + input.exportedBy : '') + '.', { size: 9.5, color: [0.35, 0.4, 0.45], after: 8 });
    if (input.carPhoto) doc.image(input.carPhoto, { maxWidth: 300, maxHeight: 200 });

    // ----- vehicle details -----
    doc.heading('Vehicle details', 1);
    var owners = (input.people && input.people.owners || []).map(function (o) { return o.name; }).concat(car.ownerOther ? [car.ownerOther] : []);
    var rows = [
      ['Registration', car.registration], ['Make and model', title], ['Status', car.status], ['Colour', car.colour], ['VIN / chassis', car.vin],
      ['Engine code', car.engineCode], ['Gearbox code', car.gearboxCode], ['Location', car.country === 'UG' ? 'Uganda' : 'United Kingdom'],
      ['Market', car.market], ['Drive', car.driveSide === 'LHD' ? 'Left-hand drive (LHD)' : car.driveSide === 'RHD' ? 'Right-hand drive (RHD)' : ''],
      ['Fuel capacity', car.fuelCapacity === null || car.fuelCapacity === undefined ? '' : car.fuelCapacity + ' litres'],
      ['Imported', precise(car.importDate)], ['Acquired', precise(car.acquisitionDate)],
      ['Acquisition cost', car.acquisitionCost === null || car.acquisitionCost === undefined ? 'Not recorded' : money(car.acquisitionCost, car.acquisitionCurrency || car.currency)],
      ['Owner / custodian', owners.length ? owners.join(', ') : 'Not recorded'],
      ['Default currency', car.currency], ['Parts catalogue', car.partsouqUrl],
      ['Guest access (QR code)', car.guestEnabled ? 'On' : 'Off'], ['Notes', car.notes],
    ];
    rows.forEach(function (r) { if (r[1]) doc.kv(r[0], r[1], { labelWidth: 130 }); });

    // ----- odometer log -----
    doc.heading('Odometer Log', 1);
    doc.kv('Current reading', car.odometer === null || car.odometer === undefined ? 'Not set' : num(car.odometer) + ' mi', { labelWidth: 130 });
    if (car.odometerUpdatedAt) doc.kv('Last updated', day(car.odometerUpdatedAt), { labelWidth: 130 });

    // ----- maintenance and issues -----
    var entries = input.entries || [];
    doc.heading('Maintenance & Issues Log', 1);
    doc.text(entries.length ? entries.length + (entries.length === 1 ? ' entry' : ' entries') + ', newest first.' : 'No entries.', { size: 10, color: [0.35, 0.4, 0.45], after: 4 });
    entries.forEach(function (summary) { entryBlock(doc, summary, (input.details || {})[summary.id], input); });

    // ----- reminders -----
    doc.heading('Reminders', 1);
    var tasks = input.tasks || [];
    if (!tasks.length) doc.text('No reminders.', { size: 10, color: [0.35, 0.4, 0.45] });
    tasks.forEach(function (t) {
      doc.need(70);
      doc.text(t.name + (t.kind === 'compliance' ? '  (renewal)' : ''), { bold: true, size: 10.5, after: 1 });
      doc.kv('Status', t.active ? (t.text || t.status) : (t.pausedReason || 'Paused'), { indent: 8, labelWidth: 105 });
      if (t.repeatText) doc.kv('Repeats every', t.repeatText, { indent: 8, labelWidth: 105 });
      if (t.lastDoneDate) doc.kv('Last done', day(t.lastDoneDate) + (t.lastDoneDistance !== null && t.lastDoneDistance !== undefined ? ' at ' + num(t.lastDoneDistance) + ' mi' : ''), { indent: 8, labelWidth: 105 });
      if (t.dueDate) doc.kv('Next due date', day(t.dueDate), { indent: 8, labelWidth: 105 });
      if (t.dueDistance !== null && t.dueDistance !== undefined) doc.kv('Next due at', num(t.dueDistance) + ' mi', { indent: 8, labelWidth: 105 });
      doc.spacer(3);
    });

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

    // ----- costs -----
    doc.heading('Costs', 1);
    var currencies = (input.costs && input.costs.currencies) || [];
    if (!currencies.length) doc.text('No costs recorded.', { size: 10, color: [0.35, 0.4, 0.45] });
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
    doc.text('Each cost is counted once, when the money was spent.', { size: 9, color: [0.4, 0.4, 0.4] });

    doc.spacer(8);
    doc.text('Car details last changed ' + day(car.updatedAt) + '.', { size: 9, color: [0.4, 0.4, 0.4] });
    return doc.finish({ title: 'Vehicle data export - ' + car.registration, date: exportedAt });
  }

  function entryBlock(doc, summary, d, input) {
    var e = d ? d.entry : summary;
    var missing = input.missing || {};
    doc.need(90); // a heading never sits alone at the bottom of a page
    doc.spacer(4);
    doc.text((e.ref ? e.ref + '  ·  ' : '') + e.title, { bold: true, size: 11.5, after: 1 });
    var kv = function (label, value) { if (value !== '' && value !== null && value !== undefined) doc.kv(label, value, { indent: 8, labelWidth: 105 }); };
    kv('Type', e.type);
    kv('Date', day(e.date));
    kv('Mileage', e.mileage === null || e.mileage === undefined ? '' : num(e.mileage) + ' mi');
    kv('Vendor', e.vendor);
    if (e.guestName) kv('Added by', 'Guest: ' + e.guestName);

    if (e.type === 'Issue') {
      kv('Status', e.status);
      kv('Cost', e.cost ? money(e.cost, e.currency) : '');
      if (d && d.fixedBy && d.fixedBy.length) kv('Fixed by', d.fixedBy.map(function (f) { return f.title + ' (' + day(f.date) + ')'; }).join('; '));
    } else if (e.type === 'Compliance') {
      kv('Cost', e.cost ? money(e.cost, e.currency) : '');
      kv('Expires', day(e.expiryDate));
    } else if (e.type === 'Purchase') {
      if (d && d.items && d.items.length) {
        // every item of the purchase on its own line, with what has been used
        d.items.forEach(function (i, n) {
          kv(d.items.length > 1 ? 'Item ' + (n + 1) : 'Item', i.name + (i.partNumber ? ' [' + i.partNumber + ']' : '') + '  ·  ' + i.quantity + ' x ' + money(i.unitCost, e.currency) + ' = ' + money(i.lineTotal, e.currency) + '  ·  used ' + i.used + ', ' + i.remaining + ' left');
        });
      } else {
        kv('Part number', e.partNumber);
        kv('Quantity', e.quantity === null || e.quantity === undefined ? '' : String(e.quantity));
        kv('Unit cost', e.unitCost === null || e.unitCost === undefined ? '' : money(e.unitCost, e.currency));
        kv('Shipping', e.shippingCost ? money(e.shippingCost, e.currency) : '');
      }
      if (d && d.stock) {
        kv('Total', money(d.stock.total, e.currency));
        kv('Stock', d.stock.status + ' (used ' + d.stock.used + ', ' + d.stock.remaining + ' left)');
      }
      kv('Item link', e.productUrl);
      if (d && d.usedIn && d.usedIn.length) kv('Used in', d.usedIn.map(function (u) { return u.title + ' x ' + u.quantity + (u.item ? ' (' + u.item + ')' : ''); }).join('; '));
    } else { // Maintenance
      if (e.costMode === 'lump') {
        kv('Invoice total', e.lumpSumCost === null || e.lumpSumCost === undefined ? '' : money(e.lumpSumCost, e.lumpCurrency));
      } else {
        kv('Labour', e.labourCost ? money(e.labourCost, e.labourCurrency) + (e.labourNote ? ' (' + e.labourNote + ')' : '') + (e.labourHours ? ', ' + e.labourHours + ' h' : '') : '');
        kv('Other costs', e.otherCost ? money(e.otherCost, e.otherCurrency) + (e.otherNote ? ' (' + e.otherNote + ')' : '') : '');
        if (d && d.parts && d.parts.length) {
          kv('Parts used', d.parts.map(function (p) { return p.name + (p.partNumber ? ' [' + p.partNumber + ']' : '') + ' x ' + p.quantity + ' = ' + money(p.cost, p.currency); }).join('; '));
        }
      }
      if (d && d.jobCost && Object.keys(d.jobCost).length) kv('Total job cost', moneyList(d.jobCost));
      if (d && d.linkedIssue) kv('Fixes issue', d.linkedIssue.title);
      if (d && d.reminder) kv('Reminder', d.reminder.name);
    }
    kv('Notes', e.notes);

    var files = (d && d.attachments) || [];
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

  root.ExportReport = { build: build, INTRO: INTRO };
})(typeof window !== 'undefined' ? window : globalThis);
