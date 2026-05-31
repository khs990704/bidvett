/**
 * Integration test — Silent Retry x3 + Deduct-on-Success sequence around
 * the OpenAI client used by /api/analyze.
 *
 * Scope:
 *   - Confirms the loop performs exactly 1 initial + 3 retries (=4 attempts)
 *     on retriable (5xx / timeout / network) errors before raising
 *     ApiError(502, ERR_LLM_UPSTREAM).
 *   - Confirms a successful call on retry #2 does NOT throw and returns
 *     the parsed payload (Deduct-on-Success precondition: caller never
 *     reaches the RPC when upstream fails).
 *   - Confirms non-retriable errors (400, schema mismatch) propagate
 *     immediately without re-trying.
 *
 * Why this lives in tests/integration: the SUT spans openai/client.ts,
 * errors.ts, schemas.ts (Zod). Full route-handler tests against
 * Supabase / Dodo Payments live infra are out of scope at MVP (would require
 * testcontainers + Dodo sandbox tooling).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import { z } from "zod";

// Provide the env vars that env.ts validates so importing the SUT does
// not throw. These are all stub values.
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-srk";
  process.env.OPENAI_API_KEY = "stub-openai";
  process.env.DODO_API_KEY = "dodo_test_stub";
  process.env.DODO_WEBHOOK_SECRET = "whsec_stub";
});

// ── Mock the OpenAI SDK ──────────────────────────────────────────────
const createMock = vi.fn();

vi.mock("openai", () => {
  return {
    default: class FakeOpenAI {
      chat = {
        completions: {
          create: (...args: unknown[]) => createMock(...args),
        },
      };
    },
  };
});

// ── Helpers ─────────────────────────────────────────────────────────
function buildCompletion(payload: unknown) {
  return {
    choices: [
      {
        message: { content: JSON.stringify(payload) },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
  };
}

function retriableError(): Error & { status?: number } {
  const e = new Error("upstream 503") as Error & { status?: number };
  e.status = 503;
  return e;
}

function nonRetriableError(): Error & { status?: number } {
  const e = new Error("bad request") as Error & { status?: number };
  e.status = 400;
  return e;
}

beforeEach(() => {
  createMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/api/analyze — Silent Retry x3 (Deduct-on-Success precondition)", () => {
  it("retries on retriable errors and throws ERR_LLM_UPSTREAM after 4 attempts", async () => {
    const { callStructuredWithRetry } = await import("@/lib/openai/client");
    const { ApiError, ErrorCode } = await import("@/lib/errors");

    createMock.mockRejectedValue(retriableError());

    const TestZod = z.object({ ok: z.boolean() });

    await expect(
      callStructuredWithRetry({
        promptName: "analyze.v1",
        systemPrompt: "sys",
        userMessage: "hello",
        schemaName: "Test",
        jsonSchema: { type: "object" },
        zodSchema: TestZod,
        maxInputChars: 16_000,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // initial + 3 retries == 4 total OpenAI invocations
    expect(createMock).toHaveBeenCalledTimes(4);

    // Verify the thrown ApiError code is the documented one.
    try {
      await callStructuredWithRetry({
        promptName: "analyze.v1",
        systemPrompt: "sys",
        userMessage: "hello",
        schemaName: "Test",
        jsonSchema: { type: "object" },
        zodSchema: TestZod,
        maxInputChars: 16_000,
      });
    } catch (err) {
      const e = err as InstanceType<typeof ApiError>;
      expect(e.status).toBe(502);
      expect(e.code).toBe(ErrorCode.LLM_UPSTREAM);
    }
  });

  it("succeeds on attempt #2 (no extra retries)", async () => {
    const { callStructuredWithRetry } = await import("@/lib/openai/client");

    const TestZod = z.object({ ok: z.boolean(), n: z.number() });
    const payload = { ok: true, n: 42 };

    createMock
      .mockRejectedValueOnce(retriableError())
      .mockResolvedValueOnce(buildCompletion(payload));

    const out = await callStructuredWithRetry({
      promptName: "analyze.v1",
      systemPrompt: "sys",
      userMessage: "ok",
      schemaName: "Test",
      jsonSchema: { type: "object" },
      zodSchema: TestZod,
      maxInputChars: 16_000,
    });

    expect(out.data).toEqual(payload);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it("non-retriable error (4xx) propagates after a SINGLE attempt — no retry budget burned", async () => {
    const { callStructuredWithRetry } = await import("@/lib/openai/client");

    createMock.mockRejectedValue(nonRetriableError());
    const TestZod = z.object({ ok: z.boolean() });

    await expect(
      callStructuredWithRetry({
        promptName: "analyze.v1",
        systemPrompt: "sys",
        userMessage: "ok",
        schemaName: "Test",
        jsonSchema: { type: "object" },
        zodSchema: TestZod,
        maxInputChars: 16_000,
      }),
    ).rejects.toBeDefined();
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("schema mismatch (LLM returned wrong shape) maps to ERR_VALIDATION 422 and does NOT retry", async () => {
    const { callStructuredWithRetry } = await import("@/lib/openai/client");
    const { ApiError, ErrorCode } = await import("@/lib/errors");

    createMock.mockResolvedValue(buildCompletion({ not: "expected" }));
    const TestZod = z.object({ expected: z.string() });

    try {
      await callStructuredWithRetry({
        promptName: "analyze.v1",
        systemPrompt: "sys",
        userMessage: "ok",
        schemaName: "Test",
        jsonSchema: { type: "object" },
        zodSchema: TestZod,
        maxInputChars: 16_000,
      });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as InstanceType<typeof ApiError>;
      expect(e).toBeInstanceOf(ApiError);
      expect(e.status).toBe(422);
      expect(e.code).toBe(ErrorCode.VALIDATION);
    }
    // 422 is non-retriable per the contract.
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("input_too_large is enforced BEFORE the network call (caller-side guard)", async () => {
    const { callStructuredWithRetry } = await import("@/lib/openai/client");
    const { ApiError, ErrorCode } = await import("@/lib/errors");

    const TestZod = z.object({ ok: z.boolean() });
    try {
      await callStructuredWithRetry({
        promptName: "analyze.v1",
        systemPrompt: "sys",
        userMessage: "x".repeat(17_000),
        schemaName: "Test",
        jsonSchema: { type: "object" },
        zodSchema: TestZod,
        maxInputChars: 16_000,
      });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as InstanceType<typeof ApiError>;
      expect(e).toBeInstanceOf(ApiError);
      expect(e.status).toBe(413);
      expect(e.code).toBe(ErrorCode.INPUT_TOO_LARGE);
    }
    expect(createMock).not.toHaveBeenCalled();
  });
});
