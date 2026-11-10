'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeJoin } = require('./paths');
const { applyIni } = require('./ini');
const log = require('./log');

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.servcrafty-tmp-${process.pid}`;
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    /* new file */
  }
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Applies plan.files under gameDir. Returns a list of {path, action} for reporting/tests.
function applyFileOps(ops, gameDir) {
  const results = [];
  for (const op of ops) {
    const target = safeJoin(gameDir, op.path);
    const existing = readIfExists(target);
    if (op.when === 'missing' && existing !== null) {
      results.push({ path: op.path, action: 'skipped' });
      continue;
    }
    const next = op.type === 'template' ? op.content : applyIni(existing, op.set, op.list);
    if (existing === next) {
      results.push({ path: op.path, action: 'unchanged' });
      continue;
    }
    writeAtomic(target, next);
    results.push({ path: op.path, action: existing === null ? 'created' : 'updated' });
  }
  for (const r of results) log.info(`file ${r.action}: ${r.path}`);
  return results;
}

module.exports = { applyFileOps, writeAtomic };
