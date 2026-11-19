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
  it('keeps legacy native-signature placement and repairs foreign parallel call history', () => {
    const sig = 'YWJjZA==';
    expect(replay(sig)[0].thoughtSignature).toBe(sig);
    expect(replay(sig, true).map((p: any) => p.thoughtSignature)).toEqual([sig, sig, sig]);
    expect(replay('ccr_1795069948562', true).map((p: any) => p.thoughtSignature))
      .toEqual([undefined, 'skip_thought_signature_validator', undefined]);
  });
});
