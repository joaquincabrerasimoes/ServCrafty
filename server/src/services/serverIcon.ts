import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { SERVER_ICON_FILE } from '../lib/serverIcon.js';
import { gameOf } from '../lib/games.js';

const iconPath = (serverId: string) => path.join(config().serversDir, serverId, SERVER_ICON_FILE);

/** Java Edition only: Bedrock, Terraria and Steam games have no multiplayer-list icon. */
export const supportsIcon = (type: string) => gameOf(type) === 'minecraft' && type !== 'BEDROCK';

/** Modification time (ms) of the server's icon, or null when it has none. Used as the cache-busting version. */
export function iconVersion(serverId: string, type: string): number | null {
  if (!supportsIcon(type)) return null;
  try {
    const st = fs.statSync(iconPath(serverId));
    return st.isFile() ? Math.floor(st.mtimeMs) : null;
  } catch {
    return null;
  }
}

export const readIcon = (serverId: string) => fsp.readFile(iconPath(serverId)).catch(() => null);

export async function writeIcon(serverId: string, png: Buffer): Promise<void> {
  const file = iconPath(serverId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  // World-readable: the game process may run as another user than the panel.
  await fsp.writeFile(tmp, png, { mode: 0o644 });
  await fsp.chmod(tmp, 0o644).catch(() => undefined);
  await fsp.rename(tmp, file);
}

export const deleteIcon = (serverId: string) => fsp.rm(iconPath(serverId), { force: true });
