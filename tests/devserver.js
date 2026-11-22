'use strict';
// Local end-to-end test server: serves web/ and answers POST /api with the REAL backend code
// (running against in-memory stand-ins for Sheets, Drive and Mail). Nothing here touches Google.
//   node tests/devserver.js        then open http://localhost:8124/
// /__as/admin or /__as/sam switches who you are signed in as.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createEnv } = require('./harness');

const PORT = 8124;
const WEB = path.join(__dirname, '..', 'web');
const env = createEnv();
let kept = null;

env.seedUser({ name: 'Perez Kabagambe', email: 'perez@example.com', role: 'admin' });
env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
const tokens = { admin: env.signInAs('perez@example.com'), sam: env.signInAs('sam@example.com') };
let persona = 'admin';

// A pretend Gemini, so the receipt Inbox can be tried locally. A file whose name contains "invoice" reads as a garage invoice.
env.props.GEMINI_API_KEY = 'local-test';
const FILL = {
  details: { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Black', engineCode: 'D4HB', gearboxCode: '', market: 'European', driveSide: 'RHD', fuelCapacity: '71' },
  fluids: [{ fluid: 'Engine oil', specification: '5W-30 ACEA C3', capacity: '6.7 L', notes: '' }, { fluid: 'Brake fluid', specification: 'DOT 4', capacity: '', notes: '' }, { fluid: 'Coolant', specification: 'Long-life 50/50', capacity: '', notes: '' }],
  bulbs: [{ location: 'Dipped beam', type: 'Xenon D3S 35 W', quantity: '2', notes: 'Halogen versions use H7' }, { location: 'Full beam', type: 'Halogen H1 55 W', quantity: '2', notes: '' }],
  summary: 'A 2013 Kia Sorento 2.2 CRDi (local test answer).', confidence: 'medium',
};
const MATCHES = { candidates: [
  { label: '2013 Kia Sorento 2.2 CRDi (D4HB), European', why: 'The common diesel', confidence: 'medium', details: FILL.details },
  { label: '2013 Kia Sorento 2.4 petrol (G4KE), European', why: 'The petrol version', confidence: 'low', details: { make: 'Kia', model: 'Sorento', year: '2013', engineCode: 'G4KE', market: 'European', driveSide: 'RHD' } },
] };
const LOGBOOK = { isLogbook: true, registration: 'LB06 XYZ', vin: 'WBAVB11060PK12345', make: 'BMW', model: '325i SE', colour: 'SILVER', dateFirstRegistered: '2006-03-01', engineCapacityCc: '2497', fuelType: 'Petrol hybrid', fuelTypeAsPrinted: 'HYBRID ELECTRIC', transmission: 'CVT', acquisitionDate: '2025-05-25', bodyType: 'SALOON', confidence: 'high' };
// Other websites (the parts catalogue icon): the catalogue site refuses servers, so the icon comes from Google's copy, as it does for real.
const LLL_ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAmVBMVEVHcEyTpsoTSps6cq0iNVpDg8AlNHoWLm+vw90iLmpEcqAiMHJEg8ATRYobK2QXLV5NeZ4VSZgRRY1Lg7wgKmZGfrcXS5dSZXkURZBDf7lMgrdDerTc6PgZUaQpOYZKishIi8v+//8oOYMYUqhFhsUfMHs8gcMpOYkUTqABQJYUS50PInS70OTU4u5deKzz/P2Lk6k+SHhtmL83gev6AAAAHXRSTlMA/sJFHsL9Sv25LdjlZ2kzHeqJgo9v1QuvlVeoUfXgWBQAAAOQSURBVFiF7Zdrd6IwEIbVIqBUrVov1QZyARIQsbv//8dtgiAzY+3u2f2wX/pSezgc83aeTJiZDgbf6vW++7f1YTgMsN6rNXmye6ICBvvTKfMzoMmxKI0xpSntj3G/9+uUaAwMMh1baXfp5mZRMqbYTYqpxTNPkFIQwcKPobT0F4ZhldM0IQYggFeJDGL5uiLr1X5NAkgggU/Wy2BJDFhACZLDQ4JYZtM/INg9JtCTFdzBhmBDAuCIgBjEnxGQAPgGEkiN1meewQGw8iVNcAiIQIMI3O1kxhR2GB1IACgHEf77sQy2ZL2ZjUkACSDwpIxBCNoRkD10BCQHL73BHC53h3kyU9hAbQ/0EDxDAmggtdTzEWPYwRLgFCRrQODjLdC+VyIDxYyX8qTfBJ5wRCCtoEEUKPImbp/oIXhI4CDme7wFis2OCUkCINj5tpZAD0tgigI6OII8T3sLnk4BwSms6gxsQxSY+lz1Dootp0lenUOQSUgwOZ3FR4YITC1EARBWbzw/iyrvDd6AQUYMHEEtLgUiSLABJAgkMYgWhhhYAmKACDQ2kPMVIwaWABtwRBBjA99bEoPSeyYRIIKYIFgChQ2WLymJABLYatgYtGnUzTlGBmrp3kRkkAODgX/dA0kQQBqNReAPEWw1ghHYE/m6uiKoRu5MrzZNBGG/iUfIIE+VqE6dMh15xigh6qJTw5BX4px3SmFPGmTZUIgqbFX7jqG4iEv3JCwcQ2q/dK5aDRHDRMrLRXSy+bBdrRyK2yO7nSvb1fL+O6JK4UEIZFYLYCBtIllRid5ALW1XSn/2DiFh0NmPj2GrWjaJVEXdPRmWyr3OPE1uUMMUM2gts9sm2tZuC4piZVGU18vl4c1uPe83Eb+OgXR9qa1r7j56cn2pTaMbLdgSd1bO0WHc+Vq7wcSNJs3HMtz6imqu8lpUe+GzFLl13VG0Vd0yoJrsyvqR45rIQVF0Zbk9iI5CurLMaGP5sizv/Fijwuzftzbvq9bmCjsykPMRaa53rQkV9sFckwHDtXdssD3Q7gwZPMuADO4HDPNlex5EOAIdB1tGdMcARxw7ZGlscM8w2lCDMWIgM4obMZDU3ZjHSR6wXB6wgflNHoiBZcAhKDukUAOSB7yNWTNk/DWDfR9oHtQnYw7KAzZwgxZNJMkDx6NiN263Z1rqT4bVqRtW+7fSVhj4f9aEarEfES2OYyIw8H/rP+oX+yFEtZqxF4cAAAAASUVORK5CYII=', 'base64');
env.state.web = (url) => (/google\.com\/s2\/favicons/.test(url) ? { code: 200, body: LLL_ICON } : { code: 403, body: '<title>Just a moment...</title>' });
env.state.gemini = (req) => {
  if (req.body.contents[0].parts.some((x) => /V5C/.test(x.text || ''))) return { code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(LOGBOOK) }] } }] } }; // reading a log book
  const prompt = (req.body.contents[0].parts[0] || {}).text || '';
  if (req.body.tools || /Return this JSON object/.test(prompt)) { // car lookups (with Google Search)
    const answer = /There is no VIN/.test(prompt) ? MATCHES : FILL;
    return { code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/sorento', title: 'example.com' } }] } }] } };
  }
  const part = req.body.contents[0].parts.filter((x) => x.inline_data)[0];
  const garage = !!part && /invoice/i.test(Buffer.from(part.inline_data.data, 'base64').toString('latin1'));
  return { code: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(garage
    ? { documentType: 'garage_invoice', title: 'Full service and brake check', vendor: 'Kampala Motors', date: '2026-09-15', currency: 'UGX', total: 450000, workDescription: 'Full service and brake check', mileage: 51234, confidence: 'medium' }
    : { documentType: 'parts_receipt', vendor: 'Euro Car Parts', date: '2026-10-02', currency: 'GBP', orderNumber: 'ECP-5521', total: 71.97, items: [{ name: 'Front brake pads', partNumber: 'BP123', quantity: 1, unitPrice: 41.99 }, { name: 'Oil filter', quantity: 2, lineTotal: 19.98 }, { name: 'Delivery', quantity: 1, unitPrice: 0 }], vehicleRegistration: 'AB12CDE', confidence: 'high', summary: 'Brake pads and oil filters (local test answer).' }) }] } }] } };
};

