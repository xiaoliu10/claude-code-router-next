import test from 'node:test';
import assert from 'node:assert/strict';
import { fitToolsToBudget, TOOL_TOKEN_BUDGET } from '../src/agy-tool-budget.mjs';

/** agy's own cost model: ceil(UTF-8 bytes / 3) per serialized entry. */
function tokensOf(tools) {
  return tools.reduce((total, tool) => total + Math.ceil(Buffer.byteLength(JSON.stringify(tool), 'utf8') / 3), 0);
}

/** A listing entry with a nested schema description, as the bridge sends it. */
function makeTool(i, prose) {
  return {
    name: `tool_${i}`,
    description: prose,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['a', 'b'], description: prose },
        list: { type: 'array', items: { type: 'string', description: prose } },
      },
      required: ['key'],
    },
    _meta: { 'antigravity/alwaysLoad': true },
  };
}

/** Copy of a schema with every description string removed, for structural comparison. */
function withoutDescriptions(node) {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node)
    .filter(([key, value]) => !(key === 'description' && typeof value === 'string'))
    .map(([key, value]) => [key, withoutDescriptions(value)]));
}

test('a fitting list is returned unchanged', () => {
  const tools = [makeTool(0, 'Short description.')];
  assert.equal(fitToolsToBudget(tools), tools);
});

test('non-array and empty inputs pass through', () => {
  assert.equal(fitToolsToBudget(undefined), undefined);
  assert.equal(fitToolsToBudget(null), null);
  const empty = [];
  assert.equal(fitToolsToBudget(empty), empty);
});

test('over budget: every tool and schema constraint stays, only descriptions shrink', () => {
  const prose = 'This sentence explains the tool in detail. 你好世界. '.repeat(40);
  const tools = Array.from({ length: 30 }, (_, i) => makeTool(i, prose));
  assert.ok(tokensOf(tools) > TOOL_TOKEN_BUDGET);
  const fitted = fitToolsToBudget(tools);
  assert.equal(fitted.length, tools.length);
  assert.ok(tokensOf(fitted) <= TOOL_TOKEN_BUDGET);
  for (const [i, entry] of fitted.entries()) {
    const original = tools[i];
    assert.equal(entry.name, original.name);
    assert.deepEqual(entry._meta, original._meta);
    // Every schema key and constraint is untouched, including nested ones.
    assert.deepEqual(withoutDescriptions(entry.inputSchema), withoutDescriptions(original.inputSchema));
    assert.ok(Buffer.byteLength(entry.description, 'utf8') < Buffer.byteLength(prose, 'utf8'));
    // The cut never splits a multi-byte code point: a JSON round-trip alone
    // cannot prove it (lone surrogates survive), so assert UTF-8 byte symmetry.
    assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);
    assert.equal(Buffer.from(entry.description, 'utf8').toString('utf8'), entry.description);
  }
});

test('a trailing Examples block is stripped before any truncation', () => {
  const bare = 'Useful prose about the tool.';
  const tools = [makeTool(0, `${bare} Examples: one two three four five six seven eight nine ten.`)];
  // A budget that fits the bare descriptions but not the Examples blocks.
  const budget = tokensOf(tools.map(tool => ({ ...tool, description: bare,
    inputSchema: { ...tool.inputSchema, properties: Object.fromEntries(Object.entries(tool.inputSchema.properties)
      .map(([key, value]) => [key, { ...value, description: bare }])) } })));
  const fitted = fitToolsToBudget(tools, budget);
  assert.equal(fitted[0].description, bare);
  assert.equal(fitted[0].inputSchema.properties.key.description, bare);
  assert.ok(!fitted[0].description.includes('…'));
});

test('truncation lands on a sentence boundary and is marked with an ellipsis', () => {
  const prose = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu. Nu xi omicron pi.';
  const tools = [{ name: 'tool_0', description: prose, inputSchema: { type: 'object' } }];
  const budget = Math.ceil(Buffer.byteLength(JSON.stringify({ ...tools[0], description: 'Alpha beta gamma delta. Epsilon…' }), 'utf8') / 3);
  const fitted = fitToolsToBudget(tools, budget);
  assert.ok(fitted[0].description.endsWith('…'));
  assert.ok(fitted[0].description.length < prose.length);
  // The cut kept whole sentences rather than trailing partial words.
  assert.match(fitted[0].description, /\.…$/);
});

test('descriptions under the minimum byte cap are dropped entirely', () => {
  const tools = [makeTool(0, 'Some prose that is long enough to be cut down.')];
  // A budget that only fits the listing with every description removed.
  const stripped = [makeTool(0, '')];
  delete stripped[0].description;
  delete stripped[0].inputSchema.properties.key.description;
  delete stripped[0].inputSchema.properties.list.items.description;
  const fitted = fitToolsToBudget(tools, tokensOf(stripped));
  assert.equal(fitted.length, 1);
  assert.equal('description' in fitted[0], false);
  assert.equal('description' in fitted[0].inputSchema.properties.key, false);
  assert.equal('description' in fitted[0].inputSchema.properties.list.items, false);
  assert.deepEqual(withoutDescriptions(fitted[0]), withoutDescriptions(tools[0]));
});

test('a list still over budget with no descriptions keeps every tool', () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({
    name: `tool_${i}`,
    inputSchema: { type: 'object', properties: Object.fromEntries(
      Array.from({ length: 20 }, (_, j) => [`field_${j}`, { type: 'string', enum: ['value-one', 'value-two'] }])),
    },
  }));
  const fitted = fitToolsToBudget(tools, 10);
  assert.equal(fitted.length, tools.length);
  assert.deepEqual(fitted.map(tool => tool.name), tools.map(tool => tool.name));
  assert.deepEqual(fitted.map(tool => tool.inputSchema), tools.map(tool => tool.inputSchema));
});

test('nested schema descriptions are capped without touching other keys', () => {
  const prose = 'A very long nested description. '.repeat(100);
  const tools = [makeTool(0, 'Short top-level prose.'), makeTool(1, prose)];
  const fitted = fitToolsToBudget(tools, 900);
  assert.equal(fitted.length, 2);
  assert.ok(tokensOf(fitted) <= 900);
  for (const [i, entry] of fitted.entries()) {
    assert.deepEqual(withoutDescriptions(entry.inputSchema), withoutDescriptions(tools[i].inputSchema));
    assert.deepEqual(entry._meta, tools[i]._meta);
  }
  // The short description survived; the long nested ones were trimmed.
  assert.equal(fitted[0].description, 'Short top-level prose.');
  assert.ok(Buffer.byteLength(fitted[1].inputSchema.properties.key.description ?? '', 'utf8') < Buffer.byteLength(prose, 'utf8'));
});