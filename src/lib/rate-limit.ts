/**
 * In-process sliding-window rate limiter (spec §37).
 *
 * Deliberately dependency-free. It is per-process, which is correct for a
 * single bot/API instance; when you scale horizontally, swap `RateLimiter` for
 * the Redis implementation behind the same interface (docs/09-deployment.md).
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the caller may retry (0 when allowed). */
  retryAfter: number;
}

interface Bucket {
  /** timestamps (ms) of accepted hits inside the window */
  hits: number[];
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private sweep(now: number): void {
    // Cheap opportunistic GC so long-running processes do not grow unbounded.
    if (this.buckets.size < 5_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hits.length === 0 || now - (bucket.hits[bucket.hits.length - 1] as number) > this.windowMs) {
        this.buckets.delete(key);
      }
    }
  }

  check(key: string): RateLimitResult {
    const now = Date.now();
    this.sweep(now);
    const bucket = this.buckets.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((t) => now - t < this.windowMs);
    if (bucket.hits.length >= this.limit) {
      const oldest = bucket.hits[0] as number;
      this.buckets.set(key, bucket);
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((this.windowMs - (now - oldest)) / 1000) };
    }
    bucket.hits.push(now);
    this.buckets.set(key, bucket);
    return { allowed: true, remaining: this.limit - bucket.hits.length, retryAfter: 0 };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

/**
 * Named limiters. Configuration comes from the environment / admin_settings so
 * limits are tunable without a redeploy.
 */
export function createLimiters(opts: { perMinuteForNumbers: number; perMinuteForStart: number; perMinuteForApi: number }) {
  return {
    getNumber: new RateLimiter(opts.perMinuteForNumbers, 60_000),
    start: new RateLimiter(opts.perMinuteForStart, 60_000),
    referral: new RateLimiter(10, 60_000),
    adminAction: new RateLimiter(60, 60_000),
    api: new RateLimiter(opts.perMinuteForApi, 60_000),
    pbx: new RateLimiter(300, 60_000),
  };
}

export type Limiters = ReturnType<typeof createLimiters>;
