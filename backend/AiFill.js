/**
 * "Fill in the rest with AI" for a car, and "Refresh specs with AI".
 *
 * Asks Google's Gemini (with Google Search, so it looks the car up rather than only remembering) for a car's details,
 * its standard fluids and its bulbs. Nothing is saved here: the answer goes back to the form, which shows it, so the
 * person checks it before keeping anything.
 *
 * What is used, in order: the VIN when there is one (it identifies the exact car and decodes to its build); otherwise the
 * make, model, year and whatever else was typed (registration, engine code, market...), and then the AI first offers a few
 * likely matches (aiFindCar) for the person to pick from before it fills in the specs.
 *
 * AI answers are not always right. Everything this returns is marked as an AI suggestion so it is never mistaken for a
 * checked fact. It uses the same key as the receipt reader (Script Property GEMINI_API_KEY). Optional Script Properties:
 * GEMINI_CAR_MODEL (a different model for car lookups), GEMINI_SEARCH_FALLBACK_MODEL (the older model tried with search when the
 * latest one cannot search; default gemini-2.5-flash), AI_USER_DAILY and AI_APP_DAILY (limits).
 */

const AI_USER_DAILY = 10;   // lookups per person per day
const AI_APP_DAILY = 100;   // lookups for everyone together per day (keeps the free allowance safe)
const AI_MAX_CANDIDATES = 3;
const AI_SOURCE = 'AI suggestion (Gemini with Google Search), not verified';

// The names the app uses (they must match the standard lists in web/views-cars.js).
const AI_FLUID_NAMES = ['Engine oil', 'Gearbox oil / ATF', 'Front differential oil', 'Rear differential oil', 'Transfer case oil',
  'Coolant', 'Brake fluid', 'Power steering fluid', 'AC refrigerant'];
const AI_BULB_NAMES = ['Dipped beam', 'Full beam', 'Front side light', 'Front indicator', 'Rear indicator', 'Front fog', 'Rear fog',
  'Front daytime running', 'Rear light', 'Rear brake light', 'Rear reverse light'];

function aiKey_() { return geminiKey_(); }
function aiSearchFallbackModel_() { return String(props_().getProperty('GEMINI_SEARCH_FALLBACK_MODEL') || '').trim() || 'gemini-2.5-flash'; }
function aiModel_() { return String(props_().getProperty('GEMINI_CAR_MODEL') || '').trim() || geminiModel_(); }

function aiLimit_(propName, fallback) {
  const n = Number(props_().getProperty(propName));
  return isFinite(n) && n > 0 ? n : fallback;
}

function aiToday_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** How many of today's lookups a counter has used (a counter is "day|n" in the script properties). */
function aiUsed_(name) {
  const parts = String(props_().getProperty('cap:' + name) || '').split('|');
  return parts[0] === aiToday_() ? Number(parts[1]) || 0 : 0;
}

function aiUserName_(ctx) { return 'ai_u_' + ctx.user.id; }

/** Take one lookup from the person's allowance and the app's. Returns '' if allowed, else the error code. */
function aiTake_(ctx) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (!dailyCap_(aiUserName_(ctx), aiLimit_('AI_USER_DAILY', AI_USER_DAILY))) return 'ai_limit_user';
    if (!dailyCap_('ai_app', aiLimit_('AI_APP_DAILY', AI_APP_DAILY))) {
      aiGiveBack_(aiUserName_(ctx));
      return 'ai_limit_app';
    }
    return '';
  } finally {
    lock.releaseLock();
  }
}

/** A lookup that failed does not use up the allowance. */
function aiGiveBack_(name) {
  const key = 'cap:' + name;
  const parts = String(props_().getProperty(key) || '').split('|');
  if (parts[0] === aiToday_() && Number(parts[1]) > 0) props_().setProperty(key, parts[0] + '|' + (Number(parts[1]) - 1));
}

function aiRefund_(ctx) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    aiGiveBack_(aiUserName_(ctx));
    aiGiveBack_('ai_app');
  } finally {
    lock.releaseLock();
  }
}

/** Is AI switched on (is there a key), and how many lookups has this person left today? */
function aiStatus_(p, ctx) {
  const limit = aiLimit_('AI_USER_DAILY', AI_USER_DAILY);
  return { available: !!aiKey_(), limit: limit, remaining: Math.max(0, limit - aiUsed_(aiUserName_(ctx))) };
}

// ---------- what the person has told us ----------

