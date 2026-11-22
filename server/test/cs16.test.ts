import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import SevenZipImport, { type SevenZipModuleFactory } from '7z-wasm';
import {
  assertBotRequest,
  assertMatchSettings,
  banCommands,
  botCommands,
  changeLevelCommand,
  kickCommand,
  END_LINE,
  parseStatus,
  readMatchSettings,
  restartCommand,
  sayCommand,
  settingCommands,
} from '../src/lib/cs16/control.js';
import { assertMapcycle, formatMapcycle, parseMapcycle, planMapInstall, STOCK_MAPS } from '../src/lib/cs16/maps.js';
import { downloadFileTo, imageUrl, plainText, searchUrl, toCatalogDetail, toCatalogMap } from '../src/lib/cs16/gamebanana.js';
import { addMetamodLine, CS16_PLUGIN_CATALOG, removeMetamodLine, withDependencies } from '../src/lib/cs16/pluginCatalog.js';
import { extractArchive } from '../src/lib/sevenZip.js';

const SevenZip = ((SevenZipImport as unknown as { default?: unknown }).default ?? SevenZipImport) as SevenZipModuleFactory;

// ---------------------------------------------------------------------------------------------
// Controls

test('cs16 commands: changelevel, kick, ban, restart, say', () => {
  assert.equal(changeLevelCommand('de_dust2'), 'changelevel de_dust2');
  assert.throws(() => changeLevelCommand('de_dust2; quit'), /Invalid map/);
  assert.equal(kickCommand(5), 'kick #5');
  assert.equal(kickCommand(5, 'camping; quit "now"'), 'kick #5 camping quit now');
  assert.throws(() => kickCommand(0), /Invalid player/);
  assert.deepEqual(banCommands(7, 30), ['banid 30 #7 kick', 'writeid']);
  assert.deepEqual(banCommands(7, 0), ['banid 0 #7 kick', 'writeid']);
  assert.throws(() => banCommands(7, -1), /ban length/);
  assert.equal(restartCommand('round'), 'sv_restartround 1');
  assert.equal(restartCommand('game'), 'sv_restart 1');
  assert.throws(() => restartCommand('x'), /restart/);
  assert.equal(sayCommand('hello; quit'), 'say hello quit');
  assert.throws(() => sayCommand('  '), /empty/);
});

test('cs16 bots: stock commands and YaPB commands', () => {
  assert.deepEqual(botCommands('stock', assertBotRequest({ action: 'add', team: 't' })), ['bot_add_t']);
  assert.deepEqual(botCommands('stock', assertBotRequest({ action: 'add', team: 'ct' })), ['bot_add_ct']);
  assert.deepEqual(botCommands('stock', assertBotRequest({ action: 'add' })), ['bot_add']);
  assert.deepEqual(botCommands('stock', assertBotRequest({ action: 'kick_all' })), ['bot_kick']);
  assert.deepEqual(botCommands('stock', assertBotRequest({ action: 'quota', count: 8 })), ['bot_quota 8']);
  assert.deepEqual(botCommands('stock', assertBotRequest({ action: 'difficulty', level: 'expert' })), ['bot_difficulty 3']);
  assert.deepEqual(botCommands('stock', assertBotRequest({ action: 'knives_only', on: true })), ['bot_knives_only 1']);
  assert.deepEqual(botCommands('yapb', assertBotRequest({ action: 'add' })), ['yb add']);
  assert.deepEqual(botCommands('yapb', assertBotRequest({ action: 'kick_all' })), ['yb kickall']);
  assert.deepEqual(botCommands('yapb', assertBotRequest({ action: 'quota', count: 4 })), ['yb_quota 4']);
  assert.equal(botCommands('yapb', assertBotRequest({ action: 'difficulty', level: 'hard' })), null);
  for (const bad of [null, {}, { action: 'quota', count: 33 }, { action: 'quota', count: 1.5 }, { action: 'add', team: 'spec' }, { action: 'difficulty', level: 'god' }, { action: 'rm -rf' }]) {
    assert.throws(() => assertBotRequest(bad), Error, JSON.stringify(bad));
  }
});

