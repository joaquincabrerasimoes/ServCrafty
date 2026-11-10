import fsp from 'node:fs/promises';
import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { APP_VERSION, config } from '../config.js';
import { query, queryOne } from '../db/pool.js';
import { requireAdmin, requireUser } from '../auth/plugin.js';
import { badRequest } from '../lib/errors.js';
import { formatPortPool, parsePortPool } from '../lib/ports.js';
import { intQuery, parse } from '../lib/validation.js';
import { audit, listAudit } from '../services/audit.js';
import { docker } from '../services/docker.js';
import { getGlobalLimits, hostUsage, setGlobalLimits } from '../services/globalLimits.js';
import { getLanNetworksSpec } from '../services/lanOnly.js';
import { isRemoteRequest, parseNetworks } from '../lib/network.js';
import {
  deleteSetting,
  getCurseforgeKey,
  getDefaultJavaArgs,
  getPortPoolSpec,
  getPublicServersHost,
  normalizeHost,
  getPublicUrl,
  setSetting,
  SettingKeys,
} from '../services/settings.js';

async function settingsPayload() {
  return {
    lanNetworks: await getLanNetworksSpec(),
    globalLimits: await getGlobalLimits(),
    hostUsage: await hostUsage(),
    portPool: await getPortPoolSpec(),
    curseforgeKeySet: !!(await getCurseforgeKey()),
    defaultJavaArgs: await getDefaultJavaArgs(),
    publicUrl: await getPublicUrl(),
    publicServersHost: await getPublicServersHost(),
  };
}

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Readable by any signed-in user: the address players use to reach game servers.
  app.get('/public-config', async (req) => {
    requireUser(req);
    return { publicServersHost: await getPublicServersHost(), installType: process.env.INSTALL_TYPE === 'lxc' ? 'lxc' : 'docker' };
  });

  app.get('/admin/settings', async (req) => {
    requireAdmin(req);
    return settingsPayload();
  });

  app.put('/admin/settings', async (req) => {
    requireAdmin(req);
    const body = parse(
      z
        .object({
          portPool: z.string().min(1).max(2000),
          curseforgeKey: z.string().max(500).nullable(),
          defaultJavaArgs: z.string().max(4096),
          publicUrl: z.string().url().or(z.literal('')),
          lanNetworks: z.string().max(1000),
          publicServersHost: z.string().max(255),
          globalLimits: z.object({
            maxServers: z.number().int().min(1).nullable(),
            maxRamMb: z.number().int().min(256).nullable(),
            maxCpu: z.number().min(0.1).nullable(),
            maxDiskMb: z.number().int().min(1).nullable(),
          }),
        })
        .partial(),
      req.body,
    );
    const changed: string[] = [];
    if (body.portPool !== undefined) {
      const ports = parsePortPool(body.portPool);
      if (!ports.length) throw badRequest('Port pool cannot be empty', 'invalid_port_pool');
      const outside = await query<{ port: number; name: string }>('SELECT port, name FROM servers WHERE NOT (port = ANY($1::int[]))', [
        ports,
      ]);
      if (outside.length) {
        throw badRequest(
          `Ports in use would fall outside the pool: ${outside.map((o) => `${o.port} (${o.name})`).join(', ')}`,
          'ports_in_use',
        );
      }
      await setSetting(SettingKeys.portPool, formatPortPool(ports));
      changed.push('portPool');
    }
    if (body.curseforgeKey !== undefined) {
      if (body.curseforgeKey) await setSetting(SettingKeys.curseforgeKey, body.curseforgeKey.trim(), true);
      else await deleteSetting(SettingKeys.curseforgeKey);
      changed.push('curseforgeKey');
    }
    if (body.defaultJavaArgs !== undefined) {
      await setSetting(SettingKeys.defaultJavaArgs, body.defaultJavaArgs);
      changed.push('defaultJavaArgs');
    }
    if (body.publicUrl !== undefined) {
      if (body.publicUrl) await setSetting(SettingKeys.publicUrl, body.publicUrl.replace(/\/+$/, ''));
      else await deleteSetting(SettingKeys.publicUrl);
      changed.push('publicUrl');
    }
    if (body.publicServersHost !== undefined) {
      const host = normalizeHost(body.publicServersHost);
      if (host && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$|^[0-9a-f:]+$/i.test(host)) {
        throw badRequest('Enter a host name or IP address, like play.example.com', 'invalid_public_servers_host');
      }
      if (host) await setSetting(SettingKeys.publicServersHost, host);
      else await deleteSetting(SettingKeys.publicServersHost);
      changed.push('publicServersHost');
    }
    if (body.lanNetworks !== undefined) {
      const spec = body.lanNetworks.trim();
      const nets = parseNetworks(spec);
      // Refuse a range this very request is not inside: it would lock out the admin saving it.
      if (nets.length && isRemoteRequest(req, nets)) {
        throw badRequest('Save this from a device inside the range (not through the tunnel), or you would lock yourself out', 'lan_networks_lockout');
      }
      if (spec) await setSetting(SettingKeys.lanNetworks, spec);
      else await deleteSetting(SettingKeys.lanNetworks);
      changed.push('lanNetworks');
    }
    if (body.globalLimits !== undefined) {
      // Existing servers are left alone if a cap is set below what they already use; it only blocks new growth.
      await setGlobalLimits(body.globalLimits);
      changed.push('globalLimits');
    }
    await audit(req, 'admin.settings_updated', 'settings', null, { changed });
    return settingsPayload();
  });

  app.get('/admin/ports', async (req) => {
    requireAdmin(req);
    const pool = parsePortPool(await getPortPoolSpec());
    const used = await query<{ port: number; id: string; name: string }>('SELECT port, id, name FROM servers');
    const byPort = new Map(used.map((u) => [u.port, u]));
    const rows = pool.map((port) => ({ port, serverId: byPort.get(port)?.id ?? null, serverName: byPort.get(port)?.name ?? null }));
    // Ports assigned outside the current pool (should not happen, but show them).
    for (const u of used) if (!pool.includes(u.port)) rows.push({ port: u.port, serverId: u.id, serverName: u.name });
    return rows.sort((a, b) => a.port - b.port);
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/admin/audit', async (req) => {
    requireAdmin(req);
    return listAudit({
      limit: intQuery(req.query.limit, 50, 1, 500),
      offset: intQuery(req.query.offset, 0, 0, 10_000_000),
      user: req.query.user || undefined,
      action: req.query.action || undefined,
    });
  });

  app.get('/admin/system', async (req) => {
    requireAdmin(req);
    const c = config();
    let dockerInfo: Record<string, unknown> | null = null;
    let dockerError: string | null = null;
    try {
      const [info, version] = await Promise.all([docker().info(), docker().version()]);
      const i = info as Record<string, unknown>;
      dockerInfo = {
        version: version.Version,
        apiVersion: version.ApiVersion,
        os: i.OperatingSystem,
        kernel: i.KernelVersion,
        cpus: i.NCPU,
        memoryBytes: i.MemTotal,
        containers: i.Containers,
        containersRunning: i.ContainersRunning,
        images: i.Images,
        storageDriver: i.Driver,
      };
    } catch (err) {
      dockerError = (err as Error).message;
    }
    let disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null = null;
    try {
      await fsp.mkdir(c.dataDir, { recursive: true });
      const s = await fsp.statfs(c.dataDir);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      disk = { totalBytes: total, freeBytes: free, usedBytes: total - free };
    } catch {
      /* unsupported */
    }
    const pg = await queryOne<{ version: string }>('SELECT version()');
    const counts = await queryOne<{ users: number; servers: number; running: number }>(
      `SELECT (SELECT count(*)::int FROM users) AS users, (SELECT count(*)::int FROM servers) AS servers,
              (SELECT count(*)::int FROM servers WHERE status IN ('running','starting','installing')) AS running`,
    );
    return {
      app: { version: APP_VERSION, node: process.version, uptimeSec: Math.floor(process.uptime()), env: c.nodeEnv },
      host: {
        platform: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        cpus: os.cpus().length,
        loadavg: os.loadavg(),
        memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
        processRssBytes: process.memoryUsage().rss,
      },
      docker: dockerInfo,
      dockerError,
      disk,
      dataDir: c.dataDir,
      database: { version: pg?.version ?? null },
      counts,
    };
  });
}
