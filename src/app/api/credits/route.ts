/**
 * GET /api/credits — current balance + active pass + active subscription.
 * Source: _workspace/02_api_spec.md §3.7.
 */
import { NextResponse } from 'next/server';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/require-user';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';
import type { CreditsResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withErrorHandling(async (req: Request) => {
  const ip = clientIpFromHeaders(req.headers);
  const ipRl = await checkRate({ key: rlKey.ip(ip), windowSec: 60, limit: 120 });
  if (!ipRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
  }
  const user = await requireUser();
  const supabase = await createSupabaseServerClient();

  const { data: ledger } = await supabase
    .from('credit_ledger')
    .select('balance_after')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const balance = ledger?.balance_after ?? 0;

  const nowIso = new Date().toISOString();
  const { data: subs } = await supabase
    .from('subscriptions')
    .select('plan, period_end, usage_count, soft_cap, status, stripe_subscription_id')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .gt('period_end', nowIso)
    .order('created_at', { ascending: true });

  let active_pass: CreditsResponse['active_pass'] = null;
  let active_subscription: CreditsResponse['active_subscription'] = null;

  for (const sub of subs ?? []) {
    if (sub.plan === 'weekly_pass' && !active_pass) {
      active_pass = {
        type: 'weekly',
        expires_at: sub.period_end,
        usage_this_period: sub.usage_count,
        soft_cap: sub.soft_cap,
      };
    } else if (sub.plan === 'monthly_sub' && !active_subscription) {
      active_subscription = {
        type: 'monthly',
        period_end: sub.period_end,
        usage_this_period: sub.usage_count,
        soft_cap: sub.soft_cap,
        // cancel_at_period_end is sourced from Stripe; without webhook field we expose false.
        // TODO: persist cancel_at_period_end on subscriptions table when Stripe sends it.
        cancel_at_period_end: false,
      };
    }
  }

  const body: CreditsResponse = { balance, active_pass, active_subscription };
  return NextResponse.json(body);
});
