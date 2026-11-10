'use strict';

const path = require('node:path');

// All container paths hang off a root (default "/"). Tests and --dry-run set SERVCRAFTY_ROOT to a temp dir.
function makePaths(root) {
  const r = root && root.length ? root : '/';
  const j = (...p) => path.join(r, ...p);
  return {
    root: r,
    plan: j('servcrafty', 'plan.json'),
    data: j('data'),
    game: j('data', 'game'),
    workshop: j('data', 'workshop'),
    steamHome: j('data', 'steam'),
    wineprefix: j('data', 'steam', 'wineprefix'),
    manifest: j('data', 'steam', 'workshop-manifest.json'),
    // These two live in the image, not under the data root.
    steamcmd: process.env.SERVCRAFTY_STEAMCMD || '/opt/steamcmd/steamcmd.sh',
    steamcmdDir: process.env.SERVCRAFTY_STEAMCMD_DIR || '/opt/steamcmd',
  };
}

// Join a plan-relative path under base and refuse anything that escapes it.
function safeJoin(base, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error('empty path');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new Error(`absolute path not allowed: ${rel}`);
  const parts = rel.split(/[\\/]+/);
  if (parts.includes('..')) throw new Error(`".." not allowed in path: ${rel}`);
  const full = path.join(base, ...parts);
  const rBase = path.resolve(base);
  const rFull = path.resolve(full);
  if (rFull !== rBase && !rFull.startsWith(rBase + path.sep)) throw new Error(`path escapes base: ${rel}`);
  return full;
}

module.exports = { makePaths, safeJoin };
