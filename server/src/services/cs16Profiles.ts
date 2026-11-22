import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { conflict, notFound } from '../lib/errors.js';
import {
  assertProfileContent,
  assertProfileName,
  emptyProfiles,
  parseProfile,
  PROFILES_MAX,
  type ProfileRecord,
  type ProfilesState,
} from '../lib/cs16/profiles.js';
import { cs16Def } from './cs16.js';
import { serverDir } from './docker.js';
import { bus } from './events.js';
import * as runtime from './runtime.js';
import { getServerRow } from './servers.js';
import type { ServerRow } from './types.js';

/**
 * Config profiles of Counter-Strike 1.6 servers (see `lib/cs16/profiles.ts`). They live in `servcrafty-profiles.json`
 * in the server's folder. A profile is applied by sending its commands to the game console one after the other; the
 * default profile is applied automatically after the first map of every server start (and, if asked, after each map change).
 */

const stateFile = (id: string) => path.join(serverDir(id), 'servcrafty-profiles.json');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function load(id: string): Promise<ProfilesState> {
  try {
    const j = JSON.parse(await fsp.readFile(stateFile(id), 'utf8')) as ProfilesState;
    if (j && j.schema === 1 && Array.isArray(j.profiles)) {
      return { schema: 1, profiles: j.profiles, defaultId: typeof j.defaultId === 'string' ? j.defaultId : null, applyOnMapChange: j.applyOnMapChange === true };
    }
  } catch {
    /* none yet */
  }
  return emptyProfiles();
}

async function save(id: string, state: ProfilesState): Promise<void> {
  const file = stateFile(id);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await fsp.rename(tmp, file);
}

/** Changes to one server's profiles run one after the other. */
const queues = new Map<string, Promise<unknown>>();
function mutate<T>(id: string, fn: (state: ProfilesState) => T | Promise<T>): Promise<T> {
  const next = (queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const state = await load(id);
    const result = await fn(state);
    await save(id, state);
    return result;
  });
  queues.set(id, next.catch(() => undefined));
  return next;
}

const detail = (p: ProfileRecord, state: ProfilesState) => ({
  id: p.id,
  name: p.name,
  content: p.content,
  commands: parseProfile(p.content).commands.length,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
  isDefault: state.defaultId === p.id,
});

const find = (state: ProfilesState, profileId: string): ProfileRecord => {
  const p = state.profiles.find((x) => x.id === profileId);
  if (!p) throw notFound('That profile does not exist');
  return p;
};

const nameTaken = (state: ProfilesState, name: string, exceptId?: string) => state.profiles.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());

/** The list the Controls users see: no command text (a profile may hold passwords). */
export async function listProfiles(server: ServerRow) {
  cs16Def(server);
  const state = await load(server.id);
  return {
    profiles: state.profiles.map((p) => ({ id: p.id, name: p.name, commands: parseProfile(p.content).commands.length, updatedAt: p.updatedAt, isDefault: state.defaultId === p.id })),
    defaultId: state.defaultId,
    applyOnMapChange: state.applyOnMapChange,
  };
}

export async function getProfile(server: ServerRow, profileId: string) {
  cs16Def(server);
  const state = await load(server.id);
  return detail(find(state, profileId), state);
}

export async function createProfile(server: ServerRow, input: { name: unknown; content: unknown }) {
  cs16Def(server);
  const name = assertProfileName(input.name);
  const content = assertProfileContent(input.content);
  return mutate(server.id, (state) => {
    if (state.profiles.length >= PROFILES_MAX) throw conflict(`A server can have at most ${PROFILES_MAX} profiles`, 'too_many_profiles');
    if (nameTaken(state, name)) throw conflict('There is already a profile with that name', 'profile_name_taken');
    const now = new Date().toISOString();
    const p: ProfileRecord = { id: crypto.randomBytes(5).toString('hex'), name, content, createdAt: now, updatedAt: now };
    state.profiles.push(p);
    return detail(p, state);
  });
}

