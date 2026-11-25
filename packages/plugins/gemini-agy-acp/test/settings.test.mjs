import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_METHODS, enabledSettings, hiddenModelsOf, settingsPath } from '../src/settings.mjs';

const name = 'gemini-agy-acp';

test('settingsPath pins the sidecar next to the CCR config', () => {
  assert.equal(settingsPath('/ccr/config'), `/ccr/config/${name}.json`);
});

test('enabledSettings accepts both auth methods and resolves the optional gemini apiKey', () => {
  const base = { enabled: true, binary: '/fixture/agy' };
  assert.deepEqual(enabledSettings({ ...base, authMethod: 'gemini-api-key' }),
    { binary: '/fixture/agy', authMethod: 'gemini-api-key', timeoutMs: 60000, maxWorkers: 4 });
  assert.deepEqual(enabledSettings({ ...base, authMethod: 'gemini-api-key', apiKey: 'k' }),
    { binary: '/fixture/agy', authMethod: 'gemini-api-key', timeoutMs: 60000, maxWorkers: 4, apiKey: 'k' });
  assert.deepEqual(enabledSettings({ ...base, authMethod: 'oauth-personal' }),
    { binary: '/fixture/agy', authMethod: 'oauth-personal', timeoutMs: 60000, maxWorkers: 4 });
  assert.deepEqual(AUTH_METHODS, ['gemini-api-key', 'oauth-personal']);
});

test('enabledSettings rejects oauth-personal carrying an apiKey and every malformed field', () => {
  const base = { enabled: true, binary: '/fixture/agy', timeoutMs: 60000, maxWorkers: 1 };
  for (const bad of [
    { authMethod: 'oauth-personal', apiKey: 'k' },
    { authMethod: 'oauth-personal', apiKey: '' },
    { authMethod: 'consumer-login' },
    { authMethod: undefined },
    { authMethod: 'gemini-api-key', apiKey: '' },
    { authMethod: 'gemini-api-key', apiKey: 42 },
  ]) {
    assert.throws(() => enabledSettings({ ...base, ...bad }), error => error.code === 'agy_config_invalid', JSON.stringify(bad));
  }
});

test('hiddenModelsOf normalizes absent or malformed containers to the empty default', () => {
  for (const raw of [undefined, null, [], 'sidecar', { hiddenModels: undefined }, { hiddenModels: null },
    { hiddenModels: 'm2' }, { hiddenModels: {} }, { hiddenModels: [{}] }]) {
    assert.deepEqual(hiddenModelsOf(raw), [], JSON.stringify(raw));
  }
});

test('hiddenModelsOf keeps order and deduplicates', () => {
  assert.deepEqual(hiddenModelsOf({ hiddenModels: ['m2', 'default', 'm2', 'default', 'm2'] }), ['m2', 'default']);
  assert.deepEqual(hiddenModelsOf({ hiddenModels: ['default'] }), ['default']);
});

test('hiddenModelsOf drops entries outside the bounded non-control shape', () => {
  const tooLong = 'm'.repeat(129);
  assert.deepEqual(hiddenModelsOf({ hiddenModels: ['ok', '', '   '.repeat(43), 'a\0b', 'a\nb', 'a\tb', 'a\x7fb',
    42, null, true, {}, ['m2'], tooLong, 'm'.repeat(128) ]}), ['ok', 'm'.repeat(128)]);
});

test('hiddenModelsOf caps the list at 256 entries', () => {
  const many = Array.from({ length: 300 }, (_, index) => `m-${index}`);
  assert.equal(hiddenModelsOf({ hiddenModels: many }).length, 256);
  assert.deepEqual(hiddenModelsOf({ hiddenModels: many }), many.slice(0, 256));
});
