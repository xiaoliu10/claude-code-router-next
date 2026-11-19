import { describe, expect, it } from 'vitest';
import { buildRequestBody } from '../utils/gemini.util';
import type { UnifiedMessage } from '../types/llm';

function replay(signature: string, tools = false) {
  const message: UnifiedMessage = {
    role: 'assistant', content: 'previous reply', thinking: { content: 'note', signature },
    ...(tools && { tool_calls: ['a', 'b'].map(id => ({ id, type: 'function' as const, function: { name: 'lookup', arguments: '{}' } })) }),
  };
  return buildRequestBody({ model: 'gemini', messages: [message] }).contents[0].parts;
}

describe('AI Studio history signatures', () => {
  it.each(['ccr_1795069948562', 'ccr_think_signature', 'rs_abcd', 'a'.repeat(24), 'abc!?'])('drops foreign or malformed text signatures: %s', signature => {
    expect(replay(signature)).toEqual([{ text: 'previous reply' }]);
  });
  it.each([['gemini-4-hydrogen', undefined], ['gemini-3-pro', ''], ['gemini-4-hydrogen', 'YWJjZA==']])(
    'places the recovered signature on the first call in each strict-model step (%s, %s)', (model, signature) => {
      const calls = (ids: string[]): UnifiedMessage => ({ role: 'assistant', content: 'working',
        ...(signature !== undefined && { thinking: { content: '', signature } }),
        tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'bash', arguments: '{}' } })) });
      const parts = buildRequestBody({ model: model!, messages: [calls(['one', 'two']), calls(['three'])] }).contents
        .filter((c: any) => c.role === 'model').map((c: any) => c.parts.map((p: any) => p.thoughtSignature));
      const expected = signature || 'skip_thought_signature_validator';
      expect(parts).toEqual([[undefined, expected, undefined], [undefined, expected]]);
    });
  it('keeps legacy native-signature placement and repairs foreign parallel call history', () => {
    const sig = 'YWJjZA==';
    expect(replay(sig)[0].thoughtSignature).toBe(sig);
    expect(replay(sig, true).map((p: any) => p.thoughtSignature)).toEqual([sig, sig, sig]);
    expect(replay('ccr_1795069948562', true).map((p: any) => p.thoughtSignature))
      .toEqual([undefined, 'skip_thought_signature_validator', undefined]);
  });
});
