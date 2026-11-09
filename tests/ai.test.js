'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./harness');

const KEY = 'sk-ant-test-key-1234567890';

function setup(opts) {
  const env = createEnv();
  env.seedUser({ name: 'Sam', email: 'sam@example.com', role: 'user' });
  env.seedUser({ name: 'Ann', email: 'ann@example.com', role: 'user' });
  const sam = env.signInAs('sam@example.com');
  const ann = env.signInAs('ann@example.com');
  if (!opts || opts.key !== false) env.props.ANTHROPIC_API_KEY = KEY;
  const fill = (extra, token) => env.call('aiFillCar', Object.assign({ token: token || sam, registration: 'ua 132fp', vin: 'knaku814se5455201' }, extra || {}));
  return { env, sam, ann, fill };
}

// A reply like the real one: a search, its results, then the answer (with citations) as text.
function reply(obj, extra) {
  return {
    code: 200,
    body: Object.assign({
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'I will search for the vehicle.' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'KNAKU814SE5455201' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com/a', title: 'A', encrypted_content: 'xyz' }] },
        { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj), citations: [{ type: 'web_search_result_location', url: 'https://example.com/a', title: 'A', cited_text: '...' }, { type: 'web_search_result_location', url: 'http://insecure.example.com/b', title: 'B', cited_text: '...' }] },
      ],
      usage: { input_tokens: 1000, output_tokens: 500 },
    }, extra || {}),
  };
}

