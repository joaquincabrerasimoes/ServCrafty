import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CpuTracker,
  createProcessMonitor,
  MAX_TRACKED_PIDS,
  parseDuration,
  parsePsText,
  parseRssKb,
  parseTop,
  PS_ARGS,
  redactCommand,
  type MonitorDeps,
  type MonitoredServer,
  type PsRow,
} from '../src/lib/processTop.js';

test('ps args are the ones from the spec', () => {
  assert.equal(PS_ARGS, '-eo pid,ppid,user,time,rss,stat,etime,args');
});

test('parseDuration: etime [[dd-]hh:]mm:ss and time formats', () => {
  assert.equal(parseDuration('00:05'), 5);
  assert.equal(parseDuration('01:05'), 65);
  assert.equal(parseDuration('1:05'), 65);
  assert.equal(parseDuration('02:01:05'), 2 * 3600 + 65);
  assert.equal(parseDuration('3-02:01:05'), 3 * 86400 + 2 * 3600 + 65);
  assert.equal(parseDuration('12-00:00:00'), 12 * 86400);
  // procps `time` is [dd-]hh:mm:ss
  assert.equal(parseDuration('00:00:00'), 0);
  assert.equal(parseDuration('00:12:34'), 754);
  assert.equal(parseDuration('1-00:00:01'), 86401);
  // BusyBox prints mm:ss with minutes > 59, and plain seconds may carry a fraction
  assert.equal(parseDuration('125:07'), 125 * 60 + 7);
  assert.equal(parseDuration('0:01.50'), 1.5);
  assert.equal(parseDuration(' 07 '), 7);
  for (const bad of ['', 'abc', '1-', '-1:00', '1:2:3:4', '3-05', '12h']) assert.equal(parseDuration(bad), null, bad);
});

test('parseRssKb: plain KiB and BusyBox suffixes', () => {
  assert.equal(parseRssKb('123456'), 123456);
  assert.equal(parseRssKb('800k'), 800);
  assert.equal(parseRssKb('12m'), 12 * 1024);
  assert.equal(parseRssKb('1.5g'), 1.5 * 1024 * 1024);
  assert.equal(parseRssKb('x'), null);
});

const PROCPS = `  PID  PPID USER         TIME   RSS STAT     ELAPSED COMMAND
 4123  4100 root     00:00:00  1024 Ss    1-02:03:04 /sbin/tini -- /start
 4150  4123 1000     01:02:03 2097152 Sl         05:06 java -Xmx4G -jar server.jar --nogui
 4199  4123 1000     00:00:01   512 S+           00:09 ./FactoryServer.sh -Port=7777 -ServerPassword=hunter2 -log
`;

test('parsePsText / parseTop: columns, args with spaces, bad rows skipped', () => {
  const rows = parsePsText(PROCPS);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    pid: 4123,
    ppid: 4100,
    user: 'root',
    cpuTimeSec: 0,
    rssKb: 1024,
    state: 'Ss',
    elapsedSec: 86400 + 2 * 3600 + 3 * 60 + 4,
    command: '/sbin/tini -- /start',
  });
  assert.equal(rows[1]!.command, 'java -Xmx4G -jar server.jar --nogui');
  assert.equal(rows[1]!.cpuTimeSec, 3723);
  assert.equal(rows[1]!.elapsedSec, 306);
  assert.equal(rows[1]!.user, '1000');
  // Docker's own top result (rest of line already joined into COMMAND), plus odd rows.
  const top = parseTop({
    Titles: ['PID', 'PPID', 'USER', 'TIME', 'RSS', 'STAT', 'ELAPSED', 'COMMAND'],
    Processes: [
      ['77', '1', 'root', '00:00:02', '2048', 'R', '00:04', 'sh -c echo hi'],
      ['x', '1', 'root', '00:00:02', '2048', 'R', '00:04', 'not a pid'],
      // A splitter that did not join the last column.
      ['78', '77', 'root', '00:00:00', '10', 'S', '00:01', 'sleep', '100'],
    ],
  });
  assert.deepEqual(top.map((r) => [r.pid, r.command]), [
    [77, 'sh -c echo hi'],
    [78, 'sleep 100'],
  ]);
  assert.deepEqual(parseTop({ Titles: ['USER', 'COMMAND'], Processes: [['root', 'x']] }), []);
  assert.deepEqual(parseTop({ Titles: null, Processes: null }), []);
  assert.deepEqual(parsePsText(''), []);
  // BusyBox header/fields.
  const bb = parsePsText('PID   PPID  USER     TIME  RSS  STAT ELAPSED COMMAND\n    1     0 root      0:00  12m  S    125:07 /init x\n');
  assert.equal(bb[0]!.rssKb, 12 * 1024);
  assert.equal(bb[0]!.elapsedSec, 125 * 60 + 7);
});

