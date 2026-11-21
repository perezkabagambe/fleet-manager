'use strict';
// The Android download link saved in the app's Drive folder (a function run once from the Apps Script editor).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { createEnv } = require('./harness');

test('saveAndroidLinkToDrive writes the link into the Fleet Manager folder, and running it again updates the same file', () => {
  const env = createEnv();
  env.props.ROOT_FOLDER_ID = 'root-folder';
  const id = vm.runInContext('saveAndroidLinkToDrive()', env.ctx);
  const file = env.files[id];
  assert.equal(file.folder, 'root-folder');
  assert.equal(file.name, 'Fleet Manager - Android app download link.txt');
  assert.match(String(file.content), /releases\/download\/android-v1\.1\/FleetManager-1\.1\.apk/);
  assert.match(String(file.content), /allow installing apps from that source/);
  const again = vm.runInContext('saveAndroidLinkToDrive()', env.ctx);
  assert.equal(again, id);
  assert.equal(Object.values(env.files).filter((f) => f.name === file.name).length, 1);
});
