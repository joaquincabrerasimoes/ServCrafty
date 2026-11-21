'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DebugStringFilter, unescapeDebugString, wantsDebugStrings } = require('../src/winelog');

const BS = '\\';

test('unescapeDebugString undoes Wine debugstr escaping', () => {
  const input = ['a', BS + 'n', 'b ', BS + '"q', BS + '" ', BS + BS, ' ', BS + 'x41', BS + '101'].join('');
  assert.equal(unescapeDebugString(input), 'a\nb "q" \\ AA');
});

test('wantsDebugStrings only for warn+seh', () => {
  assert.equal(wantsDebugStrings('fixme-all,warn+seh'), true);
  assert.equal(wantsDebugStrings('warn+seh'), true);
  assert.equal(wantsDebugStrings('-all'), false);
  assert.equal(wantsDebugStrings('warn+seh2'), false);
  assert.equal(wantsDebugStrings(undefined), false);
});

test('DebugStringFilter turns debug strings into game console text and drops the noise', () => {
  const out = [];
  const f = new DebugStringFilter((t) => out.push(t));
  const q = BS + '"';
  const line1 = '0024:warn:seh:dispatch_exception "Game.dll loaded for ' + q + 'Left 4 Dead 2' + q + BS + 'n"\n';
  f.push(Buffer.from(line1 + '0044:warn:seh:dispatch_exception unknown exception (code=6ba) raised\nerr:ntoskrnl:Zw'));
  f.push(Buffer.from('LoadDriver failed\r\n0024:warn:seh:dispatch_exception "partial'));
  f.flush();
  assert.deepEqual(out, ['Game.dll loaded for "Left 4 Dead 2"\n', 'err:ntoskrnl:ZwLoadDriver failed\n', '0024:warn:seh:dispatch_exception "partial\n']);
});

test('a debug string without a trailing newline is passed on as is (the game decides line breaks)', () => {
  const out = [];
  const f = new DebugStringFilter((t) => out.push(t));
  f.push(Buffer.from('0024:warn:seh:dispatch_exception "Console initialized."\n0024:warn:seh:dispatch_exception "' + BS + 'n"\n'));
  assert.equal(out.join(''), 'Console initialized.\n');
});
