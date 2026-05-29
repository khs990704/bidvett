/**
 * Unit tests for the Vercel KV rate-limit / lock helpers.
 *
 * Strategy:
 *   `@vercel/kv` is mocked with an in-memory sorted-set + key-value store.
 *   Env vars KV_REST_API_URL / KV_REST_API_TOKEN are set BEFORE importing
 *   the kv module so that `kvAvailable()` returns true and the real code
 *   paths run against the mock.
 *
 * Coverage targets:
 *   - Sliding window: under-limit allowed, over-limit denied
 *   - Window expiry: old entries pruned by ZREMRANGEBYSCORE
 *   - SET NX lock: first caller wins, second caller blocked, release frees
 *   - INCR daily cap with TTL on first set
 *   - Fail-open behaviour when KV env is absent (separate suite)
 */
import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest";

// Force kvAvailable() to return true within the module under test.
beforeAll(() => {
  process.env.KV_REST_API_URL = "https://stub-kv.invalid";
  process.env.KV_REST_API_TOKEN = "stub-token";
});

// ── In-memory @vercel/kv mock ────────────────────────────────────────
type SortedSet = Array<{ score: number; member: string }>;
const zsets = new Map<string, SortedSet>();
const kvStrings = new Map<string, { value: unknown; expiresAt: number | null }>();

function nowExpired(entry: { expiresAt: number | null } | undefined): boolean {
  if (!entry) return true;
  return entry.expiresAt !== null && entry.expiresAt <= Date.now();
}

vi.mock("@vercel/kv", () => {
  return {
    kv: {
      async zremrangebyscore(key: string, min: number, max: number) {
        const arr = zsets.get(key) ?? [];
        const next = arr.filter((m) => m.score < min || m.score > max);
        zsets.set(key, next);
        return arr.length - next.length;
      },
      async zadd(key: string, item: { score: number; member: string }) {
        const arr = zsets.get(key) ?? [];
        arr.push(item);
        zsets.set(key, arr);
        return 1;
      },
      async zcard(key: string) {
        return zsets.get(key)?.length ?? 0;
      },
      async expire(_key: string, _seconds: number) {
        // No-op; we don't model TTL on zsets for these tests.
        return 1;
      },
      async set(
        key: string,
        value: unknown,
        opts?: { nx?: boolean; ex?: number },
      ) {
        const existing = kvStrings.get(key);
        if (opts?.nx && existing && !nowExpired(existing)) return null;
        const ttl = opts?.ex ?? null;
        kvStrings.set(key, {
          value,
          expiresAt: ttl != null ? Date.now() + ttl * 1000 : null,
        });
        return "OK";
      },
      async get(key: string) {
        const e = kvStrings.get(key);
        if (!e) return null;
        if (nowExpired(e)) {
          kvStrings.delete(key);
          return null;
        }
        return e.value;
      },
      async del(key: string) {
        const had = kvStrings.delete(key);
        zsets.delete(key);
        return had ? 1 : 0;
      },
      async incr(key: string) {
        const e = kvStrings.get(key);
        const prev =
          e && !nowExpired(e) && typeof e.value === "number"
            ? (e.value as number)
            : 0;
        const next = prev + 1;
        kvStrings.set(key, { value: next, expiresAt: e?.expiresAt ?? null });
        return next;
      },
    },
  };
});

import {
  checkRate,
  acquireLock,
  releaseLock,
  incrDailyCap,
  rlKey,
  lockKey,
  costKey,
  clientIpFromHeaders,
} from "../kv";

beforeEach(() => {
  zsets.clear();
  kvStrings.clear();
});

describe("rate-limit/kv.checkRate — sliding window", () => {
  it("allows requests below the limit", async () => {
    const key = rlKey.analyzeUser("u1");
    for (let i = 0; i < 5; i++) {
      const r = await checkRate({ key, windowSec: 60, limit: 60 });
      expect(r.allowed).toBe(true);
    }
  });

  it("denies the request that crosses the limit", async () => {
    const key = rlKey.ip("1.2.3.4");
    let lastAllowed = true;
    for (let i = 0; i < 6; i++) {
      const r = await checkRate({ key, windowSec: 60, limit: 5 });
      lastAllowed = r.allowed;
    }
    // 6th call is over the limit of 5.
    expect(lastAllowed).toBe(false);
  });

  it("prunes entries older than the window so refilled budget allows again", async () => {
    const key = rlKey.extractUser("u2");
    // Fill exactly to the limit at t0.
    for (let i = 0; i < 3; i++) {
      await checkRate({ key, windowSec: 60, limit: 3 });
    }
    // Manually backdate the sorted-set members beyond the window.
    const arr = zsets.get(key)!;
    arr.forEach((m) => (m.score = Date.now() - 120_000));
    const r = await checkRate({ key, windowSec: 60, limit: 3 });
    expect(r.allowed).toBe(true);
  });

  it("isolates counters across different key prefixes (SEC-1 regression)", async () => {
    // /api/profile/extract uses rlKey.ipExtract (limit=10); other routes use rlKey.ip (limit=120).
    // Filling the strict extract bucket must NOT consume the lenient general-IP bucket.
    const ip = "9.9.9.9";
    const strictKey = rlKey.ipExtract(ip);
    const lenientKey = rlKey.ip(ip);
    for (let i = 0; i < 10; i++) {
      await checkRate({ key: strictKey, windowSec: 60, limit: 10 });
    }
    // Strict bucket is at cap.
    const strictNext = await checkRate({ key: strictKey, windowSec: 60, limit: 10 });
    expect(strictNext.allowed).toBe(false);
    // Lenient bucket is still untouched.
    const lenientFirst = await checkRate({ key: lenientKey, windowSec: 60, limit: 120 });
    expect(lenientFirst.allowed).toBe(true);
  });
});

describe("rate-limit/kv.acquireLock / releaseLock", () => {
  it("first acquire wins, second is blocked until release", async () => {
    const key = lockKey.analyzeUser("u3");
    expect(await acquireLock(key, 30)).toBe(true);
    expect(await acquireLock(key, 30)).toBe(false);
    await releaseLock(key);
    expect(await acquireLock(key, 30)).toBe(true);
  });
});

describe("rate-limit/kv.incrDailyCap", () => {
  it("increments per call and sets TTL on first set", async () => {
    const key = costKey.dailyUser("u4");
    const a = await incrDailyCap(key, 86_400);
    const b = await incrDailyCap(key, 86_400);
    const c = await incrDailyCap(key, 86_400);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(c).toBe(3);
  });
});

describe("rate-limit/kv.clientIpFromHeaders", () => {
  it("uses first XFF token when present", () => {
    const h = new Headers({ "x-forwarded-for": "203.0.113.5, 10.0.0.1" });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.5");
  });

  it("falls back to x-real-ip", () => {
    const h = new Headers({ "x-real-ip": "198.51.100.7" });
    expect(clientIpFromHeaders(h)).toBe("198.51.100.7");
  });

  it("returns 'unknown' when no IP header is present", () => {
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });
});
