// Fixed-window rate limiter for the public OAuth endpoints. The login password
// gate (scrypt) already makes guessing expensive per attempt; this adds a coarse
// per-client request bound so a public tunnel can't be hammered. It is
// defense-in-depth, not a precise quota — keys are bucketed per fixed window and
// the whole structure is capped to bound memory.

export interface RateLimiterOptions {
  /** Max requests allowed per key within a window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max distinct keys tracked (bounds memory; oldest window evicted past this). */
  maxKeys?: number;
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window resets (for Retry-After). */
  retryAfterSec: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: RateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Count one request for `key`; returns whether it is allowed. */
  hit(key: string): RateLimitResult {
    return this.record(key, true);
  }

  /**
   * Report whether `key` has budget left WITHOUT spending any.
   *
   * A gate that both counts and decides can only be placed before the work it
   * guards, which makes every rejected request — including one an unauthenticated
   * caller can send for free — spend from the same budget the legitimate caller
   * needs. Splitting the two lets a caller check first and charge only for the
   * outcome that is actually worth bounding.
   */
  check(key: string): RateLimitResult {
    return this.record(key, false);
  }

  /** Spend one unit of `key`'s budget, ignoring the verdict. */
  consume(key: string): void {
    this.record(key, true);
  }

  private record(key: string, spend: boolean): RateLimitResult {
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      bucket = { count: 0, resetAt: t + this.options.windowMs };
      this.buckets.set(key, bucket);
    }
    if (spend) {
      bucket.count += 1;
    }
    this.evictIfNeeded(t);
    // `check` asks whether one more would fit; `hit` has already taken it.
    const used = spend ? bucket.count : bucket.count + 1;
    const allowed = used <= this.options.limit;
    return { allowed, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)) };
  }

  private evictIfNeeded(t: number): void {
    if (this.buckets.size <= this.maxKeys) {
      return;
    }
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= t) {
        this.buckets.delete(key);
      }
    }
    // If still over budget (all live), drop the oldest-inserted entries.
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.buckets.delete(oldest);
    }
  }
}
