/**
 * The demo car: one fully filled-in vehicle that the user guide links to, so a reader can try every action on something that is not
 * their own data. An admin creates it once (Diagnostics); everyone can then find it. It is an ordinary car (an admin can delete it).
 * It is built with the app's own save functions, so every part of it (entries, parts, reminders, documents) is real and linked.
 */

const DEMO_REG = 'DEMO 001';

// A tiny valid PDF (a logbook stand-in) and a small picture, so the Documents and Photos sections have something in them.
const DEMO_PDF_B64 = 'JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA0MjAgNTk1XS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFIvRjIgNiAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDI4OT4+CnN0cmVhbQpCVCAvRjIgMjAgVGYgNDAgNTIwIFRkIChERU1PIExPR0JPT0spIFRqIEVUCkJUIC9GMSAxMiBUZiA0MCA0OTAgVGQgKE1hZGUgdXAgZm9yIHRoZSBGbGVldCBNYW5hZ2VyIHVzZXIgZ3VpZGUuKSBUaiBFVApCVCAvRjEgMTIgVGYgNDAgNDYwIFRkIChSZWdpc3RyYXRpb246IERFTU8gMDAxKSBUaiBFVApCVCAvRjEgMTIgVGYgNDAgNDQwIFRkIChNYWtlIGFuZCBtb2RlbDogRXhhbXBsZSBEZW1vIEVzdGF0ZSAyLjAgVERJKSBUaiBFVApCVCAvRjEgMTIgVGYgNDAgNDIwIFRkIChDb2xvdXI6IEJsdWUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PgplbmRvYmoKNiAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2EtQm9sZD4+CmVuZG9iagp4cmVmCjAgNwowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTA1IDAwMDAwIG4gCjAwMDAwMDAyMjYgMDAwMDAgbiAKMDAwMDAwMDU2NCAwMDAwMCBuIAowMDAwMDAwNjI3IDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA3L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNjk1CiUlRU9GCg==';

// A small picture of the demo car (a drawing).
const DEMO_PHOTO_B64 = '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';

function demoDay_(daysAgo) {
  return Utilities.formatDate(new Date(Date.now() - daysAgo * 86400000), TZ, 'yyyy-MM-dd');
}

function findDemoCar_() {
  return Db.all('Cars').filter(function (c) { return !isTrue_(c.deleted) && String(c.registration).toUpperCase() === DEMO_REG; })[0] || null;
}

/** Anyone signed in: where the demo car is (its id), or null if it has not been created yet. */
function getDemoCar_(p, ctx) {
  const car = findDemoCar_();
  return { id: car ? car.id : null };
}