test('cs16 match settings: validate, commands and reading server.cfg', () => {
  const v = assertMatchSettings({ mp_timelimit: 30, mp_friendlyfire: true });
  assert.deepEqual(settingCommands(v), ['mp_timelimit 30', 'mp_friendlyfire 1']);
  for (const bad of [{ nope: 1 }, { mp_timelimit: -1 }, { mp_timelimit: '30' }, { mp_friendlyfire: 1 }, { mp_roundtime: 99 }, []]) {
    assert.throws(() => assertMatchSettings(bad), Error, JSON.stringify(bad));
  }
  const cfg = 'hostname "x"\nmp_timelimit 35\nmp_friendlyfire "1"\n// mp_c4timer 99\nmp_startmoney 3000 // comment\n';
  const read = readMatchSettings(cfg);
  assert.equal(read.mp_timelimit, 35);
  assert.equal(read.mp_friendlyfire, true);
  assert.equal(read.mp_c4timer, 45); // commented out -> default
  assert.equal(read.mp_startmoney, 3000);
  assert.equal(read.mp_roundtime, 5); // missing -> default
});

test('cs16 end marker: only the echoed line matches, not the command echo', () => {
  assert.ok(END_LINE.test('servcrafty-end'));
  assert.ok(END_LINE.test('servcrafty-end\r'));
  assert.ok(!END_LINE.test('> echo servcrafty-end'));
  assert.ok(!END_LINE.test('servcrafty-ends'));
});

test('cs16 status: players, bots and the map', () => {
  const out = [
    'hostname:  Counter-Strike 1.6 Server',
    'map     :  de_dust2 at: 0 x, 0 y, 0 z',
    'players :  2 active (16 max)',
    '',
    '#      name userid uniqueid frag time ping loss adr',
    '# 1 "Stervil98" 2 STEAM_0:1:91473723   5 00:12   40    0 1.2.3.4:27005',
    '# 2 "Juan Pérez" 3 STEAM_0:0:5   -1 1:02:03   120   3 10.0.0.1:27005',
    '# 3 "Ruben" 4 BOT   0 00:12    0    0',
    'servcrafty-end',
  ];
  const s = parseStatus(out);
  assert.equal(s.map, 'de_dust2');
  assert.equal(s.players.length, 3);
  assert.deepEqual(s.players[0], { userId: 2, name: 'Stervil98', steamId: 'STEAM_0:1:91473723', bot: false, frags: 5, connected: '00:12', ping: 40, loss: 0 });
  assert.equal(s.players[1]!.name, 'Juan Pérez');
  assert.equal(s.players[1]!.frags, -1);
  assert.equal(s.players[1]!.connected, '1:02:03');
  assert.equal(s.players[2]!.bot, true);
  assert.equal(s.players[2]!.userId, 4);
});

// ---------------------------------------------------------------------------------------------
// Maps

test('mapcycle: parse, format, validation', () => {
  assert.deepEqual(parseMapcycle('de_dust2\r\n// a comment\n\n  cs_office  // trailing\nbad!name\n\nde_nuke\n'), ['de_dust2', 'cs_office', 'de_nuke']);
  assert.equal(formatMapcycle(['de_dust2', 'cs_office']), 'de_dust2\ncs_office\n');
  const installed = new Set(['de_dust2', 'cs_office']);
  assert.deepEqual(assertMapcycle(['de_dust2', 'cs_office', 'de_dust2'], installed), ['de_dust2', 'cs_office', 'de_dust2']);
  assert.throws(() => assertMapcycle([], installed), /1 to/);
  assert.throws(() => assertMapcycle(['de_dust2', 'aim_x'], installed), /Not installed: aim_x/);
  assert.throws(() => assertMapcycle(['de_dust2; quit'], installed), /Invalid map/);
  assert.throws(() => assertMapcycle('de_dust2', installed), /1 to/);
  assert.ok(STOCK_MAPS.includes('de_dust2') && STOCK_MAPS.length === 25);
});

