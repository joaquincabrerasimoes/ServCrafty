#!/usr/bin/env node
'use strict';

// servcrafty-steam-run: executes /servcrafty/plan.json (SPEC.md, "SteamCMD games (v0.3.0)").
// Starts as root, fixes ownership of /data, drops to uid/gid 1000 and never logs plan secrets.

const fs = require('node:fs');
const path = require('node:path');
const log = require('./log');
const proc = require('./proc');
const { makePaths, safeJoin } = require('./paths');
const { loadPlan, PlanError } = require('./plan');
const { applyFileOps } = require('./files');
const steamcmd = require('./steamcmd');
const { syncWorkshop, loadManifest } = require('./workshop');
const { buildLaunch, runGame, XVFB_ARGS } = require('./launch');
const { redactEnv, describeCommand } = require('./redact');

const UID = 1000;
const GID = 1000;

function dirHasFiles(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

// chown -R, touching only entries that are not already owned by uid:gid (cheap on big game dirs).
function chownTree(root, uid, gid) {
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.uid !== uid || st.gid !== gid) {
      try {
        fs.lchownSync(p, uid, gid);
      } catch (e) {
        log.info(`chown failed for ${path.relative(root, p) || '.'}: ${e.code}`);
      }
    }
    if (st.isDirectory()) {
      try {
        for (const name of fs.readdirSync(p)) stack.push(path.join(p, name));
      } catch {
        /* unreadable dir */
      }
    }
  }
}

function dropPrivileges() {
  try {
    process.initgroups('steam', GID);
  } catch {
    process.setgroups([GID]);
  }
  process.setgid(GID);
  process.setuid(UID);
}

// Games locate the Steam client library through ~/.steam/sdk{32,64}/steamclient.so.
function linkSteamSdk(paths) {
  const pairs = [
    ['sdk32', path.join(paths.steamcmdDir, 'linux32', 'steamclient.so')],
    ['sdk64', path.join(paths.steamcmdDir, 'linux64', 'steamclient.so')],
  ];
  for (const [dir, target] of pairs) {
    const d = path.join(paths.steamHome, '.steam', dir);
    const link = path.join(d, 'steamclient.so');
    try {
      fs.mkdirSync(d, { recursive: true });
      try {
        fs.unlinkSync(link);
      } catch {
        /* none */
      }
      fs.symlinkSync(target, link);
    } catch (e) {
      log.info(`could not link ${dir}: ${e.code}`);
    }
  }
}

function runScript(name, snippet, cwd, env, dryRun) {
  if (!snippet) return Promise.resolve();
  if (dryRun) {
    log.info(`[dry-run] would run scripts.${name} (${snippet.split('\n').length} line(s), cwd=${cwd})`);
    return Promise.resolve();
  }
  proc.throwIfAborted();
  const { done } = proc.spawnTracked('sh', ['-c', snippet], { cwd, env, stdio: ['ignore', 'inherit', 'inherit'] });
  return done.then(({ code, signal }) => {
    proc.throwIfAborted();
    const c = proc.exitCodeFor(code, signal);
    if (c !== 0) throw new Error(`scripts.${name} exited with code ${c}`);
  });
}

async function initWinePrefix(paths, env, dryRun) {
  if (fs.existsSync(path.join(paths.wineprefix, 'system.reg'))) return;
  const args = ['-a', '-s', XVFB_ARGS, 'wineboot', '-u'];
  if (dryRun) {
    log.info(`[dry-run] would initialise the wine prefix: xvfb-run ${args.join(' ')}`);
    return;
  }
  log.info('initialising the wine prefix (first run)');
  fs.mkdirSync(paths.wineprefix, { recursive: true });
  const wenv = { ...env, WINEPREFIX: paths.wineprefix, WINEDEBUG: '-all' };
  delete wenv.DISPLAY;
  const { child, done } = proc.spawnTracked('xvfb-run', args, { env: wenv, stdio: ['ignore', 'ignore', 'ignore'] });
  const timer = setTimeout(() => proc.killGroup(child, 'SIGKILL'), 180000);
  try {
    const { code } = await done;
    if (code !== 0) log.info(`wineboot exited with code ${code} (continuing)`);
  } catch (e) {
    log.info(`wineboot failed to start: ${e.code || 'error'} (continuing)`);
  } finally {
    clearTimeout(timer);
  }
  proc.throwIfAborted();
}

