'use strict';
// A car's parts catalogue shows its website's icon beside the button: fetched by the server when the link is saved.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('tiny-png-body')]);
const dataUrl = (buf, mime) => 'data:' + mime + ';base64,' + buf.toString('base64');
const CAR = { registration: 'AB12 CDE', make: 'BMW', model: '325i', year: '2006', odometer: '50000' };

function setup(url) {
  const env = createEnv();
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { partsouqUrl: url || '' }) }).data.car;
  const refresh = () => env.call('refreshCatalogueIcon', { token: sam, carId: car.id });
  const shown = () => env.call('getCar', { token: sam, id: car.id }).data.car.catalogueIcon;
  return { env, sam, car, refresh, shown };
}

test('the icon a site declares in its page is used, found relative to the page (touch icons first)', () => {
  const { env, refresh, shown } = setup('https://parts.example.com/catalogs/bmw/e92');
  const html = '<html><head><base href="/assets/"><link rel="shortcut icon" href="small.ico"><link rel="apple-touch-icon" sizes="180x180" href="touch.png"></head></html>';
  env.state.web = (url) => (url === 'https://parts.example.com/catalogs/bmw/e92' ? { code: 200, body: html } : url === 'https://parts.example.com/assets/touch.png' ? { code: 200, body: PNG, headers: { 'Content-Type': 'image/png' } } : { code: 404, body: 'no' });
  assert.equal(refresh().data.icon, dataUrl(PNG, 'image/png'));
  assert.equal(shown(), dataUrl(PNG, 'image/png'));
  assert.deepEqual(env.state.webRequests.map((r) => r.url), ['https://parts.example.com/catalogs/bmw/e92', 'https://parts.example.com/assets/touch.png']);
});

test('a site that refuses servers (the lllparts.co.uk case) falls back to its /favicon.ico, then to Google\'s copy of its icon', () => {
  const url = 'https://www.lllparts.co.uk/catalogs/bmw/ECE/E92/325i+N52N/R%7CN%7C2006%7C06%7Csearch';
  const { env, refresh, shown } = setup(url);
  env.state.web = (u) => {
    if (/google\.com\/s2\/favicons\?domain=www\.lllparts\.co\.uk&sz=64$/.test(u)) return { code: 200, body: PNG, headers: { 'Content-Type': 'image/png' } };
    if (/lllparts/.test(u)) return { code: 403, body: '<title>Just a moment...</title>' }; // the page and /favicon.ico are both refused
    return { code: 404, body: '' };
  };
  assert.equal(refresh().data.icon, dataUrl(PNG, 'image/png'));
  assert.equal(shown(), dataUrl(PNG, 'image/png'));
  assert.deepEqual(env.state.webRequests.map((r) => r.url), [url, 'https://www.lllparts.co.uk/favicon.ico', 'https://www.google.com/s2/favicons?domain=www.lllparts.co.uk&sz=64']);
});

test('what is not a small picture is never kept: an HTML error page, a big file, or nothing at all', () => {
  const { env, refresh, shown } = setup('https://parts.example.com/x');
  env.state.web = () => ({ code: 200, body: '<html>a page, not a picture</html>' });
  assert.equal(refresh().data.icon, '');
  env.state.web = (u) => (/s2\/favicons/.test(u) ? { code: 404, body: PNG } : { code: 200, body: Buffer.concat([PNG, Buffer.alloc(20000)]) }); // too big, and Google has none
  assert.equal(refresh().data.icon, '');
  env.state.web = () => { throw new Error('DNS error'); };
  assert.equal(refresh().data.icon, '');
  assert.equal(shown(), '');
});

test('an SVG icon is accepted and other kinds are recognised; the address must be an ordinary public website', () => {
  const { env, refresh } = setup('https://parts.example.com/x');
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>');
  env.state.web = (u) => (/\/favicon\.ico$/.test(u) ? { code: 200, body: svg } : { code: 404, body: '' });
  assert.equal(refresh().data.icon, dataUrl(svg, 'image/svg+xml'));
  const call = (js) => require('vm').runInContext(js, env.ctx);
  ['https://localhost/x', 'https://127.0.0.1/x', 'https://192.168.1.5/x', 'https://intranet/x', 'https://printer.local/x', 'http://parts.example.com/x'].forEach((u) => {
    const before = env.state.webRequests.length;
    assert.equal(call('fetchCatalogueIcon_(' + JSON.stringify(u) + ')'), '', u);
    assert.equal(env.state.webRequests.length, before, 'nothing was requested for ' + u);
  });
});

