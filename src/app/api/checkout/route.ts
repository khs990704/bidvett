/**
 * POST /api/checkout — Dodo Payments Hosted Checkout Session creation.
 * Source: _workspace/02_api_spec.md §3.8, _workspace/00_input.md §11.3 (PIVOT-01).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { requireUser } from '@/lib/supabase/require-user';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';
import { createCheckoutSession } from '@/lib/dodo/client';
import type { CheckoutResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  plan: z.enum(['credit_single', 'weekly_pass', 'monthly_sub']),
});

export const POST = withErrorHandling(async (req: Request) => {
  const ip = clientIpFromHeaders(req.headers);
  const ipRl = await checkRate({ key: rlKey.ip(ip), windowSec: 60, limit: 120 });
  if (!ipRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
  }
  const user = await requireUser();
  const userRl = await checkRate({
    key: rlKey.checkoutUser(user.id),
    windowSec: 60,
    limit: 10,
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

  if (parsed.data.plan !== 'credit_single') {
    const supabase = await createSupabaseServerClient();
    const { data: activeSub, error: subErr } = await supabase
      .from('subscriptions')
      .select('plan, period_end, cancelled_at')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .gt('period_end', new Date().toISOString())
      .in('plan', ['weekly_pass', 'monthly_sub'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (subErr) {
      // eslint-disable-next-line no-console
      console.error('[checkout] active subscription lookup failed', subErr);
      throw new ApiError(500, ErrorCode.INTERNAL);
    }

    if (activeSub) {
      throw new ApiError(
        409,
        ErrorCode.BAD_REQUEST,
        {
          reason: 'active_subscription_exists',
          active_plan: activeSub.plan,
          period_end: activeSub.period_end,
          cancel_at_period_end: activeSub.cancelled_at != null,
        },
        'You already have an active subscription. Cancel it before changing plans.',
      );
    }
  }

  const idempotencyKey = req.headers.get('idempotency-key') ?? undefined;
  const { url, sessionId } = await createCheckoutSession({
    userId: user.id,
    plan: parsed.data.plan,
    idempotencyKey,
  });
  const body: CheckoutResponse = { checkout_url: url, session_id: sessionId };
  return NextResponse.json(body);
});
