'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tailFile } = require('../src/logtail');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'logtail-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('streams a file that appears later, in order, and flushes on stop', async () => {
  const dir = tmp();
  const file = path.join(dir, 'console.log');
  const got = [];
  const t = tailFile(file, (s) => got.push(s), { intervalMs: 10 });
  await wait(30); // file does not exist yet: nothing happens
  fs.writeFileSync(file, 'line 1\n');
  await wait(50);
  fs.appendFileSync(file, 'line 2\nline 3');
  await wait(50);
  fs.appendFileSync(file, '\nlast');
  t.stop(); // reads what was written since the last poll
  assert.equal(got.join(''), 'line 1\nline 2\nline 3\nlast');
});

test('starts over when the file is truncated', async () => {
  const dir = tmp();
  const file = path.join(dir, 'console.log');
  fs.writeFileSync(file, 'old old old old\n');
  const got = [];
  const t = tailFile(file, (s) => got.push(s), { intervalMs: 10 });
  await wait(40);
  fs.writeFileSync(file, 'new\n');
  await wait(40);
  t.stop();
  assert.equal(got.join(''), 'old old old old\nnew\n');
});

test('multi-byte characters split across reads are not corrupted', async () => {
  const dir = tmp();
  const file = path.join(dir, 'console.log');
  const bytes = Buffer.from('ñandú ✓\n', 'utf8');
  fs.writeFileSync(file, bytes.subarray(0, 2)); // cuts "ñ"? no: ñ is 2 bytes; cut inside "a"+"n" boundary is fine, cut a later char below
  const got = [];
  const t = tailFile(file, (s) => got.push(s), { intervalMs: 10 });
  await wait(30);
  fs.appendFileSync(file, bytes.subarray(2, bytes.length - 3)); // stops inside the 3-byte "✓"
  await wait(30);
  fs.appendFileSync(file, bytes.subarray(bytes.length - 3));
  t.stop();
  assert.equal(got.join(''), 'ñandú ✓\n');
});
