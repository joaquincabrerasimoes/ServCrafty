import net from 'node:net';

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_COMMAND = 2;
const TYPE_RESPONSE = 0;

/** Minecraft splits responses into packets of at most this many body bytes. */
const MAX_CHUNK = 4096;
/** How long to wait for a continuation packet after a full-size chunk. */
const CONTINUATION_WAIT_MS = 250;

interface Pending {
  id: number;
  chunks: string[];
  resolve: (v: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  settleTimer: NodeJS.Timeout | null;
}

/**
 * Minimal RCON client for Minecraft Java. Minecraft processes exactly one packet
 * per socket read and drops the connection if several packets are coalesced, so
 * the usual "sentinel packet" trick cannot be used. Instead, commands are strictly
 * serialized and a response is complete when a chunk shorter than 4096 bytes
 * arrives (or, after a full-size chunk, when no continuation follows shortly).
 */
export class RconClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private authWaiter: { id: number; resolve: () => void; reject: (e: Error) => void } | null = null;
  private connecting: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly password: string,
    private readonly timeoutMs = 5000,
  ) {}

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed && !this.connecting;
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed && !this.connecting) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(err);
      };
      const t = setTimeout(() => fail(new Error('RCON connect timeout')), this.timeoutMs);
      sock.setNoDelay(true);
      sock.on('data', (d) => this.onData(d));
      sock.on('error', (err) => {
        clearTimeout(t);
        fail(err);
        this.teardown(err);
      });
      sock.on('close', () => this.teardown(new Error('RCON connection closed')));
      sock.once('connect', () => {
        this.socket = sock;
        this.buffer = Buffer.alloc(0);
        const id = this.allocId();
        this.authWaiter = {
          id,
          resolve: () => {
            clearTimeout(t);
            if (!settled) {
              settled = true;
              resolve();
            }
          },
          reject: (e) => {
            clearTimeout(t);
            fail(e);
          },
        };
        sock.write(encode(id, TYPE_AUTH, this.password));
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Execute a command; commands are serialized over the single connection. */
  command(cmd: string): Promise<string> {
    const run = async () => {
      await this.connect();
      return this.send(cmd);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  close(): void {
    this.socket?.destroy();
    this.teardown(new Error('RCON closed'));
  }

  private send(cmd: string): Promise<string> {
    const sock = this.socket;
    if (!sock || sock.destroyed) return Promise.reject(new Error('RCON not connected'));
    if (Buffer.byteLength(cmd, 'utf8') > 1400) return Promise.reject(new Error('RCON command too long'));
    return new Promise<string>((resolve, reject) => {
      const id = this.allocId();
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (p?.settleTimer) clearTimeout(p.settleTimer);
        // Partial output is still useful; otherwise report a timeout.
        if (p && p.chunks.length) resolve(p.chunks.join(''));
        else reject(new Error('RCON command timeout'));
      }, this.timeoutMs);
      this.pending.set(id, { id, chunks: [], resolve, reject, timer, settleTimer: null });
      sock.write(encode(id, TYPE_COMMAND, cmd));
    });
  }

  private allocId(): number {
    this.nextId = (this.nextId % 0x7ffffff0) + 1;
    return this.nextId;
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const len = this.buffer.readInt32LE(0);
      if (len < 10 || len > 1024 * 1024) {
        this.socket?.destroy(new Error('RCON protocol error'));
        return;
      }
      if (this.buffer.length < 4 + len) return;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.subarray(12, 4 + len - 2).toString('utf8');
      this.buffer = this.buffer.subarray(4 + len);
      this.onPacket(id, type, body);
    }
  }

  private onPacket(id: number, type: number, body: string): void {
    if (this.authWaiter && type === TYPE_AUTH_RESPONSE) {
      const w = this.authWaiter;
      this.authWaiter = null;
      if (id === -1) w.reject(new Error('RCON authentication failed'));
      else w.resolve();
      return;
    }
    if (type !== TYPE_RESPONSE) return;
    const p = this.pending.get(id);
    if (!p) return;
    p.chunks.push(body);
    if (p.settleTimer) clearTimeout(p.settleTimer);
    const finish = () => {
      clearTimeout(p.timer);
      this.pending.delete(p.id);
      p.resolve(p.chunks.join(''));
    };
    if (Buffer.byteLength(body, 'utf8') < MAX_CHUNK) finish();
    else p.settleTimer = setTimeout(finish, CONTINUATION_WAIT_MS);
  }

  private teardown(err: Error): void {
    this.socket = null;
    if (this.authWaiter) {
      this.authWaiter.reject(err);
      this.authWaiter = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      if (p.settleTimer) clearTimeout(p.settleTimer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

function encode(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  buf.writeInt16LE(0, 12 + b.length);
  return buf;
}

/** Strip Minecraft § formatting codes. */
export function stripFormatting(s: string): string {
  return s.replace(/§[0-9a-fk-orx]/gi, '');
}
