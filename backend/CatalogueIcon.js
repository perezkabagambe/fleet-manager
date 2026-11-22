/**
 * The little picture (favicon) of a car's parts catalogue website, shown beside its button on the car page.
 * It is fetched by the server when the catalogue link is saved (best effort: a site that blocks the request just has no
 * picture), kept as a small data address in the car's row, and never loaded from the other site by the phone itself.
 */

const CATALOGUE_ICON_MAX = 6 * 1024; // bytes: up to four fit in one sheet cell, and the lists that carry them stay small
const CATALOGUE_UA = 'Mozilla/5.0 (compatible; FleetManager/1.0)';

/** Only an ordinary public website name: no addresses, no "localhost", nothing without a dot. */
function isPublicHost_(host) {
  const h = String(host || '').toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h) || h.indexOf('.') === -1) return false;
  if (/^\d+(\.\d+){3}$/.test(h) || /^\./.test(h) || /\.(local|localhost|internal|lan|home)$/.test(h) || h === 'localhost') return false;
  return true;
}

/** What kind of picture these bytes are ('' if none we show). */
function catalogueIconMime_(bytes) {
  const b = function (i) { return (bytes[i] === undefined ? -1 : bytes[i] & 0xff); };
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0x00 && b(1) === 0x00 && b(2) === 0x01 && b(3) === 0x00) return 'image/x-icon';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return 'image/gif';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return 'image/webp';
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 400); i++) head += String.fromCharCode(bytes[i] & 0xff);
  if (/<svg[\s>]/i.test(head)) return 'image/svg+xml'; // shown with <img>, so it can never run a script
  return '';
}

/** A data address for the picture in a response, or '' if it is not a small picture. */
function catalogueIconFrom_(res) {
  if (!res || res.getResponseCode() !== 200) return '';
  const bytes = res.getContent();
  if (!bytes || !bytes.length || bytes.length > CATALOGUE_ICON_MAX) return '';
  const mime = catalogueIconMime_(bytes);
  return mime ? 'data:' + mime + ';base64,' + Utilities.base64Encode(bytes) : '';
}

/** Turn an address found in a page into a full one (relative to the page, or to its <base>). */
function resolveIconUrl_(href, pageUrl, baseHref) {
  const h = String(href || '').trim();
  if (!h || /^(data|javascript|blob):/i.test(h)) return '';
  const origin = /^(https:\/\/[^\/]+)/.exec(pageUrl)[1];
  const base = baseHref ? resolveIconUrl_(baseHref, pageUrl, '') || pageUrl : pageUrl;
  if (/^https:\/\//i.test(h)) return h;
  if (/^\/\//.test(h)) return 'https:' + h;
  if (/^http:\/\//i.test(h)) return '';
  if (h.charAt(0) === '/') return origin + h;
  const dir = base.replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
  return (/^https:\/\/[^\/]+\/$/.test(dir) || /^https:\/\/[^\/]+$/.test(dir) ? origin + '/' : dir) + h;
}

/** The icon addresses a page declares, best first: touch icons (bigger, nicer), then ordinary icons. */
function pageIconUrls_(html, pageUrl) {
  const base = (/<base[^>]*\shref\s*=\s*["']([^"']+)["']/i.exec(html) || [])[1] || '';
  const found = [];
  (html.match(/<link\b[^>]*>/gi) || []).forEach(function (tag) {
    const rel = ((/\srel\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '').toLowerCase();
    const href = (/\shref\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!href || !/\bicon\b/.test(rel)) return;
    const size = Number((/\ssizes\s*=\s*["'](\d+)x/i.exec(tag) || [])[1] || 0);
    const url = resolveIconUrl_(href, pageUrl, base);
    if (url) found.push({ url: url, touch: /apple-touch/.test(rel), size: size });
  });
  found.sort(function (a, b) { return (b.touch ? 1 : 0) - (a.touch ? 1 : 0) || (a.size && b.size ? Math.abs(a.size - 64) - Math.abs(b.size - 64) : 0); });
  return found.map(function (f) { return f.url; });
}

function catalogueFetch_(url) {
  try {
    return UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': CATALOGUE_UA, 'Accept': 'image/*,text/html;q=0.8,*/*;q=0.5' } });
  } catch (e) {
    return null;
  }
}

/**
 * The picture for a catalogue website: what the site itself declares, then its /favicon.ico, then Google's copy of the site's icon
 * (many parts sites refuse requests from servers, so the last step is what usually works for them). '' if nothing was found.
 */
function fetchCatalogueIcon_(url) {
  const m = /^(https:\/\/([^\/:?#]+))/i.exec(String(url || ''));
  if (!m || !isPublicHost_(m[2])) return '';
  const origin = m[1];
  const host = m[2].toLowerCase();
  const tried = {};
  const candidates = [];
  const page = catalogueFetch_(url);
  if (page && page.getResponseCode() === 200 && /html/i.test(String((page.getHeaders && page.getHeaders()['Content-Type']) || 'text/html'))) {
    pageIconUrls_(String(page.getContentText()).slice(0, 200000), url).forEach(function (u) { candidates.push(u); });
  }
  candidates.push(origin + '/favicon.ico');
  for (let i = 0; i < candidates.length && i < 4; i++) {
    const u = candidates[i];
    if (tried[u]) continue;
    tried[u] = true;
    const mm = /^https:\/\/([^\/:?#]+)/i.exec(u);
    if (!mm || !isPublicHost_(mm[1])) continue;
    const icon = catalogueIconFrom_(catalogueFetch_(u));
    if (icon) return icon;
  }
  return catalogueIconFrom_(catalogueFetch_('https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64'));
}

/**
 * Fetch the pictures for a car's catalogues that have none yet (or all of them with `all: true`) and keep them. Quick to ignore if it
 * fails: the car page just has no picture. Not a new version of the car, so nobody's open form is spoilt by it.
 */
function refreshCatalogueIcon_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const started = Date.now();
  const list = cataloguesOf_(car);
  let changed = false;
  list.forEach(function (x) {
    if ((x.i && !p.all) || Date.now() - started > 40000) return; // enough time spent: the rest are tried next time
    const icon = fetchCatalogueIcon_(x.u);
    if (icon !== x.i) { x.i = icon; changed = true; }
  });
  if (changed) {
    withScriptLock_(function () {
      const fresh = findCar_(car.id, false) || car;
      const now = cataloguesOf_(fresh);
      const merged = now.map(function (n) { const got = list.filter(function (x) { return x.u === n.u; })[0]; return { u: n.u, i: got ? got.i : n.i }; }); // keep any edit made meanwhile
      Db.update('Cars', fresh._row, { catalogues: merged.length ? JSON.stringify(merged) : '', catalogue_icon: merged.length ? merged[0].i : '' });
    });
  }
  return { icon: list.length ? list[0].i : '', catalogues: list.map(function (x) { return { url: x.u, icon: x.i }; }) };
}