/** The car as known so far, from a request or a saved car, cleaned. */
function aiKnown_(src) {
  const known = {
    registration: cleanStr_(src.registration, 20).toUpperCase(),
    vin: cleanStr_(src.vin, 30).toUpperCase().replace(/\s+/g, ''),
    country: src.country === 'UG' ? 'UG' : 'UK',
    make: cleanStr_(src.make, 40), model: cleanStr_(src.model, 40), year: cleanStr_(src.year, 4),
    colour: cleanStr_(src.colour, 30), engineCode: cleanStr_(src.engineCode, 30), gearboxCode: cleanStr_(src.gearboxCode, 30),
    market: cleanStr_(src.market, 30), driveSide: cleanStr_(src.driveSide, 4).toUpperCase(), fuelCapacity: cleanStr_(src.fuelCapacity, 8),
  };
  if (known.vin && !/^[A-Z0-9-]{5,25}$/.test(known.vin)) fail_('invalid_vin');
  return known;
}

/** Enough to look a car up: a VIN, or at least the make and the model. */
function aiNeedEnough_(known) {
  if (!known.vin && !(known.make && known.model)) fail_('ai_need_more');
}

function aiKnownLines_(known) {
  const lines = [];
  if (known.vin) lines.push('VIN: ' + known.vin + '  (the most reliable thing we know: it identifies this exact car)');
  if (known.registration) lines.push('Registration number: ' + known.registration);
  lines.push('The car is kept in: ' + (known.country === 'UG' ? 'Uganda' : 'the United Kingdom'));
  const typed = [['make', known.make], ['model', known.model], ['year', known.year], ['colour', known.colour], ['engine code', known.engineCode],
    ['gearbox code', known.gearboxCode], ['market', known.market], ['drive side', known.driveSide], ['fuel tank (litres)', known.fuelCapacity]]
    .filter(function (x) { return x[1]; });
  if (typed.length) lines.push('The person has already typed: ' + typed.map(function (x) { return x[0] + ' ' + x[1]; }).join(', ') + (known.vin ? ' (if any of this disagrees with what the VIN decodes to, trust the VIN and say so in the summary)' : ' (trust these)') + '.');
  return lines;
}

// ---------- the questions ----------

function aiSystemPrompt_() {
  return [
    'You research vehicles for a small fleet-records app. You look a vehicle up (use Google Search: search for the VIN, the registration and the make, model and year)',
    'to fill in its record. A VIN, when given, decodes to the exact vehicle, so it comes before everything else.',
    'Be accurate rather than complete. Fill a field only if you are reasonably sure it is right for this exact vehicle;',
    'otherwise leave it as an empty string or leave the item out. A wrong value is worse than a blank one.',
    'Never invent a colour: only give one if a source states it for this specific vehicle.',
    'Reply with ONE JSON object and nothing else (no explanation, no markdown fence).',
  ].join(' ');
}

// (a function, not a constant: MARKETS is defined in another file, which Apps Script may load later)
function aiDetailsJson_() {
  return [
  '    "make": "", "model": "", "year": "",  // year as 4 digits',
  '    "colour": "",',
  '    "engineCode": "",  // the manufacturer engine code, e.g. D4HB',
  '    "gearboxCode": "", // the transmission code if known',
  '    "market": "",      // exactly one of: ' + MARKETS.join(' | ') + ' (where it was built and sold for)',
  '    "driveSide": "",   // LHD or RHD',
  '    "fuelCapacity": "" // fuel tank size in litres, a number',
].join('\n');
}