test('planMapInstall: the layouts GameBanana packages come in', () => {
  // `cstrike/maps/..` and a wrapping folder; readme and screenshots are not game content
  let p = planMapInstall(['Aim_Map/cstrike/maps/aim_map.bsp', 'Aim_Map/cstrike/maps/aim_map.txt', 'Aim_Map/readme.txt', 'Aim_Map/shot.jpg', 'Aim_Map/cstrike/sound/ambience/x.wav']);
  assert.deepEqual(p.files.map((f) => f.to), ['maps/aim_map.bsp', 'maps/aim_map.txt', 'sound/ambience/x.wav']);
  assert.deepEqual(p.maps, ['aim_map']);
  assert.deepEqual(p.skipped, ['Aim_Map/readme.txt', 'Aim_Map/shot.jpg']);
  // loose files in the root, upper case (Linux is case sensitive)
  p = planMapInstall(['Aim_training.bsp', 'Instructions.wad', 'README.txt']);
  assert.deepEqual(p.files.map((f) => f.to), ['maps/aim_training.bsp', 'instructions.wad']);
  assert.deepEqual(p.maps, ['aim_training']);
  // a folder that is not an asset folder holding the map
  p = planMapInstall(['legocity/map/aim_legocity.bsp', 'legocity/scns/1.JPG']);
  assert.deepEqual(p.files.map((f) => f.to), ['maps/aim_legocity.bsp']);
  // models and sprites keep their folders
  p = planMapInstall(['maps/x.bsp', 'models/props/box.mdl', 'sprites/glow.spr', 'gfx/env/skyup.tga', 'overviews/x.bmp', 'overviews/x.txt']);
  assert.deepEqual(p.files.map((f) => f.to), ['maps/x.bsp', 'models/props/box.mdl', 'sprites/glow.spr', 'gfx/env/skyup.tga', 'overviews/x.bmp']);
  assert.deepEqual(p.skipped, ['overviews/x.txt']);
});

test('planMapInstall: never lets code, configs or paths outside cstrike/ through', () => {
  const p = planMapInstall([
    'maps/x.bsp',
    'addons/amxmodx/plugins/evil.amxx',
    'dlls/cs.so',
    'dlls/mp.dll',
    'server.cfg',
    'autoexec.cfg',
    'maps/run.cfg',
    'maps/evil.sh',
    '../../etc/passwd',
    'maps/../../outside.bsp',
    '/abs/maps/y.bsp',
    'maps/we ird.bsp',
    'maps/ok.so',
    'a/b/c/d/e/f/g/h/i/maps/deep.bsp',
  ]);
  assert.deepEqual(p.files.map((f) => f.to), ['maps/x.bsp', 'maps/y.bsp']);
  assert.deepEqual(p.maps, ['x', 'y']);
  assert.ok(p.files.every((f) => !f.to.startsWith('/') && !f.to.includes('..')));
  // two entries that land on the same place: the first wins
  const dup = planMapInstall(['a/maps/x.bsp', 'b/maps/X.bsp']);
  assert.equal(dup.files.length, 1);
});

// ---------------------------------------------------------------------------------------------
// GameBanana

const record = {
  _idRow: 92163,
  _sName: 'cs_mansion',
  _bHasFiles: true,
  _nLikeCount: 43,
  _nViewCount: 345412,
  _tsDateAdded: 1322855532,
  _tsDateModified: 1377847169,
  _aSubmitter: { _sName: 'Anushapopli' },
  _aRootCategory: { _sName: 'Maps' },
  _aSubCategory: { _sName: 'Hostage Rescue' },
  _aPreviewMedia: { _aImages: [{ _sType: 'screenshot', _sBaseUrl: 'https://images.gamebanana.com/img/ss/mods', _sFile: 'a.jpg', _sFile530: '530-90_a.jpg' }] },
};

test('gamebanana: a search record becomes a catalogue entry', () => {
  const m = toCatalogMap(record);
  assert.equal(m.id, 92163);
  assert.equal(m.name, 'cs_mansion');
  assert.equal(m.category, 'Hostage Rescue');
  assert.equal(m.thumbnail, 'https://images.gamebanana.com/img/ss/mods/530-90_a.jpg');
  assert.equal(m.submitter, 'Anushapopli');
  assert.equal(m.likes, 43);
  assert.equal(m.addedAt, '2011-12-02T19:52:12.000Z');
  assert.equal(m.url, 'https://gamebanana.com/mods/92163');
});

test('gamebanana: thumbnails only from the image host over https', () => {
  assert.equal(imageUrl('https://images.gamebanana.com/img/ss/mods', 'a.jpg'), 'https://images.gamebanana.com/img/ss/mods/a.jpg');
  assert.equal(imageUrl('http://images.gamebanana.com/img', 'a.jpg'), null);
  assert.equal(imageUrl('https://evil.example/img', 'a.jpg'), null);
  assert.equal(imageUrl('https://images.gamebanana.com.evil.example/img', 'a.jpg'), null);
  assert.equal(imageUrl('https://images.gamebanana.com/img', '../../x.jpg'), null);
  assert.equal(imageUrl(undefined, 'a.jpg'), null);
});