const GOOD = {
  details: { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Black', engineCode: 'D4HB', gearboxCode: '', market: 'European', driveSide: 'RHD', fuelCapacity: '71' },
  fluids: [{ fluid: 'Coolant', specification: 'Long-life ethylene glycol 50/50', capacity: '', notes: 'check' }, { fluid: 'Engine oil', specification: '5W-30 ACEA C3', capacity: '6.7 L', notes: '' }],
  bulbs: [{ location: 'Full beam', type: 'Halogen H1 55 W', quantity: '2', notes: '' }, { location: 'Dipped beam', type: 'Xenon D3S 35 W', quantity: '2', notes: 'Halogen versions use H7' }],
  summary: '2013 Kia Sorento 2.2 CRDi.', confidence: 'medium',
};

test('AI lookup needs a session', () => {
  const { env } = setup();
  assert.equal(env.call('aiFillCar', { registration: 'A', vin: 'B' }).error, 'unauthorized');
  assert.equal(env.call('aiStatus', {}).error, 'unauthorized');
});

test('without a key AI says it is not set up, and nothing is sent', () => {
  const { env, sam, fill } = setup({ key: false });
  assert.deepEqual(env.call('aiStatus', { token: sam }).data, { available: false, limit: 10, remaining: 10 });
  assert.equal(fill().error, 'ai_not_set_up');
  assert.equal(env.state.aiRequests.length, 0);
});

test('a lookup sends the right request to Claude and returns tidy, marked suggestions', () => {
  const { env, sam, fill } = setup();
  env.state.anthropic = () => reply('```json\n' + JSON.stringify(GOOD) + '\n```');
  assert.deepEqual(env.call('aiStatus', { token: sam }).data, { available: true, limit: 10, remaining: 10 });
  const r = fill({ make: 'Kia', country: 'UG' });
  assert.equal(r.ok, true, r.error);

  // the request
  assert.equal(env.state.aiRequests.length, 1);
  const q = env.state.aiRequests[0];
  assert.equal(q.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(q.headers['x-api-key'], KEY);
  assert.ok(q.headers['anthropic-version']);
  assert.equal(q.body.model, 'claude-opus-5-5');
  assert.deepEqual(q.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
  assert.deepEqual(q.body.output_config, { effort: 'low' });
  assert.equal(q.body.messages.length, 1);
  assert.match(q.body.messages[0].content, /UA 132FP/);
  assert.match(q.body.messages[0].content, /KNAKU814SE5455201/);
  assert.match(q.body.messages[0].content, /Uganda/);
  assert.match(q.body.messages[0].content, /make Kia/);
  assert.ok(!JSON.stringify(q.body).includes(KEY), 'the key is never put in the question');

  // the answer
  const d = r.data;
  assert.deepEqual(d.details, GOOD.details && { make: 'Kia', model: 'Sorento', year: '2013', colour: 'Black', engineCode: 'D4HB', market: 'European', driveSide: 'RHD', fuelCapacity: '71' });
  assert.deepEqual(d.fluids.map((f) => f.fluid), ['Engine oil', 'Coolant'], 'in the app\'s order');
  assert.deepEqual(d.bulbs.map((b) => b.fluid), ['Dipped beam', 'Full beam'], 'in the app\'s order, with no "Bulb: " prefix');
  [].concat(d.fluids, d.bulbs).forEach((row) => {
    assert.match(row.notes, /AI suggestion: check before relying on it\.$/);
    assert.match(row.source, /AI suggestion/);
    assert.ok(row.notes.length <= 200);
  });
  assert.equal(d.bulbs[0].kind, 'bulb');
  assert.equal(d.fluids[0].kind, 'fluid');
  assert.equal(d.bulbs[0].capacity, '2');
  assert.match(d.bulbs[0].notes, /^Halogen versions use H7 AI suggestion/);
  assert.deepEqual(d.sources, ['https://example.com/a'], 'only secure links');
  assert.equal(d.confidence, 'medium');
  assert.equal(d.remaining, 9);
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.ok(env.sheets.Audit._rows.slice(1).some((row) => row[3] === 'ai_lookup'));
});

test('only values the app can use get through', () => {
  const { env, fill } = setup();
  env.state.anthropic = () => reply({
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
  assert.equal(d.fluids[1].specification.length, 120);
  assert.ok(d.fluids[1].notes.length <= 200);
  assert.deepEqual(d.bulbs.map((b) => [b.fluid, b.specification]), [['Front fog', 'Halogen H8 35 W']]);
  assert.equal(d.confidence, 'low', 'an unknown confidence is treated as low');
  assert.ok(d.summary.length <= 300);
});

test('the answer can have words around the JSON, but an answer with no JSON is refused and does not use up a lookup', () => {
  const { env, sam, fill } = setup();
  env.state.anthropic = () => reply('Here is the vehicle: ' + JSON.stringify({ details: { make: 'Kia' }, fluids: [], bulbs: [] }) + ' Hope that helps!');
  assert.equal(fill().data.details.make, 'Kia');
  env.state.anthropic = () => reply('Sorry, I could not find that vehicle.');
  assert.equal(fill().error, 'ai_bad_answer');
  env.state.anthropic = () => ({ code: 200, body: { stop_reason: 'refusal', content: [] } });
  assert.equal(fill().error, 'ai_bad_answer');
  env.state.anthropic = () => ({ code: 200, body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"details":' }] } });
  assert.equal(fill().error, 'ai_bad_answer');
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 9, 'only the one that worked was counted');
});

test('a paused lookup is resumed by sending the paused answer back, and a lookup that stays paused gives up', () => {
  const { env, sam, fill } = setup();
  const paused = { stop_reason: 'pause_turn', content: [{ type: 'text', text: 'Searching' }, { type: 'server_tool_use', id: 'srvtoolu_9', name: 'web_search', input: { query: 'x' } }] };
  let n = 0;
  env.state.anthropic = () => (++n === 1 ? { code: 200, body: paused } : reply(GOOD));
  const r = fill();
  assert.equal(r.ok, true, r.error);
  assert.equal(env.state.aiRequests.length, 2);
  const second = env.state.aiRequests[1].body.messages;
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant'], 'no extra "continue" message');
  assert.deepEqual(second[1].content, paused.content);
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 9, 'a resumed lookup is still one lookup');

  env.state.aiRequests.length = 0;
  env.state.anthropic = () => ({ code: 200, body: paused });
  assert.equal(fill().error, 'ai_bad_answer');
  assert.equal(env.state.aiRequests.length, 3, 'one try and two resumes, then it stops');
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 9);
});

test('problems with the service are named, and none of them uses up a lookup', () => {
  const { env, sam, fill } = setup();
  const cases = [
    [{ code: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }, 'ai_not_set_up'],
    [{ code: 403, body: {} }, 'ai_not_set_up'],
    [{ code: 429, body: { error: { type: 'rate_limit_error' } } }, 'ai_busy'],
    [{ code: 529, body: {} }, 'ai_busy'],
    [{ code: 400, body: { error: { type: 'invalid_request_error', message: 'Web search is not enabled for your organization' } } }, 'ai_search_disabled'],
    [{ code: 500, body: 'oops' }, 'ai_unavailable'],
    [{ code: 400, body: { error: { message: 'something else' } } }, 'ai_unavailable'],
    [new Error('Timeout: https://api.anthropic.com'), 'ai_unavailable'],
  ];
  cases.forEach(([resp, code]) => {
    env.state.anthropic = () => resp;
    assert.equal(fill().error, code, code);
  });
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 10);
});

test('each person has a daily allowance, the app has one too, and they reset the next day', () => {
  const { env, sam, ann, fill } = setup();
  env.state.anthropic = () => reply(GOOD);
  for (let i = 0; i < 10; i++) assert.equal(fill().ok, true, 'lookup ' + (i + 1));
  assert.equal(fill().error, 'ai_limit_user');
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 0);
  assert.equal(fill({}, ann).ok, true, 'another person has their own');
  assert.equal(env.state.aiRequests.length, 11, 'the refused one never reached the service');
  env.advance(26 * 3600 * 1000);
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 10, 'a new day');
  assert.equal(fill().ok, true);

  // the whole app's limit (here set low): the person is not charged for the refused one
  env.props.AI_APP_DAILY = '2';
  env.advance(26 * 3600 * 1000);
  assert.equal(fill().ok, true);
  assert.equal(fill({}, ann).ok, true);
  assert.equal(fill().error, 'ai_limit_app');
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 9, 'only the lookup that ran was counted');
});

test('the person limit and the model can be changed with script properties', () => {
  const { env, sam, fill } = setup();
  env.state.anthropic = () => reply(GOOD);
  env.props.AI_USER_DAILY = '2';
  env.props.AI_MODEL = 'claude-sonnet-5-5';
  assert.equal(fill().ok, true);
  assert.equal(env.state.aiRequests[0].body.model, 'claude-sonnet-5-5');
  assert.equal(env.call('aiStatus', { token: sam }).data.remaining, 1);
  assert.equal(fill().ok, true);
  assert.equal(fill().error, 'ai_limit_user');
  env.props.AI_MODEL = 'some-older-model';
  env.props.AI_USER_DAILY = '5';
  env.state.aiRequests.length = 0;
  assert.equal(fill().ok, true);
  assert.equal(env.state.aiRequests[0].body.output_config, undefined, 'the effort setting is only sent to models that take it');
});

test('a registration and a valid VIN are needed', () => {
  const { env, fill } = setup();
  env.state.anthropic = () => reply(GOOD);
  assert.equal(fill({ registration: '' }).error, 'registration_required');
  assert.equal(fill({ vin: '' }).error, 'ai_need_vin');
  assert.equal(fill({ vin: 'no good!' }).error, 'invalid_vin');
  assert.equal(env.state.aiRequests.length, 0);
});
