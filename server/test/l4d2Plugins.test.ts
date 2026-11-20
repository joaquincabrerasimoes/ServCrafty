import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import archiver from 'archiver';
import * as tar from 'tar';
import { PLUGIN_CATALOG, pluginById, sourcesFor, withDependencies } from '../src/lib/l4d2/pluginCatalog.js';
import {
  applyCvars,
  installSource,
  loadState,
  mapEntry,
  normalizeSettings,
  removeFiles,
  saveState,
  settingCommands,
  writeSettings,
  type InstallDeps,
} from '../src/lib/l4d2/pluginInstall.js';

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'servcrafty-plug-'));
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, data] of Object.entries(files)) {
    const f = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, data);
  }
}

async function makeZip(dest: string, files: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    const a = archiver('zip');
    out.on('close', () => resolve());
    a.on('error', reject);
    a.pipe(out);
    for (const [name, data] of Object.entries(files)) a.append(data, { name });
    void a.finalize();
  });
}

async function makeTgz(dest: string, files: Record<string, string>): Promise<void> {
  const src = await tmp();
  try {
    await write(src, files);
    await tar.c({ gzip: true, file: dest, cwd: src }, Object.keys(files).map((f) => f.split('/')[0]!).filter((v, i, a) => a.indexOf(v) === i));
  } finally {
    await fsp.rm(src, { recursive: true, force: true });
  }
}

/** Deps that "download" prepared files by URL. */
function fakeDeps(downloads: Record<string, string>, texts: Record<string, string> = {}): InstallDeps {
  const real = {
    unzip: (file: string, dest: string) => import('../src/lib/zip.js').then((m) => m.extractZip(file, dest)),
    untar: (file: string, dest: string) => tar.x({ file, cwd: dest }),
  };
  return {
    fetchText: async (url) => {
      if (!(url in texts)) throw new Error(`unexpected text fetch ${url}`);
      return texts[url]!;
    },
    download: async (url, dest) => {
      if (!(url in downloads)) throw new Error(`unexpected download ${url}`);
      await fsp.copyFile(downloads[url]!, dest);
    },
    ...real,
  };
}

test('catalog: every entry is installable (known dependencies, https, rules, settings in range)', () => {
  const ids = new Set(PLUGIN_CATALOG.map((p) => p.id));
  assert.equal(ids.size, PLUGIN_CATALOG.length, 'unique ids');
  for (const p of PLUGIN_CATALOG) {
    assert.ok(p.requires.every((r) => ids.has(r) && r !== p.id), `${p.id} requires`);
    assert.ok(p.sources.length > 0, p.id);
    for (const s of p.sources) {
      const urls = [s.url, s.latest?.index, s.latest?.base].filter(Boolean) as string[];
      assert.ok(urls.length > 0 && urls.every((u) => u.startsWith('https://')), `${p.id} urls`);
      assert.ok(s.rules.length > 0);
      assert.ok(!s.rules.some((r) => r.to.includes('..') || r.to.startsWith('/')), `${p.id} rules`);
    }
    for (const st of p.settings) {
      assert.match(st.key, /^[a-z][a-z0-9_]*$/);
      if (st.type === 'number') assert.ok(typeof st.default === 'number' && st.min! <= st.default && st.default <= st.max!, `${p.id}.${st.key} default in range`);
      else assert.equal(typeof st.default, 'boolean');
    }
    assert.doesNotThrow(() => normalizeSettings(p, {}), p.id);
    assert.match(p.configFile, /^[\w/.-]+\.cfg$/);
  }
  assert.deepEqual(withDependencies('l4d2_rmc').map((p) => p.id), ['metamod', 'sourcemod', 'l4dtoolz', 'l4d2_rmc']);
  assert.deepEqual(withDependencies('metamod').map((p) => p.id), ['metamod']);
  assert.deepEqual(withDependencies('nope'), []);
});

test('mapEntry: prefixes, wildcard top folder, single destination file', () => {
  assert.equal(mapEntry([{ from: '', to: '' }], 'addons/metamod.vdf'), 'addons/metamod.vdf');
  assert.equal(mapEntry([{ from: '*/sourcemod/plugins/', to: 'addons/sourcemod/plugins/' }], 'Left4DHooks-main/sourcemod/plugins/left4dhooks.smx'), 'addons/sourcemod/plugins/left4dhooks.smx');
  assert.equal(mapEntry([{ from: '*/sourcemod/plugins/', to: 'addons/sourcemod/plugins/' }], 'Left4DHooks-main/sourcemod/scripting/x.sp'), null);
  assert.equal(mapEntry([{ from: '*/sourcemod/plugins/', to: 'x/' }], 'plugins.txt'), null);
  assert.equal(mapEntry([{ from: 'l4dtoolz.so', to: 'addons/l4dtoolz.so' }], 'l4dtoolz.so'), 'addons/l4dtoolz.so');
  assert.equal(mapEntry([{ from: 'l4dtoolz.so', to: 'addons/l4dtoolz.so' }], 'README.md'), null);
  assert.equal(mapEntry([{ from: '', to: 'addons/sourcemod/plugins/p.smx' }], 'file'), 'addons/sourcemod/plugins/p.smx');
});

