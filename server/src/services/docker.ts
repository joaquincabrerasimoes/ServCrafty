import Docker from 'dockerode';
import path from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { config } from '../config.js';
import { unavailable } from '../lib/errors.js';
import type { ServerRow } from './types.js';
import { getDefaultJavaArgs } from './settings.js';

export const LABEL_SERVER = 'servcrafty.server';
export const JAVA_IMAGE = 'itzg/minecraft-server';
export const BEDROCK_IMAGE = 'itzg/minecraft-bedrock-server';
export const RCON_PORT = 25575;

/** Env keys controlled by ServCrafty that users may not override. */
const PROTECTED_ENV = new Set(['EULA', 'ENABLE_RCON', 'RCON_PASSWORD', 'RCON_PORT', 'SERVER_PORT', 'TYPE']);
/** ServCrafty-only env key to force an image tag (e.g. "java17"). Not passed to the container. */
export const IMAGE_TAG_ENV = 'SERVCRAFTY_IMAGE_TAG';

function parseDockerHost(spec: string): Docker.DockerOptions {
  if (spec.startsWith('unix://')) return { socketPath: spec.slice('unix://'.length) };
  if (spec.startsWith('npipe://')) return { socketPath: spec.slice('npipe://'.length).replace(/\//g, '\\') };
  if (spec.startsWith('tcp://') || spec.startsWith('http://') || spec.startsWith('https://')) {
    const u = new URL(spec.replace(/^tcp:/, 'http:'));
    return {
      host: u.hostname,
      port: Number(u.port || (u.protocol === 'https:' ? 2376 : 2375)),
      protocol: u.protocol === 'https:' ? 'https' : 'http',
    };
  }
  return { socketPath: spec };
}

let client: Docker | undefined;
export function docker(): Docker {
  if (!client) client = new Docker(parseDockerHost(config().dockerHost));
  return client;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker().ping();
    return true;
  } catch {
    return false;
  }
}

export async function ensureNetwork(): Promise<void> {
  const name = config().dockerNetwork;
  const nets = await docker().listNetworks({ filters: JSON.stringify({ name: [name] }) });
  if (nets.some((n) => n.Name === name)) return;
  await docker().createNetwork({ Name: name, Driver: 'bridge', Labels: { 'servcrafty.managed': 'true' } });
}

export const containerName = (serverId: string) => `servcrafty-${serverId}`;

/** Server data dir as seen by ServCrafty. */
export const serverDir = (serverId: string) => path.join(config().serversDir, serverId);
/** Server data dir as seen by the docker daemon (bind mount source). */
export const hostServerDir = (serverId: string) => `${config().hostDataDir}/servers/${serverId}`;

function versionTuple(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Pick the itzg java image tag compatible with a Minecraft version. */
export function javaImageTag(mcVersion: string): string {
  const t = versionTuple(mcVersion);
  if (!t) return 'latest';
  const [maj, min, patch] = t as [number, number, number];
  if (maj > 1) return 'latest'; // year-based versions (26.x+)
  if (min <= 16) return 'java8';
  if (min <= 19 || (min === 20 && patch <= 4)) return 'java17';
  return 'latest';
}

export function imageFor(server: ServerRow): string {
  if (server.type === 'BEDROCK') return `${BEDROCK_IMAGE}:latest`;
  const forced = server.env?.[IMAGE_TAG_ENV];
  return `${JAVA_IMAGE}:${forced || javaImageTag(server.mc_version)}`;
}

export async function buildEnv(server: ServerRow, cfKey: string | undefined): Promise<string[]> {
  const env: Record<string, string> = { EULA: 'TRUE' };
  if (server.type === 'BEDROCK') {
    env.VERSION = server.mc_version || 'LATEST';
    env.SERVER_PORT = '19132';
  } else {
    env.SERVER_PORT = '25565';
    env.ENABLE_RCON = 'true';
    env.RCON_PASSWORD = server.rcon_password;
    env.RCON_PORT = String(RCON_PORT);
    env.MEMORY = `${server.memory_mb}M`;
    const javaArgs = server.java_args ?? (await getDefaultJavaArgs());
    if (javaArgs) env.JVM_OPTS = javaArgs;
    const lv = server.loader_version ?? undefined;
    switch (server.type) {
      case 'CURSEFORGE': {
        env.TYPE = 'AUTO_CURSEFORGE';
        if (cfKey) env.CF_API_KEY = cfKey;
        const mp = server.modpack;
        if (mp?.localFile) env.CF_MODPACK_ZIP = `/data/${mp.localFile}`;
        if (mp?.slug) env.CF_SLUG = mp.slug;
        if (mp?.fileId) env.CF_FILE_ID = String(mp.fileId);
        break;
      }
      case 'MODRINTH': {
        env.TYPE = 'MODRINTH';
        const mp = server.modpack;
        if (mp?.localFile) env.MODRINTH_MODPACK = `/data/${mp.localFile}`;
        else if (mp?.slug || mp?.projectId) env.MODRINTH_MODPACK = String(mp.slug ?? mp.projectId);
        if (mp?.versionId && !mp.localFile) env.MODRINTH_VERSION = mp.versionId;
        break;
      }
      default:
        env.TYPE = server.type;
        env.VERSION = server.mc_version || 'LATEST';
    }
    if (lv) {
      const map: Partial<Record<ServerRow['type'], string>> = {
        FABRIC: 'FABRIC_LOADER_VERSION',
        QUILT: 'QUILT_LOADER_VERSION',
        FORGE: 'FORGE_VERSION',
        NEOFORGE: 'NEOFORGE_VERSION',
        PAPER: 'PAPER_BUILD',
        PURPUR: 'PURPUR_BUILD',
        FOLIA: 'FOLIA_BUILD',
      };
      const k = map[server.type];
      if (k) env[k] = lv;
    }
    if (cfKey && !env.CF_API_KEY) env.CF_API_KEY = cfKey; // lets CURSEFORGE_FILES etc. work
  }
  for (const [k, v] of Object.entries(server.env ?? {})) {
    if (PROTECTED_ENV.has(k) || k === IMAGE_TAG_ENV) continue;
    env[k] = String(v);
  }
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

/**
 * Docker memory limit = JVM heap + overhead for metaspace, code cache, threads and native memory.
 * Measured on Paper 1.21.4 (Java 25): a fully touched 2 GB heap needs ~2.4 GB resident, so a flat
 * 384 MB / 20 % left only ~15 MB of headroom and risked an OOM kill during first-boot world generation.
 */
export function containerMemoryBytes(memoryMb: number): number {
  const overhead = Math.max(512, Math.round(memoryMb * 0.25));
  return (memoryMb + overhead) * 1024 * 1024;
}

async function imageExists(image: string): Promise<boolean> {
  try {
    await docker().getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Pull an image if missing, reporting coarse progress lines. */
export async function ensureImage(image: string, onProgress: (line: string) => void): Promise<void> {
  if (await imageExists(image)) return;
  onProgress(`[servcrafty] pulling image ${image} ...`);
  const stream = (await docker().pull(image)) as Readable;
  await new Promise<void>((resolve, reject) => {
    let last = 0;
    docker().modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (evt: { status?: string; id?: string }) => {
        if (Date.now() - last > 3000 && evt.status) {
          last = Date.now();
          onProgress(`[servcrafty] ${evt.status}${evt.id ? ` ${evt.id}` : ''}`);
        }
      },
    );
  });
  onProgress(`[servcrafty] image ${image} ready`);
}

export async function removeContainerIfExists(nameOrId: string): Promise<void> {
  try {
    await docker().getContainer(nameOrId).remove({ force: true, v: true });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 404) throw err;
  }
}

/** (Re)create the game container for a server with its current configuration. */
export async function createServerContainer(
  server: ServerRow,
  cfKey: string | undefined,
  onProgress: (line: string) => void,
): Promise<Docker.Container> {
  const image = imageFor(server);
  await ensureImage(image, onProgress);
  await ensureNetwork();
  await removeContainerIfExists(containerName(server.id));
  if (server.container_id) await removeContainerIfExists(server.container_id);

  const bedrock = server.type === 'BEDROCK';
  const gamePort = bedrock ? '19132/udp' : '25565/tcp';
  const exposed: Record<string, object> = { [gamePort]: {} };
  const bindings: Record<string, { HostIp?: string; HostPort: string }[]> = {
    [gamePort]: [{ HostPort: String(server.port) }],
  };
  if (!bedrock && config().rconPublishLocal) {
    exposed[`${RCON_PORT}/tcp`] = {};
    bindings[`${RCON_PORT}/tcp`] = [{ HostIp: '127.0.0.1', HostPort: '' }];
  }
  return docker().createContainer({
    name: containerName(server.id),
    Image: image,
    Env: await buildEnv(server, cfKey),
    Labels: { [LABEL_SERVER]: server.id, 'servcrafty.managed': 'true' },
    ExposedPorts: exposed,
    Tty: bedrock,
    OpenStdin: true,
    StdinOnce: false,
    AttachStdin: false,
    HostConfig: {
      Binds: [`${hostServerDir(server.id)}:/data`],
      PortBindings: bindings,
      Memory: containerMemoryBytes(server.memory_mb),
      MemorySwap: containerMemoryBytes(server.memory_mb),
      NanoCpus: Math.round(server.cpu * 1e9),
      NetworkMode: config().dockerNetwork,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '3' } },
    },
  });
}

/** Address to dial RCON on for a running container. */
export async function rconAddress(containerId: string): Promise<{ host: string; port: number } | null> {
  const info = await docker().getContainer(containerId).inspect();
  if (config().rconPublishLocal) {
    const b = info.NetworkSettings.Ports?.[`${RCON_PORT}/tcp`]?.[0];
    if (b?.HostPort) return { host: '127.0.0.1', port: Number(b.HostPort) };
  }
  const net = info.NetworkSettings.Networks?.[config().dockerNetwork];
  const ip = net?.IPAddress || info.NetworkSettings.IPAddress;
  return ip ? { host: ip, port: RCON_PORT } : null;
}

/** Run a command inside a container and collect its output. */
export async function execIn(containerId: string, cmd: string[], timeoutMs = 15_000): Promise<string> {
  const exec = await docker().getContainer(containerId).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  return new Promise<string>((resolve, reject) => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    docker().modem.demuxStream(stream, out, out);
    const t = setTimeout(() => {
      stream.destroy();
      reject(new Error('exec timeout'));
    }, timeoutMs);
    stream.on('end', () => {
      clearTimeout(t);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

/** Decode a non-TTY docker log buffer (8-byte frame headers) into text. */
export function demuxBuffer(buf: Buffer): string {
  // A TTY stream has no headers; detect by checking the first header shape.
  if (buf.length < 8 || (buf[0]! > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0)) return buf.toString('utf8');
  const parts: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    parts.push(buf.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

export function requireDocker(ok: boolean): void {
  if (!ok) throw unavailable('Docker daemon is not reachable', 'docker_unavailable');
}
