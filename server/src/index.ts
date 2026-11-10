import fsp from 'node:fs/promises';
import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { closeDb } from './db/pool.js';
import { ensureGracefulUnit } from './lib/gracefulUnit.js';
import { purgeExpiredSessions } from './auth/sessions.js';
import { loadGameDefinitions } from './services/gameDefinitions.js';
import { loadDisabledGames } from './services/gameAccess.js';
import { initLanAnnouncer, stopLanAnnouncer } from './services/lanAnnouncer.js';
import { initRuntime, shutdownRuntime } from './services/runtime.js';
import { initScheduler, stopScheduler } from './services/scheduler.js';
import { seedSettings } from './services/settings.js';
import { ensureAdmin } from './services/users.js';
import { initWebhooks } from './services/webhooks.js';

async function main(): Promise<void> {
  const c = config();
  for (const d of [c.dataDir, c.serversDir, c.backupsDir, c.tmpDir]) await fsp.mkdir(d, { recursive: true });

  const app = await buildApp();
  const log = app.log;

  const applied = await migrate((m) => log.info(m));
  if (applied.length) log.info(`applied migrations: ${applied.join(', ')}`);
  await seedSettings();
  await ensureAdmin((m) => log.info(m));

  // Definitions first: the runtime needs them to re-attach to running SteamCMD servers.
  await loadGameDefinitions(log);
  // Disabled games (v0.3.2): the server JSON reads a synchronous snapshot.
  await loadDisabledGames();
  initWebhooks(log);
  await initRuntime(log);
  await initScheduler(log);
  initLanAnnouncer(log);

  const purge = setInterval(() => void purgeExpiredSessions().catch(() => undefined), 3600_000);
  purge.unref();
  // Clean stale temp uploads from a previous run.
  for (const f of await fsp.readdir(c.tmpDir).catch(() => [] as string[])) {
    await fsp.rm(`${c.tmpDir}/${f}`, { recursive: true, force: true }).catch(() => undefined);
  }

  await app.listen({ port: c.port, host: c.host });

  // LXC installs: make sure the container's shutdown stops game servers gracefully (see lib/gracefulUnit.ts).
  if (process.env.INSTALL_TYPE === 'lxc') {
    ensureGracefulUnit().then(
      (changed) => changed && log.info('installed servcrafty-graceful.service'),
      (err: unknown) => log.warn({ err: err instanceof Error ? err.message : String(err) }, 'could not install servcrafty-graceful.service'),
    );
  }

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received, shutting down (game servers keep running)`);
    stopScheduler();
    stopLanAnnouncer();
    await shutdownRuntime();
    await app.close().catch(() => undefined);
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  console.error('[servcrafty] unhandled rejection', err);
});

main().catch((err: unknown) => {
  console.error('[servcrafty] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
