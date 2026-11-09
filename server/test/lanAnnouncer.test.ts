import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANNOUNCE_INTERVAL_MS,
  IFACE_REFRESH_MS,
  LAN_GROUP,
  LAN_PORT,
  LanAnnouncer,
  buildPacket,
  listAnnounceAddresses,
  sanitizeMotd,
  selectAnnouncements,
  type AnnounceRow,
  type IfaceMap,
  type LanSocket,
} from '../src/services/lanAnnouncer.js';

const row = (o: Partial<AnnounceRow> = {}): AnnounceRow => ({
  id: 'a',
  name: 'My Server',
  type: 'VANILLA',
  port: 25565,
  lan_announce: true,
  minecraft: null,
  ...o,
});

test('builds the vanilla LAN packet', () => {
  assert.equal(buildPacket('Hello', 25570).toString(), '[MOTD]Hello[/MOTD][AD]25570[/AD]');
});

test('sanitizeMotd strips formatting, brackets, control chars and markers', () => {
  assert.equal(sanitizeMotd('§aGreen §lBold§r text'), 'Green Bold text');
  assert.equal(sanitizeMotd('a[/MOTD][AD]1[/AD]b'), 'a/MOTDAD1/ADb');
  assert.equal(sanitizeMotd('line1\nline2\r\n\ttab\u0000x'), 'line1 line2 tab x');
  assert.equal(sanitizeMotd('first\\nsecond'), 'first second');
  assert.equal(sanitizeMotd('   padded   '), 'padded');
  assert.equal(sanitizeMotd('x'.repeat(200)).length, 60);
  assert.equal(sanitizeMotd('é'.repeat(100)).length, 60);
});

test('sanitizeMotd falls back to the server name, then a default', () => {
  assert.equal(sanitizeMotd(undefined, 'Survival'), 'Survival');
  assert.equal(sanitizeMotd('§a§b', 'Survival'), 'Survival');
  assert.equal(sanitizeMotd('[]', '[x]'), 'x');
  assert.equal(sanitizeMotd('', ''), 'Minecraft Server');
  const body = sanitizeMotd('[/MOTD]evil[AD]9[/AD]');
  assert.ok(!/[[\]]/.test(body));
  assert.equal(buildPacket(body, 1).toString().match(/\[\/?(MOTD|AD)\]/g)?.length, 4);
});

test('selection: only running + enabled + Java servers', () => {
  const rows = [
    row({ id: 'run' }),
    row({ id: 'off', lan_announce: false }),
    row({ id: 'stopped' }),
    row({ id: 'bedrock', type: 'BEDROCK' }),
    row({ id: 'motd', port: 25566, minecraft: { motd: '§bCool World' } }),
  ];
  const running = new Set(['run', 'off', 'bedrock', 'motd']);
  const sel = selectAnnouncements(rows, (id) => running.has(id));
  assert.deepEqual(
    sel.map((s) => [s.id, s.packet.toString()]),
    [
      ['run', '[MOTD]My Server[/MOTD][AD]25565[/AD]'],
      ['motd', '[MOTD]Cool World[/MOTD][AD]25566[/AD]'],
    ],
  );
});

test('interface selection skips virtual, loopback and link-local', () => {
  const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal, netmask: '', mac: '', cidr: null }) as never;
  const ifaces: IfaceMap = {
    lo: [v4('127.0.0.1', true)],
    eth0: [v4('192.168.69.242'), { address: 'fe80::1', family: 'IPv6', internal: false } as never],
    docker0: [v4('172.17.0.1')],
    'br-1234': [v4('172.18.0.1')],
    veth9: [v4('172.19.0.1')],
    eth1: [v4('169.254.3.4')],
    eth2: [v4('10.0.0.5')],
    'vEthernet (Default Switch)': [v4('172.29.96.1')],
    'vEthernet (WSL (Hyper-V firewall))': [v4('172.30.176.1')],
    'vEthernet (Mi Casa Switch)': [v4('192.168.69.2')],
  };
  assert.deepEqual(listAnnounceAddresses(ifaces), ['10.0.0.5', '192.168.69.2', '192.168.69.242']);
  assert.deepEqual(listAnnounceAddresses(ifaces, ['10.0.0.5', '127.0.0.1', '1.2.3.4']), ['10.0.0.5']);
});

function harness(rows: AnnounceRow[], addrs: () => string[]) {
  let t = 0;
  const running = new Set(rows.map((r) => r.id));
  const sent: { addr: string; payload: string; port: number; host: string }[] = [];
  const created: string[] = [];
  const closed: string[] = [];
  const warns: string[] = [];
  let failWith: string | null = null;
  const a = new LanAnnouncer({
    loadRows: async () => rows,
    isRunning: (id) => running.has(id),
    listAddresses: addrs,
    createSocket: (addr): LanSocket => {
      created.push(addr);
      return {
        send: (msg, port, host, cb) => {
          if (failWith) {
            const e = new Error('boom') as NodeJS.ErrnoException;
            e.code = failWith;
            return cb(e);
          }
          sent.push({ addr, payload: msg.toString(), port, host });
          cb(null);
        },
        close: () => closed.push(addr),
      };
    },
    now: () => t,
    log: { warn: (m) => warns.push(m), info: () => undefined },
  });
  return {
    a, sent, created, closed, warns, running,
    advance: (ms: number) => (t += ms),
    fail: (c: string | null) => (failWith = c),
  };
}

test('announcer sends one packet per server per interface to the LAN group', async () => {
  const h = harness([row({ id: 'a' }), row({ id: 'b', name: 'Two', port: 25566 })], () => ['10.0.0.5', '192.168.1.9']);
  await h.a.refresh();
  h.a.tick();
  assert.equal(h.sent.length, 4);
  assert.ok(h.sent.every((s) => s.host === LAN_GROUP && s.port === LAN_PORT));
  assert.deepEqual(h.created, ['10.0.0.5', '192.168.1.9']);
  assert.equal(ANNOUNCE_INTERVAL_MS, 1500);
});

test('announcer reacts to status changes after refresh and releases sockets when idle', async () => {
  const h = harness([row({ id: 'a' })], () => ['10.0.0.5']);
  await h.a.refresh();
  h.a.tick();
  assert.equal(h.sent.length, 1);
  h.running.delete('a');
  await h.a.refresh();
  h.a.tick();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.closed, ['10.0.0.5']);
  h.running.add('a');
  await h.a.refresh();
  h.a.tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.created.length, 2);
});

test('announcer re-enumerates interfaces only every 30 s', async () => {
  let addrs = ['10.0.0.5'];
  const h = harness([row()], () => addrs);
  await h.a.refresh();
  h.a.tick();
  addrs = ['10.0.0.6'];
  h.advance(IFACE_REFRESH_MS - 1);
  h.a.tick();
  assert.deepEqual(h.a.interfaces, ['10.0.0.5']);
  h.advance(1);
  h.a.tick();
  assert.deepEqual(h.a.interfaces, ['10.0.0.6']);
  assert.deepEqual(h.closed, ['10.0.0.5']);
});

test('send errors are logged once per interface/error and do not throw', async () => {
  const h = harness([row()], () => ['10.0.0.5']);
  await h.a.refresh();
  h.fail('ENETUNREACH');
  for (let i = 0; i < 5; i++) h.a.tick();
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0]!, /10\.0\.0\.5.*ENETUNREACH/);
  h.fail(null);
  h.a.tick();
  h.fail('ENETUNREACH');
  h.a.tick();
  assert.equal(h.warns.length, 2); // logged again after a recovery
});
