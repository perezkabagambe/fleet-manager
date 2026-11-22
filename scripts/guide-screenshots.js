'use strict';
// Takes the user guide's screenshots from the app running against the demo data (tests/devserver.js, never real data), drives each
// page with tests/shot.html, and writes web/guide/*.jpg. Needs Google Chrome and macOS's sips. Usage:
//   node scripts/guide-screenshots.js            all of them
//   node scripts/guide-screenshots.js guide-qr   just one (or several)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'web', 'guide');
const PORT = 8131;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 360;
const H = 780;

const SHOTS = {
  'guide-email': [{ hash: '#/demo/log', wait: 4500 }, { scroll: { sel: '.receipt-hint', offset: -150 } }, { hl: { sel: '.receipt-hint-link', label: 'This car\'s own email address', pad: 3, pos: 'tr' } }],
  'guide-inbox': [{ hash: '#/inbox', wait: 3500 }, { click: { sel: 'a.inbox-row' }, after: 3000 }, { scroll: { sel: 'h2', text: 'What AI read from it', offset: -70 } }, { hl: { sel: '.facts', label: 'What AI read from the receipt', pad: 3, pos: 'tr' } }],
  'guide-addcar': [{ hash: '#/car/new', wait: 3500 }, { hl: { sel: '.choice', text: '1. Upload', label: '1. Log book', pad: 2, pos: 'tr' } }, { hl: { sel: '.choice', text: '2. Add it yourself', label: '2. Manual', pad: 2, pos: 'tr' } }],
  'guide-fluids': [{ hash: '#/demo/fluids', wait: 4500 }, { scroll: { sel: 'summary h2', text: 'Fluids | Bulbs | Parts', offset: -60 } }, { hl: { sel: '.section-note', text: 'Some entries below', label: 'AI suggestions to check', pad: 3, pos: 'tr' } }],
  'guide-addentry': [{ hash: '#/demo/add', wait: 4500 }],
  'guide-filter': [{ hash: '#/demo/log', wait: 4500 }, { scroll: { sel: '.filter-bar', offset: -200 } }, { hl: { sel: '.filter-bar', label: 'Tap a type to filter', pad: 4, pos: 'below' } }],
  'guide-qr': [{ hash: '#/demo/qr', wait: 4500 }, { scroll: { sel: 'img.qr', offset: -230 } }, { hl: { sel: 'img.qr', label: 'Scan to open this car', pad: 4, pos: 'below' } }],
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const wanted = process.argv.slice(2);
  const names = wanted.length ? wanted : Object.keys(SHOTS);
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn('node', [path.join(ROOT, 'tests', 'devserver.js')], { env: Object.assign({}, process.env, { PORT: String(PORT), DEMO_SHOTS: '1' }), stdio: 'ignore' });
  try {
    await sleep(2500);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-shots-'));
    for (const name of names) {
      const plan = SHOTS[name];
      if (!plan) { console.log('no such shot: ' + name); continue; }
      const png = path.join(tmp, name + '.png');
      const url = 'http://localhost:' + PORT + '/__shot?w=' + W + '&h=' + H + '&plan=' + encodeURIComponent(JSON.stringify(plan));
      const r = spawnSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=' + W + ',' + H,
        '--virtual-time-budget=40000', '--user-data-dir=' + path.join(tmp, 'profile-' + name), '--screenshot=' + png, url], { encoding: 'utf8', timeout: 120000 });
      if (!fs.existsSync(png)) { console.log('FAILED ' + name + ': ' + (r.stderr || '').slice(0, 300)); continue; }
      const jpg = path.join(OUT, name + '.jpg');
      spawnSync('sips', ['--resampleWidth', '600', '-s', 'format', 'jpeg', '-s', 'formatOptions', '60', png, '--out', jpg], { encoding: 'utf8' });
      console.log('wrote ' + path.relative(ROOT, jpg) + ' (' + Math.round(fs.statSync(jpg).size / 1024) + ' KB)');
    }
  } finally {
    server.kill();
  }
}
main();
