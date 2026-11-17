const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../app/src/main/assets/web/reasoning-policy.js');

test('model names do not establish capabilities; absent provider metadata uses standard requests', () => {
  for (const id of ['gpt-6.1-sol','gpt-6-astra','claude-fixture','relay/custom-model']) {
    assert.deepEqual(policy.supported({id}, false), []);
    assert.deepEqual(policy.supported({id}, true), ['low','medium','high']);
    assert.deepEqual(policy.supported({id, supportedReasoningEfforts:[]}, true), ['low','medium','high']);
    assert.equal(policy.validSelection('max', {id}, true), false);
  }
});

test('selection preserves eligible requests and resolves excluded defaults to available levels', () => {
  const model = {id:'custom-model'};
  assert.equal(policy.choose({model, thirdParty:true}), 'medium');
  assert.equal(policy.choose({previous:'high', model, thirdParty:true}), 'high');
  assert.equal(policy.choose({previous:'ultra', fallback:'none', model, thirdParty:true}), 'medium');
  assert.equal(policy.choose({model}), '');
});

test('runtime metadata bounds eligible levels for every provider', () => {
  const model = {id:'custom-model', supportedReasoningEfforts:[{reasoningEffort:'high'}, 'low', 'unknown', null, 'HIGH', 'ultra']};
  for (const thirdParty of [false,true]) {
    assert.deepEqual(policy.supported(model, thirdParty), ['low','high']);
    assert.equal(policy.validSelection('high', model, thirdParty), true);
    assert.equal(policy.validSelection('medium', model, thirdParty), false);
    assert.equal(policy.validSelection('max', model, thirdParty), false);
    assert.equal(policy.validSelection('', model, thirdParty), false);
  }
  assert.deepEqual(policy.supported({id:'limited', supported_reasoning_efforts:['none','ultra']}, true), []);
  assert.deepEqual(policy.supported({id:'nested', reasoning:{supported_efforts:[{effort:'max'},'xhigh']}}, true), ['xhigh','max']);
});

test('excluded and malformed levels are rejected even with a stale experiment preference', () => {
  assert.deepEqual(policy.offered(), ['low','medium','high','xhigh','max']);
  for (const value of ['auto','none','minimal','ultra','high\nextra']) {
    assert.equal(policy.validSelection(value, {id:'custom-model'}, true, true), false);
  }
  assert.equal(policy.validSelection('high', null, true), false);
});
