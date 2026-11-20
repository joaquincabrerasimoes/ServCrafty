import assert from 'node:assert/strict';
import test from 'node:test';
import { nowStamp, splitStamp } from '../src/lib/logTime.js';

test('splitStamp takes the docker timestamp off the front of a line', () => {
  assert.deepEqual(splitStamp('2026-11-20T07:46:00.589825612Z [Server] Done (3.2s)!'), {
    ts: '2026-11-20T07:46:00.589825612Z',
    text: '[Server] Done (3.2s)!',
  });
  // An empty line keeps its (empty) text.
  assert.deepEqual(splitStamp('2026-11-20T07:46:00.589825612Z '), { ts: '2026-11-20T07:46:00.589825612Z', text: '' });
});

test('splitStamp leaves lines without a docker timestamp alone', () => {
  assert.deepEqual(splitStamp('plain line'), { ts: null, text: 'plain line' });
  assert.deepEqual(splitStamp('2026-11-20 07:46:00 INFO x'), { ts: null, text: '2026-11-20 07:46:00 INFO x' });
  // Only nanosecond stamps are docker's; a shorter one is the game's own.
  assert.equal(splitStamp('2026-11-20T07:46:00.589Z hello').ts, null);
});

test('nowStamp has the docker format (nanoseconds, Z)', () => {
  assert.equal(nowStamp(new Date('2026-11-20T07:46:00.589Z')), '2026-11-20T07:46:00.589000000Z');
  assert.match(nowStamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$/);
});