async function run(argv, env) {
  const dryRun = argv.includes('--dry-run') || env.SERVCRAFTY_DRY_RUN === '1';
  const paths = makePaths(env.SERVCRAFTY_ROOT);
  const planIdx = argv.indexOf('--plan');
  const planPath = planIdx >= 0 && argv[planIdx + 1] ? argv[planIdx + 1] : env.SERVCRAFTY_PLAN || paths.plan;

  // The plan is read while still root: it is mode 0600.
  const plan = loadPlan(planPath);

  if (!dryRun && typeof process.getuid === 'function' && process.getuid() === 0) {
    fs.mkdirSync(paths.game, { recursive: true });
    fs.mkdirSync(paths.workshop, { recursive: true });
    fs.mkdirSync(paths.steamHome, { recursive: true });
    chownTree(paths.data, UID, GID);
    dropPrivileges();
  }

  const baseEnv = { ...env, HOME: paths.steamHome, USER: 'steam', LOGNAME: 'steam' };
  fs.mkdirSync(paths.game, { recursive: true });
  fs.mkdirSync(paths.steamHome, { recursive: true });
  if (!dryRun) linkSteamSdk(paths);

  let bootstrapped = false;
  const steamOpts = { bin: paths.steamcmd, env: baseEnv, cwd: paths.steamHome };
  async function steam(args, label) {
    if (dryRun) {
      log.info(`[dry-run] ${label}: ${paths.steamcmd} ${steamcmd.describeArgs(args)}`);
      return;
    }
    if (!bootstrapped) {
      bootstrapped = true;
      await steamcmd.runWithRetry(steamcmd.buildBootstrapArgs(), 'steamcmd self-update', steamOpts);
    }
    await steamcmd.runWithRetry(args, label, steamOpts);
  }

  // --- (1) install / update ---
  log.phase('install');
  let installed = false;
  const skipInstall = plan.steam.update === false && dirHasFiles(paths.game);
  if (skipInstall) {
    log.info('update disabled and game files present: skipping SteamCMD');
  } else {
    await steam(steamcmd.buildInstallArgs(plan.steam, paths.game), 'game install');
    installed = true;
  }
  proc.throwIfAborted();

  // --- (2) workshop ---
  const manifest = loadManifest(paths.manifest);
  const hasWorkshopWork = (plan.workshop && plan.workshop.ids.length > 0) || Object.keys(manifest.items).length > 0;
  if (hasWorkshopWork) {
    log.phase('workshop');
    if (plan.workshop && plan.workshop.ids.length > 0) {
      fs.mkdirSync(paths.workshop, { recursive: true });
      await steam(steamcmd.buildWorkshopArgs(plan.steam, plan.workshop, paths.workshop), 'workshop download');
      proc.throwIfAborted();
    }
    if (dryRun) {
      log.info(`[dry-run] would sync workshop items (${plan.workshop ? plan.workshop.install : 'none'})`);
    } else {
      const { missing } = syncWorkshop({ paths, workshop: plan.workshop });
      if (missing.length) {
        if (plan.workshop && plan.workshop.install === 'steamcmd') {
          throw new Error(`workshop item(s) not found after download: ${missing.join(', ')}`);
        }
      }
    }
  }

  // --- (3) files, (4) scripts ---
  log.phase('configure');
  const launch = buildLaunch(plan, paths, baseEnv);
  fs.mkdirSync(launch.cwd, { recursive: true });
  // Order: postInstall (every start, so it can seed files), files, preStart. Scripts run in the game dir.
  await runScript('postInstall', plan.scripts.postInstall, paths.game, launch.env, dryRun);
  const results = applyFileOps(plan.files, paths.game);
  if (dryRun) log.info(`[dry-run] file ops: ${results.map((r) => `${r.path}=${r.action}`).join(', ') || 'none'}`);
  if (plan.steam.platform === 'windows') await initWinePrefix(paths, baseEnv, dryRun);
  await runScript('preStart', plan.scripts.preStart, paths.game, launch.env, dryRun);
  proc.throwIfAborted();

  // --- (5) launch ---
  log.phase('launch');
  if (dryRun) {
    log.info(`[dry-run] launch: cwd=${launch.cwd} windows=${launch.windows} command=${describeCommand([launch.cmd, ...launch.args])}`);
    log.info(`[dry-run] game argv: ${describeCommand(plan.launch.argv)}`);
    log.info(`[dry-run] env keys: ${Object.keys(redactEnv(plan.launch.env)).join(', ') || 'none'}`);
    log.info(`[dry-run] stop: ${plan.stop.type} timeout=${plan.stop.timeoutSec}s stdin=${plan.console.stdin}`);
    return 0;
  }
  return runGame(plan, launch);
}

async function main() {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => proc.handleSignal(sig));
  let code;
  try {
    code = await run(process.argv.slice(2), process.env);
  } catch (e) {
    if (e instanceof proc.AbortError) {
      code = 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[e.signal] || 15);
    } else {
      log.error(e instanceof PlanError || e instanceof Error ? e.message : 'unexpected failure');
      code = 1;
    }
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = { run, chownTree, safeJoin };
