import { AcpError } from './acp-errors.mjs';

const selectorIds = {
  model: ['model'],
  thought_level: ['thought_level', 'thinking', 'thinking_level'],
};

function selectorFor(options, category) {
  if (!Array.isArray(options)) throw new AcpError('unsupported_option');
  const selectors = options.filter(option => option?.type === 'select' && (
    option.category == null ? selectorIds[category].includes(option.id) : option.category === category
  ));
  if (selectors.length !== 1) throw new AcpError('unsupported_option');
  const [selector] = selectors;
  if (typeof selector.id !== 'string' || !Array.isArray(selector.options)) {
    throw new AcpError('unsupported_option');
  }
  return selector;
}

/** The single advertised model selector, shared by session configuration and
 * the model-sync route's catalog discovery. */
export function modelSelector(options) {
  return selectorFor(options, 'model');
}

/** Flat {id,name} options of a selector, deduplicated by wire value. */
export function modelOptions(selector) {
  const models = [];
  const seen = new Set();
  for (const entry of selector.options.flatMap(option => option?.options ?? [option])) {
    if (typeof entry?.value !== 'string' || !entry.value || seen.has(entry.value)) continue;
    seen.add(entry.value);
    models.push({ id: entry.value, name: typeof entry.name === 'string' && entry.name ? entry.name : entry.value });
    if (models.length >= 256) break;
  }
  return models;
}

function select(options, category, requested) {
  const selector = selectorFor(options, category);
  const values = selector.options.flatMap(entry => entry?.options ?? [entry])
    .filter(entry => typeof entry?.value === 'string');
  const normalized = requested.toLowerCase();
  const aliases = category === 'thought_level' && normalized === 'xhigh' ? ['xhigh', 'extra'] : [normalized];
  const exact = values.filter(entry => entry.value === requested);
  const matches = exact.length ? exact : values.filter(entry =>
    aliases.includes(entry.value.toLowerCase()) ||
    (typeof entry.name === 'string' && aliases.includes(entry.name.toLowerCase()))
  );
  if (matches.length !== 1) throw new AcpError('unsupported_option');
  return { selector, value: matches[0].value };
}

export async function configureSession(rpc, session, model, thinking) {
  let options = session.configOptions;
  const selections = [['model', model]];
  if (thinking != null) selections.push(['thought_level', thinking]);
  const expected = new Map();
  for (const [category, requested] of selections) {
    const { selector, value } = select(options, category, requested);
    expected.set(selector.id, value);
    if (selector.currentValue !== value) {
      const result = await rpc.request('session/set_config_option', {
        sessionId: session.sessionId, configId: selector.id, value,
      });
      options = result.configOptions;
    }
    // Setting the model can change the available thinking levels and their wire values.
    for (const [id, currentValue] of expected) {
      if (!Array.isArray(options) || !options.some(option => option?.id === id && option.currentValue === currentValue)) {
        throw new AcpError('unsupported_option');
      }
    }
  }
}
