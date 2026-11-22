'use strict';
// AI help for cars: "Fill in the rest" (VIN first, else make and model), a few likely matches when there is no VIN, and "Refresh specs".
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const KEY = 'AIza-test-key-1234567890';

function setup(opts) {
  const env = createEnv();
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  env.seedUser({ name: 'Ann', email: 'ann@example.com', role: 'user' });
  const sam = env.signInAs('sam@example.com');
  const ann = env.signInAs('ann@example.com');
  if (!opts || opts.key !== false) env.props.GEMINI_API_KEY = KEY;
  const fill = (extra, token) => env.call('aiFillCar', Object.assign({ token: token || sam, registration: 'ua 132fp', vin: 'knaku814se5455201' }, extra || {}));
  const find = (extra, token) => env.call('aiFindCar', Object.assign({ token: token || sam, registration: 'MV56 HUH', make: 'Kia', model: 'Sorento', year: '2013' }, extra || {}));
  return { env, sam, ann, fill, find };
}

// Gemini's reply: text, with the search sources it used.
function reply(obj, extra) {
  return {
    code: 200,
    body: {
      candidates: [Object.assign({
        content: { parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] },
        groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'example.com' } }, { web: { uri: 'http://insecure.example.com/b', title: 'insecure.example.com' } }] },
      }, extra || {})],
    },
  };
}