// A little starting data
const mk = (fields) => env.call('saveCar', { token: tokens.admin, fields }).data.car;
const car1 = mk({ registration: 'AB12 CDE', make: 'Toyota', model: 'Land Cruiser', year: '2015', vin: 'JTMHV05J604123456', colour: 'White', odometer: '51200', country: 'UK' });
mk({ registration: 'UBA 123X', make: 'Toyota', model: 'Hilux', year: '2012', odometer: '210450', country: 'UG' });
env.call('setGuestAccess', { token: tokens.admin, carId: car1.id, enabled: true });
const guestSecret = env.call('getCar', { token: tokens.admin, id: car1.id }).data.car.guestSecret;
env.call('saveFluids', { token: tokens.admin, carId: car1.id, fluids: [{ fluid: 'Engine oil', specification: '5W-30 ACEA C3', capacity: '5.5 L' }] });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/api') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let out;
      try { out = env.ctx.doPost({ postData: { contents: body } }).getContent(); } catch (e) { out = JSON.stringify({ ok: false, error: 'server_error' }); console.error(e); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(out);
    });
    return;
  }
  if (url.startsWith('/__as/')) {
    const who = url.slice(6);
    persona = who === 'sam' ? 'sam' : who === 'guest' ? 'guest' : 'admin'; // guest = signed out
    res.writeHead(302, { Location: '/' });
    res.end();
    return;
  }
  if (url === '/__guestlink') { // the address the first car's QR code holds
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('http://localhost:' + PORT + '/#/car/' + car1.id + '?g=' + guestSecret);
    return;
  }
  if (url === '/__outbox') { // the emails the backend would have sent, for checking them by eye
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(env.outbox));
    return;
  }
  if (url === '/__keep' && req.method === 'POST') { // dev only: keep a file the page made (e.g. an exported PDF) so it can be opened in the browser
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { kept = Buffer.concat(chunks); res.writeHead(200); res.end('ok'); });
    return;
  }
  if (url === '/__kept.pdf') {
    res.writeHead(kept ? 200 : 404, { 'Content-Type': 'application/pdf' });
    res.end(kept || '');
    return;
  }
  if (url === '/__reminders') { // pretend it is Monday morning: run the weekly job now
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sent: env.ctx.sendWeeklyReminders() }));
    return;
  }
  if (url === '/sw.js') { res.writeHead(404); res.end(); return; } // no service worker while testing
  if (url === '/config.js') {
    const src = fs.readFileSync(path.join(WEB, 'config.js'), 'utf8')
      .replace(/apiUrl: '[^']*'/, "apiUrl: '/api'")
      .replace('__COMMIT__', 'e2e').replace('__BUILT_AT__', 'local');
    const login = persona === 'guest' ? "localStorage.removeItem('fleet.session');\n"
      : "localStorage.setItem('fleet.session', JSON.stringify({ token: '" + tokens[persona] + "', expiresAt: '2099-01-01T00:00:00Z' }));\n";
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
    res.end(login + src);
    return;
  }
  const file = path.join(WEB, url === '/' ? 'index.html' : url);
  if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(file));
}).listen(PORT, () => console.log('E2E test server on http://localhost:' + PORT));
