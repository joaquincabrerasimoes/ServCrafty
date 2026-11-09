/**
 * Self-update (SPEC "Self-update feature (v0.2)").
 *
 * - Checks GitHub Releases of `UPDATE_REPO` (stable `vX.Y.Z` only) with ETag
 *   revalidation and a 6 h cache; never throws on network errors (`checkError`).
 * - Detects the install type and whether this instance can update itself.
 * - Reads the updater's status/log files under `$DATA_DIR/update/`.
 * - Starts `lxc/apply-update.sh` outside the service cgroup via `systemd-run`.
 *
 * The pure helpers (semver, release filtering, origin/SHA checks, capability
 * evaluation) are exported for unit tests; `UpdateService` takes its I/O as deps.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_ROOT, APP_VERSION, USER_AGENT, config } from '../config.js';
import { AppError, badRequest, conflict, errorMessage } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Public payload types (binding contract with the web UI)
// ---------------------------------------------------------------------------

export type InstallType = 'lxc' | 'docker' | 'source';
export type UpdateState = 'idle' | 'running' | 'succeeded' | 'failed' | 'rolled_back';

export interface LatestRelease {
  version: string;
  tag: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
  commitSha: string;
  verified: boolean;
}

export interface UpdateStatus {
  state: UpdateState;
  step: string | null;
  fromVersion: string | null;
  targetVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

export interface UpdatePayload {
  currentVersion: string;
  commit: string | null;
  installType: InstallType;
  canUpdate: boolean;
  cannotUpdateReason: string | null;
  checkedAt: string | null;
  checkError: string | null;
  updateAvailable: boolean;
  latest: LatestRelease | null;
  dockerCommand: string | null;
  runningServers: number;
  status: UpdateStatus;
  rollbackAvailable: boolean;
  previousVersion: string | null;
}

export interface UpdateLogChunk {
  text: string;
  offset: number;
  state: UpdateState;
}

export const DOCKER_UPDATE_COMMAND = 'docker compose pull && docker compose up -d';
export const UPDATER_UNIT = 'servcrafty-updater';
/** Successful checks are reused for this long before GitHub is asked again. */
export const CHECK_TTL_MS = 6 * 3600_000;
/** After a failed check, wait this long before an automatic retry. */
export const FAILED_CHECK_RETRY_MS = 15 * 60_000;
const MAX_NOTES_CHARS = 100_000;
const MAX_LOG_CHUNK = 256 * 1024;
/** A `running` status older than this whose updater unit is gone is reported as failed. */
const STALE_RUNNING_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parse `X.Y.Z[-pre][+build]` (optional leading `v`). Returns null when invalid. */
export function parseSemver(input: string): SemVer | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [],
  };
}

/** True for a plain `X.Y.Z` / `vX.Y.Z` (no prerelease or build suffix). */
export function isStableVersion(input: string): boolean {
  return /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.trim());
}

/**
 * Compare two versions by semver precedence (build metadata ignored).
 * Returns <0, 0 or >0. An unparseable version sorts below any valid one.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  // A version without prerelease has higher precedence than one with.
  if (!pa.prerelease.length || !pb.prerelease.length) return pb.prerelease.length - pa.prerelease.length;
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1; // numeric identifiers sort below alphanumeric
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return !!parseSemver(candidate) && compareSemver(candidate, current) > 0;
}

// ---------------------------------------------------------------------------
// GitHub release parsing / filtering
// ---------------------------------------------------------------------------

/** The subset of a GitHub release object the updater uses. */
export interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

function asRelease(v: unknown): GhRelease | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return null;
  return {
    tag_name: r.tag_name,
    name: typeof r.name === 'string' ? r.name : null,
    body: typeof r.body === 'string' ? r.body : null,
    html_url: r.html_url,
    published_at: typeof r.published_at === 'string' ? r.published_at : null,
    draft: r.draft === true,
    prerelease: r.prerelease === true,
  };
}

/** A release that may be offered: not a draft, not a prerelease, tag `vX.Y.Z`. */
export function isEligibleRelease(r: GhRelease): boolean {
  return !r.draft && !r.prerelease && /^v/.test(r.tag_name) && isStableVersion(r.tag_name);
}

