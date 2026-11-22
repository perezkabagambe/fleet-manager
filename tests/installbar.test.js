'use strict';
// The "get the app" bar: its files are wired in, and the APK address on the website is the same one the backend saves to Drive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('install.js is loaded by the page and cached by the service worker, and the bar has a place in the page', () => {
  assert.ok(/<script src="install\.js"><\/script>/.test(read('web/index.html')));
  assert.ok(/'install\.js'/.test(read('web/sw.js')));
  assert.ok(/id="installbar"/.test(read('web/index.html')));
});

test('the website and the backend point at the same Android app file, and the manifest names the Android app', () => {
  const site = /androidApkUrl: '([^']+)'/.exec(read('web/config.js'))[1];
  const backend = /ANDROID_APP_URL = '([^']+)'/.exec(read('backend/Setup.js'))[1];
  assert.equal(site, backend);
  const m = JSON.parse(read('web/manifest.webmanifest'));
  assert.deepEqual(m.related_applications, [{ platform: 'play', id: 'com.potentiamotus.fleetmanager' }]);
  assert.ok(!m.prefer_related_applications, 'the browser is not told to prefer the store app over installing the web app');
});

test('"Open in app" hands the current page to the app as ?go=, and the app accepts only plain page routes', () => {
  const app = read('web/app.js');
  assert.ok(/get\('go'\)/.test(app));
  const accepts = new RegExp(/go && (\/[^\n]+\/)\.test\(go\)/.exec(app)[1].slice(1, -1));
  ['#/', '#/car/abc-123', '#/inbox?shared=1', '#/car/ab12/entry/9f?x=1&y=2'].forEach((r) => assert.ok(accepts.test(r), r));
  ['javascript:alert(1)', '#/<script>', 'https://evil.example/', '//evil.example', '#/a b'].forEach((r) => assert.ok(!accepts.test(r), r));
});

test('links.js is loaded by the page and cached by the service worker, and Me has the setting', () => {
  assert.ok(/<script src="links\.js"><\/script>/.test(read('web/index.html')));
  assert.ok(/'links\.js'/.test(read('web/sw.js')));
  assert.ok(/ExternalLinks\.setMode/.test(read('web/views-auth.js')));
});
