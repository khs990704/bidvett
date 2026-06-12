/**
 * POST /api/subscription/cancel — schedule cancellation at end of billing period.
 *
 * Flow:
 *   1) Find the user's active subscription row (status='active', period_end>now).
 *   2) Tell Dodo: `subscription.update(subId, { cancel_at_next_billing_date: true })`.
 *   3) Optimistically set `cancelled_at = now` on our row so /api/credits
 *      immediately surfaces `cancel_at_period_end: true`. The `subscription.cancelled`
 *      webhook (which fires at the actual termination) will overwrite this with
 *      Dodo's authoritative cancelled_at.
 *
 * Idempotent: calling twice on an already-cancelled sub is a no-op success.
 */
import { NextResponse } from 'next/server';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { requireUser } from '@/lib/supabase/require-user';
import { checkRate, rlKey, clientIpFromHeaders } from '@/lib/rate-limit/kv';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { dodoClient } from '@/lib/dodo/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  // Use RLS-respecting client to ensure the user owns the row.
  const supabase = await createSupabaseServerClient();
  const nowIso = new Date().toISOString();
  const { data: sub, error: selErr } = await supabase
    .from('subscriptions')
    .select('id, dodo_subscription_id, cancelled_at')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .gt('period_end', nowIso)
    .in('plan', ['weekly_pass', 'monthly_sub'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selErr) {
    // eslint-disable-next-line no-console
    console.error('[subscription.cancel] select failed', selErr);
    throw new ApiError(500, ErrorCode.INTERNAL);
  }
  if (!sub || !sub.dodo_subscription_id) {
    throw new ApiError(404, ErrorCode.NOT_FOUND, { reason: 'no_active_subscription' });
  }

  // Already scheduled — idempotent success.
  if (sub.cancelled_at != null) {
    return NextResponse.json({ ok: true, already_cancelled: true });
  }

  try {
    await dodoClient().subscriptions.update(sub.dodo_subscription_id, {
      cancel_at_next_billing_date: true,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[subscription.cancel] dodo update failed', err);
    throw new ApiError(502, ErrorCode.PAYMENT_UPSTREAM);
  }

  // Optimistic write — service-role bypasses RLS, but we still pin by id.
  const admin = supabaseAdmin();
  const { error: updErr } = await admin
    .from('subscriptions')
    .update({
      cancelled_at: nowIso,
      updated_at: nowIso,
    })
    .eq('id', sub.id);
  if (updErr) {
    // Dodo already received the cancel intent — our local write is a UX hint.
    // Webhook will reconcile when the subscription terminates.
    // eslint-disable-next-line no-console
    console.warn('[subscription.cancel] local mark failed (Dodo accepted)', updErr);
  }

  return NextResponse.json({ ok: true });
});