const GOOD = {
  details: { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Black', engineCode: 'D4HB', gearboxCode: '', market: 'European', driveSide: 'RHD', fuelCapacity: '71' },
  fluids: [{ fluid: 'Coolant', specification: 'Long-life ethylene glycol 50/50', capacity: '', notes: 'check' }, { fluid: 'Engine oil', specification: '5W-30 ACEA C3', capacity: '6.7 L', notes: '' }],
  bulbs: [{ location: 'Full beam', type: 'Halogen H1 55 W', quantity: '2', notes: '' }, { location: 'Dipped beam', type: 'Xenon D3S 35 W', quantity: '2', notes: 'Halogen versions use H7' }],
  summary: '2013 Kia Sorento 2.2 CRDi.', confidence: 'medium',
};
const MATCHES = {
  candidates: [
    { label: '2013 Kia Sorento 2.2 CRDi (D4HB), European', why: 'The common diesel', confidence: 'medium', details: { make: 'Kia', model: 'Sorento', year: '2013', engineCode: 'D4HB', market: 'European', driveSide: 'RHD', fuelCapacity: '71', colour: 'Red' } },
    { label: '2013 Kia Sorento 2.4 petrol', why: 'The petrol', confidence: 'low', details: { make: 'Kia', model: 'Sorento', year: '2013', engineCode: 'G4KE' } },
    { label: 'Not a car', details: { make: '', model: '' } },
    { label: 'Fourth', details: { make: 'Kia', model: 'Sorento' } },
    { label: 'Fifth', details: { make: 'Kia', model: 'Sorento' } },
  ],
};

test('AI lookups need a session', () => {
  const { env } = setup();
  assert.equal(env.call('aiFillCar', { registration: 'A', vin: 'B' }).error, 'unauthorized');
  assert.equal(env.call('aiFindCar', {}).error, 'unauthorized');
  assert.equal(env.call('aiRefreshSpecs', {}).error, 'unauthorized');
  assert.equal(env.call('aiStatus', {}).error, 'unauthorized');
});

test('without a key AI says it is not set up, and nothing is sent', () => {
  const { env, sam, fill, find } = setup({ key: false });
  assert.deepEqual(env.call('aiStatus', { token: sam }).data, { available: false, limit: 10, remaining: 10 });
  assert.equal(fill().error, 'ai_not_set_up');
  assert.equal(find().error, 'ai_not_set_up');
  assert.equal(env.state.geminiRequests.length, 0);
});

test('a VIN is used first: the request carries it, everything typed, and a warning to trust the VIN', () => {
  const { env, sam, fill } = setup();
  env.state.gemini = () => reply('```json\n' + JSON.stringify(GOOD) + '\n```');
  assert.deepEqual(env.call('aiStatus', { token: sam }).data, { available: true, limit: 10, remaining: 10 });
  const r = fill({ make: 'Kia', country: 'UG', engineCode: 'D4HB', colour: 'Black' });
  assert.equal(r.ok, true, r.error);
  assert.equal(env.state.geminiRequests.length, 1);
  const q = env.state.geminiRequests[0];
  assert.match(q.url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(q.headers['x-goog-api-key'], KEY);
  assert.equal(q.url.includes(KEY), false);
  assert.deepEqual(q.body.tools, [{ google_search: {} }]);
  const prompt = q.body.contents[0].parts[0].text;
  assert.match(prompt, /VIN: KNAKU814SE5455201/);
  assert.match(prompt, /UA 132FP/);
  assert.match(prompt, /Uganda/);
  assert.match(prompt, /make Kia/);
  assert.match(prompt, /engine code D4HB/);
  assert.match(prompt, /colour Black/);
  assert.match(prompt, /trust the VIN/);
  assert.match(q.body.systemInstruction.parts[0].text, /VIN, when given, decodes to the exact vehicle, so it comes before everything else/);
  assert.ok(!JSON.stringify(q.body).includes(KEY), 'the key is never put in the question');

  const d = r.data;
  assert.equal(d.usedVin, true);
  assert.deepEqual(d.details, { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Black', engineCode: 'D4HB', market: 'European', driveSide: 'RHD', fuelCapacity: '71' });
  assert.deepEqual(d.fluids.map((f) => f.fluid), ['Engine oil', 'Coolant'], 'in the app\'s order');
  assert.deepEqual(d.bulbs.map((b) => b.fluid), ['Dipped beam', 'Full beam'], 'in the app\'s order, with no "Bulb: " prefix');
  [].concat(d.fluids, d.bulbs).forEach((row) => {
    assert.ok(!/check before relying/.test(row.notes), 'no AI warning is added to the notes');
    assert.match(row.source, /AI suggestion/);
    assert.ok(row.notes.length <= 200);
  });
  assert.equal(d.bulbs[0].kind, 'bulb');
  assert.equal(d.fluids[0].kind, 'fluid');
  assert.deepEqual(d.sources, [{ url: 'https://example.com/a', title: 'example.com' }], 'only secure links');
  assert.equal(d.confidence, 'medium');
  assert.equal(d.remaining, 9);
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.ok(env.sheets.Audit._rows.slice(1).some((row) => row[3] === 'ai_lookup'));
});

test('without a VIN the make, model and everything else typed is used; the make and model are needed', () => {
  const { env, sam, fill } = setup();
  env.state.gemini = () => reply(GOOD);
  assert.equal(fill({ vin: '', make: '', model: '' }).error, 'ai_need_more');
  assert.equal(fill({ vin: '', make: 'Kia', model: '' }).error, 'ai_need_more');
  assert.equal(fill({ vin: 'a b' }).error, 'invalid_vin');
  assert.equal(env.state.geminiRequests.length, 0);
  const r = fill({ vin: '', registration: 'MV56 HUH', make: 'Kia', model: 'Sorento', year: '2013', engineCode: 'D4HB', market: 'European' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.usedVin, false);
  const prompt = env.state.geminiRequests[0].body.contents[0].parts[0].text;
  assert.equal(/VIN:/.test(prompt), false);
  assert.match(prompt, /MV56 HUH/);
  assert.match(prompt, /make Kia, model Sorento, year 2013, engine code D4HB, market European \(trust these\)/);
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 9);
});

test('with no VIN, a few likely matches are offered: at most three, only usable ones, cleaned', () => {
  const { env, sam, find } = setup();
  env.state.gemini = () => reply(MATCHES);
  const r = find({ vin: 'KNAKU814SE5455201' }); // a VIN is ignored by this step: it is only for cars without one
  assert.equal(r.ok, true, r.error);
  assert.equal(/VIN:/.test(env.state.geminiRequests[0].body.contents[0].parts[0].text), false);
  assert.match(env.state.geminiRequests[0].body.contents[0].parts[0].text, /There is no VIN/);
  const c = r.data.candidates;
  assert.deepEqual(c.map((x) => x.label), ['2013 Kia Sorento 2.2 CRDi (D4HB), European', '2013 Kia Sorento 2.4 petrol'], 'the empty one is dropped, and only the first three are looked at');
  assert.deepEqual(c[0].details, { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Red', engineCode: 'D4HB', market: 'European', driveSide: 'RHD', fuelCapacity: '71' });
  assert.equal(c[0].confidence, 'medium');
  assert.equal(c[1].confidence, 'low');
  assert.equal(c[0].why, 'The common diesel');
  assert.equal(r.data.remaining, 9);
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 9);
  assert.equal(find({ make: 'Kia', model: '' }).error, 'ai_need_more');
  env.state.gemini = () => reply({ candidates: [] });
  assert.deepEqual(find().data.candidates, []);
});

test('refresh specs: a saved car is looked up by its VIN first, then its make and model; details are left alone', () => {
  const { env, sam } = setup();
  env.state.gemini = () => reply(GOOD);
  const car = env.call('saveCar', { token: sam, fields: { registration: 'MV56 HUH', make: 'Kia', model: 'Sorento', year: '2013', vin: 'KNAKU814SE5455201', engineCode: 'D4HB', odometer: '1' } }).data.car;
  const r = env.call('aiRefreshSpecs', { token: sam, carId: car.id });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.usedVin, true);
  assert.equal(r.data.details, undefined);
  assert.deepEqual(r.data.fluids.map((f) => f.fluid), ['Engine oil', 'Coolant']);
  const prompt = env.state.geminiRequests[0].body.contents[0].parts[0].text;
  assert.match(prompt, /VIN: KNAKU814SE5455201/);
  assert.match(prompt, /engine code D4HB/);
  const noVin = env.call('saveCar', { token: sam, fields: { registration: 'ZZ99 ZZZ', make: 'Toyota', model: 'Hilux', year: '2012', odometer: '1' } }).data.car;
  const r2 = env.call('aiRefreshSpecs', { token: sam, carId: noVin.id });
  assert.equal(r2.data.usedVin, false);
  assert.equal(/VIN:/.test(env.state.geminiRequests[1].body.contents[0].parts[0].text), false);
  assert.equal(env.call('aiRefreshSpecs', { token: sam, carId: 'nope' }).error, 'not_found');
  // nothing was changed on the car
  assert.equal(env.call('getCar', { token: sam, id: car.id }).data.car.engineCode, 'D4HB');
});

const SEARCH_ERR = { code: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for grounding requests' } } };
const modelOf = (q) => /models\/([^:]+):/.exec(q.url)[1];

test('step 2: if the latest model cannot search, an older 2.5 model is asked, still with Google Search', () => {
  const { env, fill } = setup();
  env.state.gemini = (q) => (modelOf(q) === 'gemini-3.5-flash-lite' ? SEARCH_ERR : reply(GOOD));
  const r = fill();
  assert.equal(r.ok, true, r.error);
  const sent = env.state.geminiRequests;
  assert.deepEqual(sent.map(modelOf), ['gemini-3.5-flash-lite', 'gemini-2.5-flash']);
  assert.deepEqual(sent.map((q) => !!q.body.tools), [true, true]);
  assert.deepEqual(r.data.method, { step: 2, model: 'gemini-2.5-flash', searched: true });
  assert.match(env.props.GEMINI_LAST_ERROR, /HTTP 429 RESOURCE_EXHAUSTED · gemini-3\.5-flash-lite with Google Search: Quota exceeded for grounding requests/);
  assert.equal(env.props.GEMINI_LAST_ERROR.includes(KEY), false);
});

test('the older search model can be chosen with GEMINI_SEARCH_FALLBACK_MODEL', () => {
  const { env, fill } = setup();
  env.props.GEMINI_SEARCH_FALLBACK_MODEL = 'gemini-2.5-flash-lite';
  env.state.gemini = (q) => (modelOf(q) === 'gemini-3.5-flash-lite' ? SEARCH_ERR : reply(GOOD));
  assert.equal(fill().ok, true);
  assert.deepEqual(env.state.geminiRequests.map(modelOf), ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite']);
});

test('step 3: if searching fails completely, the latest model answers without searching, and the answer says so', () => {
  const { env, fill } = setup();
  env.state.gemini = (q) => (q.body.tools ? { code: 400, body: { error: { message: 'Search tool is not supported' } } } : reply(GOOD));
  const r = fill();
  assert.equal(r.ok, true, r.error);
  const sent = env.state.geminiRequests;
  assert.deepEqual(sent.map(modelOf), ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash-lite']);
  assert.deepEqual(sent.map((q) => !!q.body.tools), [true, true, false]);
  assert.deepEqual(r.data.method, { step: 3, model: 'gemini-3.5-flash-lite', searched: false });
  [].concat(r.data.fluids, r.data.bulbs).forEach((row) => assert.equal(row.source, 'AI suggestion (Gemini with Google Search), not verified', 'rows carry the same hidden marker whichever step answered'));
  env.state.geminiRequests.length = 0;
  env.state.gemini = () => ({ code: 400, body: { error: { message: 'bad' } } });
  assert.equal(fill().error, 'ai_unavailable');
});

test('when the latest model is already the older one, search is not tried twice; and a key problem stops at once', () => {
  const { env, fill } = setup();
  env.props.GEMINI_CAR_MODEL = 'gemini-2.5-flash';
  env.state.gemini = (q) => (q.body.tools ? SEARCH_ERR : reply(GOOD));
  assert.equal(fill().ok, true);
  assert.deepEqual(env.state.geminiRequests.map((q) => !!q.body.tools), [true, false]);
  env.state.geminiRequests.length = 0;
  env.state.gemini = () => ({ code: 403, body: { error: { message: 'API key not valid' } } });
  assert.equal(fill().error, 'ai_not_set_up');
  assert.equal(env.state.geminiRequests.length, 1);
});

test('a model that no longer exists (404) at step 1 or 2 just moves on to the next step', () => {
  const { env, fill } = setup();
  const gone = { code: 404, body: { error: { status: 'NOT_FOUND', message: 'This model models/gemini-2.5-flash is no longer available to new users.' } } };
  env.state.gemini = (q) => (modelOf(q) === 'gemini-2.5-flash' ? gone : q.body.tools ? SEARCH_ERR : reply(GOOD));
  const r = fill();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.method, { step: 3, model: 'gemini-3.5-flash-lite', searched: false });
  assert.deepEqual(env.state.geminiRequests.map(modelOf), ['gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.5-flash-lite']);
  // the latest model itself missing at step 1 also falls through to step 2
  env.state.geminiRequests.length = 0;
  env.state.gemini = (q) => (modelOf(q) === 'gemini-3.5-flash-lite' ? gone : reply(GOOD));
  assert.deepEqual(fill().data.method, { step: 2, model: 'gemini-2.5-flash', searched: true });
});

test('busy at every step: the person is told', () => {
  const { env, fill } = setup();
  env.state.gemini = () => ({ code: 429, body: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Too many requests' } } });
  assert.equal(fill().error, 'ai_busy');
  assert.equal(env.state.geminiRequests.length, 3);
});

test('only values the app can use get through', () => {
  const { env, fill } = setup();
  env.state.gemini = () => reply({
    details: { make: 'K'.repeat(100), model: 'Sorento', year: '1850', colour: '', engineCode: '<b>D4HB</b>', gearboxCode: 5, market: 'Martian', driveSide: 'left', fuelCapacity: 'lots' },
    fluids: [
      { fluid: 'Rocket fuel', specification: 'x' }, { fluid: 'Bulb: Dipped beam', specification: 'x' }, { fluid: 'Coolant', specification: '' },
      { fluid: 'Engine oil', specification: 'a' }, { fluid: 'Engine oil', specification: 'b' }, { fluid: 'Brake fluid', specification: 'S'.repeat(500), notes: 'N'.repeat(500) },
    ],
    bulbs: [{ location: 'Roof', type: 'x' }, { location: 'Front fog', type: '' }, { location: 'Front fog', type: 'Halogen H8 35 W' }, { location: 'Front fog', type: 'dup' }],
    confidence: 'certain', summary: 'S'.repeat(1000),
  });
  const d = fill().data;
  assert.equal(d.details.make.length, 40);
  assert.equal(d.details.year, undefined, 'a year that cannot be right');
  assert.equal(d.details.market, undefined);
  assert.equal(d.details.driveSide, undefined);
  assert.equal(d.details.fuelCapacity, undefined);
  assert.equal(d.details.gearboxCode, '5');
  assert.deepEqual(d.fluids.map((f) => [f.fluid, f.specification.slice(0, 3)]), [['Engine oil', 'a'], ['Brake fluid', 'SSS']]);
  assert.equal(d.fluids[1].specification.length, 250);
  assert.ok(d.fluids[1].notes.length <= 200);
  assert.deepEqual(d.bulbs.map((b) => [b.fluid, b.specification]), [['Front fog', 'Halogen H8 35 W']]);
  assert.equal(d.confidence, 'low', 'an unknown confidence is treated as low');
  assert.ok(d.summary.length <= 300);
});

test('the answer can have words around the JSON, but an answer with no JSON is refused and does not use up a lookup', () => {
  const { env, sam, fill } = setup();
  env.state.gemini = () => reply('Here is the vehicle: ' + JSON.stringify({ details: { make: 'Kia' }, fluids: [], bulbs: [] }) + ' Hope that helps!');
  assert.equal(fill().data.details.make, 'Kia');
  env.state.gemini = () => reply('Sorry, I could not find that vehicle.');
  assert.equal(fill().error, 'ai_bad_answer');
  env.state.gemini = () => ({ code: 200, body: { candidates: [] } });
  assert.equal(fill().error, 'ai_bad_answer');
  env.state.gemini = () => ({ code: 200, body: { candidates: [{ finishReason: 'SAFETY' }] } });
  assert.equal(fill().error, 'ai_bad_answer');
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 9, 'only the one that worked was counted');
});

test('problems with the service are named, and none of them uses up a lookup', () => {
  const { env, sam, fill } = setup();
  const cases = [
    [{ code: 401, body: { error: { message: 'unauthenticated' } } }, 'ai_not_set_up'],
    [{ code: 403, body: {} }, 'ai_not_set_up'],
    [{ code: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } }, 'ai_not_set_up'],
    [{ code: 429, body: { error: { status: 'RESOURCE_EXHAUSTED' } } }, 'ai_busy'],
    [{ code: 503, body: {} }, 'ai_busy'],
    [{ code: 500, body: 'oops' }, 'ai_unavailable'],
    [new Error('Timeout: https://generativelanguage.googleapis.com'), 'ai_unavailable'],
  ];
  cases.forEach(([resp, code]) => {
    env.state.gemini = () => resp;
    assert.equal(fill().error, code, code);
  });
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 10);
});

test('each person has a daily allowance, the app has one too, and they reset the next day', () => {
  const { env, sam, ann, fill } = setup();
  env.state.gemini = () => reply(GOOD);
  for (let i = 0; i < 10; i++) assert.equal(fill().ok, true, 'lookup ' + (i + 1));
  assert.equal(fill().error, 'ai_limit_user');
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 0);
  assert.equal(fill({}, ann).ok, true, 'another person has their own');
  assert.equal(env.state.geminiRequests.length, 11, 'the refused one never reached the service');
  env.advance(26 * 3600 * 1000);
  const again = env.signInAs('sam@example.com');
  assert.equal(env.call('aiStatus', { token: again }).data.remaining, 10, 'a new day');
  assert.equal(fill({}, again).ok, true);

  // the whole app's limit (here set low): the person is not charged for the refused one
  env.props.AI_APP_DAILY = '2';
  env.advance(26 * 3600 * 1000);
  const sam3 = env.signInAs('sam@example.com');
  const ann3 = env.signInAs('ann@example.com');
  assert.equal(fill({}, sam3).ok, true);
  assert.equal(fill({}, ann3).ok, true);
  assert.equal(fill({}, sam3).error, 'ai_limit_app');
  assert.equal(env.call('aiStatus', { token: sam3 }).data.remaining, 9, 'only the lookup that ran was counted');
});

test('the person limit and the model can be changed with script properties', () => {
  const { env, sam, fill } = setup();
  env.state.gemini = () => reply(GOOD);
  env.props.AI_USER_DAILY = '2';
  env.props.GEMINI_CAR_MODEL = 'gemini-custom-pro';
  assert.equal(fill().ok, true);
  assert.match(env.state.geminiRequests[0].url, /models\/gemini-custom-pro:generateContent$/);
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 1);
  assert.equal(fill().ok, true);
  assert.equal(fill().error, 'ai_limit_user');
  delete env.props.GEMINI_CAR_MODEL;
  env.props.GEMINI_MODEL = 'gemini-other';
  env.props.AI_USER_DAILY = '5';
  env.state.geminiRequests.length = 0;
  assert.equal(fill().ok, true);
  assert.match(env.state.geminiRequests[0].url, /models\/gemini-other:generateContent$/);
});

test('the model check lists what the key can use and tries the likely ones with a search, twice each (admins only)', () => {
  const { env, sam } = setup();
  env.seedUser({ name: 'Admin', email: 'admin@example.com', role: 'admin' });
  const admin = env.signInAs('admin@example.com');
  const LIST = { models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.8-pro', 'gemini-embedding-001', 'gemini-3.8-flash-preview-tts', 'gemma-3-27b'].map((n) => ({ name: 'models/' + n, supportedGenerationMethods: n.includes('embedding') ? ['embedContent'] : ['generateContent'] })) };
  const grounded = { candidates: [{ content: { parts: [{ text: 'x' }] }, groundingMetadata: { webSearchQueries: ['q'] } }] };
  env.state.gemini = (q) => {
    if (!q.body) return { code: 200, body: LIST };
    const m = modelOf(q);
    if (m === 'gemini-3.8-flash') return { code: 200, body: grounded };
    if (m === 'gemini-3.5-flash-lite') return SEARCH_ERR;
    if (m === 'gemini-2.5-flash') return { code: 404, body: { error: { status: 'NOT_FOUND', message: 'no longer available' } } };
    return { code: 200, body: { candidates: [{ content: { parts: [{ text: 'x' }] } }] } };
  };
  assert.equal(env.call('checkGeminiModels', { token: sam }).error, 'forbidden');
  const r = env.call('checkGeminiModels', { token: admin });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.models, ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash', 'gemini-3.8-pro'], 'no embeddings, speech or other families');
  assert.equal(r.data.results[0].model, 'gemini-3.8-flash');
  assert.deepEqual([r.data.results[0].answered, r.data.results[0].searched], [2, true]);
  assert.match(r.data.lines.join('\n'), /✗ gemini-2\.5-flash: 0 of 2 answered.*NOT_FOUND/);
  assert.match(r.data.lines.join('\n'), /GEMINI_SEARCH_FALLBACK_MODEL to e\.g\. gemini-3\.8-flash/);
  assert.equal(JSON.stringify(r).includes(KEY), false);
  assert.equal(env.state.geminiRequests.filter((q) => q.body).length, 8, 'two searches for each of four models');
});
