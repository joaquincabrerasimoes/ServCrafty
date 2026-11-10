import dgram from 'node:dgram';

/**
 * Minimal Steam A2S client (A2S_INFO + A2S_PLAYER over UDP), with challenge handling and Source-style
 * split packets. https://developer.valvesoftware.com/wiki/Server_queries
 */

export interface A2sInfo {
  name: string;
  map: string;
  folder: string;
  game: string;
  appId: number | null;
  players: number;
  maxPlayers: number;
  bots: number;
  version: string | null;
}

export interface A2sPlayer {
  name: string;
  score: number;
  durationSec: number;
}

const SIMPLE = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const INFO_PAYLOAD = Buffer.from('Source Engine Query\0', 'latin1');
const MAX_SPLIT_PACKETS = 32;

export function buildInfoRequest(challenge?: Buffer): Buffer {
  return Buffer.concat([SIMPLE, Buffer.from([0x54]), INFO_PAYLOAD, challenge ?? Buffer.alloc(0)]);
}

export function buildPlayerRequest(challenge?: Buffer): Buffer {
  return Buffer.concat([SIMPLE, Buffer.from([0x55]), challenge ?? SIMPLE]);
}

/** Bounds-checked reader; any overrun throws and the parser returns null. */
class Reader {
  constructor(
    private readonly buf: Buffer,
    public off = 0,
  ) {}
  get left(): number {
    return this.buf.length - this.off;
  }
  u8(): number {
    if (this.left < 1) throw new RangeError('eof');
    return this.buf.readUInt8(this.off++);
  }
  u16(): number {
    if (this.left < 2) throw new RangeError('eof');
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  i32(): number {
    if (this.left < 4) throw new RangeError('eof');
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }
  f32(): number {
    if (this.left < 4) throw new RangeError('eof');
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }
  str(): string {
    const end = this.buf.indexOf(0, this.off);
    if (end < 0) throw new RangeError('unterminated string');
    const s = this.buf.toString('utf8', this.off, end);
    this.off = end + 1;
    return clean(s);
  }
}

/** Strip control characters and cap length of strings coming from the network. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 256);
}

/** Parse an A2S_INFO response (Source 0x49 or obsolete GoldSrc 0x6D), header included. */
export function parseInfo(buf: Buffer): A2sInfo | null {
  try {
    const r = new Reader(buf);
    if (r.i32() !== -1) return null;
    const kind = r.u8();
    if (kind === 0x49) {
      r.u8(); // protocol
      const name = r.str();
      const map = r.str();
      const folder = r.str();
      const game = r.str();
      const appId = r.u16();
      const players = r.u8();
      const maxPlayers = r.u8();
      const bots = r.u8();
      r.u8(); // server type
      r.u8(); // environment
      r.u8(); // visibility
      r.u8(); // VAC
      if (appId === 2400) {
        // The Ship: mode, witnesses, duration
        r.u8();
        r.u8();
        r.u8();
      }
      let version: string | null = null;
      if (r.left > 0) version = r.str() || null;
      return { name, map, folder, game, appId, players, maxPlayers, bots, version };
    }
    if (kind === 0x6d) {
      r.str(); // address
      const name = r.str();
      const map = r.str();
      const folder = r.str();
      const game = r.str();
      const players = r.u8();
      const maxPlayers = r.u8();
      return { name, map, folder, game, appId: null, players, maxPlayers, bots: 0, version: null };
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse an A2S_PLAYER response (0x44), header included. */
export function parsePlayers(buf: Buffer): A2sPlayer[] | null {
  try {
    const r = new Reader(buf);
    if (r.i32() !== -1 || r.u8() !== 0x44) return null;
    const count = r.u8();
    const out: A2sPlayer[] = [];
    for (let i = 0; i < count && r.left > 0; i++) {
      r.u8(); // index
      const name = r.str();
      const score = r.i32();
      const duration = r.f32();
      out.push({ name, score, durationSec: Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : 0 });
    }
    return out;
  } catch {
    return null;
  }
}

/** A challenge response (0x41) -> the 4 challenge bytes, else null. */
export function parseChallenge(buf: Buffer): Buffer | null {
  if (buf.length >= 9 && buf.readInt32LE(0) === -1 && buf[4] === 0x41) return buf.subarray(5, 9);
  return null;
}

/**
 * Reassemble Source-format split packets (header -2). Returns the full payload once complete,
 * null while waiting for more parts, or the packet itself when it is not split.
 */
export class SplitAssembler {
  private parts = new Map<number, Map<number, Buffer>>();
  push(pkt: Buffer): Buffer | null {
    if (pkt.length < 4) return null;
    const header = pkt.readInt32LE(0);
    if (header === -1) return pkt;
    if (header !== -2 || pkt.length < 12) return null;
    const id = pkt.readInt32LE(4);
    if (id & 0x80000000) return null; // bzip2-compressed: unsupported
    const total = pkt[8]!;
    const number = pkt[9]!;
    if (total === 0 || total > MAX_SPLIT_PACKETS || number >= total) return null;
    const payload = pkt.subarray(12);
    let m = this.parts.get(id);
    if (!m) {
      if (this.parts.size > 4) this.parts.clear();
      m = new Map();
      this.parts.set(id, m);
    }
    m.set(number, payload);
    if (m.size < total) return null;
    this.parts.delete(id);
    const chunks: Buffer[] = [];
    for (let i = 0; i < total; i++) {
      const c = m.get(i);
      if (!c) return null;
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
}

export interface A2sResult {
  info: A2sInfo | null;
  players: A2sPlayer[] | null;
}

/**
 * Query a server. Each request handles one challenge round trip. Resolves (never rejects) with
 * whatever could be read before `timeoutMs`.
 */
export async function queryA2s(host: string, port: number, opts: { timeoutMs?: number; players?: boolean } = {}): Promise<A2sResult> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const sock = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  const asm = new SplitAssembler();
  let waiter: ((b: Buffer) => void) | null = null;
  sock.on('message', (msg, rinfo) => {
    if (rinfo.port !== port) return; // only the queried port answers
    if (msg.length > 64 * 1024) return;
    const full = asm.push(msg);
    if (full && waiter) waiter(full);
  });
  sock.on('error', () => undefined);

  const exchange = (req: Buffer, ms: number) =>
    new Promise<Buffer | null>((resolve) => {
      const t = setTimeout(() => {
        waiter = null;
        resolve(null);
      }, ms);
      waiter = (b) => {
        clearTimeout(t);
        waiter = null;
        resolve(b);
      };
      sock.send(req, port, host, (err) => {
        if (err) {
          clearTimeout(t);
          waiter = null;
          resolve(null);
        }
      });
    });

  const request = async (build: (c?: Buffer) => Buffer, deadline: number): Promise<Buffer | null> => {
    let res = await exchange(build(), Math.max(1, deadline - Date.now()));
    for (let i = 0; i < 2 && res; i++) {
      const ch = parseChallenge(res);
      if (!ch) break;
      res = await exchange(build(ch), Math.max(1, deadline - Date.now()));
    }
    return res;
  };

  const deadline = Date.now() + timeoutMs;
  try {
    const infoBuf = await request(buildInfoRequest, deadline);
    const info = infoBuf ? parseInfo(infoBuf) : null;
    let players: A2sPlayer[] | null = null;
    if (opts.players !== false && Date.now() < deadline) {
      const pBuf = await request(buildPlayerRequest, deadline);
      players = pBuf ? parsePlayers(pBuf) : null;
    }
    return { info, players };
  } finally {
    sock.close();
  }
}