/** Admin: create the demo car if it does not exist yet (safe to repeat: it never makes a second one). */
function createDemoCar_(p, ctx) {
  const existing = findDemoCar_();
  if (existing) return { id: existing.id, created: false };

  const saved = saveCar_({
    fields: {
      registration: DEMO_REG, make: 'Example', model: 'Demo Estate 2.0 TDI', year: '2019', colour: 'Blue',
      vin: 'EXAMPLE0DEMO00001', engineCode: 'DEMO20', gearboxCode: 'DEMO-M6', transmission: 'Manual', fuelType: 'Diesel', fuelCapacity: '55',
      country: 'UK', market: 'UK', driveSide: 'RHD', importDate: '', status: 'Active', odometer: '48250',
      acquisitionDate: '2021-03', acquisitionCost: '9500', acquisitionCurrency: 'GBP', ownerOther: 'Example Garage Ltd',
      catalogues: ['https://partsouq.com/en/catalog/genuine/unit?c=Example', 'https://www.lllparts.co.uk/catalogs/example'],
      notes: 'This is a demo vehicle for the user guide. Everything on it is made up, so feel free to try things out here. An administrator can delete it at any time.',
    },
  }, ctx);
  const carId = saved.car.id;

  // fluids and bulbs, the engine oil and coolant marked as AI suggestions so the note about checking them shows
  const AI = 'AI suggestion (Gemini with Google Search), not verified';
  saveFluids_({ carId: carId, fluids: [
    { kind: 'fluid', fluid: 'Engine oil', specification: '5W-30, ACEA C3, API SN, VW 504 00 / 507 00', capacity: '5.2 L with filter change (4.8 L without)', notes: '', source: AI },
    { kind: 'fluid', fluid: 'Coolant', specification: 'Pink long-life Si-OAT, VW TL 774-J (G12evo), 50/50 with distilled water', capacity: '6.5 L total system', notes: '', source: AI },
    { kind: 'fluid', fluid: 'Brake fluid', specification: 'DOT 4', capacity: '1.0 L for a full flush', notes: '' },
    { kind: 'fluid', fluid: 'Gearbox oil / ATF', specification: 'SAE 75W-80, API GL-4', capacity: '2.0 L', notes: 'Filled for life by the manufacturer' },
    { kind: 'bulb', fluid: 'Dipped beam', specification: 'Halogen H7 55 W', capacity: '2', notes: '' },
    { kind: 'bulb', fluid: 'Full beam', specification: 'Halogen H1 55 W', capacity: '2', notes: '' },
    { kind: 'bulb', fluid: 'Rear brake light', specification: 'P21W 21 W', capacity: '2', notes: '' },
  ] }, ctx);

  // parts bought, then used in a job (so the stock shows as fitted), an issue that the job resolves, and one still open
  const buy = function (title, vendor, daysAgo, items) {
    return saveEntry_({ carId: carId, type: 'Purchase', fields: { title: title, date: demoDay_(daysAgo), vendor: vendor, currency: 'GBP' }, items: items }, ctx).entry;
  };
  const pads = buy('Front brake pads and discs', 'Euro Car Parts', 42, [{ name: 'Front brake pads', partNumber: 'BP1234', quantity: '1', unitCost: '42.50' }, { name: 'Front brake discs (pair)', partNumber: 'BD5678', quantity: '1', unitCost: '68.00' }]);
  buy('Oil and filter kit', 'Euro Car Parts', 120, [{ name: '5W-30 engine oil 5 L', quantity: '1', unitCost: '34.99' }, { name: 'Oil filter', partNumber: 'OF9012', quantity: '1', unitCost: '9.50' }]);
  const itemsOf = function (id) { return getEntry_({ id: id }, ctx).items; };
  const padItems = itemsOf(pads.id);

  const squeak = saveEntry_({ carId: carId, type: 'Issue', fields: { title: 'Squeaking noise when braking', date: demoDay_(55), mileage: '47200', notes: 'Worse when cold, front left.' } }, ctx).entry;
  saveEntry_({ carId: carId, type: 'Issue', fields: { title: 'Offside wing mirror cracked', date: demoDay_(9), mileage: '48100', notes: 'Cracked in a car park. Still usable.' } }, ctx);

  saveEntry_({
    carId: carId, type: 'Maintenance', resolveIssue: true,
    fields: { title: 'Front brakes: pads and discs fitted', date: demoDay_(38), mileage: '47800', vendor: 'Example Garage', currency: 'GBP', costMode: 'itemised', labourCost: '80', labourCurrency: 'GBP', labourNote: '2 hours', linkedIssueId: squeak.id },
    parts: padItems.map(function (i) { return { purchaseId: i.id, quantity: String(i.quantity) }; }),
  }, ctx);
  saveEntry_({
    carId: carId, type: 'Maintenance',
    fields: { title: 'Full service (invoice)', date: demoDay_(118), mileage: '41200', vendor: 'Example Garage', currency: 'GBP', costMode: 'lump', lumpSumCost: '185', lumpCurrency: 'GBP', notes: 'Oil, oil filter, air filter and a general check.' },
  }, ctx);

  // a renewal (an MOT) that keeps a reminder for its expiry date
  saveEntry_({ carId: carId, type: 'Compliance', fields: { title: 'MOT test', date: demoDay_(200), mileage: '43500', vendor: 'Example Garage', currency: 'GBP', cost: '54.85', expiryDate: demoDay_(-165), notes: 'Passed with no advisories.' } }, ctx);

  addStandardTasks_({ carId: carId }, ctx);
  // the demo car's reminders are paused, so it never sends reminder emails to anyone
  Db.all('Tasks').filter(function (t) { return t.car_id === carId && !isTrue_(t.deleted); }).forEach(function (t) {
    Db.update('Tasks', t._row, { active: false, paused_reason: 'Demo car: reminders are off' });
  });

  uploadCarDocument_({ carId: carId, type: 'Logbook', note: 'Demo document', mime: 'application/pdf', data: DEMO_PDF_B64, filename: 'Demo logbook.pdf' }, ctx);
  if (typeof DEMO_PHOTO_B64 === 'string' && DEMO_PHOTO_B64) {
    try { uploadCarPhoto_({ carId: carId, full: DEMO_PHOTO_B64, thumb: DEMO_PHOTO_B64 }, ctx); } catch (e) { /* the car is fine without a photo */ }
  }

  audit_(ctx.user, 'demo_car_created', 'Car', carId, 'Demo car ' + DEMO_REG + ' created for the user guide');
  return { id: carId, created: true };
}
