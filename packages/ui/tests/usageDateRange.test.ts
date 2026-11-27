import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageDateRange } from '../src/utils/usageDateRange.ts';

process.env.TZ = 'America/New_York';
const now = new Date('2026-03-10T12:30:00-04:00');

test('seven local dates include today across a daylight saving transition', () => {
  assert.deepEqual(usageDateRange(168, now), {
    startDate: '2026-03-04', endDate: '2026-03-10',
    start: '2026-03-04T05:00:00.000Z', end: now.toISOString(),
  });
  assert.equal(usageDateRange(720, now).startDate, '2026-02-09');
});

test('24 hours is an elapsed duration while manual dates include local midnight through the last millisecond', () => {
  const afterChange = new Date('2026-03-08T12:00:00-04:00');
  assert.equal(usageDateRange(24, afterChange).start, '2026-03-07T16:00:00.000Z');
  const day = usageDateRange({ startDate: '2026-03-08', endDate: '2026-03-08' });
  assert.equal(day.start, '2026-03-08T05:00:00.000Z');
  assert.equal(day.end, '2026-03-09T03:59:59.999Z');
  assert.equal(usageDateRange({ startDate: '', endDate: '' }).start, undefined);
});
