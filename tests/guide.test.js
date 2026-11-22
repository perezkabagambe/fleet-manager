'use strict';
// The user guide: it is wired into the app, every demo link in it goes somewhere, and every screenshot it shows exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const guide = read('web/views-guide.js');

test('the guide is loaded by the page, cached by the service worker, routed, and linked from Me', () => {
  assert.ok(/<script src="views-guide\.js"><\/script>/.test(read('web/index.html')));
  assert.ok(/'views-guide\.js'/.test(read('web/sw.js')));
  const app = read('web/app.js');
  assert.ok(/r\.path === '\/guide'\) view = Views\.guide/.test(app));
  assert.ok(/\^\\\/demo/.test(app) && /Views\.demoLink/.test(app));
  assert.ok(/menuRow\('User guide', \{ href: '#\/guide' \}\)/.test(read('web/views-auth.js')));
});

test('every demo link in the guide has a destination, and every destination is used', () => {
  const block = /var TARGETS = \{([\s\S]*?)\n  \};/.exec(guide)[1];
  const targets = [...block.matchAll(/^    (\w+): \{/gm)].map((m) => m[1]);
  const used = [...guide.matchAll(/link\('(\w+)',/g)].map((m) => m[1]);
  assert.ok(used.length >= 10, 'the guide has demo links');
  used.forEach((u) => assert.ok(targets.includes(u), 'no destination for ' + u));
  targets.filter((t) => t !== 'car' && t !== 'edit').forEach((t) => assert.ok(used.includes(t) || /^add/.test(t) || t === 'editspecs', 'unused destination ' + t));
  // the sections a destination opens or scrolls to are real names on the car page
  const carPage = read('web/views-cars.js');
  [...guide.matchAll(/(?:open: \['([^']+)'\]|scroll: '([^']+)')/g)].forEach((m) => {
    const name = m[1] || m[2];
    assert.ok(name === 'Export all vehicle data' || carPage.includes("'" + name + "'"), 'the car page has no section called ' + name);
  });
});

test('every screenshot the guide shows has been taken, and they are small enough to load quickly on a phone', () => {
  const shots = [...guide.matchAll(/shot\('([\w-]+)'/g)].map((m) => m[1]);
  assert.ok(shots.length >= 6);
  shots.forEach((name) => {
    const file = path.join(root, 'web', 'guide', name + '.jpg');
    assert.ok(fs.existsSync(file), name + '.jpg is missing (run: node scripts/guide-screenshots.js)');
    assert.ok(fs.statSync(file).size < 200 * 1024, name + '.jpg is large');
    assert.equal(fs.readFileSync(file).slice(0, 3).toString('hex'), 'ffd8ff', name + ' is a JPEG');
  });
});
