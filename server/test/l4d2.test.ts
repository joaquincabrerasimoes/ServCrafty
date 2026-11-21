import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseKeyValues, kvObject, kvString } from '../src/lib/keyvalues.js';
import { openVpk, readVpkEntry, VpkError } from '../src/lib/vpk.js';
import { chapterTitle, firstMap, parseMission, scanGame } from '../src/lib/l4d2/campaigns.js';
import {
  assertItem,
  assertMap,
  addBotCommand,
  assertCharacter,
  CHARACTERS,
  CHEAT_REFUSED,
  parseCheatsState,
  parseAddBot,
  parseSurvivorList,
  assertUserId,
  changeLevelCommands,
  cleanReason,
  giveCommand,
  ITEM_GROUPS,
  kickCommand,
  parseStatus,
  STATUS_END,
} from '../src/lib/l4d2/control.js';

/** A VPK v1 in memory. `preload` files live in the tree, the others in the data section (archive 0x7FFF). */
function buildVpk(files: { path: string; data: string; preload?: boolean }[]): Buffer {
  const byExt = new Map<string, Map<string, { name: string; data: Buffer; preload: boolean }[]>>();
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const dir = slash < 0 ? ' ' : f.path.slice(0, slash);
    const file = f.path.slice(slash + 1);
    const dot = file.lastIndexOf('.');
    const ext = dot < 0 ? ' ' : file.slice(dot + 1);
    const name = dot < 0 ? file : file.slice(0, dot);
    if (!byExt.has(ext)) byExt.set(ext, new Map());
    const dirs = byExt.get(ext)!;
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push({ name, data: Buffer.from(f.data), preload: !!f.preload });
  }
  const tree: Buffer[] = [];
  const data: Buffer[] = [];
  let offset = 0;
  const str = (s: string) => tree.push(Buffer.from(`${s}\0`));
  for (const [ext, dirs] of byExt) {
    str(ext);
    for (const [dir, names] of dirs) {
      str(dir);
      for (const n of names) {
        str(n.name);
        const e = Buffer.alloc(18);
        e.writeUInt32LE(0, 0);
        e.writeUInt16LE(n.preload ? n.data.length : 0, 4);
        e.writeUInt16LE(0x7fff, 6);
        e.writeUInt32LE(n.preload ? 0 : offset, 8);
        e.writeUInt32LE(n.preload ? 0 : n.data.length, 12);
        e.writeUInt16LE(0xffff, 16);
        tree.push(e);
        if (n.preload) tree.push(n.data);
        else {
          data.push(n.data);
          offset += n.data.length;
        }
      }
      str('');
    }
    str('');
  }
  str('');
  const t = Buffer.concat(tree);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x55aa1234, 0);
  head.writeUInt32LE(1, 4);
  head.writeUInt32LE(t.length, 8);
  return Buffer.concat([head, t, ...data]);
}

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'servcrafty-l4d2-'));
}

const MISSION = `"mission"
{
	"Name"		"Test Campaign"   // a comment
	"Author"	"Someone"
	"DisplayTitle"	"The Test Campaign"
	"modes"
	{
		"coop"
		{
			"1"	{ "Map" "tc_m1_start"  "DisplayName" "Start" }
			"2"	{ "Map" "tc_m2_end"    "DisplayName" "#Token" }
		}
		"survival"
		{
			"1"	{ "Map" "tc_m1_start" }
		}
		"unknownmode" { "1" { "Map" "x" } }
	}
}`;

test('keyvalues: nested blocks, comments, case-insensitive keys, escapes', () => {
  const kv = parseKeyValues(MISSION);
  const m = kvObject(kv, 'MISSION')!;
  assert.equal(kvString(m, 'name'), 'Test Campaign');
  assert.equal(kvString(kvObject(kvObject(kvObject(m, 'modes'), 'coop'), '1'), 'map'), 'tc_m1_start');
  assert.deepEqual(parseKeyValues('"a" "x\\ny" "b" { "c" "d" }'), { a: 'x\ny', b: { c: 'd' } });
  // Malformed input never throws.
  assert.doesNotThrow(() => parseKeyValues('"a" { "b" '));
  assert.doesNotThrow(() => parseKeyValues('}}}{{{ "x"'));
  assert.doesNotThrow(() => parseKeyValues('{'.repeat(5000)));
});