export async function updateProfile(server: ServerRow, profileId: string, input: { name?: unknown; content?: unknown }) {
  cs16Def(server);
  const name = input.name === undefined ? undefined : assertProfileName(input.name);
  const content = input.content === undefined ? undefined : assertProfileContent(input.content);
  return mutate(server.id, (state) => {
    const p = find(state, profileId);
    if (name !== undefined) {
      if (nameTaken(state, name, p.id)) throw conflict('There is already a profile with that name', 'profile_name_taken');
      p.name = name;
    }
    if (content !== undefined) p.content = content;
    p.updatedAt = new Date().toISOString();
    return detail(p, state);
  });
}

export async function deleteProfile(server: ServerRow, profileId: string) {
  cs16Def(server);
  await mutate(server.id, (state) => {
    find(state, profileId);
    state.profiles = state.profiles.filter((p) => p.id !== profileId);
    if (state.defaultId === profileId) state.defaultId = null;
  });
}

export async function setDefaultProfile(server: ServerRow, input: { profileId: string | null; applyOnMapChange?: boolean }) {
  cs16Def(server);
  return mutate(server.id, (state) => {
    if (input.profileId !== null) find(state, input.profileId);
    state.defaultId = input.profileId;
    if (input.applyOnMapChange !== undefined) state.applyOnMapChange = input.applyOnMapChange;
    return { defaultId: state.defaultId, applyOnMapChange: state.applyOnMapChange };
  });
}

// ---------------------------------------------------------------------------------------------
// Running a profile

const applying = new Set<string>();
/** Pause between two commands, so the game is not flooded and each one is processed before the next arrives. */
const COMMAND_GAP_MS = 40;

const consoleReady = (id: string) => ['running', 'starting'].includes(runtime.getStatus(id));

/** Send the commands of a profile to the console, in order, one after the other. */
export async function runProfile(server: ServerRow, profileId: string) {
  cs16Def(server);
  if (!consoleReady(server.id)) throw conflict('The server is not running', 'not_running');
  const state = await load(server.id);
  const profile = find(state, profileId);
  if (applying.has(server.id)) throw conflict('A profile is already being applied to this server', 'profile_busy');
  applying.add(server.id);
  try {
    const { commands, skipped } = parseProfile(profile.content);
    runtime.systemLog(server.id, `[servcrafty] Applying profile "${profile.name}" (${commands.length} commands)`);
    let sent = 0;
    for (const cmd of commands) {
      await runtime.sendCommand(server.id, cmd);
      sent++;
      await sleep(COMMAND_GAP_MS);
    }
    return { sent, skipped };
  } finally {
    applying.delete(server.id);
  }
}

// ---------------------------------------------------------------------------------------------
// Automatic application of the default profile

/** Servers whose first map since they started has been seen. */
const bootHandled = new Set<string>();
const lastApplied = new Map<string, number>();
/** Wait after the map starts: the game runs `server.cfg` around then, and the profile must come after it. */
const SETTLE_MS = 2000;

async function onMapStarted(serverId: string): Promise<void> {
  // Only Counter-Strike 1.6 servers that have profiles have this file.
  if (!(await fsp.access(stateFile(serverId)).then(() => true, () => false))) return;
  const first = !bootHandled.has(serverId);
  bootHandled.add(serverId);
  const state = await load(serverId);
  if (!state.defaultId || (!first && !state.applyOnMapChange)) return;
  if (Date.now() - (lastApplied.get(serverId) ?? 0) < 5000) return;
  lastApplied.set(serverId, Date.now());
  const server = await getServerRow(serverId);
  if (!server) return;
  await sleep(SETTLE_MS);
  try {
    await runProfile(server, state.defaultId);
  } catch (err) {
    runtime.systemLog(serverId, `[servcrafty] The default profile could not be applied: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Listen to the server logs: the first `Started map` after a start (and later ones when asked) applies the default profile. */
export function startProfileAutoApply(): void {
  bus.on('status', (id, status) => {
    if (status !== 'running') bootHandled.delete(id);
  });
  bus.on('log', (id, line) => {
    if (!line.includes('Started map "')) return;
    void onMapStarted(id).catch(() => undefined);
  });
}
