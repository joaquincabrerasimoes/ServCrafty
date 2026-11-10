import type Docker from 'dockerode';
import { terrariaImage, TERRARIA_VARIANTS, type TerrariaType } from './games.js';
import { normalizeTerrariaConfig, protectedTerrariaEnv, terrariaLaunch, type TerrariaConfig } from './terrariaConfig.js';

/** The subset of a server row the Terraria container spec depends on. */
export interface TerrariaServerInput {
  id: string;
  type: TerrariaType;
  port: number;
  memory_mb: number;
  cpu: number;
  env: Record<string, string> | null;
  terraria: TerrariaConfig | null;
}

export interface TerrariaSpecContext {
  /** Container name. */
  name: string;
  /** Server data dir as seen by the docker daemon (bind mount source). */
  hostDir: string;
  network: string;
  labels: Record<string, string>;
  /** Per-server env key that forces the image tag (not passed to the container). */
  imageTagEnv: string;
}

/**
 * Pure: the `createContainer` options for a Terraria server. Values only ever travel as separate
 * env entries / command array elements (no shell), already validated by the config schema.
 */
export function terrariaContainerSpec(server: TerrariaServerInput, ctx: TerrariaSpecContext): Docker.ContainerCreateOptions {
  const v = TERRARIA_VARIANTS[server.type];
  // Re-validate stored config (defaults for null) so nothing unchecked reaches the container.
  const cfg = normalizeTerrariaConfig(server.type, server.terraria ?? {});
  const { env, cmd } = terrariaLaunch(server.type, cfg);
  const protectedKeys = protectedTerrariaEnv(server.type);
  const finalEnv: Record<string, string> = { ...env };
  for (const [k, val] of Object.entries(server.env ?? {})) {
    if (k === ctx.imageTagEnv || protectedKeys.has(k)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(String(val))) continue; // a line break could add config lines
    finalEnv[k] = String(val);
  }
  const gamePort = `${v.containerPort}/${v.protocol}`;
  const memory = server.memory_mb * 1024 * 1024;
  const opts: Docker.ContainerCreateOptions = {
    name: ctx.name,
    Image: terrariaImage(server.type, server.env?.[ctx.imageTagEnv]),
    Env: Object.entries(finalEnv).map(([k, val]) => `${k}=${val}`),
    Labels: { ...ctx.labels },
    ExposedPorts: { [gamePort]: {} },
    Tty: v.tty,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: false,
    HostConfig: {
      Binds: v.mounts.map((m) => `${m.hostRel ? `${ctx.hostDir}/${m.hostRel}` : ctx.hostDir}:${m.container}`),
      PortBindings: { [gamePort]: [{ HostPort: String(server.port) }] },
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(server.cpu * 1e9),
      NetworkMode: ctx.network,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
    },
  };
  if (cmd) opts.Cmd = cmd;
  return opts;
}