test('gamebanana: detail with files, description as plain text', () => {
  const d = toCatalogDetail({
    ...record,
    _sText: '<b>Great <i>map</i></b><br>Line&nbsp;two &amp; more<script>alert(1)</script>',
    _nDownloadCount: 168860,
    _aFiles: [
      { _idRow: 307023, _sFile: 'cs_mansion.7z', _nFilesize: 167752, _sMd5Checksum: '546b481e0c21ebf51b718262ffaad8f8', _nDownloadCount: 5, _sAvResult: 'clean' },
      { _idRow: 1, _sFile: 'old.zip', _bIsArchived: true },
    ],
  });
  assert.equal(d.files.length, 1);
  assert.deepEqual(d.files[0], { id: 307023, name: 'cs_mansion.7z', size: 167752, md5: '546b481e0c21ebf51b718262ffaad8f8', downloads: 5, addedAt: null, clean: true });
  assert.ok(!d.description.includes('<'));
  assert.ok(d.description.startsWith('Great map'));
  assert.equal(d.downloads, 168860);
  assert.equal(plainText(undefined), '');
});

test('gamebanana: search URL has the game, the Maps category, the page size and the sort', () => {
  const u = new URL(searchUrl({ q: 'dust, 2', page: 3, sort: 'newest' }));
  assert.equal(u.searchParams.get('_aFilters[Generic_Game]'), '4254');
  assert.equal(u.searchParams.get('_aFilters[Generic_Category]'), '5474');
  assert.equal(u.searchParams.get('_aFilters[Generic_Name]'), 'contains,dust  2');
  assert.equal(u.searchParams.get('_nPage'), '3');
  assert.equal(u.searchParams.get('_sSort'), 'Generic_Newest');
  const d = new URL(searchUrl({ category: 5484 }));
  assert.equal(d.searchParams.get('_aFilters[Generic_Category]'), '5484');
  assert.equal(d.searchParams.get('_aFilters[Generic_Name]'), null);
  assert.equal(d.searchParams.get('_sSort'), 'Generic_MostDownloaded');
});

function fakeFetch(steps: Array<{ status: number; location?: string; body?: string }>) {
  const seen: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    seen.push(String(url));
    const s = steps.shift();
    if (!s) throw new Error('unexpected request');
    return new Response(s.body ?? null, { status: s.status, headers: s.location ? { location: s.location } : {} });
  }) as typeof fetch;
  return { fn, seen };
}