function aiFillPrompt_(known) {
  const lines = aiKnownLines_(known);
  lines.push(
    '',
    'Return this JSON object (every key present; use "" or [] when unknown):',
    '{',
    '  "details": {',
    aiDetailsJson_(),
    '  },',
    '  "fluids": [  // only from these names: ' + AI_FLUID_NAMES.join(', '),
    '    { "fluid": "Engine oil", "specification": "see the rule below", "capacity": "e.g. 6.7 L", "notes": "" }',
    '  ],',
    '  "bulbs": [   // only from these locations: ' + AI_BULB_NAMES.join(', '),
    '    { "location": "Dipped beam", "type": "bulb type then the specific bulb, e.g. Halogen H7 55 W", "quantity": "e.g. 2", "notes": "" }',
    '  ],',
    '  "summary": "one or two sentences: what vehicle this is and how sure you are",',
    '  "confidence": "high, medium or low"',
    '}',
    'Engine oil and coolant are critical fluids, so give as much specification as you can find, separated by commas, and never just a viscosity or just a manufacturer approval. ' +
    'Engine oil: start with the viscosity grade. Then, for the manufacturer approval(s) this car needs (e.g. MB 229.3, VW 504 00 / 507 00, BMW Longlife-04, Ford WSS-M2C913-D, GM dexos2, Toyota, Renault RN0720), ' +
    'ALWAYS look up what each one is equivalent to and give the ACEA class (A1/B1, A3/B3, A3/B4, A5/B5, C1, C2, C3, C4, C5, E4, E6 or E7) and the API service class (e.g. SN, SP, CK-4) it corresponds to. ' +
    'Always try to find the equivalent ACEA class; only leave it out if there truly is none, and then say so. Keep the manufacturer approval too. ' +
    'Example: "5W-40, ACEA A3/B4, API SN, MB 229.3". ' +
    'Coolant: say the technology type (one of IAT, OAT, HOAT, P-OAT, Si-OAT, or the nearest match), whether it is long life (and roughly how many years or km), the typical colour (e.g. pink, blue, green, violet, orange, yellow), ' +
    'the manufacturer specification or VW G-number (e.g. VW TL 774-J G13, G12evo, Toyota Super Long Life, Ford WSS-M97B44-D, MB 325.5) and the mix ratio. ' +
    'Example: "Pink/violet long-life Si-OAT, VW TL 774-J (G13), 50/50 with distilled water". ' +
    'The same applies to other critical fluids (gearbox oil, brake fluid DOT grade): include the standard. Other strings can stay short. Put any doubt in "notes" (for example "xenon cars use D1S instead").'
  );
  return lines.join('\n');
}

function aiFindPrompt_(known) {
  const lines = aiKnownLines_(known);
  lines.push(
    '',
    'There is no VIN, so the exact car is not certain. List the ' + AI_MAX_CANDIDATES + ' or fewer most likely versions this could be (differing in engine, market, generation or fuel type),',
    'most likely first. Give one only if it is clearly the only sensible match. Return this JSON object:',
    '{',
    '  "candidates": [',
    '    {',
    '      "label": "short, e.g. 2013 Kia Sorento 2.2 CRDi (D4HB), European market",',
    '      "why": "one short sentence on what distinguishes this version",',
    '      "confidence": "high, medium or low",',
    '      "details": {',
    aiDetailsJson_(),
    '      }',
    '    }',
    '  ]',
    '}'
  );
  return lines.join('\n');
}

// ---------- talking to Gemini ----------

/**
 * Ask in up to three steps, so the answer is as well researched as the free allowance allows:
 *  1. the latest model (GEMINI_CAR_MODEL, else GEMINI_MODEL) with Google Search;
 *  2. if that is refused or over its limit: an older model that still has its own search allowance (GEMINI_SEARCH_FALLBACK_MODEL,
 *     default gemini-2.5-flash), again with Google Search;
 *  3. if search fails completely: the latest model without searching, from what it knows.
 * Returns { text, sources, method: { step, model, searched } }. A "busy" answer to step 3 is reported to the person.
 */
