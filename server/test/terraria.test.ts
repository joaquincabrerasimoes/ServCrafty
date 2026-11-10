import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/lib/errors.js';
import { capabilitiesOf, gameOf, terrariaImage, TERRARIA_VARIANTS } from '../src/lib/games.js';
import { terrariaContainerSpec, type TerrariaServerInput } from '../src/lib/terrariaContainer.js';
import { parseBanlist, removeFromBanlist, sanitizeWorldUpload, validateTerrariaPlayerName } from '../src/lib/terrariaFiles.js';
import { cleanTerrariaLine, parseTerrariaLine } from '../src/lib/terrariaLog.js';
import { selectAnnouncements } from '../src/services/lanAnnouncer.js';
import { terrariaCommandFor } from '../src/services/players.js';
import { assertGameFields } from '../src/services/servers.js';
import { serverTypes } from '../src/lib/validation.js';

const errCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : 'other';
  }
  return undefined;
};

test('gameOf derives the game from the type', () => {
  for (const t of serverTypes) {
    const expected = ['TERRARIA', 'TSHOCK', 'TMODLOADER'].includes(t) ? 'terraria' : t === 'STEAMCMD' ? 'steam' : 'minecraft';
    assert.equal(gameOf(t), expected);
  }
  assert.equal(capabilitiesOf('TSHOCK').hasRcon, false);
  assert.equal(capabilitiesOf('PAPER').hasMods, true);
});

test('image table and tag override', () => {
  assert.equal(terrariaImage('TERRARIA'), 'hexlo/terraria-server-docker:latest');
  assert.equal(terrariaImage('TSHOCK'), 'ghcr.io/pryaxis/tshock:latest');
  assert.equal(terrariaImage('TMODLOADER', 'v2024.05'), 'jacobsmile/tmodloader1.4:v2024.05');
  assert.equal(terrariaImage('TMODLOADER', 'bad tag;rm'), 'jacobsmile/tmodloader1.4:latest');
});

const base: TerrariaServerInput = {
  id: 'abc',
  type: 'TERRARIA',
  port: 25570,
  memory_mb: 2048,
  cpu: 2,
  env: {},
  terraria: null,
};
const ctx = {
  name: 'servcrafty-abc',
  hostDir: '/data/servers/abc',
  network: 'servcrafty',
  labels: { 'servcrafty.server': 'abc', 'servcrafty.managed': 'true' },
  imageTagEnv: 'SERVCRAFTY_IMAGE_TAG',
};

test('vanilla container spec', () => {
  const o = terrariaContainerSpec(base, ctx);
  assert.equal(o.Image, 'hexlo/terraria-server-docker:latest');
  assert.equal(o.name, 'servcrafty-abc');
  assert.equal(o.Tty, true);
  assert.equal(o.OpenStdin, true);
  assert.equal(o.StdinOnce, false);
  assert.deepEqual(o.ExposedPorts, { '7777/tcp': {} });
  assert.deepEqual(o.HostConfig?.PortBindings, { '7777/tcp': [{ HostPort: '25570' }] });
  assert.deepEqual(o.HostConfig?.Binds, ['/data/servers/abc:/root/.local/share/Terraria']);
  assert.equal(o.HostConfig?.Memory, 2048 * 1024 * 1024);
  assert.equal(o.HostConfig?.MemorySwap, 2048 * 1024 * 1024);
  assert.equal(o.HostConfig?.NanoCpus, 2e9);
  assert.equal(o.HostConfig?.NetworkMode, 'servcrafty');
  assert.deepEqual(o.Labels, ctx.labels);
  assert.equal(o.Cmd, undefined);
  assert.ok(o.Env?.includes('world=ServCrafty.wld'));
  assert.ok(o.Env?.includes('port=7777'));
});

test('TShock container spec uses args and three mounts', () => {
  const o = terrariaContainerSpec({ ...base, type: 'TSHOCK', terraria: { worldName: 'W', size: 1, difficulty: 1, maxPlayers: 4, secure: true } }, ctx);
  assert.equal(o.Image, 'ghcr.io/pryaxis/tshock:latest');
  assert.equal(o.Tty, true);
  assert.deepEqual(o.HostConfig?.Binds, ['/data/servers/abc/tshock:/tshock', '/data/servers/abc/Worlds:/worlds', '/data/servers/abc/plugins:/plugins']);
  assert.deepEqual(o.Cmd?.slice(0, 4), ['-port', '7777', '-world', '/worlds/W.wld']);
  assert.ok(!Object.keys(o.ExposedPorts ?? {}).includes('7878/tcp'), 'REST port is not published');
  assert.deepEqual(o.Env, []);
});

