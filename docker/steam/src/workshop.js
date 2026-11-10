'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeJoin } = require('./paths');
const log = require('./log');

// Manifest of files the executor copied into the game dir, so removed items can be cleaned up
// without ever touching files the user (or the game) created.
//   { "schema": 1, "items": { "<id>": { "dir": "Mods", "files": ["rel/path", ...] } } }
function loadManifest(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (m && m.schema === 1 && m.items && typeof m.items === 'object') return m;
  } catch {
    /* missing or corrupt: start empty (nothing will be deleted) */
  }
  return { schema: 1, items: {} };
}

function saveManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, file);
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// Where SteamCMD may have put an item, in order of preference.
function itemSourceCandidates(paths, wsAppId, id) {
  const rel = path.join('steamapps', 'workshop', 'content', String(wsAppId), String(id));
  return [
    path.join(paths.workshop, rel),
    path.join(paths.steamHome, 'Steam', rel),
    path.join(paths.steamHome, rel),
    path.join(paths.game, rel),
  ];
}

function findItemDir(paths, wsAppId, id) {
  for (const c of itemSourceCandidates(paths, wsAppId, id)) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

function copyIfChanged(src, dst) {
  const s = fs.statSync(src);
  try {
    const d = fs.statSync(dst);
    if (d.size === s.size && Math.abs(d.mtimeMs - s.mtimeMs) < 2000) return false;
  } catch {
    /* new file */
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.utimesSync(dst, s.atime, s.mtime);
  return true;
}

function pruneEmptyDirs(start, stop) {
  let dir = start;
  const rStop = path.resolve(stop);
  while (path.resolve(dir).startsWith(rStop + path.sep)) {
    try {
      fs.rmdirSync(dir); // throws when not empty: that is the stop condition
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

// Removes manifest-tracked copies of items that are no longer wanted. Returns the updated manifest.
function removeStale(manifest, keepIds, gameDir) {
  const keepFiles = new Set();
  for (const id of keepIds) {
    const it = manifest.items[id];
    if (it) for (const f of it.files) keepFiles.add(`${it.dir}/${f}`);
  }
  for (const id of Object.keys(manifest.items)) {
    if (keepIds.has(id)) continue;
    const it = manifest.items[id];
    for (const f of it.files) {
      if (keepFiles.has(`${it.dir}/${f}`)) continue; // shared with a kept item
      let target;
      try {
        target = safeJoin(gameDir, `${it.dir}/${f}`);
      } catch {
        continue;
      }
      try {
        fs.unlinkSync(target);
        pruneEmptyDirs(path.dirname(target), safeJoin(gameDir, it.dir));
      } catch {
        /* already gone */
      }
    }
    log.info(`workshop: removed copies of item ${id}`);
    delete manifest.items[id];
  }
  return manifest;
}

/**
 * Sync downloaded items into the game dir.
 * wantCopy=false (install "config-list" or no workshop) only cleans up tracked copies.
 */
function syncWorkshop({ paths, workshop }) {
  const manifest = loadManifest(paths.manifest);
  const wantCopy = !!workshop && workshop.install === 'steamcmd';
  const ids = wantCopy ? workshop.ids : [];
  const keep = new Set(ids);
  removeStale(manifest, keep, paths.game);

  const missing = [];
  for (const id of ids) {
    const src = findItemDir(paths, workshop.appId, id);
    if (!src) {
      missing.push(id);
      continue;
    }
    const files = listFiles(src);
    let copied = 0;
    for (const f of files) {
      const dstRel = `${workshop.dir}/${f}`;
      if (copyIfChanged(path.join(src, ...f.split('/')), safeJoin(paths.game, dstRel))) copied++;
    }
    // Files that disappeared from a newer version of the item are cleaned up too.
    const prev = manifest.items[id];
    if (prev) {
      const now = new Set(files);
      for (const f of prev.files) {
        if (now.has(f)) continue;
        try {
          fs.unlinkSync(safeJoin(paths.game, `${prev.dir}/${f}`));
        } catch {
          /* gone */
        }
      }
    }
    manifest.items[id] = { dir: workshop.dir, files };
    log.info(`workshop: item ${id} synced (${files.length} files, ${copied} copied)`);
  }
  saveManifest(paths.manifest, manifest);
  return { missing };
}

module.exports = { loadManifest, saveManifest, listFiles, findItemDir, itemSourceCandidates, removeStale, syncWorkshop };
