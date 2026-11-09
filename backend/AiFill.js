/**
 * "Fill in the rest with AI" for a new car.
 *
 * Given a registration number and a VIN, asks Anthropic's Claude (with its web search tool, so it looks the car up
 * rather than only remembering) for the car's details, its standard fluids and its bulbs. Nothing is saved here:
 * the answer goes back to the Add car form, which fills only the empty boxes, so the person checks it before saving.
 *
 * AI answers are not always right. Everything this returns is marked as an AI suggestion so it is never mistaken for
 * a checked fact. The key lives in the Script Property ANTHROPIC_API_KEY and is never sent to the phone.
 * Optional Script Properties: AI_MODEL (default claude-opus-5-5), AI_USER_DAILY and AI_APP_DAILY (limits).
 */

const AI_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const AI_API_VERSION = '2026-10-21';
const AI_DEFAULT_MODEL = 'claude-opus-5-5';
const AI_USER_DAILY = 10;   // lookups per person per day
const AI_APP_DAILY = 100;   // lookups for everyone together per day (keeps the cost predictable)
const AI_MAX_SEARCHES = 3;  // web searches per lookup
const AI_BUDGET_MS = 45000; // Apps Script gives one outside request about a minute: do not start another after this
const AI_MAX_CONTINUES = 2; // how often a paused lookup is resumed
const AI_MARK = 'AI suggestion: check before relying on it.';
const AI_SOURCE = 'AI suggestion (Claude with web search), not verified';

// The names the app uses (they must match the standard lists in web/views-cars.js).
const AI_FLUID_NAMES = ['Engine oil', 'Gearbox oil / ATF', 'Front differential oil', 'Rear differential oil', 'Transfer case oil',
  'Coolant', 'Brake fluid', 'Power steering fluid', 'AC refrigerant'];
const AI_BULB_NAMES = ['Dipped beam', 'Full beam', 'Front side light', 'Front indicator', 'Rear indicator', 'Front fog', 'Rear fog',
  'Front daytime running', 'Rear light', 'Rear brake light', 'Rear reverse light'];

function aiKey_() {
  return String(props_().getProperty('ANTHROPIC_API_KEY') || '').trim();
}

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

// ---------- the question ----------

function aiSystemPrompt_() {
  return [
    'You research vehicles for a small fleet-records app. You are given a registration number and a VIN and you look the vehicle up',
    '(use web search: search for the VIN, the registration and the model and year) to fill in its record.',
    'Be accurate rather than complete. Fill a field only if you are reasonably sure it is right for this exact vehicle;',
    'otherwise leave it as an empty string or leave the item out. A wrong value is worse than a blank one.',
    'Never invent a colour: only give one if a source states it for this specific vehicle.',
    'Reply with ONE JSON object and nothing else (no explanation, no markdown fence).',
  ].join(' ');
}

function aiUserPrompt_(input) {
  const lines = [
    'Registration number: ' + input.registration,
    'VIN: ' + input.vin,
    'The car is kept in: ' + (input.country === 'UG' ? 'Uganda' : 'the United Kingdom'),
  ];
  const typed = [];
  if (input.make) typed.push('make ' + input.make);
  if (input.model) typed.push('model ' + input.model);
  if (input.year) typed.push('year ' + input.year);
  if (typed.length) lines.push('The person has already typed: ' + typed.join(', ') + ' (trust these).');
  lines.push(
    '',
    'Return this JSON object (every key present; use "" or [] when unknown):',
    '{',
    '  "details": {',
    '    "make": "", "model": "", "year": "",  // year as 4 digits',
    '    "colour": "",',
    '    "engineCode": "",  // the manufacturer engine code, e.g. D4HB',
    '    "gearboxCode": "", // the transmission code if known',
    '    "market": "",      // exactly one of: ' + MARKETS.join(' | ') + ' (where it was built and sold for)',
    '    "driveSide": "",   // LHD or RHD',
    '    "fuelCapacity": "" // fuel tank size in litres, a number',
    '  },',
    '  "fluids": [  // only from these names: ' + AI_FLUID_NAMES.join(', '),
    '    { "fluid": "Engine oil", "specification": "e.g. 5W-30 ACEA C3", "capacity": "e.g. 6.7 L", "notes": "" }',
    '  ],',
    '  "bulbs": [   // only from these locations: ' + AI_BULB_NAMES.join(', '),
    '    { "location": "Dipped beam", "type": "bulb type then the specific bulb, e.g. Halogen H7 55 W", "quantity": "e.g. 2", "notes": "" }',
    '  ],',
    '  "summary": "one or two sentences: what vehicle this is and how sure you are",',
    '  "confidence": "high, medium or low"',
    '}',
    'Keep every string short. Put any doubt in "notes" (for example "xenon cars use D1S instead").'
  );
  return lines.join('\n');
}

