'use strict';
// Apps Script loads the backend files one after another (alphabetically, as clasp pushes them) and runs every
// top-level statement while loading. A constant that uses something defined in a file loaded LATER breaks the whole app
// ("MARKETS is not defined"). The other tests load the files in a convenient order, so this one loads them the real way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BACKEND = path.join(__dirname, '..', 'backend');
const files = fs.readdirSync(BACKEND).filter((f) => f.endsWith('.js')).sort();

function load(order) {
  // no Google service is touched while loading, so none is provided: a top-level call to one would fail here too
  const ctx = vm.createContext({ console });
  order.forEach((f) => {
    try {
      vm.runInContext(fs.readFileSync(path.join(BACKEND, f), 'utf8'), ctx, { filename: f });
    } catch (e) {
      assert.fail('loading ' + f + ' failed: ' + e.message);
    }
  });
  return ctx;
}

test('every backend file loads in the order Apps Script uses (alphabetical)', () => {
  const ctx = load(files);
  assert.equal(typeof vm.runInContext('doPost', ctx), 'function');
  assert.equal(typeof vm.runInContext('aiFillCar_', ctx), 'function');
});

test('the files also load in reverse order, so no file depends on another being loaded first', () => {
  load(files.slice().reverse());
});
