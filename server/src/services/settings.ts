import { config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { parsePortPool } from '../lib/ports.js';

/** Known setting keys. */
export const SettingKeys = {
  portPool: 'port_pool',
  curseforgeKey: 'curseforge_key',
  defaultJavaArgs: 'default_java_args',
  publicUrl: 'public_url',
} as const;

const cache = new Map<string, unknown>();

export async function getSetting<T>(key: string): Promise<T | undefined> {
  if (cache.has(key)) return cache.get(key) as T;
  const row = await queryOne<{ value: unknown; encrypted: boolean }>(
    'SELECT value, encrypted FROM settings WHERE key = $1',
    [key],
  );
  if (!row) return undefined;
  let v: unknown = row.value;
  if (row.encrypted && typeof v === 'string') {
    try {
      v = decrypt(v);
    } catch {
      v = undefined; // SECRET_KEY changed: treat as unset
    }
  }
  cache.set(key, v);
  return v as T;
}

export async function setSetting(key: string, value: unknown, encrypted = false): Promise<void> {
  const stored = encrypted ? encrypt(String(value)) : value;
  await query(
    `INSERT INTO settings (key, value, encrypted) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted`,
    [key, JSON.stringify(stored), encrypted],
  );
  cache.set(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  await query('DELETE FROM settings WHERE key = $1', [key]);
  cache.delete(key);
}

/** Seed defaults from env on boot (never overrides existing values). */
export async function seedSettings(): Promise<void> {
  const c = config();
  if ((await getSetting<string>(SettingKeys.portPool)) === undefined) {
    parsePortPool(c.portPoolDefault);
    await setSetting(SettingKeys.portPool, c.portPoolDefault);
  }
  if (c.curseforgeApiKey && (await getSetting<string>(SettingKeys.curseforgeKey)) === undefined) {
    await setSetting(SettingKeys.curseforgeKey, c.curseforgeApiKey, true);
  }
}

export async function getPortPoolSpec(): Promise<string> {
  return (await getSetting<string>(SettingKeys.portPool)) ?? config().portPoolDefault;
}

export async function getCurseforgeKey(): Promise<string | undefined> {
  const v = await getSetting<string>(SettingKeys.curseforgeKey);
  return v || config().curseforgeApiKey || undefined;
}

export async function getDefaultJavaArgs(): Promise<string> {
  return (await getSetting<string>(SettingKeys.defaultJavaArgs)) ?? '';
}

/** Effective public URL (admin setting overrides PUBLIC_URL). */
export async function getPublicUrl(): Promise<string> {
  const v = await getSetting<string>(SettingKeys.publicUrl);
  return (v || config().publicUrl).replace(/\/+$/, '');
}
