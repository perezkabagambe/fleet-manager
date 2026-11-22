'use strict';
// Where links to other websites open: in the app (over it) or in the phone's own browser, chosen in Me.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, '..', 'web', 'links.js'), 'utf8');

function load(userAgent) {
  const store = {};
  let clickHandler = null;
  const location = { origin: 'https://perezkabagambe.github.io', href: 'https://perezkabagambe.github.io/fleet-manager/', hash: '' };
  const window = { location };
  const ctx = vm.createContext({
    window, navigator: { userAgent }, URL, location,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; } },
  });
  vm.runInContext(code, ctx);
  const link = (href, extra) => {
    const a = Object.assign({ href, attrs: {}, target: '', rel: '', getAttribute(n) { return n === 'href' ? href : null; }, hasAttribute(n) { return n in this.attrs; } }, extra || {});
    return a;
  };
  const click = (a) => {
    const ev = { defaultPrevented: false, button: 0, target: { closest: () => a }, preventDefault() { this.defaultPrevented = true; } };
    clickHandler(ev);
    return ev;
  };
  return { api: window.ExternalLinks, window, location, link, click, store };
}

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120';

test('links open in the app unless the person chose their browser, and the choice is kept', () => {
  const t = load(ANDROID);
  assert.equal(t.api.mode(), 'app');
  t.api.setMode('browser');
  assert.equal(t.api.mode(), 'browser');
  assert.equal(t.store['fm-link-mode'], 'browser');
  t.api.setMode('anything else');
  assert.equal(t.api.mode(), 'app');
});

test('in the app, a link to another website opens over the app (a new window), never replacing the app', () => {
  const t = load(ANDROID);
  const a = t.link('https://partsouq.com/en/catalog');
  const ev = t.click(a);
  assert.equal(ev.defaultPrevented, false);
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
});

test('in the browser, an Android phone hands the link to its own browser (and falls back to opening it normally)', () => {
  const t = load(ANDROID);
  t.api.setMode('browser');
  const ev = t.click(t.link('https://www.lllparts.co.uk/catalogs/bmw/E92?q=1#top'));
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.window.location.href, 'intent://www.lllparts.co.uk/catalogs/bmw/E92?q=1#Intent;scheme=https;action=android.intent.action.VIEW;S.browser_fallback_url=' + encodeURIComponent('https://www.lllparts.co.uk/catalogs/bmw/E92?q=1') + ';end');
  // not on a phone that cannot do this: the link just opens as usual
  const other = load('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
  other.api.setMode('browser');
  const a = other.link('https://partsouq.com/x');
  assert.equal(other.click(a).defaultPrevented, false);
  assert.equal(a.target, '_blank');
});

test('links within the app, mail links, downloads (the Android app file) and modified clicks are left alone', () => {
  const t = load(ANDROID);
  t.api.setMode('browser');
  const before = t.window.location.href;
  [t.link('https://perezkabagambe.github.io/fleet-manager/#/car/1'), t.link('mailto:a@b.c'), t.link('#/inbox'), t.link('https://x.example/FleetManager-1.2.apk'),
    t.link('https://x.example/file.pdf', { attrs: { download: '' } })].forEach((a) => {
    assert.equal(t.click(a).defaultPrevented, false, a.href);
    assert.equal(a.target, '', a.href);
  });
  assert.equal(t.window.location.href, before);
});
