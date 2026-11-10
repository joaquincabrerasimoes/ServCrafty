'use strict';

const proc = require('./proc');
const log = require('./log');
const { redactSteamArgs } = require('./redact');

const BASE = ['+@ShutdownOnFailedCommand', '1', '+@NoPromptForPassword', '1'];

function platformArgs(platform) {
  return platform === 'windows' ? ['+@sSteamCmdForcePlatformType', 'windows'] : [];
}

// Arguments for the game install/update run (SPEC.md, "Image" step 1).
function buildInstallArgs(steam, gameDir) {
  const args = [...BASE, ...platformArgs(steam.platform), '+force_install_dir', gameDir, '+login', 'anonymous', '+app_update', String(steam.appId)];
  if (steam.branch && steam.branch !== 'public') {
    args.push('-beta', steam.branch);
    if (steam.betaPassword) args.push('-betapassword', steam.betaPassword);
  }
  if (steam.validate) args.push('validate');
  args.push('+quit');
  return args;
}

// Arguments for workshop downloads; content ends up under <installDir>/steamapps/workshop/content/<appid>/<id>.
function buildWorkshopArgs(steam, workshop, installDir) {
  const args = [...BASE, ...platformArgs(steam.platform), '+force_install_dir', installDir, '+login', 'anonymous'];
  for (const id of workshop.ids) args.push('+workshop_download_item', String(workshop.appId), String(id));
  args.push('+quit');
  return args;
}

// Self-update only.
function buildBootstrapArgs() {
  return [...BASE, '+quit'];
}

const PROGRESS_RE = /Update state \(0x[0-9a-fA-F]+\)[^,\n]*, progress: (\d+(?:\.\d+)?)/;

// Returns an integer 0-100 or null when the line is not a progress line.
function parseProgress(line) {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const n = Math.floor(parseFloat(m[1]));
  return Math.max(0, Math.min(100, n));
}

const NO_SPACE_RE = /state is 0x(?:202|602)\b|not enough disk space|disk write failure/i;
const AFTER_UPDATE_RE = /error!\s+app\s+'?\d+'?\s+state is 0x[0-9a-f]+ after update job/i;
const WORKSHOP_FAIL_RE = /ERROR!\s+Download item \d+ failed/i;
const TRANSIENT_TEXT_RE = /missing configuration|timeout|timed out/i;
const NO_SUB_RE = /no subscription|invalid password|login failure/i;

/**
 * Decide what to do after a SteamCMD run.
 * @returns {{kind:'ok'}|{kind:'retry',reason:string}|{kind:'fatal',reason:string}}
 */
function classifyResult(exitCode, output) {
  const text = String(output || '');
  if (NO_SPACE_RE.test(text)) return { kind: 'fatal', reason: 'not enough disk space' };
  const failedDownload = WORKSHOP_FAIL_RE.test(text);
  const failedUpdate = AFTER_UPDATE_RE.test(text);
  if (exitCode === 0 && !failedDownload && !failedUpdate) return { kind: 'ok' };
  if (NO_SUB_RE.test(text)) return { kind: 'fatal', reason: 'SteamCMD refused the anonymous login or the app needs a subscription' };
  if (exitCode === 8 || exitCode === 10) return { kind: 'retry', reason: `SteamCMD exit code ${exitCode}` };
  if (TRANSIENT_TEXT_RE.test(text)) return { kind: 'retry', reason: 'SteamCMD transient error' };
  if (failedUpdate) return { kind: 'retry', reason: 'SteamCMD reported a failed update state' };
  if (failedDownload) return { kind: 'retry', reason: 'workshop download failed' };
  return { kind: 'fatal', reason: `SteamCMD exited with code ${exitCode}` };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run SteamCMD once, streaming its output. Resolves { code, output }.
 */
async function runOnce(bin, args, env, cwd) {
  proc.throwIfAborted();
  const { child, done } = proc.spawnTracked(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  let lastPct = -1;
  const onData = (buf) => {
    const parts = (onData.rest + buf.toString('utf8')).split(/[\r\n]+/);
    onData.rest = parts.pop();
    for (const line of parts) {
      if (!line.trim()) continue;
      tail = (tail + '\n' + line).slice(-8000);
      const pct = parseProgress(line);
      if (pct !== null) {
        if (pct !== lastPct) {
          lastPct = pct;
          log.progress(pct);
        }
        continue;
      }
      process.stdout.write(line + '\n');
    }
  };
  onData.rest = '';
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const { code, signal } = await done;
  if (onData.rest.trim()) tail = (tail + '\n' + onData.rest).slice(-8000);
  proc.throwIfAborted();
  return { code: proc.exitCodeFor(code, signal), output: tail };
}

/**
 * Run SteamCMD with up to `maxAttempts` attempts on transient failures.
 * opts: { bin, env, cwd, maxAttempts, sleep, run } (run/sleep are injectable for tests)
 */
async function runWithRetry(args, label, opts) {
  const maxAttempts = opts.maxAttempts || 3;
  const sleep = opts.sleep || defaultSleep;
  const run = opts.run || ((a) => runOnce(opts.bin, a, opts.env, opts.cwd));
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log.info(`${label}: SteamCMD attempt ${attempt}/${maxAttempts}`);
    const res = await run(args);
    const verdict = classifyResult(res.code, res.output);
    if (verdict.kind === 'ok') return;
    last = verdict;
    if (verdict.kind === 'fatal') throw new Error(`${label} failed: ${verdict.reason}`);
    log.info(`${label}: ${verdict.reason}; retrying`);
    if (attempt < maxAttempts) await sleep(5000 * attempt);
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts: ${last.reason}`);
}

function describeArgs(args) {
  return redactSteamArgs(args).join(' ');
}

module.exports = {
  buildInstallArgs,
  buildWorkshopArgs,
  buildBootstrapArgs,
  parseProgress,
  classifyResult,
  runWithRetry,
  describeArgs,
};