test('tModLoader container spec', () => {
  const o = terrariaContainerSpec({ ...base, type: 'TMODLOADER', terraria: { worldName: 'W', size: 2, difficulty: 0, maxPlayers: 8, secure: true, workshopMods: ['9'] } }, ctx);
  assert.equal(o.Image, 'jacobsmile/tmodloader1.4:latest');
  assert.equal(o.Tty, false);
  assert.deepEqual(o.HostConfig?.Binds, ['/data/servers/abc:/data', '/data/servers/abc/banlist.txt:/terraria-server/banlist.txt']);
  assert.ok(o.Env?.includes('TMOD_ENABLEDMODS=9'));
});

test('user env cannot override generated keys, tag env or inject lines', () => {
  const o = terrariaContainerSpec(
    {
      ...base,
      env: { port: '1', world: '/etc/passwd', SERVCRAFTY_IMAGE_TAG: 'nightly', EXTRA: 'ok', BAD: 'a\nport=1', 'bad-key': 'x' },
    },
    ctx,
  );
  assert.equal(o.Image, 'hexlo/terraria-server-docker:nightly');
  assert.ok(o.Env?.includes('port=7777'));
  assert.ok(o.Env?.includes('world=ServCrafty.wld'));
  assert.ok(o.Env?.includes('EXTRA=ok'));
  assert.ok(!o.Env?.some((e) => e.startsWith('BAD=') || e.startsWith('bad-key=') || e.startsWith('SERVCRAFTY_IMAGE_TAG=')));
  const t = terrariaContainerSpec({ ...base, type: 'TMODLOADER', env: { TMOD_PASS: 'x', TMOD_USECONFIGFILE: 'Yes' } }, ctx);
  assert.ok(t.Env?.includes('TMOD_PASS=N/A'));
  assert.ok(!t.Env?.includes('TMOD_USECONFIGFILE=Yes'));
});

test('stored config is re-validated before reaching the container', () => {
  assert.equal(
    errCode(() => terrariaContainerSpec({ ...base, terraria: { worldName: 'x', motd: 'a\nb' } as never }, ctx)),
    'invalid_terraria_config',
  );
});

test('every variant has its worlds dir among the created dirs', () => {
  for (const v of Object.values(TERRARIA_VARIANTS)) assert.ok(v.dirs.includes(v.worldsRel), v.type);
});

test('log cleaning strips ANSI, control chars and prompts', () => {
  assert.equal(cleanTerrariaLine('\x1b[32m: : Joaquin has joined.\x1b[0m\r'), 'Joaquin has joined.');
  assert.equal(cleanTerrariaLine('\x1b]0;title\x07Server started'), 'Server started');
  assert.equal(cleanTerrariaLine('a\u0000b\u0008c\td'), 'abc\td');
});

test('log events', () => {
  assert.deepEqual(parseTerrariaLine('Joaquin has joined.'), { kind: 'join', player: 'Joaquin' });
  assert.deepEqual(parseTerrariaLine('Big Bob has left.'), { kind: 'leave', player: 'Big Bob' });
  assert.deepEqual(parseTerrariaLine('Joaquin (127.0.0.1:5555) has joined.'), { kind: 'join', player: 'Joaquin' });
  assert.equal(parseTerrariaLine('<Mallory> Alice has joined.'), null, 'chat cannot fake a join');
  assert.equal(parseTerrariaLine('[Server API] Info Alice has joined.'), null);
  assert.deepEqual(parseTerrariaLine('Server started'), { kind: 'ready' });
  assert.deepEqual(parseTerrariaLine('Listening on port 7777'), { kind: 'ready' });
  assert.deepEqual(parseTerrariaLine('Terraria Server v1.4.4.9'), { kind: 'version', version: '1.4.4.9' });
  assert.equal(parseTerrariaLine('Loading world data: 45%'), null);
});