/**
 * Pick the highest eligible release from a GitHub `/releases` response (array)
 * or a single release object (`/releases/latest`). Anything malformed is skipped.
 */
export function pickLatestRelease(data: unknown): GhRelease | null {
  const list = Array.isArray(data) ? data : data ? [data] : [];
  let best: GhRelease | null = null;
  for (const item of list) {
    const r = asRelease(item);
    if (!r || !isEligibleRelease(r)) continue;
    if (!best || compareSemver(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best;
}

/** Map an eligible release + its resolved commit to the API payload shape. */
export function toLatestRelease(r: GhRelease, commitSha: string, verified: boolean): LatestRelease {
  const notes = r.body ?? '';
  return {
    version: r.tag_name.replace(/^v/, ''),
    tag: r.tag_name,
    name: r.name?.trim() || r.tag_name,
    notes: notes.length > MAX_NOTES_CHARS ? `${notes.slice(0, MAX_NOTES_CHARS)}\n\n…` : notes,
    url: r.html_url,
    publishedAt: r.published_at ?? new Date(0).toISOString(),
    commitSha,
    verified,
  };
}

// ---------------------------------------------------------------------------
// Origin / SHA verification helpers (mirrored by lxc/apply-update.sh)
// ---------------------------------------------------------------------------

/** A full 40-hex-digit git commit SHA (case-insensitive). */
export function isFullSha(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s.trim());
}

/** Both values are full SHAs naming the same commit. */
export function shasMatch(expected: string, actual: string): boolean {
  return isFullSha(expected) && isFullSha(actual) && expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

/**
 * Canonical form of a GitHub HTTPS remote: `https://github.com/owner/name`
 * (lower-cased, credentials, trailing `/` and `.git` removed). Null for any
 * other host or scheme.
 */
export function normalizeGithubRemote(url: string): string | null {
  const m = /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m) return null;
  return `https://github.com/${m[1]}/${m[2]}`.toLowerCase();
}

/** The configured origin is `https://github.com/<repo>(.git)`. */
export function originMatchesRepo(originUrl: string, repo: string): boolean {
  const n = normalizeGithubRemote(originUrl);
  return n !== null && n === `https://github.com/${repo}`.toLowerCase();
}

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

export interface CapabilityProbe {
  installType: InstallType;
  isGitRepo: boolean;
  hasGit: boolean;
  hasSystemdRun: boolean;
  hasSystemctl: boolean;
  isRoot: boolean;
  appRootWritable: boolean;
  appRoot: string;
}

/** Decide `canUpdate` / `cannotUpdateReason` from probed facts (first failing reason wins). */
export function evaluateCapabilities(p: CapabilityProbe): { canUpdate: boolean; reason: string | null } {
  const no = (reason: string) => ({ canUpdate: false, reason });
  if (p.installType === 'docker') {
    return no(`Docker installs are updated by pulling the new image: ${DOCKER_UPDATE_COMMAND}`);
  }
  if (!p.isGitRepo) return no(`${p.appRoot} is not a git checkout`);
  if (!p.hasGit) return no('git is not installed');
  if (!p.hasSystemdRun || !p.hasSystemctl) return no('systemd-run and systemctl are required to run the updater (systemd host)');
  if (!p.isRoot) return no('ServCrafty must run as root to update itself');
  if (!p.appRootWritable) return no(`${p.appRoot} is not writable`);
  return { canUpdate: true, reason: null };
}

/** INSTALL_TYPE env wins; otherwise a `.git` in the app root means lxc, else source. */
export function detectInstallType(envValue: InstallType | undefined, appRootHasGit: boolean): InstallType {
  if (envValue) return envValue;
  return appRootHasGit ? 'lxc' : 'source';
}

/** Locate an executable on PATH (no shell). */
export function findOnPath(name: string, envPath = process.env.PATH ?? ''): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status / previous.json parsing
// ---------------------------------------------------------------------------

const STATES: readonly UpdateState[] = ['idle', 'running', 'succeeded', 'failed', 'rolled_back'];

export const IDLE_STATUS: UpdateStatus = {
  state: 'idle',
  step: null,
  fromVersion: null,
  targetVersion: null,
  startedAt: null,
  finishedAt: null,
  message: null,
};

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Parse status.json content; anything unexpected degrades to `idle`. */
export function parseStatus(text: string | null): UpdateStatus {
  if (!text) return { ...IDLE_STATUS };
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const state = STATES.includes(j.state as UpdateState) ? (j.state as UpdateState) : 'idle';
    return {
      state,
      step: strOrNull(j.step),
      fromVersion: strOrNull(j.fromVersion),
      targetVersion: strOrNull(j.targetVersion),
      startedAt: strOrNull(j.startedAt),
      finishedAt: strOrNull(j.finishedAt),
      message: strOrNull(j.message),
    };
  } catch {
    return { ...IDLE_STATUS };
  }
}

export interface PreviousInfo {
  sha: string;
  version: string | null;
}

export function parsePrevious(text: string | null): PreviousInfo | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.sha !== 'string' || !isFullSha(j.sha)) return null;
    return { sha: j.sha.toLowerCase(), version: strOrNull(j.version) };
  } catch {
    return null;
  }
}

