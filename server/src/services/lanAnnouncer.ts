import dgram from 'node:dgram';
import os from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { bus } from './events.js';
import * as runtime from './runtime.js';

/**
 * LAN discovery for Minecraft Java: clients list "LAN World" entries from UDP multicast
 * packets sent to 224.0.2.60:4445 roughly every 1.5 s with the payload
 * `[MOTD]<name>[/MOTD][AD]<port>[/AD]`. Dedicated servers never send it, so this
 * service does it on their behalf (opt-in per server, only while it is running).
 */
export const LAN_GROUP = '224.0.2.60';
export const LAN_PORT = 4445;
export const ANNOUNCE_INTERVAL_MS = 1500;
export const IFACE_REFRESH_MS = 30_000;
export const MULTICAST_TTL = 4;
export const MAX_MOTD_LENGTH = 60;

/** Make arbitrary user text safe to embed between the protocol markers. */
export function sanitizeMotd(raw: string | null | undefined, fallback = ''): string {
  const clean = (s: string): string =>
    Array.from(
      s
        .replace(/§./gu, '') // Minecraft formatting codes
        .replace(/\\[nrt]/g, ' ') // literal "\n" as stored by the MOTD field
        .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ') // control chars, newlines
        .replace(/[[\]]/g, '') // would break the [MOTD]/[AD] markers
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, MAX_MOTD_LENGTH)
      .join('')
      .trim();
  return clean(raw ?? '') || clean(fallback) || 'Minecraft Server';
}

export function buildPacket(name: string, port: number): Buffer {
  return Buffer.from(`[MOTD]${name}[/MOTD][AD]${port}[/AD]`, 'utf8');
}

export interface AnnounceRow {
  id: string;
  name: string;
  type: string;
  port: number;
  lan_announce: boolean;
  minecraft: { motd?: string } | null;
}

export interface Announcement {
  id: string;
  packet: Buffer;
}

/** Servers that should be announced right now: Java, opted in and running. */
export function selectAnnouncements(rows: AnnounceRow[], isRunning: (id: string) => boolean): Announcement[] {
  const out: Announcement[] = [];
  for (const r of rows) {
    if (!r.lan_announce || r.type === 'BEDROCK' || !isRunning(r.id)) continue;
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) continue;
    out.push({ id: r.id, packet: buildPacket(sanitizeMotd(r.minecraft?.motd, r.name), r.port) });
  }
  return out;
}

const VIRTUAL_IFACE = /^(lo\d*$|docker|br-|veth(?!ernet)|virbr|cni|flannel|cali|cilium|weave|tun|tap|vboxnet|vmnet|vEthernet \((Default Switch|WSL)|isatap|Teredo|Loopback)/i;

export type IfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** Usable IPv4 addresses to send from. `allow` (explicit list) bypasses the name filter. */
export function listAnnounceAddresses(ifaces: IfaceMap, allow: string[] = []): string[] {
  const out = new Set<string>();
  for (const [name, infos] of Object.entries(ifaces)) {
    for (const i of infos ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.') || i.address.startsWith('127.')) continue;
      if (allow.length) {
        if (allow.includes(i.address)) out.add(i.address);
      } else if (!VIRTUAL_IFACE.test(name)) out.add(i.address);
    }
  }
  return [...out].sort();
}

export interface LanSocket {
  send(msg: Buffer, port: number, host: string, cb: (err: Error | null) => void): void;
  close(): void;
}

export type SocketFactory = (address: string, onError: (err: Error) => void) => LanSocket;

/** Real UDP socket bound to one local address, sending multicast out of that interface. */
export const udpSocketFactory: SocketFactory = (address, onError) => {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let ready = false;
  sock.on('error', onError);
  sock.bind(0, address, () => {
    try {
      sock.setMulticastInterface(address);
      sock.setMulticastTTL(MULTICAST_TTL);
      ready = true;
    } catch (err) {
      onError(err as Error);
    }
  });
  return {
    send: (msg, port, host, cb) => {
      if (!ready) return cb(null);
      try {
        sock.send(msg, port, host, cb);
      } catch (err) {
        cb(err as Error);
      }
    },
    close: () => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    },
  };
};