test('banlist parse and remove', () => {
  const text = '//Griefer\n1.2.3.4\n//Other\n5.6.7.8\n9.9.9.9\n';
  assert.deepEqual(parseBanlist(text), [
    { name: 'Griefer', ip: '1.2.3.4' },
    { name: 'Other', ip: '5.6.7.8' },
    { name: '9.9.9.9', ip: '9.9.9.9' },
  ]);
  const r = removeFromBanlist(text, 'griefer');
  assert.equal(r.removed, 1);
  assert.equal(r.text, '//Other\n5.6.7.8\n9.9.9.9\n');
  assert.equal(removeFromBanlist(text, '5.6.7.8').text, '//Griefer\n1.2.3.4\n9.9.9.9\n');
  assert.equal(removeFromBanlist(text, '9.9.9.9').text, '//Griefer\n1.2.3.4\n//Other\n5.6.7.8\n');
  assert.equal(removeFromBanlist(text, 'nobody').removed, 0);
  assert.deepEqual(parseBanlist(''), []);
});

test('world upload names are sanitised', () => {
  assert.deepEqual(sanitizeWorldUpload('My World.wld'), { stem: 'My_World', ext: 'wld' });
  assert.deepEqual(sanitizeWorldUpload('C:\\Users\\x\\Docs\\W1.WLD'), { stem: 'W1', ext: 'wld' });
  assert.deepEqual(sanitizeWorldUpload('../../etc/evil.twld'), { stem: 'evil', ext: 'twld' });
  assert.deepEqual(sanitizeWorldUpload('-rf.wld'), { stem: '_rf', ext: 'wld' });
  assert.deepEqual(sanitizeWorldUpload('..wld'), { stem: '_', ext: 'wld' });
  for (const bad of ['world.zip', 'world', '.wld', 'x.wld.exe', '']) assert.equal(errCode(() => sanitizeWorldUpload(bad)), 'invalid_world_file', bad);
});

test('player names and commands', () => {
  assert.equal(validateTerrariaPlayerName(' Big Bob '), 'Big Bob');
  for (const bad of ['', 'a'.repeat(21), 'a"b', 'a\nexit', 'a\\b', '/kill']) assert.equal(errCode(() => validateTerrariaPlayerName(bad)), 'invalid_player_name');
  assert.equal(terrariaCommandFor('TERRARIA', 'kick', 'Big Bob', 'spam'), 'kick Big Bob');
  assert.equal(terrariaCommandFor('TMODLOADER', 'ban', 'Bob', ''), 'ban Bob');
  assert.equal(terrariaCommandFor('TSHOCK', 'kick', 'Big Bob', 'spam'), 'kick "Big Bob" spam');
  assert.equal(terrariaCommandFor('TSHOCK', 'ban', 'Bob', ''), 'ban add "Bob"');
});

test('game-specific fields are rejected', () => {
  assert.equal(errCode(() => assertGameFields('TERRARIA', { minecraft: { motd: 'x' } })), 'unsupported_game');
  assert.equal(errCode(() => assertGameFields('TERRARIA', { mcVersion: '1.21' })), 'unsupported_game');
  assert.equal(errCode(() => assertGameFields('TSHOCK', { modpack: { source: 'file' } })), 'unsupported_game');
  assert.equal(errCode(() => assertGameFields('TMODLOADER', { lanAnnounce: true })), 'unsupported_game');
  assert.equal(errCode(() => assertGameFields('TERRARIA', { javaArgs: '-Xmx1G' })), 'unsupported_game');
  assert.equal(errCode(() => assertGameFields('PAPER', { terraria: { worldName: 'x' } })), 'unsupported_game');
  assert.equal(errCode(() => assertGameFields('TERRARIA', { memoryMb: 256 })), 'validation_error');
  // Values that mean "nothing" are fine (clone/templates send them).
  assert.equal(errCode(() => assertGameFields('TERRARIA', { mcVersion: 'LATEST', javaArgs: null, modpack: null, minecraft: null, lanAnnounce: false, memoryMb: 512 })), undefined);
  assert.equal(errCode(() => assertGameFields('PAPER', { terraria: null, mcVersion: '1.21.4' })), undefined);
});

test('LAN announcer never includes Terraria servers', () => {
  const rows = ['TERRARIA', 'TSHOCK', 'TMODLOADER', 'PAPER'].map((type, i) => ({
    id: String(i),
    name: 'S',
    type,
    port: 7777 + i,
    lan_announce: true,
    minecraft: null,
  }));
  assert.deepEqual(
    selectAnnouncements(rows, () => true).map((a) => a.id),
    ['3'],
  );
});
