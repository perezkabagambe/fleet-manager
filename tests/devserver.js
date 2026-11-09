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

env.seedUser({ name: 'Perez Kabagambe', email: 'perez@example.com', role: 'admin' });
env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
const tokens = { admin: env.signInAs('perez@example.com'), sam: env.signInAs('sam@example.com') };
let persona = 'admin';

// A pretend AI service, so the "Fill in the rest with AI" button can be tried locally (it takes 2 seconds, like a quick lookup)
env.props.ANTHROPIC_API_KEY = 'sk-ant-local-test';
env.state.anthropic = () => ({
  code: 200,
  body: {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({
      details: { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Black', engineCode: 'D4HB', gearboxCode: '', market: 'European', driveSide: 'RHD', fuelCapacity: '71' },
      fluids: [{ fluid: 'Engine oil', specification: '5W-30 ACEA C3', capacity: '6.7 L', notes: '' }, { fluid: 'Brake fluid', specification: 'DOT 4', capacity: '', notes: '' }],
      bulbs: [{ location: 'Dipped beam', type: 'Xenon D3S 35 W', quantity: '2', notes: 'Halogen versions use H7' }, { location: 'Full beam', type: 'Halogen H1 55 W', quantity: '2', notes: '' }],
      summary: 'A 2013 Kia Sorento 2.2 CRDi (local test answer).', confidence: 'medium',
    }), citations: [{ type: 'web_search_result_location', url: 'https://example.com/sorento', title: 'x', cited_text: 'x' }] }],
  },
});

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
