'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyIni } = require('../src/ini');

test('creates a new file with sections when missing', () => {
  const out = applyIni(null, [{ section: 'A', key: 'x', value: '1' }, { section: 'B', key: 'y', value: '2' }]);
  assert.equal(out, '[A]\nx=1\n\n[B]\ny=2\n');
});

test('updates an existing key in the right section only', () => {
  const src = '[A]\nName=old\n\n[B]\nName=keep\n';
  const out = applyIni(src, [{ section: 'A', key: 'Name', value: 'new' }]);
  assert.equal(out, '[A]\nName=new\n\n[B]\nName=keep\n');
});

test('keeps unrelated lines, comments and order; preserves spacing around =', () => {
  const src = '; header\n[A]\n# note\nfoo = 1\nbar=2\n\n[B]\nz=9\n';
  const out = applyIni(src, [{ section: 'A', key: 'foo', value: '5' }]);
  assert.equal(out, '; header\n[A]\n# note\nfoo = 5\nbar=2\n\n[B]\nz=9\n');
});

test('adds a missing key at the end of its section, before trailing blanks', () => {
  const src = '[A]\na=1\n\n[B]\nb=2\n';
  const out = applyIni(src, [{ section: 'A', key: 'c', value: '3' }]);
  assert.equal(out, '[A]\na=1\nc=3\n\n[B]\nb=2\n');
});

test('adds a missing section at the end', () => {
  const out = applyIni('[A]\na=1\n', [{ section: 'N', key: 'k', value: 'v' }]);
  assert.equal(out, '[A]\na=1\n\n[N]\nk=v\n');
});

test('matches sections and keys case-insensitively', () => {
  const out = applyIni('[Engine.GameInfo]\nmaxplayers=1\n', [{ section: 'engine.gameinfo', key: 'MaxPlayers', value: '8' }]);
  assert.equal(out, '[Engine.GameInfo]\nmaxplayers=8\n');
});

test('does not treat commented keys as existing', () => {
  const out = applyIni('[A]\n;k=1\n', [{ section: 'A', key: 'k', value: '2' }]);
  assert.equal(out, '[A]\n;k=1\nk=2\n');
});

test('list replaces every occurrence with one line per value, at the first position', () => {
  const src = '[S]\nItems=1\nother=x\nItems=2\nItems=3\n[T]\nItems=keep\n';
  const out = applyIni(src, [], [{ section: 'S', key: 'Items', values: ['10', '20'] }]);
  assert.equal(out, '[S]\nItems=10\nItems=20\nother=x\n[T]\nItems=keep\n');
});

test('list with no values removes the key; with no existing key and values appends', () => {
  assert.equal(applyIni('[S]\nI=1\nI=2\nz=0\n', [], [{ section: 'S', key: 'I', values: [] }]), '[S]\nz=0\n');
  assert.equal(applyIni('[S]\nz=0\n', [], [{ section: 'S', key: 'I', values: ['a', 'b'] }]), '[S]\nz=0\nI=a\nI=b\n');
  assert.equal(applyIni(null, [], [{ section: 'S', key: 'I', values: [] }]), '');
});

test('preserves CRLF', () => {
  const src = '[A]\r\na=1\r\n[B]\r\nb=2\r\n';
  const out = applyIni(src, [{ section: 'A', key: 'a', value: '9' }, { section: 'A', key: 'n', value: '1' }], [{ section: 'B', key: 'l', values: ['x', 'y'] }]);
  assert.equal(out, '[A]\r\na=9\r\nn=1\r\n[B]\r\nb=2\r\nl=x\r\nl=y\r\n');
  assert.ok(!/[^\r]\n/.test(out));
});

test('keeps a missing trailing newline missing', () => {
  assert.equal(applyIni('[A]\na=1', [{ section: 'A', key: 'a', value: '2' }]), '[A]\na=2');
});

test('is idempotent', () => {
  const set = [{ section: 'A', key: 'k', value: 'v' }];
  const list = [{ section: 'A', key: 'L', values: ['1', '2'] }];
  const once = applyIni('[A]\nx=1\n', set, list);
  assert.equal(applyIni(once, set, list), once);
});
