import test from 'node:test';
import assert from 'node:assert/strict';
import { accountEmailShapeOk, extractAccountEmail } from '../src/account.mjs';

test('extractAccountEmail prefers the structured login line and takes the first match', () => {
  assert.equal(extractAccountEmail('applyAuthResult: email=new@example.com, status=OK\nauthenticated successfully as older@example.com, x'),
    'new@example.com');
  assert.equal(extractAccountEmail('...authenticated successfully as plain@example.com (id 7)'),
    'plain@example.com');
  // Only the email capture travels onward; surrounding token material never does.
  assert.equal(extractAccountEmail('token=abc123 applyAuthResult: email=user@x.test, token=secret-tail'),
    'user@x.test');
});

test('extractAccountEmail rejects non-email captures and absent lines', () => {
  assert.equal(extractAccountEmail('applyAuthResult: email=not-an-email'), null);
  assert.equal(extractAccountEmail('authenticated successfully as /Users/jason'), null);
  assert.equal(extractAccountEmail('applyAuthResult: email='), null);
  assert.equal(extractAccountEmail(''), null);
  assert.equal(extractAccountEmail(undefined), null);
  assert.equal(extractAccountEmail(null), null);
  assert.equal(extractAccountEmail('applyAuthResult: email=' + 'a'.repeat(300) + '@x.test'), null);
  assert.equal(extractAccountEmail('applyAuthResult: email=quoted"trick@x.test'), null);
});

test('accountEmailShapeOk bounds the display-safe email shape', () => {
  assert.equal(accountEmailShapeOk('user@example.com'), true);
  assert.equal(accountEmailShapeOk('first.last+tag@sub.example.co'), true);
  assert.equal(accountEmailShapeOk('a'.repeat(247) + '@x.test'), true); // exactly 254 chars
  assert.equal(accountEmailShapeOk('a'.repeat(248) + '@x.test'), false); // 255 chars
  for (const bad of ['', 'no-at-sign', 'two@at@sign', 'a b@x.test', 'a\0b@x.test', 'a\nb@x.test',
    'user@example.com,other@x.test', 42, null, undefined]) {
    assert.equal(accountEmailShapeOk(bad), false, JSON.stringify(bad));
  }
});