test('mission: chapters per known mode, tokens fall back to the map name', () => {
  const m = parseMission(MISSION)!;
  assert.equal(m.title, 'The Test Campaign');
  assert.deepEqual(m.modes.coop, [
    { map: 'tc_m1_start', title: 'Start' },
    { map: 'tc_m2_end', title: 'Tc M2 End' },
  ]);
  assert.deepEqual(m.modes.survival, [{ map: 'tc_m1_start', title: 'Tc M1 Start' }]);
  assert.equal(Object.keys(m.modes).includes('unknownmode'), false);
  assert.equal(parseMission('"mission" { "Name" "x" }'), null);
  assert.equal(parseMission('not a mission'), null);
  assert.equal(chapterTitle('c4m2_sugarmill_a'), 'Sugarmill A');
});

test('vpk: lists files, reads preload and archive data, refuses damaged files', async () => {
  const dir = await tmp();
  try {
    const file = path.join(dir, 'a.vpk');
    await fsp.writeFile(file, buildVpk([
      { path: 'maps/foo.bsp', data: 'BSP!' },
      { path: 'missions/foo.txt', data: MISSION },
      { path: 'addoninfo.txt', data: '"AddonInfo" { "addontitle" "Foo" }', preload: true },
    ]));
    const v = await openVpk(file);
    assert.deepEqual(v.entries.map((e) => e.path).sort(), ['addoninfo.txt', 'maps/foo.bsp', 'missions/foo.txt']);
    const get = (p: string) => readVpkEntry(v, v.entries.find((e) => e.path === p)!);
    assert.equal((await get('maps/foo.bsp')).toString(), 'BSP!');
    assert.equal((await get('missions/foo.txt')).toString(), MISSION);
    assert.match((await get('addoninfo.txt')).toString(), /addontitle/);

    await fsp.writeFile(path.join(dir, 'bad.vpk'), 'this is not a vpk file at all');
    await assert.rejects(openVpk(path.join(dir, 'bad.vpk')), VpkError);
    const whole = await fsp.readFile(file);
    await fsp.writeFile(path.join(dir, 'cut.vpk'), whole.subarray(0, 30));
    await assert.rejects(openVpk(path.join(dir, 'cut.vpk')), VpkError);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('scanGame: the campaigns of the DLC folders (The Passing, The Sacrifice, the Left 4 Dead 1 ports...) are listed too', async () => {
  const dir = await tmp();
  try {
    const mission = (name: string, maps: string[]) =>
      `"mission" { "Name" "${name}" "modes" { "coop" { ${maps.map((m, i) => `"${i + 1}" { "Map" "${m}" }`).join(' ')} } } }`;
    const put = async (folder: string, files: { path: string; data: string }[]) => {
      await fsp.mkdir(path.join(dir, folder), { recursive: true });
      await fsp.writeFile(path.join(dir, folder, 'pak01_dir.vpk'), buildVpk(files));
    };
    // Where the real game keeps them: the base folder only has the first campaigns.
    await put('left4dead2', [{ path: 'missions/l4d2c1.txt', data: mission('L4D2C1', ['c1m1_hotel', 'c1m2_streets']) }, { path: 'maps/c1m1_hotel.bsp', data: 'x' }]);
    await put('left4dead2_dlc1', [{ path: 'missions/l4d2c6.txt', data: mission('L4D2C6', ['c6m1_riverbank']) }, { path: 'maps/c6m1_riverbank.bsp', data: 'x' }]);
    await put('left4dead2_dlc2', [
      { path: 'missions/l4d2c8.txt', data: mission('L4D2C8', ['c8m1_apartment', 'c8m2_subway']) },
      { path: 'missions/l4d2c10.txt', data: mission('L4D2C10', ['c10m1_caves']) },
      { path: 'maps/c8m1_apartment.bsp', data: 'x' },
    ]);
    await put('left4dead2_dlc3', [{ path: 'missions/l4d2c13.txt', data: mission('L4D2C13', ['c13m1_alpinecreek']) }]);
    // A damaged pak does not hide the others.
    await fsp.mkdir(path.join(dir, 'left4dead2_dlc4'), { recursive: true });

    const c = await scanGame(dir);
    assert.equal(c.officialFromGame, true);
    assert.deepEqual(
      c.campaigns.map((x) => x.id),
      ['official:c1', 'official:c6', 'official:c8', 'official:c10', 'official:c13'],
      'sorted by number, from all the folders',
    );
    assert.equal(c.campaigns.find((x) => x.id === 'official:c8')!.title, 'No Mercy');
    assert.equal(c.campaigns.find((x) => x.id === 'official:c13')!.title, 'Cold Stream');
    assert.ok(c.maps.some((m) => m.map === 'c8m1_apartment' && m.source === null));
    assert.ok(c.maps.some((m) => m.map === 'c6m1_riverbank'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('scanGame: built-in campaigns until the game exists, then campaigns of the official files and addons', async () => {
  const dir = await tmp();
  try {
    const none = await scanGame(dir);
    assert.equal(none.officialFromGame, false);
    assert.equal(none.campaigns.length, 14);
    assert.deepEqual(none.campaigns[7]!.modes.coop!.map((c) => c.map), ['c8m1_apartment', 'c8m2_subway', 'c8m3_sewers', 'c8m4_interior', 'c8m5_rooftop']);

    const l4d = path.join(dir, 'left4dead2');
    await fsp.mkdir(path.join(l4d, 'addons'), { recursive: true });
    const official = `"mission" { "Name" "L4D2C8" "DisplayTitle" "#L4D360UI_CampaignName_C8" "modes" { "coop" { "1" { "Map" "c8m1_apartment" } "2" { "Map" "c8m2_subway" } } "versus" { "1" { "Map" "c8m1_apartment" } } } }`;
    await fsp.writeFile(path.join(l4d, 'pak01_dir.vpk'), buildVpk([
      { path: 'missions/c8m1_apartment.txt', data: official },
      { path: 'maps/c8m1_apartment.bsp', data: 'x' },
      { path: 'maps/test_garbage.bsp', data: 'x' },
    ]));
    await fsp.writeFile(path.join(l4d, 'addons', '777.vpk'), buildVpk([
      { path: 'missions/foo.txt', data: MISSION },
      { path: 'maps/tc_m1_start.bsp', data: 'x' },
      { path: 'maps/tc_m2_end.bsp', data: 'x' },
      { path: 'addoninfo.txt', data: '"AddonInfo" { "addontitle" "Test Pack" "addonauthor" "Me" }' },
    ]));
    await fsp.writeFile(path.join(l4d, 'addons', 'skin.vpk'), buildVpk([{ path: 'models/x.mdl', data: 'x' }]));
    await fsp.writeFile(path.join(l4d, 'addons', 'broken.vpk'), 'garbage');
    await fsp.writeFile(path.join(l4d, 'addons', 'readme.txt'), 'ignored');

    const c = await scanGame(dir);
    assert.equal(c.officialFromGame, true);
    const c8 = c.campaigns.find((x) => x.id === 'official:c8')!;
    assert.equal(c8.title, 'No Mercy');
    assert.deepEqual(c8.modes.versus!.map((x) => x.map), ['c8m1_apartment']);
    assert.equal(firstMap(c8, 'coop'), 'c8m1_apartment');
    assert.equal(firstMap(c8, 'survival'), null);
    const added = c.campaigns.find((x) => x.id === 'mission:test campaign')!;
    assert.equal(added.source, 'addon');
    assert.equal(added.addon, '777.vpk');
    assert.equal(added.workshopId, '777');
    assert.equal(added.title, 'The Test Campaign');

    const byFile = Object.fromEntries(c.addons.map((a) => [a.file, a]));
    assert.equal(byFile['777.vpk']!.kind, 'campaign');
    assert.equal(byFile['777.vpk']!.title, 'Test Pack');
    assert.deepEqual(byFile['777.vpk']!.maps.sort(), ['tc_m1_start', 'tc_m2_end']);
    assert.equal(byFile['skin.vpk']!.kind, 'content');
    assert.equal(byFile['skin.vpk']!.workshopId, null);
    assert.ok(byFile['broken.vpk']!.error);
    assert.equal(c.addons.length, 3);
    // Official maps list keeps the numbered chapters only; addon maps carry their source.
    assert.ok(c.maps.some((m) => m.map === 'c8m1_apartment' && m.source === null));
    assert.ok(!c.maps.some((m) => m.map === 'test_garbage'));
    assert.ok(c.maps.some((m) => m.map === 'tc_m2_end' && m.source === '777.vpk'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('control: every value that reaches the console is validated', () => {
  assert.equal(assertMap('c2m1_highway'), 'c2m1_highway');
  for (const bad of ['', 'c1m1; quit', 'a b', 'x"y', '../x', 'a'.repeat(65), 5, null]) assert.throws(() => assertMap(bad), /Invalid map/, String(bad));
  assert.deepEqual(changeLevelCommands('c1m1_hotel', 'versus'), ['mp_gamemode versus', 'changelevel c1m1_hotel']);
  assert.deepEqual(changeLevelCommands('c1m1_hotel'), ['changelevel c1m1_hotel']);
  for (const bad of [0, -1, 1.5, '3', NaN, 2e9]) assert.throws(() => assertUserId(bad), /Invalid player/, String(bad));
  assert.equal(kickCommand(7), 'kickid 7');
  assert.equal(kickCommand(7, 'afk; quit "now"\n'), 'kickid 7 "afk quit now"');
  assert.ok(cleanReason('x'.repeat(500)).length <= 80);
  assert.equal(giveCommand(4, 'katana'), 'script GetPlayerFromUserID(4).GiveItem("katana")');
  for (const bad of ['katana")', 'x', '', 'weapon_katana']) assert.throws(() => assertItem(bad), /Unknown item/, bad);
  assert.ok(ITEM_GROUPS.every((g) => g.items.length > 0));
});

test('status output: map and players, humans and bots', () => {
  const lines = [
    'hostname: ServCrafty',
    'version : 2.2.4.3 9999 secure',
    'map     : c2m1_highway',
    'players : 2 humans, 1 bots (8 max) (not hibernating)',
    '',
    '# userid name                uniqueid            connected ping loss state   rate adr',
    '#  2 1 "Nick Name"           STEAM_1:0:1234       03:18   40    0 active 30000 1.2.3.4:27005',
    '#  3 "Coach"                 BOT                                    active',
    '#  4 2 "Quote"d"             [U:1:99]             00:05  120    2 spawning 30000 5.6.7.8:27005',
    '#end',
  ];
  const s = parseStatus(lines);
  assert.equal(s.map, 'c2m1_highway');
  assert.equal(s.players.length, 3);
  assert.deepEqual(s.players[0], { userId: 2, name: 'Nick Name', steamId: 'STEAM_1:0:1234', bot: false, state: 'active', ping: 40, connected: '03:18' });
  assert.deepEqual(s.players[1], { userId: 3, name: 'Coach', steamId: 'BOT', bot: true, state: 'active', ping: null, connected: null });
  assert.equal(s.players[2]!.name, 'Quote"d');
  assert.equal(s.players[2]!.state, 'spawning');
  assert.ok(STATUS_END.test('#end'));
  assert.deepEqual(parseStatus(['nothing useful']), { map: null, players: [] });
});

test('give needs cheats: the refusal and the cheat state are recognised (strings printed by the real game)', () => {
  assert.ok(CHEAT_REFUSED.test("Can't use cheat command script in multiplayer, unless the server has sv_cheats set to 1."));
  assert.ok(!CHEAT_REFUSED.test('L 11/21/2026 - 18:12:25: rcon from "172.18.0.1:34382": command "script GetPlayerFromUserID(33).GiveItem("smg")"'));
  assert.equal(parseCheatsState(['"sv_cheats" = "0"', ' notify replicated', ' - Allow cheats on server'].join('\n')), false);
  assert.equal(parseCheatsState(['"sv_cheats" = "1"', ' notify replicated'].join('\n')), true);
  assert.equal(parseCheatsState(''), null, 'no console output (stdin console): unknown');
});

test('bot spawner: command, character catalogue and plugin answers', () => {
  assert.equal(addBotCommand(5), 'sc_addbot 5');
  for (const bad of [-1, 8, 1.5, '3', NaN, null]) assert.throws(() => assertCharacter(bad), /Unknown survivor/, String(bad));
  assert.deepEqual(CHARACTERS.map((c) => c.name), ['Nick', 'Rochelle', 'Coach', 'Ellis', 'Bill', 'Zoey', 'Francis', 'Louis']);
  assert.deepEqual(CHARACTERS.filter((c) => c.game === 'l4d1').map((c) => c.id), [4, 5, 6, 7]);
  const list = ['SCSURV 33 0 0 Stervil98', 'SCSURV 34 1 1 Rochelle', 'SCSURV 35 -1 1 Weird Name', 'SCEND 3'].join('\n');
  assert.deepEqual(parseSurvivorList(list), [
    { userId: 33, character: 0, bot: false, name: 'Stervil98' },
    { userId: 34, character: 1, bot: true, name: 'Rochelle' },
    { userId: 35, character: -1, bot: true, name: 'Weird Name' },
  ]);
  assert.equal(parseSurvivorList('Unknown command "sc_survivors"'), null, 'plugin missing');
  assert.deepEqual(parseSurvivorList('SCEND 0'), []);
  assert.deepEqual(parseAddBot('SCOK 41 Zoey'), { ok: true, userId: 41, name: 'Zoey' });
  assert.deepEqual(parseAddBot('SCERR team_full'), { ok: false, error: 'team_full' });
  assert.equal(parseAddBot('Unknown command "sc_addbot"'), null);
});
