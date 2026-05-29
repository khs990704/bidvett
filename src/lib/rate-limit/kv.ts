/**
 * Vercel KV (Upstash Redis) rate-limit + lock + cache helpers.
 * Source: _workspace/01_architecture.md §6.8, §9.
 *
 * Sliding-window algorithm via sorted set:
 *   ZADD <key> <now_ms> <uuid>
 *   ZREMRANGEBYSCORE <key> 0 <now_ms - window_ms>
 *   ZCARD <key>
 *   EXPIRE <key> <window_sec * 2>
 *
 * If KV env vars are missing (e.g. local dev), every check returns `allowed=true`
 * with a warning. Production deployments MUST have KV provisioned.
 */
import { kv } from '@vercel/kv';
import { randomUUID } from 'node:crypto';

function kvAvailable(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

export interface RateCheck {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateCheckArgs {
  key: string;
  windowSec: number;
  limit: number;
}

export async function checkRate(args: RateCheckArgs): Promise<RateCheck> {
  const { key, windowSec, limit } = args;
  if (!kvAvailable()) {
    return { allowed: true, remaining: limit, resetAt: Date.now() + windowSec * 1000 };
  }
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const cutoff = now - windowMs;
  const member = `${now}:${randomUUID()}`;

  // Best-effort pipeline. @vercel/kv doesn't expose multi(), so issue
  // sequentially. Race window is bounded by sliding-window correction itself.
  try {
    // 1) Drop expired
    await kv.zremrangebyscore(key, 0, cutoff);
    // 2) Add this attempt
    await kv.zadd(key, { score: now, member });
    // 3) Count
    const count = (await kv.zcard(key)) ?? 0;
    // 4) Expire
    await kv.expire(key, windowSec * 2);
    const remaining = Math.max(0, limit - count);
    return {
      allowed: count <= limit,
      remaining,
      resetAt: now + windowMs,
    };
  } catch (err) {
    // KV transient failure: fail open to keep MVP traffic flowing.
    // Sentry capture happens at call-site.
    // eslint-disable-next-line no-console
    console.warn('[rate-limit] KV check failed, failing open', err);
    return { allowed: true, remaining: limit, resetAt: now + windowMs };
  }
}

/**
 * Attempt a `SET NX EX` lock. Returns true if acquired.
 */
export async function acquireLock(key: string, ttlSec: number): Promise<boolean> {
  if (!kvAvailable()) return true;
  try {
    const res = await kv.set(key, '1', { nx: true, ex: ttlSec });
    return res === 'OK';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[lock] acquire failed', err);
    return true; // fail open
  }
}

export async function releaseLock(key: string): Promise<void> {
  if (!kvAvailable()) return;
  try {
    await kv.del(key);
  } catch {
    // ignore
  }
}

export async function incrDailyCap(
  key: string,
  ttlSecOnFirstSet: number,
): Promise<number> {
  if (!kvAvailable()) return 1;
  try {
    const n = (await kv.incr(key)) ?? 1;
    if (n === 1) {
      await kv.expire(key, ttlSecOnFirstSet);
    }
    return n;
  } catch {
    return 1;
  }
}

export async function kvGetJson<T>(key: string): Promise<T | null> {
  if (!kvAvailable()) return null;
  try {
    const v = await kv.get<T>(key);
    return v ?? null;
  } catch {
    return null;
  }
}

export async function kvSetJsonEx<T>(
  key: string,
  value: T,
  ttlSec: number,
): Promise<void> {
  if (!kvAvailable()) return;
  try {
    await kv.set(key, value, { ex: ttlSec });
  } catch {
    // ignore
  }
}

// --------------------------------------------------------------------
// Namespace helpers — strictly per _workspace/01_architecture.md §9.
// --------------------------------------------------------------------
export const rlKey = {
  ip: (ip: string) => `rl:ip:${ip}`,
  ipExtract: (ip: string) => `rl:ip:extract:${ip}`,
  analyzeUser: (uid: string) => `rl:analyze:user:${uid}`,
  extractUser: (uid: string) => `rl:extract:user:${uid}`,
  checkoutUser: (uid: string) => `rl:checkout:user:${uid}`,
  reportUser: (uid: string) => `rl:report:user:${uid}`,
} as const;

export const lockKey = {
  analyzeUser: (uid: string) => `lock:analyze:user:${uid}`,
} as const;

export const costKey = {
  dailyUser: (uid: string) => `cost:daily:${uid}`,
} as const;

export const idemKey = {
  analyze: (uid: string, key: string) => `idem:analyze:${uid}:${key}`,
} as const;

/**
 * Best-effort caller IP extractor. Vercel injects `x-forwarded-for`.
 */
export function clientIpFromHeaders(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const real = headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}
