/**
 * GET /api/profile — own profile or 404
 * PUT /api/profile — upsert own profile
 * Source: _workspace/02_api_spec.md §3.3, §3.4.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorHandling, ApiError, ErrorCode, apiError } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/require-user';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PutBodySchema = z.object({
  skills: z.array(z.string().min(1).max(50)).max(20),
  years_of_experience: z.number().int().min(0).max(60),
  target_hourly_rate: z.number().int().min(0).max(1000),
  timezone: z.string().min(1).max(64),
  resume_text: z.string().max(32_000).optional(),
});

async function ipRateLimit(req: Request) {
  const ip = clientIpFromHeaders(req.headers);
  const r = await checkRate({ key: rlKey.ip(ip), windowSec: 60, limit: 120 });
  if (!r.allowed) throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
}

export const GET = withErrorHandling(async (req: Request) => {
  await ipRateLimit(req);
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('users_profile')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    throw new ApiError(500, ErrorCode.INTERNAL, { reason: 'db_select_failed' });
  }
  if (!data) {
    return apiError(404, ErrorCode.NOT_FOUND);
  }
  return NextResponse.json({
    user_id: data.user_id,
    skills: data.skills,
    years_of_experience: data.years_of_experience,
    target_hourly_rate: data.target_hourly_rate,
    timezone: data.timezone,
    resume_text: data.resume_text ?? null,
    created_at: data.created_at,
    updated_at: data.updated_at,
  });
});

export const PUT = withErrorHandling(async (req: Request) => {
  await ipRateLimit(req);
  const user = await requireUser();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, { reason: 'invalid_json' });
  }
  const parsed = PutBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(400, ErrorCode.VALIDATION, {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('users_profile')
    .upsert(
      {
        user_id: user.id,
        skills: parsed.data.skills,
        years_of_experience: parsed.data.years_of_experience,
        target_hourly_rate: parsed.data.target_hourly_rate,
        timezone: parsed.data.timezone,
        ...(parsed.data.resume_text !== undefined
          ? { resume_text: parsed.data.resume_text }
          : {}),
      },
      { onConflict: 'user_id' },
    )
    .select('*')
    .single();

  if (error || !data) {
    // eslint-disable-next-line no-console
    console.error('[profile.upsert]', error);
    throw new ApiError(500, ErrorCode.INTERNAL, { reason: 'db_upsert_failed' });
  }
  return NextResponse.json({
    user_id: data.user_id,
    skills: data.skills,
    years_of_experience: data.years_of_experience,
    target_hourly_rate: data.target_hourly_rate,
    timezone: data.timezone,
    resume_text: data.resume_text ?? null,
    created_at: data.created_at,
    updated_at: data.updated_at,
  });
});
