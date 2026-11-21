'use strict';

const proc = require('./proc');
const fs = require('node:fs');
const log = require('./log');
const { tailFile } = require('./logtail');
const { DebugStringFilter, wantsDebugStrings } = require('./winelog');

const XVFB_ARGS = '-screen 0 1024x768x16 -nolisten tcp';

// Builds the command that starts the game (pure; used by --dry-run and tests).
function buildLaunch(plan, paths, baseEnv = process.env) {
  const cwd = plan.launch.cwd ? require('./paths').safeJoin(paths.game, plan.launch.cwd) : paths.game;
  const windows = plan.steam.platform === 'windows';
  const env = { ...baseEnv, ...plan.launch.env };
  let cmd;
  let args;
  if (windows) {
    env.WINEPREFIX = paths.wineprefix;
    // Quiet by default; a game definition can ask for Wine diagnostics (launch.env.WINEDEBUG), for example
    // `fixme-all,warn+seh` makes Windows games' OutputDebugString messages visible in the server log.
    env.WINEDEBUG = (plan.launch.env && plan.launch.env.WINEDEBUG) || '-all';
    delete env.DISPLAY; // xvfb-run provides its own display
    cmd = 'xvfb-run';
    args = ['-a', '-s', XVFB_ARGS, 'wine', ...plan.launch.argv];
  } else {
    cmd = plan.launch.argv[0];
    args = plan.launch.argv.slice(1);
  }
  const logFile = plan.launch.logFile ? require('./paths').safeJoin(paths.game, plan.launch.logFile) : null;
  return { cmd, args, cwd, env, windows, logFile };
}

// Runs the game; resolves with the exit code the executor should use.
function runGame(plan, launch) {
  const needStdin = plan.console.stdin || plan.stop.type === 'stdin';
  // A game that writes its console to a file (srcds -condebug): start from an empty file and stream it to the server log.
  let tail = null;
  if (launch.logFile) {
    fs.rmSync(launch.logFile, { force: true });
    tail = tailFile(launch.logFile, (t) => process.stdout.write(t));
  }
  // Wine never gets the container's TTY (see winelog.js): its output goes through pipes that the executor relays.
  const out = launch.windows ? 'pipe' : 'inherit';
  const { child, done } = proc.spawnTracked(launch.cmd, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: [needStdin ? 'pipe' : 'ignore', out, out],
  });
  if (launch.windows) {
    const filter = wantsDebugStrings(launch.env.WINEDEBUG) ? new DebugStringFilter((t) => process.stdout.write(t)) : null;
    child.stdout.on('data', (c) => process.stdout.write(c));
    child.stderr.on('data', (c) => (filter ? filter.push(c) : process.stderr.write(c)));
    child.stderr.on('end', () => filter && filter.flush());
  }

  let stopping = false;
  let killTimer = null;

  if (needStdin) {
    child.stdin.on('error', () => {});
    // end:false -> EOF on the attached stdin must not close the game's stdin.
    process.stdin.on('error', () => {});
    process.stdin.pipe(child.stdin, { end: false });
  }

  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`stopping game (received ${sig})`);
    const { type, signal, command, timeoutSec } = plan.stop;
    if (type === 'stdin' && child.stdin && child.stdin.writable) {
      child.stdin.write(command + '\n');
    } else {
      proc.killGroup(child, signal);
    }
    killTimer = setTimeout(() => {
      log.info(`stop timeout (${timeoutSec}s), killing the game`);
      proc.killGroup(child, 'SIGKILL');
    }, timeoutSec * 1000);
  };
  proc.state.gameStopper = stop;
  // A signal that arrived while the preceding phases ended up here too.
  if (proc.state.aborted) stop(proc.state.aborted);

  return done.then(({ code, signal }) => {
    if (killTimer) clearTimeout(killTimer);
    if (tail) tail.stop();
    proc.state.gameStopper = null;
    if (needStdin) process.stdin.unpipe(child.stdin);
    // Reap helpers (wine, Xvfb) that outlived the main process.
    proc.killGroup(child, 'SIGTERM');
    return proc.exitCodeFor(code, signal);
  });
}

module.exports = { buildLaunch, runGame, XVFB_ARGS };
