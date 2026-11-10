import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError } from '../src/lib/errors.js';
import {
  mergeTerrariaConfig,
  normalizeTerrariaConfig,
  terrariaLaunch,
  tmodloaderEnv,
  tshockArgs,
  vanillaEnv,
  worldFileFor,
} from '../src/lib/terrariaConfig.js';

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? `${err.status}:${err.code}` : 'other';
  }
  return undefined;
};
const invalid = (fn: () => unknown) => assert.equal(code(fn), '400:invalid_terraria_config');

test('defaults', () => {
  const c = normalizeTerrariaConfig('TERRARIA', {});
  assert.deepEqual(c, { worldName: 'ServCrafty', size: 2, difficulty: 0, maxPlayers: 8, secure: true });
  assert.deepEqual(normalizeTerrariaConfig('TSHOCK', null), c);
  assert.equal(worldFileFor(c), 'ServCrafty.wld');
});

test('empty optional strings and nulls are dropped', () => {
  const c = normalizeTerrariaConfig('TERRARIA', { seed: '', password: '  ', motd: null, language: undefined });
  assert.equal(c.seed, undefined);
  assert.equal(c.password, undefined);
  assert.equal(c.motd, undefined);
});

test('limits', () => {
  invalid(() => normalizeTerrariaConfig('TERRARIA', { worldName: 'x'.repeat(33) }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { worldName: '' }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { worldName: 'bad/name' }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { size: 4 }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { size: '2' }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { difficulty: 4 }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { maxPlayers: 0 }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { maxPlayers: 256 }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { maxPlayers: 2.5 }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { seed: 's'.repeat(41) }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { password: 'p'.repeat(65) }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { motd: 'm'.repeat(101) }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { language: 'en' }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { unknownKey: 1 }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', 'nope'));
  assert.equal(normalizeTerrariaConfig('TERRARIA', { maxPlayers: 255, size: 3, difficulty: 3 }).maxPlayers, 255);
  assert.equal(normalizeTerrariaConfig('TERRARIA', { language: 'zh-Hans' }).language, 'zh-Hans');
});

test('error message names the field', () => {
  try {
    normalizeTerrariaConfig('TERRARIA', { maxPlayers: 999 });
    assert.fail('should throw');
  } catch (err) {
    assert.match((err as Error).message, /^terraria\.maxPlayers:/);
  }
});

test('injection safety: quotes, line breaks, shell metacharacters, switches', () => {
  for (const password of ['a"b', "a'b", 'a\\b', 'a\nb', 'a\rb', 'a\u0000b', '$(reboot)', '`id`', ' lead', '-port']) {
    invalid(() => normalizeTerrariaConfig('TERRARIA', { password }));
  }
  for (const motd of ['hi\nport=1', 'hi\r\nx', 'a"b', 'a\\b', '$HOME', '`id`', '\u0007bell', '-world /etc/passwd', 'x y']) {
    invalid(() => normalizeTerrariaConfig('TERRARIA', { motd }));
  }
  for (const worldName of ['a;b', 'a&&b', 'a|b', '../x', 'a\nb', '-autocreate', '+x', 'a"b']) {
    invalid(() => normalizeTerrariaConfig('TERRARIA', { worldName }));
  }
  for (const seed of ['a;rm -rf', '-1', 'a\nb', 'a$b']) invalid(() => normalizeTerrariaConfig('TERRARIA', { seed }));
  invalid(() => normalizeTerrariaConfig('TMODLOADER', { workshopMods: ['123', '1,2'] }));
  invalid(() => normalizeTerrariaConfig('TMODLOADER', { workshopMods: ['123 456'] }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { worldFile: '../etc/passwd.wld' }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { worldFile: 'a b.wld' }));
  invalid(() => normalizeTerrariaConfig('TERRARIA', { worldFile: '-x.wld' }));
  // Allowed punctuation in MOTD
  assert.equal(normalizeTerrariaConfig('TERRARIA', { motd: "Joe's server! :)" }).motd, "Joe's server! :)");
});

test('safe values never add args or env entries', () => {
  const cfg = normalizeTerrariaConfig('TSHOCK', {
    worldName: 'My World',
    seed: 'for the worthy',
    password: 'p@ss word!',
    motd: "Welcome, it's -fun- here",
  });
  const args = tshockArgs(cfg);
  // Each value is exactly one array element right after its switch.
  assert.equal(args[args.indexOf('-worldname') + 1], 'My World');
  assert.equal(args[args.indexOf('-seed') + 1], 'for the worthy');
  assert.equal(args[args.indexOf('-password') + 1], 'p@ss word!');
  assert.equal(args[args.indexOf('-motd') + 1], "Welcome, it's -fun- here");
  const switches = args.filter((a) => a.startsWith('-'));
  assert.deepEqual(switches, ['-port', '-world', '-autocreate', '-worldname', '-difficulty', '-maxplayers', '-seed', '-password', '-motd', '-secure']);
  for (const env of [vanillaEnv(cfg), tmodloaderEnv(cfg)]) {
    for (const [k, v] of Object.entries(env)) {
      assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*$/);
      assert.doesNotMatch(v, /[\r\n\0]/);
    }
  }
});

test('workshopMods only on tModLoader, deduplicated', () => {
  invalid(() => normalizeTerrariaConfig('TERRARIA', { workshopMods: ['2824688072'] }));
  invalid(() => normalizeTerrariaConfig('TSHOCK', { workshopMods: ['2824688072'] }));
  invalid(() => normalizeTerrariaConfig('TMODLOADER', { workshopMods: Array.from({ length: 201 }, (_, i) => String(i)) }));
  const c = normalizeTerrariaConfig('TMODLOADER', { workshopMods: ['2824688072', '2824688072', '2669644269'] });
  assert.deepEqual(c.workshopMods, ['2824688072', '2669644269']);
  assert.equal(normalizeTerrariaConfig('TMODLOADER', { workshopMods: [] }).workshopMods, undefined);
});

test('vanilla (hexlo) env mapping', () => {
  const env = vanillaEnv(
    normalizeTerrariaConfig('TERRARIA', {
      worldName: 'My World',
      size: 3,
      difficulty: 2,
      seed: 'abc',
      maxPlayers: 16,
      password: 'pw',
      motd: 'hello there',
      secure: false,
      language: 'es-ES',
    }),
  );
  assert.deepEqual(env, {
    world: 'My_World.wld',
    worldpath: '/root/.local/share/Terraria/Worlds',
    worldname: 'My World',
    autocreate: '3',
    difficulty: '2',
    maxplayers: '16',
    port: '7777',
    secure: '0',
    upnp: '0',
    banlist: '/root/.local/share/Terraria/banlist.txt',
    password: 'pw',
    motd: 'hello there',
    seed: 'abc',
    language: 'es/ES',
  });
  const d = vanillaEnv(normalizeTerrariaConfig('TERRARIA', {}));
  assert.equal(d.password, '');
  assert.equal(d.secure, '1');
  assert.equal(d.seed, undefined);
  assert.equal(d.language, undefined);
});

test('tModLoader env mapping', () => {
  const env = tmodloaderEnv(
    normalizeTerrariaConfig('TMODLOADER', { worldName: 'Big One', size: 1, difficulty: 3, workshopMods: ['1', '22'], language: 'de-DE' }),
  );
  assert.equal(env.TMOD_WORLDNAME, 'Big_One');
  assert.equal(env.TMOD_WORLDSIZE, '1');
  assert.equal(env.TMOD_DIFFICULTY, '3');
  assert.equal(env.TMOD_WORLDSEED, '');
  assert.equal(env.TMOD_PASS, 'N/A');
  assert.equal(env.TMOD_SECURE, '1');
  assert.equal(env.TMOD_LANGUAGE, 'de-DE');
  assert.equal(env.TMOD_UPNP, '0');
  assert.equal(env.TMOD_PORT, '7777');
  assert.equal(env.TMOD_AUTODOWNLOAD, '1,22');
  assert.equal(env.TMOD_ENABLEDMODS, '1,22');
  const plain = tmodloaderEnv(normalizeTerrariaConfig('TMODLOADER', { password: 'secret' }));
  assert.equal(plain.TMOD_PASS, 'secret');
  assert.equal(plain.TMOD_AUTODOWNLOAD, undefined);
});

test('TShock args mapping', () => {
  const args = tshockArgs(normalizeTerrariaConfig('TSHOCK', { worldName: 'W', secure: false }));
  assert.deepEqual(args, ['-port', '7777', '-world', '/worlds/W.wld', '-autocreate', '2', '-worldname', 'W', '-difficulty', '0', '-maxplayers', '8']);
  const withLang = tshockArgs(normalizeTerrariaConfig('TSHOCK', { language: 'fr-FR' }));
  assert.deepEqual(withLang.slice(-3), ['-secure', '-lang', 'fr-FR']);
});

test('imported world file wins over the world name', () => {
  const c = normalizeTerrariaConfig('TSHOCK', { worldName: 'Ignored', worldFile: 'Imported_1.wld' });
  assert.equal(worldFileFor(c), 'Imported_1.wld');
  assert.ok(tshockArgs(c).includes('/worlds/Imported_1.wld'));
  assert.equal(tmodloaderEnv(c).TMOD_WORLDNAME, 'Imported_1');
  assert.equal(vanillaEnv(c).world, 'Imported_1.wld');
});

test('terrariaLaunch picks env or cmd per type', () => {
  const c = normalizeTerrariaConfig('TERRARIA', {});
  assert.equal(terrariaLaunch('TERRARIA', c).cmd, undefined);
  assert.ok(terrariaLaunch('TERRARIA', c).env.world);
  assert.ok(terrariaLaunch('TMODLOADER', c).env.TMOD_WORLDNAME);
  assert.deepEqual(terrariaLaunch('TSHOCK', c).env, {});
  assert.ok(terrariaLaunch('TSHOCK', c).cmd?.includes('-world'));
});

test('PATCH merge validates the whole object', () => {
  const cur = normalizeTerrariaConfig('TERRARIA', { seed: 'abc', maxPlayers: 10 });
  const m = mergeTerrariaConfig('TERRARIA', cur, { maxPlayers: 20, seed: null });
  assert.equal(m.maxPlayers, 20);
  assert.equal(m.seed, undefined);
  assert.equal(m.worldName, 'ServCrafty');
  invalid(() => mergeTerrariaConfig('TERRARIA', cur, { maxPlayers: 0 }));
  invalid(() => mergeTerrariaConfig('TERRARIA', cur, { workshopMods: ['1'] }));
  assert.deepEqual(mergeTerrariaConfig('TERRARIA', cur, null), normalizeTerrariaConfig('TERRARIA', {}));
  // Switching variant with leftover mods is rejected until they are cleared.
  const tm = normalizeTerrariaConfig('TMODLOADER', { workshopMods: ['5'] });
  invalid(() => mergeTerrariaConfig('TSHOCK', tm, {}));
  assert.equal(mergeTerrariaConfig('TSHOCK', tm, { workshopMods: null }).workshopMods, undefined);
});
