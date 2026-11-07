import { tooMany } from './errors.js';

/** Fixed-window in-memory limiter (single instance deployment). */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    }, windowMs).unref();
  }

  /** Count a hit; throws 429 if the limit is exceeded. */
  hit(key: string): void {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return;
    }
    cur.n++;
    if (cur.n > this.max) {
      throw tooMany(`Too many attempts; try again in ${Math.ceil((cur.reset - now) / 1000)}s`);
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
