import assert from 'node:assert/strict';
import test from 'node:test';
import { iconProblem, pngSize } from '../src/lib/serverIcon.js';

function png(w: number, h: number, extra = 0): Buffer {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

test('pngSize reads the IHDR dimensions and rejects non-PNG data', () => {
  assert.deepEqual(pngSize(png(64, 32)), { width: 64, height: 32 });
  assert.equal(pngSize(Buffer.from('GIF89a'.repeat(10))), null);
  assert.equal(pngSize(Buffer.alloc(5)), null);
});

test('iconProblem accepts only 64x64 PNGs of reasonable size', () => {
  assert.equal(iconProblem(png(64, 64)), '');
  assert.match(iconProblem(png(128, 64)), /64x64/);
  assert.match(iconProblem(Buffer.from('not a png at all, definitely'.repeat(3))), /PNG/);
  assert.match(iconProblem(png(64, 64, 300 * 1024)), /larger/);
});
