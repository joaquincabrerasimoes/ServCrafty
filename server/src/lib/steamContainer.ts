import type Docker from 'dockerode';
import type { ResolvedPort } from './steamPlan.js';

/** Where the plan is mounted inside the steamcmd container. */
export const PLAN_CONTAINER_PATH = '/servcrafty/plan.json';
export const STEAM_GAME_LABEL = 'servcrafty.game';

export interface SteamContainerInput {
  memoryMb: number;
  cpu: number;
  image: string;
  ports: ResolvedPort[];
  /** Attach a TTY + keep stdin open (definition `console.stdin`). */
  stdin: boolean;
}

export interface SteamSpecContext {
  name: string;
  /** Server data dir as seen by the docker daemon (mounted at /data). */
  hostDir: string;
  /** Plan file as seen by the docker daemon (mounted read-only). */
  hostPlanFile: string;
  network: string;
  labels: Record<string, string>;
}

/** Docker port keys (`7777/udp`) a resolved port occupies. */
export function portKeys(p: Pick<ResolvedPort, 'containerPort' | 'protocol'>): string[] {
  return (p.protocol === 'both' ? ['tcp', 'udp'] : [p.protocol]).map((proto) => `${p.containerPort}/${proto}`);
}

/**
 * Pure: `createContainer` options for a SteamCMD server. The image is a dumb executor; everything it
 * runs comes from the plan file. No user value is ever placed in Env/Cmd here.
 */
export function steamContainerSpec(server: SteamContainerInput, ctx: SteamSpecContext): Docker.ContainerCreateOptions {
  const exposed: Record<string, object> = {};
  const bindings: Record<string, { HostPort: string }[]> = {};
  for (const p of server.ports) {
    for (const k of portKeys(p)) {
      exposed[k] = {};
      if (p.hostPort !== null) bindings[k] = [{ HostPort: String(p.hostPort) }];
    }
  }
  const memory = server.memoryMb * 1024 * 1024;
  return {
    name: ctx.name,
    Image: server.image,
    Env: [`SERVCRAFTY_PLAN=${PLAN_CONTAINER_PATH}`],
    Labels: { ...ctx.labels, [STEAM_GAME_LABEL]: 'steam' },
    ExposedPorts: exposed,
    Tty: server.stdin,
    OpenStdin: server.stdin,
    StdinOnce: false,
    AttachStdin: false,
    HostConfig: {
      Binds: [`${ctx.hostDir}:/data`, `${ctx.hostPlanFile}:${PLAN_CONTAINER_PATH}:ro`],
      PortBindings: bindings,
      Memory: memory,
      MemorySwap: memory,
      NanoCpus: Math.round(server.cpu * 1e9),
      NetworkMode: ctx.network,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
    },
  };
}
