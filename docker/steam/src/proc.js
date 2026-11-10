'use strict';

const { spawn } = require('node:child_process');
const os = require('node:os');

class AbortError extends Error {
  constructor(signal) {
    super(`aborted by ${signal}`);
    this.signal = signal;
  }
}

const state = {
  children: new Set(),
  aborted: null, // signal name once a termination signal arrived
  gameStopper: null, // set while the game runs: (signal) => void
};

function killGroup(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}

// Children run in their own process group (detached) so one kill reaches wine/xvfb helpers too.
// Their stdin is never the terminal: it is /dev/null or a pipe fed by the executor.
function spawnTracked(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { detached: true, ...opts });
  state.children.add(child);
  const done = new Promise((resolve, reject) => {
    child.once('error', (e) => {
      state.children.delete(child);
      reject(e);
    });
    child.once('close', (code, signal) => {
      state.children.delete(child);
      resolve({ code, signal });
    });
  });
  return { child, done };
}

function throwIfAborted() {
  if (state.aborted) throw new AbortError(state.aborted);
}

// Called by main on SIGTERM/SIGINT/SIGHUP.
function handleSignal(sig) {
  if (state.gameStopper) {
    state.gameStopper(sig);
    return;
  }
  if (!state.aborted) state.aborted = sig;
  for (const c of state.children) {
    killGroup(c, 'SIGTERM');
    setTimeout(() => killGroup(c, 'SIGKILL'), 10000).unref();
  }
}

function exitCodeFor(code, signal) {
  if (typeof code === 'number') return code;
  if (signal) return 128 + (os.constants.signals[signal] || 0);
  return 1;
}

module.exports = { AbortError, state, spawnTracked, killGroup, throwIfAborted, handleSignal, exitCodeFor };
