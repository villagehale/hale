import { Redis } from '@upstash/redis';

export interface WaitlistStore {
  add(email: string): Promise<{ created: boolean }>;
}

const SET_KEY = 'hearth:waitlist';
const META_KEY = 'hearth:waitlist:joined_at';

const RATE_LIMIT_MAX_PER_WINDOW = 5;
const RATE_LIMIT_WINDOW_SECONDS = 3600;
const RATE_LIMIT_KEY_PREFIX = 'hearth:waitlist:rl:';

// The minimal redis surface the rate limiter needs. Injected so the decision
// logic is testable without a live Upstash connection.
export interface RateLimitCounter {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RateLimiter {
  check(ip: string): Promise<{ allowed: boolean }>;
}

function redisFromEnv(): Redis {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error('waitlist store not configured: missing KV/Upstash REST url + token');
  }
  return new Redis({ url, token });
}

export function createWaitlistStore(): WaitlistStore {
  const redis = redisFromEnv();
  return {
    async add(email) {
      const added = await redis.sadd(SET_KEY, email);
      await redis.hset(META_KEY, { [email]: new Date().toISOString() });
      return { created: added === 1 };
    },
  };
}

// Fixed-window per-IP throttle. INCR returns the count after this hit; on the
// first hit in a window (count === 1) we set the TTL so the window expires.
export function createRateLimiter(counter: RateLimitCounter): RateLimiter {
  return {
    async check(ip) {
      const key = `${RATE_LIMIT_KEY_PREFIX}${ip}`;
      const count = await counter.incr(key);
      if (count === 1) {
        await counter.expire(key, RATE_LIMIT_WINDOW_SECONDS);
      }
      return { allowed: count <= RATE_LIMIT_MAX_PER_WINDOW };
    },
  };
}

export function createRedisRateLimiter(): RateLimiter {
  return createRateLimiter(redisFromEnv());
}

// The client IP must come from a source the request can't forge, or the per-IP
// rate limit is trivially evaded by rotating a spoofed x-forwarded-for. A client
// can prepend entries to x-forwarded-for, so the LEFTMOST entry is attacker-
// controlled; only the trusted proxy's own appends are reliable. Order of trust:
//   1. x-vercel-forwarded-for / x-real-ip — set by the platform, not the client.
//   2. RIGHTMOST x-forwarded-for entry — the hop closest to our trusted proxy.
// Assumption: deployed behind a single trusted proxy (Vercel) that appends the
// real client IP last. Returns 'unknown' when nothing is present so a missing
// header collapses into one shared bucket rather than silently disabling the limit.
export function extractClientIp(headers: Headers): string {
  const platform = headers.get('x-vercel-forwarded-for')?.trim() || headers.get('x-real-ip')?.trim();
  if (platform) return platform;
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded.split(',').map((entry) => entry.trim()).filter(Boolean);
    const rightmost = entries.at(-1);
    if (rightmost) return rightmost;
  }
  return 'unknown';
}
