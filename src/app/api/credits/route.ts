/**
 * GET /api/credits — current balance + active pass + active subscription.
 * Source: _workspace/02_api_spec.md §3.7.
 *
 * Provider: Dodo Payments (PIVOT-01 2026-05-29). Subscription rows use
 * `dodo_customer_id` / `dodo_subscription_id` / `dodo_checkout_session_id`
 * columns (renamed from `stripe_*` in PIVOT-01 verify phase).
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
    .select('plan, period_end, usage_count, soft_cap, status, dodo_subscription_id')
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
        // cancel_at_period_end is provider-sourced (Dodo `subscription.cancelled`
        // event). Until we persist it on the subscriptions row, expose false.
        // TODO(dodo-docs): confirm whether Dodo emits an at-period-end flag
        // (vs. immediate cancel) and persist it on subscriptions when it does.
        cancel_at_period_end: false,
      };
    }
  }

  const body: CreditsResponse = { balance, active_pass, active_subscription };
  return NextResponse.json(body);
});