test('redactCommand: passwords, flags, scf_ tokens, truncation', () => {
  assert.equal(redactCommand('./srv -ServerPassword=hunter2 -log'), './srv -ServerPassword=*** -log');
  assert.equal(redactCommand('./srv -ServerPassword hunter2 -log'), './srv -ServerPassword *** -log');
  assert.equal(redactCommand('srcds +rcon_password s3cr3t +map de_dust2'), 'srcds +rcon_password *** +map de_dust2');
  assert.equal(redactCommand('srv +password pw +maxplayers 8'), 'srv +password *** +maxplayers 8');
  assert.equal(redactCommand('app --password=pw --port 1'), 'app --password=*** --port 1');
  assert.equal(redactCommand('app --password pw'), 'app --password ***');
  assert.equal(redactCommand('app -password pw'), 'app -password ***');
  assert.equal(redactCommand('app rcon_password pw'), 'app rcon_password ***');
  assert.equal(redactCommand('ucc server KF-Farm?Game=KF?Password=abc?AdminPassword=def?Mut=x'), 'ucc server KF-Farm?Game=KF?Password=***?AdminPassword=***?Mut=x');
  assert.equal(redactCommand('curl -H Authorization:Bearer scf_abcDEF123_xyz http://x'), 'curl -H Authorization:Bearer scf_*** http://x');
  assert.equal(redactCommand('x --api-key=K --token=T SECRET_KEY=abc'), 'x --api-key=*** --token=*** SECRET_KEY=***');
  assert.equal(redactCommand('java -Xmx4G -jar server.jar nogui'), 'java -Xmx4G -jar server.jar nogui');
  const long = redactCommand(`x ${'a'.repeat(1000)}`);
  assert.equal(long.length, 500);
  assert.ok(long.endsWith('…'));
  // Control characters (a crafted argv) never break the output.
  assert.equal(redactCommand('a\nb\tc'), 'a b c');
});

const psRow = (pid: number, cpuTimeSec: number, elapsedSec: number): PsRow => ({
  pid,
  ppid: 1,
  user: 'root',
  cpuTimeSec,
  rssKb: 1024,
  state: 'S',
  elapsedSec,
  command: 'x',
});

test('CpuTracker: first sample = lifetime average, then deltas; dead pids and containers dropped', () => {
  const t = new CpuTracker();
  // 50 s CPU over 100 s lifetime = 50 %
  let r = t.sample('c1', [psRow(10, 50, 100), psRow(11, 0, 0)], 1_000_000);
  assert.equal(r.get(10), 50);
  assert.equal(r.get(11), 0);
  // 2 s later the pid used 3 more CPU seconds (multi-threaded): 150 %
  r = t.sample('c1', [psRow(10, 53, 102)], 1_002_000);
  assert.equal(r.get(10), 150);
  // pid 11 was not seen: dropped
  assert.equal(t.size(), 1);
  // Baseline is the oldest recent sample (4 s old): (54 - 50) / 4 s = 100 %
  r = t.sample('c1', [psRow(10, 54, 104)], 1_004_000);
  assert.equal(r.get(10), 100);
  // pid reuse (cpu time went backwards) -> lifetime average again
  r = t.sample('c1', [psRow(10, 1, 4)], 1_005_000);
  assert.equal(r.get(10), 25);
  // idle process: 0 %
  r = t.sample('c1', [psRow(10, 1, 6)], 1_007_000);
  assert.equal(r.get(10), 0);
  // Old samples (> 10 s) are not used as baseline.
  r = t.sample('c1', [psRow(10, 21, 40)], 1_040_000);
  assert.equal(r.get(10), Math.round((21 / 40) * 1000) / 10);
  // Containers not retained are forgotten; containers not sampled for a minute expire.
  t.sample('c2', [psRow(5, 0, 1)], 1_040_000);
  assert.equal(t.containerCount(), 2);
  t.retain(['c2']);
  assert.equal(t.containerCount(), 1);
  t.sample('c3', [psRow(6, 0, 1)], 1_200_000);
  assert.equal(t.containerCount(), 1);
});

test('CpuTracker: bounded total', () => {
  const t = new CpuTracker();
  const many = (n: number, base: number) => Array.from({ length: n }, (_, i) => psRow(base + i, 0, 1));
  t.sample('a', many(MAX_TRACKED_PIDS, 1), 1000);
  t.sample('b', many(100, 1), 2000);
  assert.ok(t.size() <= MAX_TRACKED_PIDS);
  assert.equal(t.containerCount(), 1);
});

