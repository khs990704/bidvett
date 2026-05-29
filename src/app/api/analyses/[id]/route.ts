/**
 * GET /api/analyses/[id] — single analysis detail (historical snapshot).
 * Source: _workspace/02_api_spec.md §3.6b.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/require-user';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';
import type { AnalyzeResponse } from '@/lib/types/api';

type ExtractedSignals = AnalyzeResponse['extracted_signals'];

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid() });

export const GET = withErrorHandling(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const ip = clientIpFromHeaders(req.headers);
    const ipRl = await checkRate({ key: rlKey.ip(ip), windowSec: 60, limit: 120 });
    if (!ipRl.allowed) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
    }

    const user = await requireUser();
    const params = await ctx.params;
    const p = ParamsSchema.safeParse(params);
    if (!p.success) {
      throw new ApiError(400, ErrorCode.BAD_REQUEST, { reason: 'invalid_id' });
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from('analyses')
      .select('*')
      .eq('id', p.data.id)
      .maybeSingle();

    if (error) {
      throw new ApiError(500, ErrorCode.INTERNAL, { reason: 'db_select_failed' });
    }
    if (!data) {
      throw new ApiError(404, ErrorCode.NOT_FOUND);
    }
    // RLS would have hidden someone else's row, but enforce defensively.
    if (data.user_id !== user.id) {
      throw new ApiError(403, ErrorCode.FORBIDDEN);
    }

    const signals = (data.extracted_signals ?? {}) as ExtractedSignals;
    const response: AnalyzeResponse = {
      analysis_id: data.id,
      verdict: data.verdict,
      backend_risk: {
        critical: data.backend_critical,
        rules_triggered: (data.backend_rules_triggered ?? []) as AnalyzeResponse['backend_risk']['rules_triggered'],
      },
      ai_risk: {
        risk_level: data.ai_risk_level,
        contextual_red_flags: (data.contextual_red_flags ?? []) as string[],
      },
      match_score: data.match_score ?? null,
      score_reason: data.score_reason ?? null,
      action_tip: data.action_tip,
      extracted_signals: signals,
      credit_after: 0, // historical snapshot — not meaningful for past rows
      took_ms: data.took_ms ?? 0,
      prompt_version: data.prompt_version ?? 1,
    };
    return NextResponse.json(response);
  },
);
