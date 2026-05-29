/**
 * POST /api/report-scam — mark own analysis as reported.
 * Source: _workspace/02_api_spec.md §3.10.
 *
 * Column-level guard: this handler is the ONLY path that writes
 * is_reported / report_reason. RLS allows arbitrary user UPDATE on
 * own analyses; defense-in-depth enforced here.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/require-user';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  analysis_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
});

export const POST = withErrorHandling(async (req: Request) => {
  const ip = clientIpFromHeaders(req.headers);
  const ipRl = await checkRate({ key: rlKey.ip(ip), windowSec: 60, limit: 120 });
  if (!ipRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
  }
  const user = await requireUser();
  const userRl = await checkRate({
    key: rlKey.reportUser(user.id),
    windowSec: 60,
    limit: 30,
  });
  if (!userRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'user' });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, { reason: 'invalid_json' });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, ErrorCode.VALIDATION, {
      issues: parsed.error.issues.slice(0, 5),
    });
  }

  const supabase = await createSupabaseServerClient();
  // App-layer column guard: only is_reported + report_reason are written.
  const { data, error } = await supabase
    .from('analyses')
    .update({ is_reported: true, report_reason: parsed.data.reason })
    .eq('id', parsed.data.analysis_id)
    .eq('user_id', user.id)
    .select('id')
    .maybeSingle();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('[report-scam]', error);
    throw new ApiError(500, ErrorCode.INTERNAL, { reason: 'db_update_failed' });
  }
  if (!data) {
    throw new ApiError(404, ErrorCode.NOT_FOUND);
  }
  return NextResponse.json({ ok: true });
});