/** Cut a buffer at the last complete UTF-8 character; returns the usable byte length. */
export function utf8SafeLength(buf: Buffer): number {
  let end = buf.length;
  // Walk back over at most 3 continuation bytes to the start of the last char.
  let i = end - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && (buf[i]! & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i < 0) return end;
  const lead = buf[i]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (need > 1 && end - i < need) end = i;
  return end;
}

// ---------------------------------------------------------------------------
// GitHub client (ETag revalidation + rate-limit awareness)
// ---------------------------------------------------------------------------

type FetchFn = typeof fetch;

export interface EtagEntry {
  etag: string;
  data: unknown;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export class GitHubClient {
  /** path -> last 200 body + its ETag. */
  readonly etags = new Map<string, EtagEntry>();
  /** Epoch ms until which the anonymous/primary limit is exhausted. */
  rateLimitedUntil = 0;
  /** True when the last `get` was answered 304 (served from the ETag cache). */
  lastNotModified = false;

  constructor(
    private readonly opts: { repo: string; token?: string; fetch: FetchFn; now: () => number; timeoutMs?: number },
  ) {}

  /** GET `/repos/<repo><suffix>`. 404 -> `null`. Throws GitHubError otherwise. */
  async get(suffix: string): Promise<unknown> {
    const now = this.opts.now();
    if (this.rateLimitedUntil > now) {
      throw new GitHubError(
        `GitHub API rate limit reached; next check possible after ${new Date(this.rateLimitedUntil).toISOString()}`,
        403,
      );
    }
    const url = `https://api.github.com/repos/${this.opts.repo}${suffix}`;
    const cached = this.etags.get(suffix);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    if (cached) headers['If-None-Match'] = cached.etag;
    this.lastNotModified = false;
    let res: Response;
    try {
      res = await this.opts.fetch(url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const why = e.name === 'TimeoutError' ? 'timed out' : (e.cause?.code ?? e.message);
      throw new GitHubError(`Could not reach api.github.com (${why})`);
    }
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (remaining === '0' && Number.isFinite(reset) && reset > 0) this.rateLimitedUntil = reset * 1000;
    if (res.status === 304 && cached) {
      this.lastNotModified = true;
      return cached.data;
    }
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) {
      if (!(this.rateLimitedUntil > now)) {
        const retry = Number(res.headers.get('retry-after'));
        this.rateLimitedUntil = now + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 3600_000);
      }
      throw new GitHubError(`GitHub API refused the request (HTTP ${res.status}, rate limit?)`, res.status);
    }
    if (!res.ok) throw new GitHubError(`GitHub API responded HTTP ${res.status}`, res.status);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new GitHubError('GitHub API returned invalid JSON', res.status);
    }
    const etag = res.headers.get('etag');
    if (etag) this.etags.set(suffix, { etag, data });
    return data;
  }
}

/**
 * Resolve a tag to its commit SHA through the GitHub API, following annotated
 * tags. `verified` is GitHub's signature verification of the tag object or the
 * commit (either one verified counts).
 */
