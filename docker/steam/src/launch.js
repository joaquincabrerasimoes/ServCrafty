'use strict';

const proc = require('./proc');
const log = require('./log');

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
    env.WINEDEBUG = '-all';
    delete env.DISPLAY; // xvfb-run provides its own display
    cmd = 'xvfb-run';
    args = ['-a', '-s', XVFB_ARGS, 'wine', ...plan.launch.argv];
  } else {
    cmd = plan.launch.argv[0];
    args = plan.launch.argv.slice(1);
  }
  return { cmd, args, cwd, env, windows };
}

// Runs the game; resolves with the exit code the executor should use.
function runGame(plan, launch) {
  const needStdin = plan.console.stdin || plan.stop.type === 'stdin';
  const { child, done } = proc.spawnTracked(launch.cmd, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: [needStdin ? 'pipe' : 'ignore', 'inherit', 'inherit'],
  });

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
    proc.state.gameStopper = null;
    if (needStdin) process.stdin.unpipe(child.stdin);
    // Reap helpers (wine, Xvfb) that outlived the main process.
    proc.killGroup(child, 'SIGTERM');
    return proc.exitCodeFor(code, signal);
  });
}

module.exports = { buildLaunch, runGame, XVFB_ARGS };