test('changing the catalogue link clears the old picture; clearing it removes the picture; nobody can refresh a car that is not there', () => {
  const { env, sam, car, refresh, shown } = setup('https://parts.example.com/x');
  env.state.web = () => ({ code: 200, body: PNG });
  refresh();
  assert.ok(shown().startsWith('data:image/png'));
  const saved = env.call('getCar', { token: sam, id: car.id }).data.car;
  const edit = (url) => env.call('saveCar', { token: sam, id: car.id, version: env.call('getCar', { token: sam, id: car.id }).data.car.version, fields: Object.assign({}, CAR, { partsouqUrl: url }) });
  edit('https://parts.example.com/x'); // the same link: the picture stays
  assert.ok(shown().startsWith('data:image/png'));
  edit('https://another.example.org/y');
  assert.equal(shown(), '', 'a different website: the old picture is gone');
  refresh();
  assert.ok(shown().startsWith('data:image/png'));
  edit('');
  assert.equal(shown(), '');
  assert.equal(refresh().data.icon, '', 'no link, no picture');
  assert.equal(env.call('refreshCatalogueIcon', { token: sam, carId: 'nope' }).error, 'not_found');
  assert.equal(env.call('refreshCatalogueIcon', { carId: car.id }).error, 'unauthorized');
  assert.ok(saved.version >= 1);
});

test('refreshing the picture does not make a new version of the car (an open edit form still saves)', () => {
  const { env, sam, car, refresh } = setup('https://parts.example.com/x');
  const version = env.call('getCar', { token: sam, id: car.id }).data.car.version;
  env.state.web = () => ({ code: 200, body: PNG });
  refresh();
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.version, version);
  assert.equal(env.call('saveCar', { token: sam, id: car.id, version, fields: Object.assign({}, CAR, { colour: 'Red', partsouqUrl: 'https://parts.example.com/x' }) }).ok, true);
});

// ---------- several catalogues ----------
const A = 'https://www.lllparts.co.uk/catalogs/bmw/E92';
const B = 'https://partsouq.com/en/catalog/genuine/unit?c=Toyota';
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('second-icon')]);

function setupMany(urls) {
  const env = createEnv();
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const sam = env.signInAs('sam@example.com');
  const car = env.call('saveCar', { token: sam, fields: Object.assign({}, CAR, { catalogues: urls }) }).data.car;
  const get = () => env.call('getCar', { token: sam, id: car.id }).data.car;
  const edit = (list, extra) => env.call('saveCar', { token: sam, id: car.id, version: get().version, fields: Object.assign({}, CAR, { catalogues: list }, extra || {}) });
  return { env, sam, car, get, edit };
}

test('a car can have up to four catalogues, kept in order, without repeats; the first is also the older single link', () => {
  const { car, get, edit } = setupMany([A, B, A]);
  assert.deepEqual(car.catalogues.map((c) => c.url), [A, B]);
  assert.equal(car.partsouqUrl, A);
  assert.deepEqual(get().catalogues.map((c) => c.url), [A, B]);
  assert.equal(edit([A, B, 'https://c.example.com/x', 'https://d.example.com/x']).ok, true);
  assert.equal(get().catalogues.length, 4);
  assert.equal(edit([A, B, 'https://c.example.com/x', 'https://d.example.com/x', 'https://e.example.com/x']).error, 'too_many_catalogues');
  assert.equal(edit([A, 'http://insecure.example.com']).error, 'invalid_catalogue_url');
  assert.deepEqual(edit([B, A]).data.car.catalogues.map((c) => c.url), [B, A], 'the order can be changed');
  assert.equal(get().partsouqUrl, B);
  assert.deepEqual(edit([]).data.car.catalogues, []);
  assert.equal(get().partsouqUrl, '');
});

test('each catalogue gets its own icon, and an edit keeps the icons of the links that did not change', () => {
  const { env, sam, car, get, edit } = setupMany([A, B]);
  env.state.web = (u) => (/lllparts/.test(u) ? { code: 200, body: PNG, headers: { 'Content-Type': 'image/png' } } : /partsouq/.test(u) ? { code: 200, body: PNG2 } : { code: 404, body: '' });
  const r = env.call('refreshCatalogueIcon', { token: sam, carId: car.id }).data;
  assert.deepEqual(r.catalogues.map((c) => c.icon), [dataUrl(PNG, 'image/png'), dataUrl(PNG2, 'image/png')]);
  assert.equal(r.icon, dataUrl(PNG, 'image/png'));
  assert.deepEqual(get().catalogues.map((c) => c.icon), [dataUrl(PNG, 'image/png'), dataUrl(PNG2, 'image/png')]);
  // change only the second one: the first keeps its icon, the new one has none yet
  edit([A, 'https://other.example.org/z']);
  assert.deepEqual(get().catalogues.map((c) => !!c.icon), [true, false]);
  // only the catalogues without an icon are fetched again
  env.state.webRequests.length = 0;
  env.call('refreshCatalogueIcon', { token: sam, carId: car.id });
  assert.ok(env.state.webRequests.every((q) => /other\.example\.org|google\.com\/s2.*other\.example\.org/.test(q.url)), env.state.webRequests.map((q) => q.url).join(' '));
  // a car saved with the older single link still shows as one catalogue
  const old = createEnv();
  old.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  const t = old.signInAs('sam@example.com');
  const c2 = old.call('saveCar', { token: t, fields: Object.assign({}, CAR, { partsouqUrl: B }) }).data.car;
  assert.deepEqual(c2.catalogues.map((c) => c.url), [B]);
});