export async function resolveTagCommit(gh: GitHubClient, tag: string): Promise<{ sha: string; verified: boolean }> {
  const ref = (await gh.get(`/git/ref/tags/${encodeURIComponent(tag)}`)) as
    | { object?: { type?: string; sha?: string } }
    | null;
  if (!ref?.object?.sha) throw new GitHubError(`Tag ${tag} was not found on GitHub`, 404);
  let { type, sha } = ref.object as { type?: string; sha: string };
  let tagVerified = false;
  // Annotated tags point at a tag object; follow (bounded) to the commit.
  for (let depth = 0; type === 'tag' && depth < 5; depth++) {
    const t = (await gh.get(`/git/tags/${sha}`)) as {
      object?: { type?: string; sha?: string };
      verification?: { verified?: boolean };
    } | null;
    if (!t?.object?.sha) throw new GitHubError(`Tag object for ${tag} could not be read`);
    tagVerified ||= t.verification?.verified === true;
    type = t.object.type;
    sha = t.object.sha;
  }
  if (type !== 'commit' || !isFullSha(sha)) throw new GitHubError(`Tag ${tag} does not point at a commit`);
  const commit = (await gh.get(`/commits/${sha}`)) as {
    sha?: string;
    commit?: { verification?: { verified?: boolean } };
  } | null;
  if (commit?.sha && !shasMatch(sha, commit.sha)) throw new GitHubError(`Commit lookup for ${tag} returned a different SHA`);
  const commitVerified = commit?.commit?.verification?.verified === true;
  return { sha: sha.toLowerCase(), verified: tagVerified || commitVerified };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type ExecFn = (file: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;

/** execFile that never rejects (spawn failures come back as code -1). */
export const defaultExec: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === -1 ? err.message : '')) });
      },
    );
  });

export interface UpdateDeps {
  repo: string;
  checkEnabled: boolean;
  token?: string;
  installTypeEnv?: InstallType;
  appRoot: string;
  dataDir: string;
  currentVersion: string;
  port: number;
  fetch: FetchFn;
  exec: ExecFn;
  now: () => number;
  countRunningServers: () => Promise<number>;
  /** Overrides for capability probing (tests). */
  probe?: Partial<CapabilityProbe>;
  log?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

interface CheckCacheFile {
  checkedAt: string | null;
  latest: LatestRelease | null;
  etags: Record<string, EtagEntry>;
}

export class UpdateService {
  private readonly gh: GitHubClient;
  private checkedAt: number | null = null;
  private lastAttemptAt = 0;
  private checkError: string | null = null;
  private latest: LatestRelease | null = null;
  private inflight: Promise<void> | null = null;
  private commit: string | null = null;
  private commitRead = false;
  private cacheLoaded = false;
  private starting = false;

  constructor(private readonly d: UpdateDeps) {
    this.gh = new GitHubClient({ repo: d.repo, token: d.token, fetch: d.fetch, now: d.now });
  }

  get updateDir(): string {
    return path.join(this.d.dataDir, 'update');
  }
  private file(name: string): string {
    return path.join(this.updateDir, name);
  }

  /** Capture the running commit early (before an update can move HEAD) and load the check cache. */
  async init(): Promise<void> {
    await this.readCommit();
    await this.loadCache();
  }

  private async readCommit(): Promise<string | null> {
    if (this.commitRead) return this.commit;
    this.commitRead = true;
    if (!fs.existsSync(path.join(this.d.appRoot, '.git'))) return null;
    const r = await this.d.exec('git', ['rev-parse', 'HEAD'], { cwd: this.d.appRoot, timeoutMs: 5000 });
    const sha = r.stdout.trim();
    this.commit = r.code === 0 && isFullSha(sha) ? sha.toLowerCase() : null;
    return this.commit;
  }

  private async loadCache(): Promise<void> {
    if (this.cacheLoaded) return;
    this.cacheLoaded = true;
    try {
      const j = JSON.parse(await fsp.readFile(this.file('check-cache.json'), 'utf8')) as CheckCacheFile;
      if (j.checkedAt) {
        const t = Date.parse(j.checkedAt);
        if (Number.isFinite(t)) this.checkedAt = t;
      }
      this.latest = j.latest ?? null;
      for (const [k, v] of Object.entries(j.etags ?? {})) if (v?.etag) this.gh.etags.set(k, v);
    } catch {
      /* no cache yet */
    }
  }