export interface AnnouncerDeps {
  loadRows: () => Promise<AnnounceRow[]>;
  isRunning: (id: string) => boolean;
  listAddresses: () => string[];
  createSocket: SocketFactory;
  now: () => number;
  log: { warn: (msg: string) => void; info: (msg: string) => void };
}

export class LanAnnouncer {
  private announcements: Announcement[] = [];
  private sockets = new Map<string, LanSocket>();
  private lastIfaceCheck = Number.NEGATIVE_INFINITY;
  private reported = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: AnnouncerDeps) {}

  /** Re-read the DB and decide which servers are announced. */
  async refresh(): Promise<void> {
    try {
      this.announcements = selectAnnouncements(await this.deps.loadRows(), this.deps.isRunning);
    } catch (err) {
      this.deps.log.warn(`LAN announcer: refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get active(): readonly Announcement[] {
    return this.announcements;
  }

  get interfaces(): string[] {
    return [...this.sockets.keys()];
  }

  private syncSockets(): void {
    const now = this.deps.now();
    if (now - this.lastIfaceCheck < IFACE_REFRESH_MS) return;
    this.lastIfaceCheck = now;
    const wanted = new Set(this.deps.listAddresses());
    for (const [addr, sock] of this.sockets) {
      if (!wanted.has(addr)) {
        sock.close();
        this.sockets.delete(addr);
      }
    }
    for (const addr of wanted) {
      if (this.sockets.has(addr)) continue;
      this.sockets.set(
        addr,
        this.deps.createSocket(addr, (err) => {
          this.report(addr, err);
          // Drop the broken socket; it is recreated at the next interface refresh.
          this.sockets.get(addr)?.close();
          this.sockets.delete(addr);
        }),
      );
    }
  }

  private report(addr: string, err: Error): void {
    const code = (err as NodeJS.ErrnoException).code ?? err.message;
    const key = `${addr}:${code}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.deps.log.warn(`LAN announcer: cannot send from ${addr}: ${code}`);
  }

  /** One announcement round (called every ANNOUNCE_INTERVAL_MS). */
  tick(): void {
    if (!this.announcements.length) {
      // Nothing to announce: release sockets so an idle feature costs nothing.
      if (this.sockets.size) {
        for (const s of this.sockets.values()) s.close();
        this.sockets.clear();
        this.lastIfaceCheck = Number.NEGATIVE_INFINITY;
      }
      return;
    }
    this.syncSockets();
    for (const [addr, sock] of this.sockets) {
      for (const a of this.announcements) {
        sock.send(a.packet, LAN_PORT, LAN_GROUP, (err) => {
          if (err) this.report(addr, err);
          else
            for (const k of this.reported) if (k.startsWith(`${addr}:`)) this.reported.delete(k);
        });
      }
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), ANNOUNCE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const s of this.sockets.values()) s.close();
    this.sockets.clear();
    this.announcements = [];
  }
}

let instance: LanAnnouncer | undefined;

/** Trigger a re-evaluation (server created/updated/deleted/toggled). No-op when disabled. */
export function refreshLanAnnouncer(): void {
  void instance?.refresh();
}

export function initLanAnnouncer(logger: FastifyBaseLogger): void {
  const c = config();
  if (!c.lanAnnounce) {
    logger.info('LAN discovery announcer disabled (LAN_ANNOUNCE=0)');
    return;
  }
  const allow = c.lanAnnounceInterfaces;
  instance = new LanAnnouncer({
    loadRows: () =>
      query<AnnounceRow>(
        `SELECT id, name, type, port, lan_announce, minecraft FROM servers WHERE lan_announce AND type <> 'BEDROCK'`,
      ),
    isRunning: (id) => runtime.getStatus(id) === 'running',
    listAddresses: () => listAnnounceAddresses(os.networkInterfaces(), allow),
    createSocket: udpSocketFactory,
    now: () => Date.now(),
    log: { warn: (m) => logger.warn(m), info: (m) => logger.info(m) },
  });
  bus.on('status', () => refreshLanAnnouncer());
  instance.start();
  void instance.refresh();
  logger.info(`LAN discovery announcer enabled${allow.length ? ` (interfaces: ${allow.join(', ')})` : ''}`);
}

export function stopLanAnnouncer(): void {
  instance?.stop();
  instance = undefined;
}
