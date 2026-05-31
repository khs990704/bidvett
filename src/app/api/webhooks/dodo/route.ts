/**
 * POST /api/webhooks/dodo — Dodo Payments webhook receiver.
 * Source: _workspace/02_api_spec.md §3.9, _workspace/01_architecture.md §6.7, §8.4,
 *         _workspace/00_input.md §11.3 (PIVOT-01).
 *
 * Standard Webhooks spec: signature verification uses the
 * `webhook-id` / `webhook-timestamp` / `webhook-signature` headers; raw body
 * (NOT `req.json()`) is required so the HMAC matches.
 *
 * Idempotency via `dodo_events` PK insert (ON CONFLICT → 200 duplicate).
 */
import { NextResponse } from 'next/server';
import { verifyDodoSignature, handleDodoEvent } from '@/lib/dodo/webhook';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { apiError, ErrorCode } from '@/lib/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Standard Webhooks required headers (per spec).
const REQUIRED_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const;

export async function POST(req: Request) {
  // 1) Raw body — must NOT use req.json(); signature is over the exact bytes.
  const rawBody = await req.text();

  // 2) Collect Standard Webhooks headers.
  const headers: Record<string, string> = {};
  for (const name of REQUIRED_HEADERS) {
    const v = req.headers.get(name);
    if (!v) {
      return apiError(400, ErrorCode.WEBHOOK_SIGNATURE, {
        reason: 'missing_header',
        header: name,
      });
    }
    headers[name] = v;
  }

  // 3) Signature verification (Standard Webhooks HMAC-SHA256).
  let event;
  try {
    event = verifyDodoSignature({ rawBody, headers });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[dodo.webhook] sig verify failed', err);
    return apiError(400, ErrorCode.WEBHOOK_SIGNATURE);
  }

  // 4) Idempotency: insert dodo_events row, treat conflict as already processed.
  const admin = supabaseAdmin();
  const insertRes = await admin
    .from('dodo_events')
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
    const msg = insertRes.error.message ?? '';
    const isConflict =
      insertRes.error.code === '23505' || /duplicate key/i.test(msg);
    if (isConflict) {
      // Already received — return 200 so Dodo stops retrying.
      return NextResponse.json({ received: true, duplicate: true });
    }
    // eslint-disable-next-line no-console
    console.error('[dodo.webhook] insert event failed', insertRes.error);
    return NextResponse.json({ received: true, persist_failed: true }, { status: 200 });
  }

  // 5) Dispatch handler
  try {
    await handleDodoEvent(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[dodo.webhook] handler failed', { event_id: event.id, err });
    // Do not mark processed — Dodo will retry per Standard Webhooks retry policy.
    return NextResponse.json({ received: true, handler_failed: true }, { status: 200 });
  }

  // 6) Mark processed
  await admin
    .from('dodo_events')
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq('id', event.id);

  return NextResponse.json({ received: true });
}
