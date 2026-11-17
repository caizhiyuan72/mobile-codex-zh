const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../app/src/main/assets/web/reasoning-policy.js');

test('model identifiers cannot turn unverified reasoning levels into claimed capabilities', () => {
  for (const id of ['gpt-6.1-sol','gpt-6-astra','claude-fixture','relay/custom-model']) {
    const model = {id};
    assert.deepEqual(policy.supported(model, true), []);
    assert.deepEqual(policy.supported(model, false), []);
    assert.doesNotMatch(policy.source(model, 'max', true), /文档确认|已验证/);
  }
});

test('reasoning defaults to automatic and preserves an explicit provider request without silently changing it', () => {
  const model = {id:'custom-model'};
  assert.equal(policy.choose({model, thirdParty:true}), '');
  assert.equal(policy.choose({previous:'max', model, thirdParty:true}), 'max');
  assert.equal(policy.choose({previous:'invalid', model, thirdParty:true}), '');
});

test('reported capabilities are read from metadata, with invalid entries ignored', () => {
  const model = {id:'custom-model', supportedReasoningEfforts:[{reasoningEffort:'high'}, 'low', 'unknown', null, 'HIGH']};
  assert.deepEqual(policy.supported(model, true), ['low','high']);
  assert.equal(policy.validSelection('high', model, false), true);
  assert.equal(policy.validSelection('max', model, false), false);
});

test('manual provider levels require a model and still reject malformed values', () => {
  assert.equal(policy.validSelection('', null, true), true);
  assert.equal(policy.validSelection('high', null, true), false);
  assert.equal(policy.validSelection('ultra', {id:'custom-model'}, true), true);
  assert.equal(policy.validSelection('high\nextra', {id:'custom-model'}, true), false);
});