function server(id: string, containerId: string | null, over: Partial<MonitoredServer> = {}): MonitoredServer {
  return {
    serverId: id,
    name: `srv-${id}`,
    game: 'minecraft',
    gameKey: 'minecraft',
    status: 'running',
    containerId,
    cpuLimit: 2,
    stats: { cpuPercent: 37.5, memUsedMb: 1500, memLimitMb: 4096 },
    ...over,
  };
}

function deps(over: Partial<MonitorDeps> & { clock?: { t: number } } = {}): MonitorDeps & { calls: string[] } {
  const clock = over.clock ?? { t: 5_000_000 };
  const calls: string[] = [];
  return {
    calls,
    listServers: async () => [server('a', 'ca'), server('b', 'cb', { stats: null }), server('c', 'gone')],
    top: async (id, args) => {
      calls.push(`${id} ${args}`);
      if (id === 'gone') throw Object.assign(new Error('no such container'), { statusCode: 404 });
      return {
        Titles: ['PID', 'PPID', 'USER', 'TIME', 'RSS', 'STAT', 'ELAPSED', 'COMMAND'],
        Processes: [['100', '1', 'root', '00:00:10', '409600', 'Sl', '00:20', 'java -Dpassword=x -jar s.jar']],
      };
    },
    dockerAvailable: async () => true,
    host: () => ({ cpuCount: 8, memTotalMb: 16384 }),
    now: () => clock.t,
    ...over,
  };
}

test('snapshot: shape, totals from runtime stats, mem%, redaction, vanished container tolerated', async () => {
  const d = deps();
  const m = createProcessMonitor(d);
  const s = await m.snapshot();
  assert.equal(s.dockerAvailable, true);
  assert.deepEqual(s.host, { cpuCount: 8, memTotalMb: 16384 });
  assert.equal(s.intervalMs, 1500);
  assert.equal(s.servers.length, 3);
  const a = s.servers[0]!;
  assert.equal(a.cpuPercent, 37.5);
  assert.equal(a.memUsedMb, 1500);
  assert.equal(a.memLimitMb, 4096);
  assert.equal(a.processes.length, 1);
  const p = a.processes[0]!;
  assert.equal(p.memMb, 400);
  assert.equal(p.memPercent, Math.round((400 / 4096) * 1000) / 10);
  assert.equal(p.cpuPercent, 50);
  assert.equal(p.command, 'java -Dpassword=*** -jar s.jar');
  // No container limit known -> host memory
  assert.equal(s.servers[1]!.processes[0]!.memPercent, Math.round((400 / 16384) * 1000) / 10);
  assert.equal(s.servers[1]!.cpuPercent, 0);
  // Vanished container: listed with no processes, the request does not fail.
  assert.deepEqual(s.servers[2]!.processes, []);
  assert.ok(d.calls.every((c) => c.endsWith(PS_ARGS)));
});

test('snapshot: cached for 1.5 s and shared while in flight', async () => {
  const clock = { t: 1_000_000 };
  const d = deps({ clock });
  const m = createProcessMonitor(d);
  const [x, y] = await Promise.all([m.snapshot(), m.snapshot()]);
  assert.equal(x, y);
  assert.equal(d.calls.length, 3);
  clock.t += 1000;
  assert.equal(await m.snapshot(), x);
  assert.equal(d.calls.length, 3);
  clock.t += 600;
  const z = await m.snapshot();
  assert.notEqual(z, x);
  assert.equal(d.calls.length, 6);
});

test('snapshot: docker down -> servers listed, no processes, dockerAvailable false', async () => {
  const d = deps({ dockerAvailable: async () => false });
  const s = await createProcessMonitor(d).snapshot();
  assert.equal(s.dockerAvailable, false);
  assert.equal(s.servers.length, 3);
  assert.ok(s.servers.every((x) => x.processes.length === 0));
  assert.equal(d.calls.length, 0);
  // A throwing availability check counts as down too.
  const s2 = await createProcessMonitor(deps({ dockerAvailable: async () => Promise.reject(new Error('x')) })).snapshot();
  assert.equal(s2.dockerAvailable, false);
});

test('snapshot: at most 64 servers', async () => {
  const d = deps({ listServers: async () => Array.from({ length: 80 }, (_, i) => server(String(i), `c${i}`)) });
  const s = await createProcessMonitor(d).snapshot();
  assert.equal(s.servers.length, 64);
});