function aiAsk_(prompt) {
  const make = function (withSearch) {
    const body = {
      systemInstruction: { parts: [{ text: aiSystemPrompt_() }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    };
    if (withSearch) body.tools = [{ google_search: {} }];
    return body;
  };
  // Any trouble with a searching attempt (refused, over its limit, or a model that no longer exists) moves on to the next step; only a refused key stops.
  const refusedSearch = function (e) { return !!(e && e.apiError && e.apiError !== 'ai_not_set_up'); };
  const latest = aiModel_();
  const older = aiSearchFallbackModel_();
  let json = null;
  let method = { step: 1, model: latest, searched: true };
  try {
    json = geminiCall_(make(true), latest);
  } catch (e) {
    if (!refusedSearch(e)) throw e;
    if (older && older !== latest) {
      try { json = geminiCall_(make(true), older); method = { step: 2, model: older, searched: true }; } catch (e2) { if (!refusedSearch(e2)) throw e2; }
    }
  }
  if (!json) {
    method = { step: 3, model: latest, searched: false };
    try { json = geminiCall_(make(false), latest); } catch (e3) { if (e3 && e3.apiError === 'ai_bad_request') fail_('ai_unavailable'); throw e3; }
  }
  const text = geminiText_(json);
  if (!text) fail_('ai_bad_answer');
  return { text: text, sources: aiSources_(json), method: method };
}

/** Web pages the answer was based on: { url, title }, https only, at most five. */
function aiSources_(json) {
  const cand = json.candidates && json.candidates[0];
  const chunks = (cand && cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || [];
  const seen = {};
  const out = [];
  chunks.forEach(function (c) {
    const web = c && c.web;
    if (web && web.uri && /^https:\/\//i.test(web.uri) && !seen[web.uri] && out.length < 5) { seen[web.uri] = true; out.push({ url: web.uri, title: cleanStr_(web.title, 60) }); }
  });
  return out;
}

// ---------- reading the answer ----------

/** The biggest JSON object in the text, or null. Tolerates words before or after it and a markdown fence. */
function aiExtractJson_(text) {
  const last = text.lastIndexOf('}');
  if (last < 0) return null;
  for (let start = text.indexOf('{'); start >= 0 && start < last; start = text.indexOf('{', start + 1)) {
    try {
      const v = JSON.parse(text.slice(start, last + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (e) { /* try from the next brace */ }
  }
  return null;
}

// The row's own note is only the model's doubt: rows are marked as AI's by their source, not by text added to the notes.
function aiNote_(note) { return cleanStr_(note, 200); }

/** Keep only what the app can use, in the shape it uses, and mark it as AI's. Never trusts the model's field names or lengths. */
function aiClean_(raw) {
  const d = (raw && raw.details) || {};
  const details = {};
  const text = function (k, max) { const v = cleanStr_(d[k], max); if (v) details[k] = v; };
  text('make', 40); text('model', 40); text('colour', 30); text('engineCode', 30); text('gearboxCode', 30);
  const year = cleanStr_(d.year, 6);
  if (/^\d{4}$/.test(year) && Number(year) >= 1900 && Number(year) <= new Date().getFullYear() + 1) details.year = year;
  const market = cleanStr_(d.market, 30);
  if (MARKETS.indexOf(market) !== -1) details.market = market;
  const side = cleanStr_(d.driveSide, 4).toUpperCase();
  if (DRIVE_SIDES.indexOf(side) !== -1) details.driveSide = side;
  const tank = String(d.fuelCapacity === undefined || d.fuelCapacity === null ? '' : d.fuelCapacity).replace(/[^0-9.]/g, '');
  if (/^\d{1,3}(\.\d)?$/.test(tank) && Number(tank) > 0) details.fuelCapacity = String(Number(tank));

  const fluids = [];
  const seenFluid = {};
  (Array.isArray(raw && raw.fluids) ? raw.fluids : []).forEach(function (f) {
    const name = cleanStr_(f && f.fluid, 40);
    const spec = cleanStr_(f && f.specification, 300);
    const cap = cleanStr_(f && f.capacity, 40);
    if (AI_FLUID_NAMES.indexOf(name) === -1 || seenFluid[name] || (!spec && !cap)) return;
    seenFluid[name] = true;
    fluids.push({ kind: 'fluid', fluid: name, specification: spec, capacity: cap, notes: aiNote_(f.notes), source: AI_SOURCE });
  });
  const bulbs = [];
  const seenBulb = {};
  (Array.isArray(raw && raw.bulbs) ? raw.bulbs : []).forEach(function (b) {
    const where = cleanStr_(b && b.location, 40);
    const type = cleanStr_(b && b.type, 120);
    const qty = cleanStr_(b && b.quantity, 40);
    if (AI_BULB_NAMES.indexOf(where) === -1 || seenBulb[where] || !type) return;
    seenBulb[where] = true;
    bulbs.push({ kind: 'bulb', fluid: where, specification: type, capacity: qty, notes: aiNote_(b.notes), source: AI_SOURCE });
  });
  // keep the app's own order
  fluids.sort(function (a, b) { return AI_FLUID_NAMES.indexOf(a.fluid) - AI_FLUID_NAMES.indexOf(b.fluid); });
  bulbs.sort(function (a, b) { return AI_BULB_NAMES.indexOf(a.fluid) - AI_BULB_NAMES.indexOf(b.fluid); });

  const confidence = /^(high|medium|low)$/i.test(String(raw && raw.confidence)) ? String(raw.confidence).toLowerCase() : 'low';
  return { details: details, fluids: fluids, bulbs: bulbs, summary: cleanStr_(raw && raw.summary, 300), confidence: confidence };
}

/** The candidate versions from a no-VIN search, cleaned. */
function aiCleanCandidates_(raw) {
  const list = Array.isArray(raw && raw.candidates) ? raw.candidates : [];
  const candidates = [];
  list.slice(0, AI_MAX_CANDIDATES).forEach(function (c) {
    const cleaned = aiClean_({ details: c && c.details });
    const d = cleaned.details;
    if (!d.make || !d.model) return;
    const label = cleanStr_(c.label, 120) || [d.year, d.make, d.model, d.engineCode].filter(Boolean).join(' ');
    const confidence = /^(high|medium|low)$/i.test(String(c.confidence)) ? String(c.confidence).toLowerCase() : 'low';
    candidates.push({ label: label, why: cleanStr_(c.why, 200), confidence: confidence, details: d });
  });
  return { candidates: candidates };
}

// ---------- the actions ----------

/** The shared steps of a lookup: check there is a key and enough to go on, take an allowance, ask, read, and give back the allowance if it failed. */
function aiRun_(ctx, known, prompt, shape, auditText) {
  if (!aiKey_()) fail_('ai_not_set_up');
  aiNeedEnough_(known);
  const refused = aiTake_(ctx);
  if (refused) fail_(refused);
  let asked;
  let raw;
  try {
    asked = aiAsk_(prompt);
    raw = aiExtractJson_(asked.text);
    if (!raw) fail_('ai_bad_answer');
  } catch (e) {
    aiRefund_(ctx); // a lookup that did not work does not use up the allowance
    throw e;
  }
  const out = shape(raw);
  out.sources = asked.sources;
  out.method = asked.method; // which of the three steps answered, shown in the AI box
  out.usedVin = !!known.vin;
  out.remaining = Math.max(0, aiLimit_('AI_USER_DAILY', AI_USER_DAILY) - aiUsed_(aiUserName_(ctx)));
  audit_(ctx.user, 'ai_lookup', 'Car', '', auditText(out));
  return out;
}

/** The car's details, fluids and bulbs, from a VIN or (when the person has settled on one version) the make, model and year. */
function aiFillCar_(p, ctx) {
  const known = aiKnown_(p);
  return aiRun_(ctx, known, aiFillPrompt_(known), aiClean_, function (out) {
    return 'AI lookup for ' + (known.registration || known.vin || known.make + ' ' + known.model) + ' (' + (known.vin ? 'by VIN' : 'by make and model') + ', ' + out.confidence + ' confidence, ' + out.fluids.length + ' fluids, ' + out.bulbs.length + ' bulbs)';
  });
}

/** No VIN: a few likely versions of the car for the person to choose from. */
function aiFindCar_(p, ctx) {
  const known = aiKnown_(p);
  known.vin = ''; // this step is only for cars without one
  return aiRun_(ctx, known, aiFindPrompt_(known), aiCleanCandidates_, function (out) {
    return 'AI search for ' + (known.registration || known.make + ' ' + known.model) + ': ' + out.candidates.length + ' possible match' + (out.candidates.length === 1 ? '' : 'es');
  });
}

/** Fresh suggestions for a saved car's fluids and bulbs, from what is known about it (its VIN first). Changes nothing. */
function aiRefreshSpecs_(p, ctx) {
  const car = findCar_(cleanStr_(p.carId, 64), false);
  if (!car) fail_('not_found');
  const known = aiKnown_({
    registration: car.registration, vin: car.vin, country: car.country, make: car.make, model: car.model, year: car.year, colour: car.colour,
    engineCode: car.engine_code, gearboxCode: car.gearbox_code, market: car.market, driveSide: car.drive_side, fuelCapacity: car.fuel_capacity,
  });
  const out = aiRun_(ctx, known, aiFillPrompt_(known), aiClean_, function (r) {
    return 'AI specs refresh for ' + car.registration + ' (' + (known.vin ? 'by VIN' : 'by make and model') + ', ' + r.confidence + ' confidence, ' + r.fluids.length + ' fluids, ' + r.bulbs.length + ' bulbs)';
  });
  delete out.details; // a refresh is about the specs only: the car's own details are left alone
  return out;
}


// ---------- which models can this key use? (Diagnostics, admins) ----------

const GEMINI_LIST_URL = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200';
const GEMINI_PROBE_MAX = 8; // models tried with a search (two requests each)

/**
 * Lists the Gemini models the key can use and tries the most likely ones with Google Search, twice each, so an admin can see
 * which still answer with search (and pick one for GEMINI_SEARCH_FALLBACK_MODEL). The key is never returned.
 */
function checkGeminiModels_() {
  if (!aiKey_()) fail_('ai_not_set_up');
  const headers = { 'x-goog-api-key': geminiKey_() };
  let res;
  try { res = UrlFetchApp.fetch(GEMINI_LIST_URL, { method: 'get', headers: headers, muteHttpExceptions: true }); } catch (e) { fail_('ai_unavailable'); }
  const code = res.getResponseCode();
  if (code === 401 || code === 403 || code === 400) fail_('ai_not_set_up');
  if (code >= 400) fail_('ai_unavailable');
  let list = [];
  try { list = JSON.parse(res.getContentText()).models || []; } catch (e) { fail_('ai_unavailable'); }
  const names = list.filter(function (m) {
    return m && /^models\/gemini-/.test(m.name) && (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1 &&
      !/embed|tts|image|live|audio|imagen|veo|robot|computer-use|native|learnlm|aqa/i.test(m.name);
  }).map(function (m) { return m.name.replace(/^models\//, ''); });
  // newest first (higher version numbers sort first), flash models before the rest
  const version = function (n) { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? Number(m[1]) : 0; };
  names.sort(function (a, b) {
    const fa = /flash/.test(a) ? 0 : 1, fb = /flash/.test(b) ? 0 : 1;
    return fa - fb || version(b) - version(a) || (a < b ? -1 : 1);
  });
  const wanted = [aiModel_(), aiSearchFallbackModel_()].filter(function (n, i, all) { return n && all.indexOf(n) === i; });
  const pick = names.slice(0, GEMINI_PROBE_MAX);
  wanted.forEach(function (n) { if (names.indexOf(n) !== -1 && pick.indexOf(n) === -1) pick.push(n); });

  const ask = {
    contents: [{ role: 'user', parts: [{ text: 'Search the web and answer in one short sentence: what is the current Bank of England base rate?' }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0, maxOutputTokens: 200 },
  };
  const requests = [];
  pick.forEach(function (n) {
    for (let i = 0; i < 2; i++) requests.push({ url: GEMINI_BASE + encodeURIComponent(n) + ':generateContent', method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(ask), muteHttpExceptions: true });
  });
  let replies = [];
  try { replies = UrlFetchApp.fetchAll(requests); } catch (e) { fail_('ai_unavailable'); }

  const results = pick.map(function (n, i) {
    let answered = 0, searched = false, error = '';
    [replies[i * 2], replies[i * 2 + 1]].forEach(function (r) {
      let json = null;
      try { json = JSON.parse(r.getContentText()); } catch (e) { json = null; }
      if (r.getResponseCode() < 400 && json) {
        answered++;
        const cand = json.candidates && json.candidates[0];
        const g = cand && cand.groundingMetadata;
        if (g && ((g.webSearchQueries || []).length || (g.groundingChunks || []).length)) searched = true;
      } else if (!error) {
        const err = (json && json.error) || {};
        error = 'HTTP ' + r.getResponseCode() + (err.status ? ' ' + err.status : '') + ': ' + cleanStr_(err.message || '', 140);
      }
    });
    return { model: n, answered: answered, searched: searched, error: error };
  });
  results.sort(function (a, b) { return (b.searched ? 1 : 0) - (a.searched ? 1 : 0) || b.answered - a.answered; });

  const lines = ['Models this key can use (' + names.length + '): ' + (names.join(', ') || 'none'), '',
    'Each of these was asked a question needing a web search, twice:'];
  results.forEach(function (r) {
    lines.push((r.searched && r.answered === 2 ? '✓ ' : r.searched || r.answered ? '~ ' : '✗ ') + r.model + ': ' + r.answered + ' of 2 answered' +
      (r.searched ? ', searched the web' : r.answered ? ', answered without searching' : '') + (r.error ? ' (' + r.error + ')' : ''));
  });
  const good = results.filter(function (r) { return r.searched && r.answered === 2; }).map(function (r) { return r.model; });
  lines.push('', good.length ? 'To use one for the second step, set the Script Property GEMINI_SEARCH_FALLBACK_MODEL to e.g. ' + good[0] + '.' : 'No model searched twice in a row, so searching is out of allowance for this key right now; lookups will use step 3 (no search).');
  lines.push('This check used up a few requests of the allowance.');
  return { models: names, results: results, lines: lines };
}
