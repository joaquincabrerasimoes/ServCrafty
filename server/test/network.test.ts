import assert from 'node:assert/strict';
import test from 'node:test';
import { hasCloudflareHeaders, ipInNetworks, isRemoteRequest, parseNetworks } from '../src/lib/network.js';

const req = (ip: string, headers: Record<string, string> = {}) => ({ headers, raw: { socket: { remoteAddress: ip } } }) as never;

test('accepts CIDR and address + subnet mask, several entries at once', () => {
  assert.equal(parseNetworks('192.168.69.0/24').length, 1);
  assert.equal(parseNetworks('192.168.69.0 255.255.255.0').length, 1);
  assert.equal(parseNetworks('192.168.69.0/24, 10.0.0.0 255.0.0.0\nfd00::/8').length, 3);
  assert.deepEqual(parseNetworks(''), []);
});

test('mask and CIDR spellings are the same range', () => {
  const a = parseNetworks('192.168.69.0 255.255.255.0');
  const b = parseNetworks('192.168.69.0/24');
  assert.deepEqual(a, b);
  // Host bits in the address are ignored: "gateway + mask" works as well.
  assert.deepEqual(parseNetworks('192.168.69.1 255.255.255.0'), b);
});

test('rejects malformed ranges', () => {
  for (const bad of ['192.168.69.0/33', '192.168.69.0 255.0.255.0', '300.1.1.1/8', 'nonsense', '192.168.69.0 255.255.255', '::1/129']) {
    assert.throws(() => parseNetworks(bad), /Not a valid network/, bad);
  }
});

test('membership follows the mask', () => {
  const lan = parseNetworks('192.168.69.0 255.255.255.0');
  assert.equal(ipInNetworks('192.168.69.2', lan), true);
  assert.equal(ipInNetworks('192.168.69.255', lan), true);
  assert.equal(ipInNetworks('192.168.70.2', lan), false);
  assert.equal(ipInNetworks('::ffff:192.168.69.9', lan), true);
  assert.equal(ipInNetworks('8.8.8.8', lan), false);
  assert.equal(ipInNetworks('fd00::1', lan), false);
  assert.equal(ipInNetworks(undefined, lan), false);
  assert.equal(ipInNetworks('10.1.2.3', parseNetworks('10.0.0.0/8')), true);
  assert.equal(ipInNetworks('fd12:3456::9', parseNetworks('fd00::/8')), true);
  assert.equal(ipInNetworks('fe80::1', parseNetworks('fd00::/8')), false);
  assert.equal(ipInNetworks('1.2.3.4', parseNetworks('0.0.0.0/0')), true);
});

test('a request is local only from inside the range and without Cloudflare headers', () => {
  const lan = parseNetworks('192.168.69.0/24');
  assert.equal(isRemoteRequest(req('192.168.69.2'), lan), false);
  assert.equal(isRemoteRequest(req('192.168.69.2', { 'cf-connecting-ip': '203.0.113.9' }), lan), true);
  assert.equal(isRemoteRequest(req('192.168.69.5', { 'cf-ray': 'abc-MIA' }), lan), true);
  assert.equal(isRemoteRequest(req('10.0.0.7'), lan), true);
  assert.equal(isRemoteRequest(req('203.0.113.9'), lan), true);
});

test('X-Forwarded-For does not change the verdict', () => {
  const lan = parseNetworks('192.168.69.0/24');
  assert.equal(isRemoteRequest(req('192.168.69.2', { 'x-forwarded-for': '8.8.8.8' }), lan), false);
  assert.equal(isRemoteRequest(req('8.8.8.8', { 'x-forwarded-for': '192.168.69.1' }), lan), true);
});

test('cdn-loop from Cloudflare is detected', () => {
  assert.equal(hasCloudflareHeaders({ 'cdn-loop': 'cloudflare; loops=1' }), true);
  assert.equal(hasCloudflareHeaders({ 'cdn-loop': 'other' }), false);
});