  private async saveCache(): Promise<void> {
    const body: CheckCacheFile = {
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      latest: this.latest,
      etags: Object.fromEntries(this.gh.etags),
    };
    try {
      await fsp.mkdir(this.updateDir, { recursive: true });
      const tmp = this.file(`check-cache.json.${process.pid}.tmp`);
      await fsp.writeFile(tmp, JSON.stringify(body));
      await fsp.rename(tmp, this.file('check-cache.json'));
    } catch (err) {
      this.d.log?.warn({ err }, 'could not persist update check cache');
    }
  }

  installType(): InstallType {
    return detectInstallType(this.d.installTypeEnv, fs.existsSync(path.join(this.d.appRoot, '.git')));
  }

  probe(): CapabilityProbe {
    const appRoot = this.d.appRoot;
    let writable = false;
    try {
      fs.accessSync(appRoot, fs.constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }
    return {
      installType: this.installType(),
      isGitRepo: fs.existsSync(path.join(appRoot, '.git')),
      hasGit: !!findOnPath('git'),
      hasSystemdRun: !!findOnPath('systemd-run'),
      hasSystemctl: !!findOnPath('systemctl'),
      isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
      appRootWritable: writable,
      appRoot,
      ...this.d.probe,
    };
  }

  /** Query GitHub (deduplicated). Never throws; failures land in `checkError`. */
  async check(force = false): Promise<void> {
    await this.loadCache();
    if (!this.d.checkEnabled) {
      this.checkError = 'Update checks are disabled (UPDATE_CHECK=0)';
      return;
    }
    const now = this.d.now();
    if (!force) {
      if (this.checkedAt !== null && now - this.checkedAt < CHECK_TTL_MS && this.checkError === null) return;
      if (now - this.lastAttemptAt < FAILED_CHECK_RETRY_MS && this.checkError !== null) return;
    }
    if (!this.inflight) {
      this.inflight = this.doCheck().finally(() => {
        this.inflight = null;
      });
    }
    await this.inflight;
  }

  private async doCheck(): Promise<void> {
    this.lastAttemptAt = this.d.now();
    try {
      const releases = await this.gh.get('/releases?per_page=30');
      const unchanged = this.gh.lastNotModified;
      const best = pickLatestRelease(releases ?? []);
      if (!best) {
        this.latest = null;
      } else if (unchanged && this.latest?.tag === best.tag_name && isFullSha(this.latest.commitSha)) {
        // Release list unchanged (304): keep the resolved commit, save two API calls.
        // (Unauthenticated 304s still count against GitHub's 60 req/h limit.)
        this.latest = toLatestRelease(best, this.latest.commitSha, this.latest.verified);
      } else {
        const { sha, verified } = await resolveTagCommit(this.gh, best.tag_name);
        this.latest = toLatestRelease(best, sha, verified);
      }
      this.checkedAt = this.d.now();
      this.checkError = null;
      await this.saveCache();
    } catch (err) {
      this.checkError = errorMessage(err);
      this.d.log?.warn({ err: this.checkError }, 'update check failed');
    }
  }

  async readStatus(): Promise<UpdateStatus> {
    const text = await fsp.readFile(this.file('status.json'), 'utf8').catch(() => null);
    const st = parseStatus(text);
    if (st.state === 'running' && !this.starting) {
      const started = st.startedAt ? Date.parse(st.startedAt) : Number.NaN;
      const old = !Number.isFinite(started) || this.d.now() - started > STALE_RUNNING_MS;
      if (old && !(await this.updaterActive())) {
        return {
          ...st,
          state: 'failed',
          finishedAt: st.finishedAt,
          message: st.message ?? 'The updater stopped unexpectedly; see the update log',
        };
      }
    }
    return st;
  }

  /** Is the transient updater unit (or a held lock) still around? */
  private async updaterActive(): Promise<boolean> {
    if (!findOnPath('systemctl') && !this.d.probe?.hasSystemctl) return false;
    const r = await this.d.exec('systemctl', ['is-active', '--quiet', `${UPDATER_UNIT}.service`], { timeoutMs: 5000 });
    return r.code === 0;
  }

  async readPrevious(): Promise<PreviousInfo | null> {
    return parsePrevious(await fsp.readFile(this.file('previous.json'), 'utf8').catch(() => null));
  }

  /** Full GET /admin/update payload. Refreshes the check when the cache is stale. */
  async payload(opts: { force?: boolean } = {}): Promise<UpdatePayload> {
    await this.check(opts.force ?? false);
    const [commit, status, previous, runningServers] = await Promise.all([
      this.readCommit(),
      this.readStatus(),
      this.readPrevious(),
      this.d.countRunningServers().catch(() => 0),
    ]);
    const probe = this.probe();
    const installType = probe.installType;
    const caps = evaluateCapabilities(probe);
    const latest = this.latest;
    return {
      currentVersion: this.d.currentVersion,
      commit,
      installType,
      canUpdate: caps.canUpdate,
      cannotUpdateReason: caps.reason,
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      checkError: this.checkError,
      updateAvailable: !!latest && isNewerVersion(latest.version, this.d.currentVersion),
      latest,
      dockerCommand: installType === 'docker' ? DOCKER_UPDATE_COMMAND : null,
      runningServers,
      status,
      rollbackAvailable:
        caps.canUpdate && !!previous && status.state !== 'running' && (!commit || previous.sha !== commit),
      previousVersion: previous?.version ?? null,
    };
  }

  private async assertCanStart(): Promise<void> {
    const caps = evaluateCapabilities(this.probe());
    if (!caps.canUpdate) throw badRequest(caps.reason ?? 'This install cannot update itself', 'cannot_update');
    if (this.starting) throw conflict('An update is already in progress', 'update_in_progress');
    const st = await this.readStatus();
    if (st.state === 'running') throw conflict('An update is already in progress', 'update_in_progress');
  }

  /** Find the release to install: the latest, or a specific stable version newer than the current one. */
  private async resolveTarget(version: string | undefined): Promise<LatestRelease> {
    if (version !== undefined) {
      const v = version.trim().replace(/^v/, '');
      if (!isStableVersion(v)) throw badRequest(`${version} is not a stable X.Y.Z version`, 'no_update');
      if (!isNewerVersion(v, this.d.currentVersion)) {
        throw badRequest(`v${v} is not newer than the running v${this.d.currentVersion}`, 'no_update');
      }
      if (this.latest?.version === v && this.checkedAt && this.d.now() - this.checkedAt < 10 * 60_000) return this.latest;
      if (!this.d.checkEnabled) throw badRequest('Update checks are disabled (UPDATE_CHECK=0)', 'no_update');
      let raw: unknown;
      try {
        raw = await this.gh.get(`/releases/tags/v${v}`);
      } catch (err) {
        throw new AppError(502, 'upstream_error', errorMessage(err));
      }
      const rel = raw ? pickLatestRelease(raw) : null;
      if (!rel) throw badRequest(`No stable release v${v} found`, 'no_update');
      try {
        const { sha, verified } = await resolveTagCommit(this.gh, rel.tag_name);
        return toLatestRelease(rel, sha, verified);
      } catch (err) {
        throw new AppError(502, 'upstream_error', errorMessage(err));
      }
    }
    // Use a recent check; refresh if it is older than 10 minutes.
    if (!this.checkedAt || this.d.now() - this.checkedAt > 10 * 60_000) await this.check(true);
    const latest = this.latest;
    if (!latest || !isNewerVersion(latest.version, this.d.currentVersion)) {
      throw badRequest(
        this.checkError && !latest ? `No update available (${this.checkError})` : 'No update available',
        'no_update',
      );
    }
    return latest;
  }

  /** POST /admin/update/apply. Returns the release being installed. */
  async apply(version?: string): Promise<LatestRelease> {
    await this.assertCanStart();
    const target = await this.resolveTarget(version);
    if (!isFullSha(target.commitSha)) throw badRequest('The release commit could not be resolved', 'no_update');
    await this.launch(['apply', target.tag, target.commitSha], target.version);
    return target;
  }

  /** POST /admin/update/rollback. Returns the version being restored. */
  async rollback(): Promise<PreviousInfo> {
    await this.assertCanStart();
    const prev = await this.readPrevious();
    const commit = await this.readCommit();
    if (!prev || (commit && prev.sha === commit)) throw badRequest('No previous version to roll back to', 'no_rollback');
    await this.launch(['rollback'], prev.version ?? prev.sha.slice(0, 12));
    return prev;
  }

  /**
   * Copy the updater out of the repo (checkout replaces it mid-run), write an
   * initial `running` status (so the UI sees progress immediately) and start it
   * in its own transient systemd unit, outside this service's cgroup.
   */
  private async launch(mode: ['apply', string, string] | ['rollback'], targetVersion: string): Promise<void> {
    this.starting = true;
    try {
      await fsp.mkdir(this.updateDir, { recursive: true });
      const script = this.file('apply-update.sh');
      await fsp.copyFile(path.join(this.d.appRoot, 'lxc', 'apply-update.sh'), script);
      await fsp.chmod(script, 0o755).catch(() => undefined);
      const startedAt = new Date(this.d.now()).toISOString();
      await this.writeStatus({
        state: 'running',
        step: 'starting',
        fromVersion: this.d.currentVersion,
        targetVersion,
        startedAt,
        finishedAt: null,
        message: null,
      });
      const scriptArgs =
        mode[0] === 'apply' ? [mode[1], mode[2], this.d.appRoot, this.d.dataDir] : ['--rollback', this.d.appRoot, this.d.dataDir];
      const env = [
        `UPDATE_REPO=${this.d.repo}`,
        `PORT=${this.d.port}`,
        `PATH=${process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}`,
        `HOME=${process.env.HOME ?? '/root'}`,
      ];
      const r = await this.d.exec(
        'systemd-run',
        [
          `--unit=${UPDATER_UNIT}`,
          '--collect',
          '--no-block',
          '--description=ServCrafty self-update',
          ...env.map((e) => `--setenv=${e}`),
          'bash',
          script,
          ...scriptArgs,
        ],
        { timeoutMs: 20_000 },
      );
      if (r.code !== 0) {
        const why = (r.stderr || r.stdout).trim() || `exit code ${r.code}`;
        if (/already (exists|loaded|active)|unit .* exists/i.test(why)) {
          // An updater unit is still loaded; it owns status.json and will overwrite it.
          throw conflict('An update is already in progress', 'update_in_progress');
        }
        await this.writeStatus({
          state: 'failed',
          step: 'starting',
          fromVersion: this.d.currentVersion,
          targetVersion,
          startedAt,
          finishedAt: new Date(this.d.now()).toISOString(),
          message: `Could not start the updater: ${why}`,
        });
        throw new AppError(500, 'updater_start_failed', `Could not start the updater: ${why}`);
      }
    } finally {
      this.starting = false;
    }
  }

  private async writeStatus(st: UpdateStatus): Promise<void> {
    const tmp = this.file(`status.json.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(st));
    await fsp.rename(tmp, this.file('status.json'));
  }

  /** GET /admin/update/log?offset=N — log bytes from `offset` (restarts at 0 if the log shrank). */
  async readLog(offset: number): Promise<UpdateLogChunk> {
    const state = (await this.readStatus()).state;
    const p = this.file('update.log');
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(p, 'r');
    } catch {
      return { text: '', offset: 0, state };
    }
    try {
      const size = (await fh.stat()).size;
      const start = offset > size ? 0 : Math.max(0, offset);
      const len = Math.min(size - start, MAX_LOG_CHUNK);
      if (len <= 0) return { text: '', offset: start, state };
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      const usable = utf8SafeLength(buf.subarray(0, bytesRead));
      return { text: buf.subarray(0, usable).toString('utf8'), offset: start + usable, state };
    } finally {
      await fh.close();
    }
  }
}

let singleton: UpdateService | undefined;

/** Process-wide updater bound to the real config, fetch, child_process and DB. */
export function updater(): UpdateService {
  if (!singleton) {
    const c = config();
    singleton = new UpdateService({
      repo: c.updateRepo,
      checkEnabled: c.updateCheck,
      token: c.githubToken,
      installTypeEnv: c.installType,
      appRoot: APP_ROOT,
      dataDir: c.dataDir,
      currentVersion: APP_VERSION,
      port: c.port,
      fetch: (input, init) => fetch(input, init),
      exec: defaultExec,
      now: () => Date.now(),
      countRunningServers: async () => {
        const { queryOne } = await import('../db/pool.js');
        const r = await queryOne<{ n: number }>(
          "SELECT count(*)::int AS n FROM servers WHERE status IN ('running','starting','installing')",
        );
        return r?.n ?? 0;
      },
    });
  }
  return singleton;
}