test('install: tar.gz with the latest-file pointer, version from the file name, preserved configs', async () => {
  const dir = await tmp();
  try {
    const root = path.join(dir, 'left4dead2');
    const archive = path.join(dir, 'sm.tgz');
    await makeTgz(archive, {
      'addons/sourcemod/plugins/admin-flatfile.smx': 'smx',
      'addons/sourcemod/configs/admins_simple.ini': 'stock admins',
      'cfg/sourcemod/sourcemod.cfg': 'stock cfg',
    });
    await write(root, { 'addons/sourcemod/configs/admins_simple.ini': 'MY ADMINS' });
    const source = { ...pluginById('sourcemod')!.sources[0]! };
    const deps = fakeDeps(
      { 'https://sm.alliedmods.net/smdrop/1.12/sourcemod-1.12.0-git9999-linux.tar.gz': archive },
      { [source.latest!.index]: 'sourcemod-1.12.0-git9999-linux.tar.gz\n' },
    );
    const r = await installSource(root, source, deps);
    assert.equal(r.version, 'sourcemod-1.12.0-git9999');
    assert.ok(r.files.includes('addons/sourcemod/plugins/admin-flatfile.smx'));
    assert.ok(r.files.includes('cfg/sourcemod/sourcemod.cfg'));
    assert.ok(!r.files.includes('addons/sourcemod/configs/admins_simple.ini'), 'existing config is left alone');
    assert.equal(await fsp.readFile(path.join(root, 'addons/sourcemod/configs/admins_simple.ini'), 'utf8'), 'MY ADMINS');
    // A second install (an update) leaves a config the admin edited, but a new config is created.
    await fsp.writeFile(path.join(root, 'cfg/sourcemod/sourcemod.cfg'), 'edited');
    await installSource(root, source, deps);
    assert.equal(await fsp.readFile(path.join(root, 'cfg/sourcemod/sourcemod.cfg'), 'utf8'), 'edited');
    // The scratch directory is gone.
    assert.deepEqual((await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('servcrafty-plugin-')).length, 0);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('install: zip with a top folder, single files, and bad downloads', async () => {
  const dir = await tmp();
  try {
    const root = path.join(dir, 'left4dead2');
    const zip = path.join(dir, 'h.zip');
    await makeZip(zip, {
      'Left4DHooks-main/README.md': 'readme',
      'Left4DHooks-main/sourcemod/plugins/left4dhooks.smx': 'smx',
      'Left4DHooks-main/sourcemod/gamedata/left4dhooks.l4d2.txt': 'gd',
      'Left4DHooks-main/sourcemod/scripting/left4dhooks.sp': 'source',
    });
    const l4dh = pluginById('left4dhooks')!.sources[0]!;
    const r = await installSource(root, l4dh, fakeDeps({ [l4dh.url!]: zip }));
    assert.deepEqual(r.files.sort(), ['addons/sourcemod/gamedata/left4dhooks.l4d2.txt', 'addons/sourcemod/plugins/left4dhooks.smx']);
    assert.equal(r.version, null);

    const bin = path.join(dir, 'p.smx');
    await fsp.writeFile(bin, 'PLUGIN');
    const rmc = pluginById('l4d2_rmc')!.sources[0]!;
    const one = await installSource(root, rmc, fakeDeps({ [rmc.url!]: bin }));
    assert.deepEqual(one.files, ['addons/sourcemod/plugins/l4d2_rmc.smx']);
    assert.equal(await fsp.readFile(path.join(root, 'addons/sourcemod/plugins/l4d2_rmc.smx'), 'utf8'), 'PLUGIN');

    // An archive without the expected files is an error, not an empty install.
    const empty = path.join(dir, 'e.zip');
    await makeZip(empty, { 'other/file.txt': 'x' });
    await assert.rejects(installSource(root, l4dh, fakeDeps({ [l4dh.url!]: empty })), /expected files/);
    // https only, and the pointer must look like a file name.
    await assert.rejects(installSource(root, { url: 'http://x.test/a.zip', format: 'zip', rules: [{ from: '', to: '' }] }, fakeDeps({})), /https/);
    await assert.rejects(
      installSource(root, { latest: { index: 'https://x.test/i', base: 'https://x.test/' }, format: 'zip', rules: [{ from: '', to: '' }] }, fakeDeps({}, { 'https://x.test/i': '../../etc/passwd' })),
      /Unexpected answer/,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('remove: only the plugin files go, empty plugin folders are pruned, top folders stay', async () => {
  const dir = await tmp();
  try {
    await write(dir, {
      'addons/sourcemod/plugins/a.smx': '1',
      'addons/sourcemod/plugins/keep.smx': '2',
      'addons/foo/bin/x.so': '3',
      'addons/foo.vdf': '4',
    });
    await removeFiles(dir, ['addons/sourcemod/plugins/a.smx', 'addons/foo/bin/x.so', 'addons/foo.vdf', '../outside.txt', 'addons/gone.txt']);
    assert.ok(fs.existsSync(path.join(dir, 'addons/sourcemod/plugins/keep.smx')));
    assert.ok(!fs.existsSync(path.join(dir, 'addons/sourcemod/plugins/a.smx')));
    assert.ok(!fs.existsSync(path.join(dir, 'addons/foo')), 'empty plugin folder pruned');
    assert.ok(fs.existsSync(path.join(dir, 'addons')), 'top folder stays');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('settings: validated, written as cvars into the plugin cfg, keeping the rest of the file', async () => {
  const toolz = pluginById('l4dtoolz')!;
  assert.deepEqual(normalizeSettings(toolz, {}), { sv_setmax: 31, sv_maxplayers: -1, sv_force_unreserved: true });
  assert.deepEqual(normalizeSettings(toolz, { sv_maxplayers: 12 }, { sv_setmax: 20 }), { sv_setmax: 20, sv_maxplayers: 12, sv_force_unreserved: true });
  for (const bad of [{ sv_setmax: 99 }, { sv_setmax: 20.5 }, { sv_setmax: '20' }, { sv_force_unreserved: 1 }, { nope: 1 }, null, []]) {
    assert.throws(() => normalizeSettings(toolz, bad), /must be|Unknown setting/, JSON.stringify(bad));
  }
  assert.equal(applyCvars('', { a_b: 1, c: true }), 'a_b "1"\nc "1"\n');
  assert.equal(applyCvars('// note\nsv_setmax "18"\nother 5\n', { sv_setmax: 31 }), '// note\nsv_setmax "31"\nother 5\n');
  assert.equal(applyCvars('SV_SETMAX 18\r\nx 1\r\n', { sv_setmax: 31, y: false }), 'sv_setmax "31"\r\nx 1\r\ny "0"\r\n');
  assert.deepEqual(settingCommands({ sv_setmax: 31, sv_force_unreserved: false }), ['sv_setmax 31', 'sv_force_unreserved 0']);

  const dir = await tmp();
  try {
    await write(dir, { 'cfg/servcrafty_plugins.cfg': '// mine\nexisting 1\n' });
    assert.equal(await writeSettings(dir, toolz, { sv_setmax: 24, sv_maxplayers: -1, sv_force_unreserved: true }), 'cfg/servcrafty_plugins.cfg');
    assert.equal(await fsp.readFile(path.join(dir, 'cfg/servcrafty_plugins.cfg'), 'utf8'), '// mine\nexisting 1\nsv_setmax "24"\nsv_maxplayers "-1"\nsv_force_unreserved "1"\n');
    assert.equal(await writeSettings(dir, pluginById('metamod')!, {}), null, 'no settings, no file');
    const rmc = pluginById('l4d2_rmc')!;
    await writeSettings(dir, rmc, normalizeSettings(rmc, { rmc_defaultslots: 10 }));
    assert.match(await fsp.readFile(path.join(dir, 'cfg/sourcemod/l4d2_rmc.cfg'), 'utf8'), /rmc_defaultslots "10"/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('state file: round trip, missing or corrupt starts empty', async () => {
  const dir = await tmp();
  try {
    const f = path.join(dir, 'state', 'p.json');
    assert.deepEqual(await loadState(f), { schema: 1, plugins: {} });
    const s = { schema: 1 as const, plugins: { metamod: { version: 'v', installedAt: 'now', files: ['a'], settings: {} } } };
    await saveState(f, s);
    assert.deepEqual(await loadState(f), s);
    await fsp.writeFile(f, '{not json');
    assert.deepEqual(await loadState(f), { schema: 1, plugins: {} });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('every plugin has downloads for both platforms; windows builds use .dll / zip archives', () => {
  for (const p of PLUGIN_CATALOG) {
    for (const platform of ['linux', 'windows'] as const) {
      assert.ok(sourcesFor(p, platform).length > 0, `${p.id} has no ${platform} download`);
    }
  }
  const sm = pluginById('sourcemod')!;
  assert.equal(sourcesFor(sm, 'windows')[0]!.format, 'zip');
  assert.equal(sourcesFor(sm, 'linux')[0]!.format, 'tar.gz');
  assert.ok(sourcesFor(pluginById('l4dtoolz')!, 'windows').some((s) => s.rules.some((r) => r.to.endsWith('.dll'))));
  assert.ok(!sourcesFor(pluginById('l4dtoolz')!, 'windows').some((s) => s.rules.some((r) => r.to.endsWith('.so'))));
  // platform-independent plugins (sourcemod scripts) are shared
  assert.equal(sourcesFor(pluginById('l4d2_rmc')!, 'windows').length, sourcesFor(pluginById('l4d2_rmc')!, 'linux').length);
});
