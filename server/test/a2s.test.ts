import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import test from 'node:test';
import { buildInfoRequest, buildPlayerRequest, parseInfo, parsePlayers, queryA2s, SplitAssembler } from '../src/lib/a2s.js';

const HDR = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
};
const f32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return b;
};

function infoPacket(o: { name?: string; map?: string; players?: number; max?: number; bots?: number; version?: string } = {}): Buffer {
  return Buffer.concat([
    HDR,
    u8(0x49),
    u8(17),
    cstr(o.name ?? 'My Server'),
    cstr(o.map ?? 'KF-BioticsLab'),
    cstr('kfgame'),
    cstr('Killing Floor 2'),
    u16(0),
    u8(o.players ?? 3),
    u8(o.max ?? 6),
    u8(o.bots ?? 1),
    u8(0x64),
    u8(0x77),
    u8(0),
    u8(1),
    cstr(o.version ?? '1.2.3'),
  ]);
}

function playersPacket(list: { name: string; score: number; dur: number }[]): Buffer {
  return Buffer.concat([
    HDR,
    u8(0x44),
    u8(list.length),
    ...list.flatMap((p, i) => [u8(i), cstr(p.name), i32(p.score), f32(p.dur)]),
  ]);
}

test('parse A2S_INFO (Source)', () => {
  const info = parseInfo(infoPacket());
  assert.deepEqual(info, {
    name: 'My Server',
    map: 'KF-BioticsLab',
    folder: 'kfgame',
    game: 'Killing Floor 2',
    appId: 0,
    players: 3,
    maxPlayers: 6,
    bots: 1,
    version: '1.2.3',
  });
});

test('parse rejects truncated / foreign packets and strips control characters', () => {
  assert.equal(parseInfo(infoPacket().subarray(0, 20)), null);
  assert.equal(parseInfo(Buffer.from('hello world')), null);
  assert.equal(parseInfo(Buffer.concat([HDR, u8(0x42)])), null);
  assert.equal(parseInfo(infoPacket({ name: 'Evil\x1b[31m\nName' }))?.name, 'Evil[31mName');
  assert.equal(parsePlayers(Buffer.concat([HDR, u8(0x44), u8(2), u8(0), cstr('a')])), null);
});

test('parse A2S_PLAYER', () => {
  const p = parsePlayers(
    playersPacket([
      { name: 'alice', score: 10, dur: 61.4 },
      { name: '', score: 0, dur: 5 },
    ]),
  );
  assert.deepEqual(p, [
    { name: 'alice', score: 10, durationSec: 61 },
    { name: '', score: 0, durationSec: 5 },
  ]);
});

test('request builders', () => {
  assert.equal(buildInfoRequest().toString('latin1'), '\xff\xff\xff\xffTSource Engine Query\0');
  assert.deepEqual([...buildPlayerRequest()], [0xff, 0xff, 0xff, 0xff, 0x55, 0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual([...buildPlayerRequest(Buffer.from([1, 2, 3, 4]))].slice(5), [1, 2, 3, 4]);
});

test('split packets are reassembled in order', () => {
  const full = playersPacket([{ name: 'bob', score: 1, dur: 2 }]);
  const a = full.subarray(0, 6);
  const b = full.subarray(6);
  const part = (n: number, payload: Buffer) => Buffer.concat([i32(-2), i32(7), u8(2), u8(n), u16(1248), payload]);
  const asm = new SplitAssembler();
  assert.equal(asm.push(part(1, b)), null);
  assert.deepEqual(asm.push(part(0, a)), full);
  assert.deepEqual(asm.push(full), full); // unsplit packets pass through
});

/** Fake game server: answers with a challenge first, like current Source servers do. */
async function fakeServer(): Promise<{ port: number; close: () => void; requests: string[] }> {
  const sock = dgram.createSocket('udp4');
  const requests: string[] = [];
  const challenge = Buffer.from([9, 8, 7, 6]);
  sock.on('message', (msg, rinfo) => {
    const kind = msg[4];
    const tail = msg.subarray(msg.length - 4);
    const challenged = tail.equals(challenge);
    requests.push(`${String.fromCharCode(kind ?? 0)}${challenged ? '+c' : ''}`);
    let reply: Buffer;
    if (!challenged) reply = Buffer.concat([HDR, u8(0x41), challenge]);
    else if (kind === 0x54) reply = infoPacket({ players: 2, max: 8, bots: 0 });
    else reply = playersPacket([{ name: 'alice', score: 3, dur: 100 }, { name: 'bob', score: 1, dur: 50 }]);
    sock.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  return { port: sock.address().port, close: () => sock.close(), requests };
}

test('queryA2s against a fake UDP server (with challenges)', async () => {
  const srv = await fakeServer();
  try {
    const r = await queryA2s('127.0.0.1', srv.port, { timeoutMs: 2000 });
    assert.equal(r.info?.players, 2);
    assert.equal(r.info?.maxPlayers, 8);
    assert.equal(r.info?.map, 'KF-BioticsLab');
    assert.deepEqual(
      r.players?.map((p) => p.name),
      ['alice', 'bob'],
    );
    assert.deepEqual(srv.requests, ['T', 'T+c', 'U', 'U+c']);
  } finally {
    srv.close();
  }
});

test('queryA2s resolves with nulls when nobody answers', async () => {
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  const port = sock.address().port;
  try {
    const started = Date.now();
    const r = await queryA2s('127.0.0.1', port, { timeoutMs: 300 });
    assert.deepEqual(r, { info: null, players: null });
    assert.ok(Date.now() - started < 1500);
  } finally {
    sock.close();
  }
});
