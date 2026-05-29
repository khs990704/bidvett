/**
 * GET /api/analyses — cursor pagination of own analyses.
 * Source: _workspace/02_api_spec.md §3.6.
 */
import { NextResponse } from 'next/server';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/require-user';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';
import type { AnalysesListItem } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const GET = withErrorHandling(async (req: Request) => {
  const ip = clientIpFromHeaders(req.headers);
  const ipRl = await checkRate({ key: rlKey.ip(ip), windowSec: 60, limit: 120 });
  if (!ipRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
  }

  const user = await requireUser();
  const url = new URL(req.url);
  const limitParam = url.searchParams.get('limit');
  const cursor = url.searchParams.get('cursor');
  let limit = limitParam ? Number.parseInt(limitParam, 10) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from('analyses')
    .select('id, verdict, ai_risk_level, match_score, is_reported, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    query = query.lt('created_at', cursor);
  }

  const { data, error } = await query;
  if (error) {
    // eslint-disable-next-line no-console
    console.error('[analyses.list]', error);
    throw new ApiError(500, ErrorCode.INTERNAL, { reason: 'db_select_failed' });
  }

  const rows = data ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: AnalysesListItem[] = page.map((r) => ({
    id: r.id as string,
    verdict: r.verdict as AnalysesListItem['verdict'],
    risk_level: r.ai_risk_level as AnalysesListItem['risk_level'],
    match_score: (r.match_score as number | null) ?? null,
    is_reported: r.is_reported as boolean,
    created_at: r.created_at as string,
  }));
  const next_cursor = hasMore ? page[page.length - 1].created_at : null;

  return NextResponse.json({ items, next_cursor });
});
