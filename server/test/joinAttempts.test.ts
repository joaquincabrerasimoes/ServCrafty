import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRejectedJoin, parseUuidLine } from '../src/lib/joinAttempts.js';

test('detects a player refused by the whitelist', () => {
  const line =
    "[20:41:08] [Server thread/INFO]: Disconnecting Stervil (/192.168.69.2:59834): You are not white-listed on this server!";
  assert.deepEqual(parseRejectedJoin(line), { name: 'Stervil', ip: '192.168.69.2' });
});

test('accepts the Paper wording and IPv6 addresses', () => {
  assert.deepEqual(
    parseRejectedJoin('[20:41:08 INFO]: Disconnecting Bob_1 (/[2001:db8::1]:5000): You are not whitelisted on this server!'),
    { name: 'Bob_1', ip: '2001:db8::1' },
  );
});

test('counts a refusal once: the follow-up "lost connection" line is ignored', () => {
  const line = '[20:41:08] [Server thread/INFO]: Stervil (/192.168.69.2:59834) lost connection: You are not white-listed on this server!';
  assert.equal(parseRejectedJoin(line), null);
});

test('ignores other disconnections', () => {
  assert.equal(parseRejectedJoin('[x] [Server thread/INFO]: Disconnecting Bob (/1.2.3.4:5): Flying is not enabled on this server'), null);
  assert.equal(parseRejectedJoin('[x] [Server thread/INFO]: Bob joined the game'), null);
});

test('reads the UUID announced before the refusal', () => {
  assert.deepEqual(
    parseUuidLine('[20:41:08] [User Authenticator #1/INFO]: UUID of player Stervil is b5d39a81-20ba-4414-bac7-81d989751cd1'),
    { name: 'Stervil', uuid: 'b5d39a81-20ba-4414-bac7-81d989751cd1' },
  );
});