test('gamebanana download: follows redirects inside gamebanana.com only and checks the MD5', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs16-dl-'));
  try {
    const md5 = 'acbd18db4cc2f85cedef654fccc4a4d8'; // md5("foo")
    const ok = fakeFetch([{ status: 302, location: 'https://files.gamebanana.com/dl/abc' }, { status: 200, body: 'foo' }]);
    assert.equal(await downloadFileTo(307023, path.join(dir, 'a.bin'), md5, ok.fn), 3);
    assert.deepEqual(ok.seen, ['https://gamebanana.com/dl/307023', 'https://files.gamebanana.com/dl/abc']);
    assert.equal(await fs.readFile(path.join(dir, 'a.bin'), 'utf8'), 'foo');

    const evil = fakeFetch([{ status: 302, location: 'https://evil.example/x.zip' }]);
    await assert.rejects(downloadFileTo(1, path.join(dir, 'b.bin'), null, evil.fn), /unexpected download host/);
    const lookalike = fakeFetch([{ status: 302, location: 'https://gamebanana.com.evil.example/x' }]);
    await assert.rejects(downloadFileTo(1, path.join(dir, 'b.bin'), null, lookalike.fn), /unexpected download host/);
    const plain = fakeFetch([{ status: 302, location: 'http://files.gamebanana.com/x' }]);
    await assert.rejects(downloadFileTo(1, path.join(dir, 'b.bin'), null, plain.fn), /unexpected download host/);

    const bad = fakeFetch([{ status: 200, body: 'bar' }]);
    await assert.rejects(downloadFileTo(1, path.join(dir, 'c.bin'), md5, bad.fn), /checksum/);
    await assert.rejects(fs.stat(path.join(dir, 'c.bin')));
    await assert.rejects(downloadFileTo(0, path.join(dir, 'd.bin'), null, ok.fn), /Invalid map id/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Plugins

test('cs16 plugin catalogue: pinned https hosts, dependencies, plugins.ini lines', () => {
  assert.deepEqual(withDependencies('amxmodx').map((p) => p.id), ['metamod', 'amxmodx']);
  assert.deepEqual(withDependencies('yapb').map((p) => p.id), ['metamod', 'yapb']);
  for (const p of CS16_PLUGIN_CATALOG) {
    for (const s of p.sources) {
      const url = s.url ?? s.latest?.index;
      assert.ok(url?.startsWith('https://'), p.id);
      assert.ok(/^https:\/\/(github\.com|www\.amxmodx\.org)\//.test(url!), `${p.id}: ${url}`);
    }
    for (const dep of p.requires) assert.ok(CS16_PLUGIN_CATALOG.some((x) => x.id === dep), `${p.id} needs ${dep}`);
  }
  const line = 'linux addons/yapb/bin/yapb.so';
  let t = addMetamodLine('; comment\r\nlinux addons/amxmodx/dlls/amxmodx_mm_i386.so\r\n', line);
  assert.equal(t, '; comment\r\nlinux addons/amxmodx/dlls/amxmodx_mm_i386.so\r\nlinux addons/yapb/bin/yapb.so\r\n');
  assert.equal(addMetamodLine(t, line), t); // no duplicates
  t = removeMetamodLine(t, line);
  assert.equal(t, '; comment\r\nlinux addons/amxmodx/dlls/amxmodx_mm_i386.so\r\n');
  assert.equal(removeMetamodLine(addMetamodLine('', line), line), '');
});

// ---------------------------------------------------------------------------------------------
// Archives (built with 7-Zip itself)

async function build(format: 'zip' | '7z' | 'tar.xz', files: Record<string, string>): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs16-arc-'));
  const sz = await SevenZip({ print: () => undefined, printErr: () => undefined });
  const mk = (p: string) => {
    const parts = p.split('/');
    let cur = '';
    for (const part of parts.slice(0, -1)) {
      cur += `/${part}`;
      try {
        sz.FS.mkdir(`/src${cur}`);
      } catch {
        /* exists */
      }
    }
  };
  sz.FS.mkdir('/src');
  for (const [name, content] of Object.entries(files)) {
    mk(name);
    const h = sz.FS.open(`/src/${name}`, 'w+');
    const b = Buffer.from(content);
    sz.FS.write(h, b, 0, b.length);
    sz.FS.close(h);
  }
  const run = (args: string[]) => {
    try {
      sz.callMain(args);
    } catch (e) {
      if ((e as { status?: number }).status !== 0) throw e;
    }
  };
  let out: string;
  if (format === 'tar.xz') {
    run(['a', '-ttar', '/tmp.tar', '/src/*', '-bso0', '-bsp0']);
    run(['a', '-txz', '/out.tar.xz', '/tmp.tar', '-bso0', '-bsp0']);
    out = '/out.tar.xz';
  } else {
    out = `/out.${format}`;
    run(['a', `-t${format}`, out, '/src/*', '-bso0', '-bsp0']);
  }
  const file = path.join(dir, `pkg.${format}`);
  await fs.writeFile(file, sz.FS.readFile(out));
  return { dir, file };
}

for (const format of ['zip', '7z', 'tar.xz'] as const) {
  test(`extractArchive: ${format} (also nested folders and spaces in names)`, async () => {
    const { dir, file } = await build(format, { 'maps/x.bsp': 'BSP', 'maps/x.txt': 'desc', 'sound/a b/c.wav': 'WAV' });
    const dest = path.join(dir, 'out');
    await fs.mkdir(dest);
    try {
      const written = (await extractArchive(file, dest)).sort();
      assert.deepEqual(written, ['maps/x.bsp', 'maps/x.txt', 'sound/a b/c.wav']);
      assert.equal(await fs.readFile(path.join(dest, 'maps', 'x.bsp'), 'utf8'), 'BSP');
      assert.equal(await fs.readFile(path.join(dest, 'sound', 'a b', 'c.wav'), 'utf8'), 'WAV');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('extractArchive: refuses a file that is not an archive, and an archive over the size limit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs16-arc-'));
  try {
    const bad = path.join(dir, 'bad.zip');
    await fs.writeFile(bad, 'this is not an archive');
    await fs.mkdir(path.join(dir, 'out'));
    await assert.rejects(extractArchive(bad, path.join(dir, 'out')), /not a valid archive|could not be extracted/i);
    const { file } = await build('zip', { 'a.bsp': 'x'.repeat(2000) });
    await assert.rejects(extractArchive(file, path.join(dir, 'out'), { maxArchiveBytes: 10, maxExtractedBytes: 1e9, maxFiles: 10 }), /too large/);
    await assert.rejects(extractArchive(file, path.join(dir, 'out'), { maxArchiveBytes: 1e9, maxExtractedBytes: 100, maxFiles: 10 }), /too large/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
