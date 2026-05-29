/**
 * POST /api/webhooks/stripe — Stripe webhook receiver.
 * Source: _workspace/02_api_spec.md §3.9, _workspace/01_architecture.md §6.7, §8.4.
 *
 * Raw body required for signature verification (do NOT use req.json()).
 * Idempotency via `stripe_events` PK insert.
 */
import { NextResponse } from 'next/server';
import { stripeClient } from '@/lib/stripe/client';
import { handleStripeEvent } from '@/lib/stripe/webhook';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env';
import { apiError, ErrorCode } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // 1) Raw body
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return apiError(400, ErrorCode.WEBHOOK_SIGNATURE, { reason: 'missing_header' });
  }

  // 2) Signature verification
  let event;
  try {
    event = stripeClient().webhooks.constructEvent(
      rawBody,
      signature,
      serverEnv().STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[stripe.webhook] sig verify failed', err);
    return apiError(400, ErrorCode.WEBHOOK_SIGNATURE);
  }

  // 3) Idempotency: insert stripe_events row, treat conflict as already processed.
  const admin = supabaseAdmin();
  const insertRes = await admin
    .from('stripe_events')
    .insert(
      {
        id: event.id,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
        processed: false,
      },
      { count: 'exact' },
    )
    .select('id')
    .maybeSingle();

  if (insertRes.error) {
    // Check whether the conflict is "already exists" (idempotent skip).
    const msg = insertRes.error.message ?? '';
    const isConflict =
      insertRes.error.code === '23505' || /duplicate key/i.test(msg);
    if (isConflict) {
      // Already received — confirm processed flag, return 200.
      return NextResponse.json({ received: true, duplicate: true });
    }
    // eslint-disable-next-line no-console
    console.error('[stripe.webhook] insert event failed', insertRes.error);
    return NextResponse.json({ received: true, persist_failed: true }, { status: 200 });
  }

  // 4) Dispatch handler
  try {
    await handleStripeEvent(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe.webhook] handler failed', { event_id: event.id, err });
    // Do not mark processed — Stripe will retry.
    return NextResponse.json({ received: true, handler_failed: true }, { status: 200 });
  }

  // 5) Mark processed
  await admin
    .from('stripe_events')
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq('id', event.id);

  return NextResponse.json({ received: true });
}
