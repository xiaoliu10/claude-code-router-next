import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenModelsOf, settingsPath } from '../src/settings.mjs';

const name = 'gemini-agy-acp';

test('settingsPath pins the sidecar next to the CCR config', () => {
  assert.equal(settingsPath('/ccr/config'), `/ccr/config/${name}.json`);
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
