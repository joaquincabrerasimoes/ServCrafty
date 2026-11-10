'use strict';

const fs = require('node:fs');

class PlanError extends Error {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isStrOrNull = (v) => v === null || v === undefined || typeof v === 'string';

function fail(pathStr, msg) {
  throw new PlanError(`invalid plan: ${pathStr} ${msg}`);
}

function relPath(p, where) {
  if (!isStr(p) || p.length === 0) fail(where, 'must be a non-empty string');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) fail(where, 'must be relative');
  if (p.split(/[\\/]+/).includes('..')) fail(where, 'must not contain ".."');
}

// Validates the shape of the plan and returns a normalised copy (defaults filled in).
// Error messages never include values (the plan contains passwords).
function validatePlan(raw) {
  if (!isObj(raw)) fail('plan', 'must be an object');
  if (raw.schema !== 1) fail('schema', `must be 1 (got ${typeof raw.schema === 'number' ? raw.schema : typeof raw.schema})`);
  if (!isStr(raw.serverName)) fail('serverName', 'must be a string');

  const s = raw.steam;
  if (!isObj(s)) fail('steam', 'must be an object');
  if (!Number.isInteger(s.appId) || s.appId <= 0) fail('steam.appId', 'must be a positive integer');
  if (!isStrOrNull(s.branch)) fail('steam.branch', 'must be a string or null');
  if (!isStrOrNull(s.betaPassword)) fail('steam.betaPassword', 'must be a string or null');
  if (s.platform !== 'linux' && s.platform !== 'windows') fail('steam.platform', 'must be "linux" or "windows"');
  if (s.login !== undefined && s.login !== 'anonymous') fail('steam.login', 'only "anonymous" is supported');
  for (const k of ['validate', 'update']) {
    if (typeof s[k] !== 'boolean') fail(`steam.${k}`, 'must be a boolean');
  }
  const steam = {
    appId: s.appId,
    branch: s.branch || null,
    betaPassword: s.betaPassword || null,
    platform: s.platform,
    login: 'anonymous',
    validate: s.validate,
    update: s.update,
  };

  let workshop = null;
  if (raw.workshop !== null && raw.workshop !== undefined) {
    const w = raw.workshop;
    if (!isObj(w)) fail('workshop', 'must be an object or null');
    if (!Number.isInteger(w.appId) || w.appId <= 0) fail('workshop.appId', 'must be a positive integer');
    if (!Array.isArray(w.ids)) fail('workshop.ids', 'must be an array');
    const ids = w.ids.map((x, i) => {
      const t = String(x);
      if (!/^\d{1,20}$/.test(t)) fail(`workshop.ids[${i}]`, 'must be a numeric id');
      return t;
    });
    if (w.install !== 'steamcmd' && w.install !== 'config-list') fail('workshop.install', 'must be "steamcmd" or "config-list"');
    if (w.install === 'steamcmd') relPath(w.dir ?? '', 'workshop.dir');
    workshop = { appId: w.appId, ids: [...new Set(ids)], install: w.install, dir: isStr(w.dir) ? w.dir : '' };
    if (w.install === 'steamcmd' && workshop.dir === '') fail('workshop.dir', 'must be a non-empty string');
  }

  if (!Array.isArray(raw.files)) fail('files', 'must be an array');
  const files = raw.files.map((f, i) => {
    const where = `files[${i}]`;
    if (!isObj(f)) fail(where, 'must be an object');
    relPath(f.path, `${where}.path`);
    const when = f.when === undefined ? 'always' : f.when;
    if (when !== 'always' && when !== 'missing') fail(`${where}.when`, 'must be "always" or "missing"');
    if (f.type === 'template') {
      if (!isStr(f.content)) fail(`${where}.content`, 'must be a string');
      return { type: 'template', path: f.path, when, content: f.content };
    }
    if (f.type === 'ini') {
      const set = f.set === undefined ? [] : f.set;
      const list = f.list === undefined ? [] : f.list;
      if (!Array.isArray(set)) fail(`${where}.set`, 'must be an array');
      if (!Array.isArray(list)) fail(`${where}.list`, 'must be an array');
      set.forEach((e, j) => {
        if (!isObj(e) || !isStr(e.section) || !isStr(e.key) || e.key === '') fail(`${where}.set[${j}]`, 'needs string section and key');
        if (!(isStr(e.value) || typeof e.value === 'number' || typeof e.value === 'boolean')) fail(`${where}.set[${j}].value`, 'must be a string, number or boolean');
      });
      list.forEach((e, j) => {
        if (!isObj(e) || !isStr(e.section) || !isStr(e.key) || e.key === '') fail(`${where}.list[${j}]`, 'needs string section and key');
        if (!Array.isArray(e.values)) fail(`${where}.list[${j}].values`, 'must be an array');
      });
      return {
        type: 'ini',
        path: f.path,
        when,
        set: set.map((e) => ({ section: e.section, key: e.key, value: String(e.value) })),
        list: list.map((e) => ({ section: e.section, key: e.key, values: e.values.map(String) })),
      };
    }
    return fail(`${where}.type`, 'must be "template" or "ini"');
  });

  const l = raw.launch;
  if (!isObj(l)) fail('launch', 'must be an object');
  if (l.cwd !== undefined && l.cwd !== '') relPath(l.cwd, 'launch.cwd');
  if (!Array.isArray(l.argv) || l.argv.length === 0 || !l.argv.every(isStr) || l.argv[0] === '') {
    fail('launch.argv', 'must be a non-empty array of strings');
  }
  const env = l.env === undefined || l.env === null ? {} : l.env;
  if (!isObj(env) || !Object.values(env).every(isStr)) fail('launch.env', 'must be an object of strings');
  const launch = { cwd: l.cwd || '', argv: [...l.argv], env: { ...env } };

  const st = raw.stop === undefined || raw.stop === null ? {} : raw.stop;
  if (!isObj(st)) fail('stop', 'must be an object');
  const stopType = st.type === undefined ? 'signal' : st.type;
  if (stopType !== 'signal' && stopType !== 'stdin') fail('stop.type', 'must be "signal" or "stdin"');
  const sig = st.signal === undefined || st.signal === null ? 'SIGINT' : st.signal;
  if (!isStr(sig) || !/^SIG[A-Z0-9]+$/.test(sig)) fail('stop.signal', 'must be a signal name like SIGINT');
  const timeoutSec = st.timeoutSec === undefined ? 60 : st.timeoutSec;
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0 || timeoutSec > 3600) fail('stop.timeoutSec', 'must be a number between 0 and 3600');
  if (stopType === 'stdin' && !isStr(st.command)) fail('stop.command', 'must be a string when stop.type is "stdin"');
  const stop = { type: stopType, signal: sig, command: isStr(st.command) ? st.command : '', timeoutSec };

  const c = raw.console === undefined || raw.console === null ? {} : raw.console;
  if (!isObj(c)) fail('console', 'must be an object');
  const consoleCfg = { stdin: c.stdin === true };

  const sc = raw.scripts === undefined || raw.scripts === null ? {} : raw.scripts;
  if (!isObj(sc)) fail('scripts', 'must be an object');
  if (!isStrOrNull(sc.postInstall)) fail('scripts.postInstall', 'must be a string or null');
  if (!isStrOrNull(sc.preStart)) fail('scripts.preStart', 'must be a string or null');
  const scripts = { postInstall: sc.postInstall || null, preStart: sc.preStart || null };

  return {
    schema: 1,
    serverName: raw.serverName,
    steam,
    workshop,
    files,
    launch,
    stop,
    console: consoleCfg,
    ready: raw.ready ?? null,
    scripts,
  };
}

function loadPlan(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new PlanError(`cannot read plan file ${file}: ${e.code || 'error'}`);
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    // Do not echo the parser message: it can quote a fragment of the secret-bearing file.
    throw new PlanError('plan file is not valid JSON');
  }
  return validatePlan(raw);
}

module.exports = { PlanError, validatePlan, loadPlan };
