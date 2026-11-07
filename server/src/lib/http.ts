import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { USER_AGENT } from '../config.js';
import { upstream } from './errors.js';

export type FetchJsonOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

/** fetch() + JSON decode with timeout; non-2xx raises a 502 AppError. */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  }).catch((err: unknown) => {
    throw upstream(`Request to ${new URL(url).host} failed: ${(err as Error).message}`);
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw upstream(`${new URL(url).host} responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

/** Simple TTL cache for upstream lookups. */
export class TtlCache<V> {
  private readonly map = new Map<string, { v: V; exp: number }>();
  constructor(private readonly ttlMs: number) {}
  async get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.map.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = await load();
    this.map.set(key, { v, exp: Date.now() + this.ttlMs });
    if (this.map.size > 500) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
    return v;
  }
}

/**
 * Download `url` to `dest` atomically (via a temp file), optionally verifying a
 * sha1/sha512 hex digest. Returns bytes written.
 */
export async function downloadFile(
  url: string,
  dest: string,
  verify?: { algo: 'sha1' | 'sha256' | 'sha512'; hex: string },
  headers: Record<string, string> = {},
): Promise<number> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, ...headers },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  }).catch((err: unknown) => {
    throw upstream(`Download failed: ${(err as Error).message}`);
  });
  if (!res.ok || !res.body) throw upstream(`Download failed: HTTP ${res.status}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${crypto.randomBytes(4).toString('hex')}`;
  const hash = verify ? crypto.createHash(verify.algo) : null;
  let bytes = 0;
  const src = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  src.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    hash?.update(chunk);
  });
  try {
    await pipeline(src, fs.createWriteStream(tmp));
    if (hash && verify && hash.digest('hex').toLowerCase() !== verify.hex.toLowerCase()) {
      throw upstream('Downloaded file hash mismatch', 'hash_mismatch');
    }
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return bytes;
}
