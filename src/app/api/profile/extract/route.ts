/**
 * POST /api/profile/extract
 * Free-form resume text → 4 structured fields via OpenAI Structured Outputs.
 * No credit deduction. Per-user 5/min, per-IP 10/min.
 * Source: _workspace/02_api_spec.md §3.2.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { requireUser } from '@/lib/supabase/require-user';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';
import { getActivePrompt } from '@/lib/openai/prompts';
import { callStructuredWithRetry } from '@/lib/openai/client';
import {
  ProfileExtractJsonSchema,
  ProfileExtractZod,
} from '@/lib/openai/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  resume_text: z.string().min(1).max(16_000),
});

export const POST = withErrorHandling(async (req: Request) => {
  const ip = clientIpFromHeaders(req.headers);
  const ipRl = await checkRate({ key: rlKey.ipExtract(ip), windowSec: 60, limit: 10 });
  if (!ipRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
  }

  const user = await requireUser();
  const userRl = await checkRate({
    key: rlKey.extractUser(user.id),
    windowSec: 60,
    limit: 5,
  });
  if (!userRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'user' });
  }

  let bodyRaw: unknown;
  try {
    bodyRaw = await req.json();
  } catch {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, { reason: 'invalid_json' });
  }
  const parsed = BodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    throw new ApiError(400, ErrorCode.VALIDATION, {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  if (parsed.data.resume_text.length > 16_000) {
    throw new ApiError(413, ErrorCode.INPUT_TOO_LARGE, {
      length: parsed.data.resume_text.length,
      limit: 16_000,
    });
  }

  const prompt = await getActivePrompt('profile_extract.v1');
  const result = await callStructuredWithRetry({
    promptName: 'profile_extract.v1',
    systemPrompt: prompt.content,
    userMessage: parsed.data.resume_text,
    schemaName: ProfileExtractJsonSchema.name,
    jsonSchema: ProfileExtractJsonSchema.schema as Record<string, unknown>,
    zodSchema: ProfileExtractZod,
    maxInputChars: 16_000,
  });

  return NextResponse.json({
    extracted: {
      skills: result.data.skills,
      years_of_experience: result.data.years_of_experience,
      target_hourly_rate: result.data.target_hourly_rate,
      timezone: result.data.timezone,
    },
    warnings: [] as string[],
  });
});
