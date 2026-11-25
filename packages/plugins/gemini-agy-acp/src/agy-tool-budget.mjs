/**
 * Fit a caller tool listing into agy's shared customization budget.
 *
 * agy loads every session MCP tool into one customization budget of roughly
 * 20,000 tokens, counted as ceil(UTF-8 bytes / 3) over each serialized tool
 * entry, and silently drops whole tools (largest first) past it. Fitting
 * trims only description prose — binary-searching one byte cap applied to
 * every description string, including nested schema descriptions — so every
 * tool stays listed and no name, type, enum, required, items or schema key
 * ever changes.
 */
export const TOOL_TOKEN_BUDGET = 18000;

function tokensOf(tools) {
  return tools.reduce((total, tool) => total + Math.ceil(Buffer.byteLength(JSON.stringify(tool), 'utf8') / 3), 0);
}

// Descriptions cut shorter than this say nothing ("The fil…") and only spend
// the budget on their key, so a cap below it drops the text entirely.
const MIN_DESCRIPTION_BYTES = 24;

// Shortens text to at most `max` UTF-8 bytes: a trailing Examples block goes
// first, then a sentence boundary near the cut, marked with "…".
function cutDescription(text, max) {
  if (Buffer.byteLength(text, 'utf8') <= max) return text;
  const bare = text.replace(/\s*\bExamples?:[\s\S]*$/i, '').trimEnd();
  if (bare && Buffer.byteLength(bare, 'utf8') <= max) return bare;
  const room = max - Buffer.byteLength('…', 'utf8');
  if (room < 4) return undefined;
  // Accumulate whole code points so a multi-byte character is never split.
  let out = '';
  let used = 0;
  for (const ch of bare || text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > room) break;
    out += ch;
    used += size;
  }
  const stop = Math.max(...['. ', '; ', '。', '；'].map(sep => out.lastIndexOf(sep)));
  if (stop > out.length / 2) out = out.slice(0, stop + 1);
  return out.trimEnd() + '…';
}

function trimDescription(text, cap) {
  if (Buffer.byteLength(text, 'utf8') <= cap) return text;
  return cap < MIN_DESCRIPTION_BYTES ? undefined : cutDescription(text, cap);
}

// Recursively caps every `description` string; every other key and value
// passes through untouched, so no schema constraint ever moves.
function shapeDescriptions(node, cap) {
  if (Array.isArray(node)) return node.map(item => shapeDescriptions(item, cap));
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') {
      const text = trimDescription(value, cap);
      if (text !== undefined) out.description = text;
      continue;
    }
    out[key] = shapeDescriptions(value, cap);
  }
  return out;
}

function shapeTool(tool, cap) {
  const out = { ...tool };
  if (typeof tool.description === 'string') {
    const text = trimDescription(tool.description, cap);
    if (text === undefined) delete out.description;
    else out.description = text;
  }
  if (tool.inputSchema !== undefined) out.inputSchema = shapeDescriptions(tool.inputSchema, cap);
  return out;
}

function longestDescription(tools) {
  let max = 0;
  const visit = node => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') {
        max = Math.max(max, Buffer.byteLength(value, 'utf8'));
      } else {
        visit(value);
      }
    }
  };
  for (const tool of tools) {
    if (typeof tool.description === 'string') max = Math.max(max, Buffer.byteLength(tool.description, 'utf8'));
    visit(tool.inputSchema);
  }
  return max;
}

/** Pure: when the listed tools exceed the token budget, progressively
 * shorten only description text (binary-searching one byte cap applied to
 * every description) and never drop a tool. Fitting lists return unchanged. */
export function fitToolsToBudget(tools, budget = TOOL_TOKEN_BUDGET) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  if (tokensOf(tools) <= budget) return tools;
  const at = cap => tools.map(tool => shapeTool(tool, cap));
  // Even with every description gone the list is over budget: keep every
  // tool and let the agent see as much schema as fits.
  if (tokensOf(at(0)) > budget) return at(0);
  // Largest cap whose shape still fits. At the longest description the
  // shape is the original over-budget list, so the search always narrows.
  let lo = 0;
  let hi = longestDescription(tools);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tokensOf(at(mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return at(lo);
}