function aiRequestBody_(input) {
  const model = String(props_().getProperty('AI_MODEL') || AI_DEFAULT_MODEL).trim() || AI_DEFAULT_MODEL;
  const body = {
    model: model,
    max_tokens: 4000,
    system: aiSystemPrompt_(),
    messages: [{ role: 'user', content: aiUserPrompt_(input) }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: AI_MAX_SEARCHES }],
  };
  // A quick, light lookup suits this job (and Apps Script waits about a minute at most for the answer).
  if (/^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model)) body.output_config = { effort: 'low' };
  return body;
}

// ---------- talking to Claude ----------

/** One request. Returns the parsed response, or throws an API error code. */
function aiPost_(body) {
  let res;
  try {
    res = UrlFetchApp.fetch(AI_ENDPOINT, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': aiKey_(), 'anthropic-version': AI_API_VERSION },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
  } catch (e) {
    fail_('ai_unavailable'); // no answer in time, or the service could not be reached
  }
  const code = res.getResponseCode();
  let json = null;
  try { json = JSON.parse(res.getContentText()); } catch (e) { json = null; }
  if (code === 401 || code === 403) fail_('ai_not_set_up');
  if (code === 429 || code === 529) fail_('ai_busy');
  if (code === 400 && json && json.error && /web search/i.test(String(json.error.message || ''))) fail_('ai_search_disabled');
  if (code >= 400 || !json) fail_('ai_unavailable');
  return json;
}

/** Ask, and if the lookup was paused part-way, resume it (within the time we have). */
function aiAsk_(input) {
  const started = Date.now();
  const body = aiRequestBody_(input);
  let response = aiPost_(body);
  for (let i = 0; i < AI_MAX_CONTINUES && response.stop_reason === 'pause_turn' && Date.now() - started < AI_BUDGET_MS; i++) {
    // resume by sending the paused answer back unchanged; the server carries on where it stopped
    body.messages = [body.messages[0], { role: 'assistant', content: response.content }];
    response = aiPost_(body);
  }
  if (response.stop_reason === 'pause_turn' || response.stop_reason === 'max_tokens' || response.stop_reason === 'refusal') fail_('ai_bad_answer');
  return response;
}

// ---------- reading the answer ----------

/** The answer's text: every text block, joined. (Search results and citations are other kinds of block.) */
function aiText_(response) {
  return (response.content || []).filter(function (b) { return b && b.type === 'text'; }).map(function (b) { return b.text || ''; }).join('\n');
}

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

/** Web addresses the answer used, for "where did this come from". Only https links, at most five. */
function aiSources_(response) {
  const seen = {};
  const out = [];
  (response.content || []).forEach(function (b) {
    (b && b.citations || []).forEach(function (c) {
      const url = c && c.url;
      if (url && /^https:\/\//i.test(url) && !seen[url] && out.length < 5) { seen[url] = true; out.push(url); }
    });
  });
  return out;
}

function aiNote_(note) {
  const room = 200 - AI_MARK.length - 1;
  const n = cleanStr_(note, room);
  return n ? n + ' ' + AI_MARK : AI_MARK;
}

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
    const spec = cleanStr_(f && f.specification, 120);
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

// ---------- the action ----------

function aiFillCar_(p, ctx) {
  if (!aiKey_()) fail_('ai_not_set_up');
  const registration = cleanStr_(p.registration, 20).toUpperCase();
  const vin = cleanStr_(p.vin, 30).toUpperCase().replace(/\s+/g, '');
  if (!registration) fail_('registration_required');
  if (!vin) fail_('ai_need_vin');
  if (!/^[A-Z0-9-]{5,25}$/.test(vin)) fail_('invalid_vin');
  const input = {
    registration: registration, vin: vin, country: p.country === 'UG' ? 'UG' : 'UK',
    make: cleanStr_(p.make, 40), model: cleanStr_(p.model, 40), year: cleanStr_(p.year, 4),
  };

  const refused = aiTake_(ctx);
  if (refused) fail_(refused);
  let response;
  try {
    response = aiAsk_(input);
  } catch (e) {
    aiRefund_(ctx); // a lookup that did not work does not use up the allowance
    throw e;
  }
  const raw = aiExtractJson_(aiText_(response));
  if (!raw) {
    aiRefund_(ctx);
    fail_('ai_bad_answer');
  }
  const out = aiClean_(raw);
  out.sources = aiSources_(response);
  out.remaining = Math.max(0, aiLimit_('AI_USER_DAILY', AI_USER_DAILY) - aiUsed_(aiUserName_(ctx)));
  audit_(ctx.user, 'ai_lookup', 'Car', '', 'AI lookup for ' + registration + ' (' + out.confidence + ' confidence, ' + out.fluids.length + ' fluids, ' + out.bulbs.length + ' bulbs)');
  return out;
}
