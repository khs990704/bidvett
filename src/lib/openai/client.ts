/**
 * OpenAI Structured Outputs wrapper.
 * Source: _workspace/01_architecture.md §6.4, §8.1.
 *
 * The caller is responsible for retry / backoff. This module performs
 * exactly ONE attempt and exposes timing + token usage. The analyze
 * Route Handler implements the Silent Retry x3 loop (backoff 200/500/1200ms).
 */
import OpenAI from 'openai';
import type { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { ApiError, ErrorCode } from '@/lib/errors';

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  _client = new OpenAI({ apiKey: serverEnv().OPENAI_API_KEY });
  return _client;
}

export interface StructuredCallArgs<T> {
  promptName: string;
  systemPrompt: string;
  userMessage: string;
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  zodSchema: z.ZodType<T>;
  /** Hard char limit on userMessage. Caller pre-checks. */
  maxInputChars: number;
  /** Per-attempt timeout in ms. Default 25_000. */
  timeoutMs?: number;
  /** Model. Default gpt-4o-mini. */
  model?: string;
}

export interface StructuredCallResult<T> {
  data: T;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  raw_text: string;
}

/**
 * Determine if an error is retriable per spec/02 §6 (5xx, timeout, network).
 * 4xx and schema validation errors are non-retriable.
 */
export function isRetriableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; code?: string; name?: string };
  if (typeof e.status === 'number') {
    return e.status >= 500 && e.status <= 599;
  }
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNRESET' || e.code === 'ENOTFOUND') {
    return true;
  }
  if (e.name === 'APIConnectionTimeoutError' || e.name === 'APIConnectionError') {
    return true;
  }
  return false;
}

export async function callStructuredOnce<T>(
  args: StructuredCallArgs<T>,
): Promise<StructuredCallResult<T>> {
  if (args.userMessage.length > args.maxInputChars) {
    throw new ApiError(413, ErrorCode.INPUT_TOO_LARGE, {
      length: args.userMessage.length,
      limit: args.maxInputChars,
    });
  }

  const timeoutMs = args.timeoutMs ?? 25_000;
  const model = args.model ?? 'gpt-4o-mini';

  const response = await client().chat.completions.create(
    {
      model,
      messages: [
        { role: 'system', content: args.systemPrompt },
        { role: 'user', content: args.userMessage },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: args.schemaName,
          strict: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          schema: args.jsonSchema as any,
        },
      },
      temperature: 0.2,
    },
    { timeout: timeoutMs },
  );

  const choice = response.choices?.[0];
  const text = choice?.message?.content ?? '';
  if (!text) {
    throw new ApiError(422, ErrorCode.VALIDATION, {
      reason: 'empty_completion',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(422, ErrorCode.VALIDATION, {
      reason: 'invalid_json',
    });
  }

  const result = args.zodSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError(422, ErrorCode.VALIDATION, {
      reason: 'schema_mismatch',
      issues: result.error.issues.slice(0, 5),
    });
  }

  return {
    data: result.data,
    usage: {
      prompt_tokens: response.usage?.prompt_tokens ?? 0,
      completion_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    },
    raw_text: text,
  };
}

/**
 * Silent Retry x3 loop — initial + 3 retries with backoff [0, 200, 500, 1200] ms.
 * Source: _workspace/01_architecture.md §8.1.
 *
 * Non-retriable errors (4xx, ApiError validation) propagate immediately.
 */
export async function callStructuredWithRetry<T>(
  args: StructuredCallArgs<T>,
): Promise<StructuredCallResult<T>> {
  const delays = [0, 200, 500, 1200] as const;
  let lastErr: unknown;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      await new Promise((r) => setTimeout(r, delays[i]));
    }
    try {
      return await callStructuredOnce(args);
    } catch (err) {
      lastErr = err;
      // ApiError (validation/input_too_large) is non-retriable.
      if (err instanceof ApiError) throw err;
      if (!isRetriableError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[openai.retry] attempt ${i + 1}/${delays.length} failed`, err);
    }
  }
  // All attempts exhausted on retriable errors.
  // eslint-disable-next-line no-console
  console.error('[openai.upstream] all retries failed', lastErr);
  throw new ApiError(502, ErrorCode.LLM_UPSTREAM);
}
