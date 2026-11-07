import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { readJson, writeJsonAtomic } from '../lib/fsutil.js';
import { fetchJson } from '../lib/http.js';
import { parseProperties } from '../lib/properties.js';
import { serverDir } from './docker.js';
import * as runtime from './runtime.js';
import type { ServerRow } from './types.js';

export const playerActions = ['op', 'deop', 'kick', 'ban', 'pardon', 'whitelist-add', 'whitelist-remove'] as const;
export type PlayerAction = (typeof playerActions)[number];
export const listKinds = ['whitelist', 'ops', 'banned'] as const;
export type ListKind = (typeof listKinds)[number];

const JAVA_NAME = /^[A-Za-z0-9_]{1,16}$/;
const BEDROCK_NAME = /^[A-Za-z0-9_ ]{1,32}$/;

export function validatePlayerName(server: ServerRow, name: string): string {
  const ok = server.type === 'BEDROCK' ? BEDROCK_NAME.test(name) : JAVA_NAME.test(name);
  if (!ok) throw badRequest('Invalid player name', 'invalid_player_name');
  return name;
}

function sanitizeReason(r?: string): string {
  return (r ?? '').replace(/[\r\n]/g, ' ').slice(0, 200).trim();
}

function commandFor(server: ServerRow, action: PlayerAction, name: string, reason: string): string {
  const quoted = server.type === 'BEDROCK' && name.includes(' ') ? `"${name}"` : name;
  const bedrock = server.type === 'BEDROCK';
  switch (action) {
    case 'op':
      return `op ${quoted}`;
    case 'deop':
      return `deop ${quoted}`;
    case 'kick':
      return `kick ${quoted}${reason ? ` ${reason}` : ''}`;
    case 'ban':
      if (bedrock) throw badRequest('Bedrock dedicated servers do not support bans', 'unsupported');
      return `ban ${name}${reason ? ` ${reason}` : ''}`;
    case 'pardon':
      if (bedrock) throw badRequest('Bedrock dedicated servers do not support bans', 'unsupported');
      return `pardon ${name}`;
    case 'whitelist-add':
      return bedrock ? `allowlist add ${quoted}` : `whitelist add ${name}`;
    case 'whitelist-remove':
      return bedrock ? `allowlist remove ${quoted}` : `whitelist remove ${name}`;
  }
}

function dashed(hex: string): string {
  const h = hex.replace(/-/g, '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID v3 as computed by the vanilla server in offline mode. */
function offlineUuid(name: string): string {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  md5[6] = (md5[6]! & 0x0f) | 0x30;
  md5[8] = (md5[8]! & 0x3f) | 0x80;
  return dashed(md5.toString('hex'));
}

async function resolveProfile(server: ServerRow, name: string): Promise<{ uuid: string; name: string }> {
  let props: Record<string, string> = {};
  try {
    props = parseProperties(await fsp.readFile(path.join(serverDir(server.id), 'server.properties'), 'utf8'));
  } catch {
    /* no properties yet: assume online mode */
  }
  if (props['online-mode'] === 'false') return { uuid: offlineUuid(name), name };
  try {
    const p = await fetchJson<{ id: string; name: string }>(
      `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
    );
    return { uuid: dashed(p.id), name: p.name };
  } catch {
    throw notFound(`Unknown Minecraft account "${name}"`, 'unknown_player');
  }
}

function mcDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

interface NamedEntry {
  uuid?: string;
  name?: string;
  [k: string]: unknown;
}

async function editList(
  server: ServerRow,
  file: string,
  fn: (list: NamedEntry[]) => NamedEntry[],
): Promise<void> {
  const p = path.join(serverDir(server.id), file);
  const list = await readJson<NamedEntry[]>(p, []);
  await writeJsonAtomic(p, fn(Array.isArray(list) ? list : []));
}

const sameName = (a: NamedEntry, name: string) => (a.name ?? '').toLowerCase() === name.toLowerCase();

/** Apply an action while the server is stopped by editing the JSON list files directly. */
async function offlineAction(server: ServerRow, action: PlayerAction, name: string, reason: string): Promise<void> {
  if (action === 'kick') throw conflict('Server is not running', 'not_running');
  if (server.type === 'BEDROCK') {
    if (action === 'whitelist-add')
      return editList(server, 'allowlist.json', (l) =>
        l.some((e) => sameName(e, name)) ? l : [...l, { name, ignoresPlayerLimit: false }],
      );
    if (action === 'whitelist-remove') return editList(server, 'allowlist.json', (l) => l.filter((e) => !sameName(e, name)));
    throw conflict('This action requires the Bedrock server to be running', 'not_running');
  }
  const remove = (file: string) => editList(server, file, (l) => l.filter((e) => !sameName(e, name)));
  if (action === 'deop') return remove('ops.json');
  if (action === 'whitelist-remove') return remove('whitelist.json');
  if (action === 'pardon') return remove('banned-players.json');
  const profile = await resolveProfile(server, name);
  const upsert = (file: string, entry: NamedEntry) =>
    editList(server, file, (l) => [...l.filter((e) => e.uuid !== profile.uuid && !sameName(e, profile.name)), entry]);
  if (action === 'op') return upsert('ops.json', { ...profile, level: 4, bypassesPlayerLimit: false });
  if (action === 'whitelist-add') return upsert('whitelist.json', profile);
  if (action === 'ban')
    return upsert('banned-players.json', {
      ...profile,
      created: mcDate(),
      source: 'ServCrafty',
      expires: 'forever',
      reason: reason || 'Banned by an operator.',
    });
}

export async function playerAction(
  server: ServerRow,
  action: PlayerAction,
  name: string,
  reason?: string,
): Promise<{ applied: 'live' | 'file'; output: string }> {
  validatePlayerName(server, name);
  const r = sanitizeReason(reason);
  if (runtime.getStatus(server.id) === 'running') {
    const output = await runtime.sendCommand(server.id, commandFor(server, action, name, r));
    return { applied: 'live', output };
  }
  await offlineAction(server, action, name, r);
  return { applied: 'file', output: '' };
}

export async function readList(server: ServerRow, kind: ListKind): Promise<unknown[]> {
  const dir = serverDir(server.id);
  if (server.type === 'BEDROCK') {
    if (kind === 'whitelist') return readJson<unknown[]>(path.join(dir, 'allowlist.json'), []);
    if (kind === 'ops') return readJson<unknown[]>(path.join(dir, 'permissions.json'), []);
    return [];
  }
  const file = kind === 'whitelist' ? 'whitelist.json' : kind === 'ops' ? 'ops.json' : 'banned-players.json';
  return readJson<unknown[]>(path.join(dir, file), []);
}
