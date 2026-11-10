'use strict';

const REDACTED = '***';

// Steam args that carry secrets: the value following them is hidden.
const SECRET_FLAGS = new Set(['-betapassword']);

function redactSteamArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    out.push(args[i]);
    if (SECRET_FLAGS.has(args[i]) && i + 1 < args.length) {
      out.push(REDACTED);
      i++;
    }
  }
  return out;
}

// Environment values are never printed: only the key names.
function redactEnv(env) {
  const out = {};
  for (const k of Object.keys(env || {})) out[k] = REDACTED;
  return out;
}

// argv values can embed passwords (-ServerPassword=...): print only the program and the count.
function describeCommand(argv) {
  return `${argv[0]} (+${Math.max(0, argv.length - 1)} args, values hidden)`;
}

module.exports = { REDACTED, redactSteamArgs, redactEnv, describeCommand };
