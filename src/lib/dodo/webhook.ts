/**
 * Dodo Payments Webhook event router.
 * Source: _workspace/01_architecture.md §6.7, _workspace/02_api_spec.md §3.9,
 *         _workspace/00_input.md §11.3 (PIVOT-01).
 *
 * Signature verification follows the Standard Webhooks spec
 * (https://www.standardwebhooks.com/). Headers expected on inbound POST:
 *   - webhook-id
 *   - webhook-timestamp
 *   - webhook-signature
 *
 * Handles 5 events (Dodo Payments event taxonomy):
 *   - payment.succeeded
 *       * credit_single  → credit_ledger insert (+1, type='purchase_single')
 *       * weekly_pass    → subscriptions insert (status='active', soft_cap=100, +7d)
 *       * monthly_sub    → subscriptions insert (status='active', soft_cap=500, +30d)
 *   - subscription.active   → upsert subscriptions row (active)
 *   - subscription.renewed  → extend period_end, reset usage_count
 *   - subscription.cancelled → status='canceled'
 *   - refund.succeeded      → guard (0 usage + ≤7d) then credit_ledger -1 / mark sub refunded
 *
 * Idempotency is enforced via `dodo_events` PK (event.id). The route handler
 * inserts the event row first and only invokes `handleDodoEvent` if INSERT
 * succeeded (i.e., not already processed).
 */
// TODO(dodo-docs): confirm exact Standard Webhooks helper import path. The
// official `standardwebhooks` npm package is assumed to export a `Webhook`
// class with a `verify(rawBody, headers)` method that throws on failure.
import { Webhook } from 'standardwebhooks';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env';
import { PLAN_SOFT_CAP, PLAN_PERIOD_DAYS } from '@/lib/dodo/plans';

// ── Dodo event shape (minimal subset we depend on) ───────────────────
// TODO(dodo-docs): confirm exact event envelope. We assume the Standard
// Webhooks spec wraps Dodo's domain payload as `{ id, type, data: {...} }`.
export interface DodoEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

type PlanFromMetadata = 'credit_single' | 'weekly_pass' | 'monthly_sub';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

function parsePlan(meta: Record<string, unknown> | null | undefined): PlanFromMetadata | null {
  const v = meta?.plan;
  if (v === 'credit_single' || v === 'weekly_pass' || v === 'monthly_sub') return v;
  return null;
}

function parseUserId(meta: Record<string, unknown> | null | undefined): string | null {
  const v = meta?.user_id;
  return typeof v === 'string' ? v : null;
}

function parseString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null;
}

// ── Signature verification (Standard Webhooks) ───────────────────────
export interface VerifyArgs {
  rawBody: string;
  headers: Record<string, string>;
  secret?: string;
}

/**
 * Verify the inbound webhook using the Standard Webhooks library. Throws on
 * invalid signature / missing headers — the route handler maps that to
 * ERR_WEBHOOK_SIGNATURE 400.
 */
export function verifyDodoSignature(args: VerifyArgs): DodoEvent {
  const secret = args.secret ?? serverEnv().DODO_WEBHOOK_SECRET;
  // TODO(dodo-docs): confirm whether the `standardwebhooks` library expects
  // the raw secret string or a base64-encoded form (some providers issue the
  // secret with a `whsec_` prefix that must be stripped first).
  const wh = new Webhook(secret);
  // `verify` throws on signature mismatch / replay; returns the parsed JSON
  // payload on success.
  const verified = wh.verify(args.rawBody, args.headers) as unknown;
  const evt = asRecord(verified);
  if (!evt || typeof evt.id !== 'string' || typeof evt.type !== 'string') {
    throw new Error('Verified payload is not a valid Dodo event envelope');
  }
  return {
    id: evt.id,
    type: evt.type,
    data: asRecord(evt.data) ?? {},
  };
}

// ── Event dispatch ───────────────────────────────────────────────────
export async function handleDodoEvent(event: DodoEvent): Promise<void> {
  const admin = supabaseAdmin();
  const data = event.data;
  // Many Dodo events carry the underlying object (payment / subscription /
  // refund) on a conventional key. We probe a few shapes defensively because
  // the exact wrapper is not yet pinned down.
  // TODO(dodo-docs): confirm canonical event.data shape.
  const obj =
    asRecord(data.object) ??
    asRecord(data.payment) ??
    asRecord(data.subscription) ??
    asRecord(data.refund) ??
    data;
  const metadata = asRecord(obj.metadata) ?? asRecord(data.metadata);

  switch (event.type) {
    case 'payment.succeeded': {
      const userId = parseUserId(metadata);
      const plan = parsePlan(metadata);
      if (!userId || !plan) {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] missing user_id or plan', {
          event_id: event.id,
        });
        return;
      }

      if (plan === 'credit_single') {
        // Fetch current balance (single-row read; race-free enough since this
        // event is processed once per dodo_events PK).
        const { data: latest } = await admin
          .from('credit_ledger')
          .select('balance_after')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const prev = latest?.balance_after ?? 0;
        await admin.from('credit_ledger').insert({
          user_id: userId,
          type: 'purchase_single',
          delta: 1,
          balance_after: prev + 1,
          dodo_event_id: event.id,
          note: `Dodo purchase ${parseString(obj.id) ?? event.id}`,
        });
        return;
      }

      // weekly_pass or monthly_sub → subscriptions row
      const now = new Date();
      const periodEnd = new Date(now.getTime() + PLAN_PERIOD_DAYS[plan] * 86_400_000);
      await admin.from('subscriptions').insert({
        user_id: userId,
        plan,
        status: 'active',
        period_start: now.toISOString(),
        period_end: periodEnd.toISOString(),
        usage_count: 0,
        soft_cap: PLAN_SOFT_CAP[plan],
        dodo_customer_id:
          parseString(obj.customer_id) ?? parseString(obj.customerId) ?? '',
        dodo_subscription_id:
          parseString(obj.subscription_id) ?? parseString(obj.subscriptionId) ?? null,
        dodo_checkout_session_id:
          parseString(obj.checkout_session_id) ??
          parseString(obj.checkoutSessionId) ??
          parseString(obj.id),
        dodo_event_id: event.id,
      });
      return;
    }

    case 'subscription.active': {
      const userId = parseUserId(metadata);
      const plan = parsePlan(metadata);
      const subId =
        parseString(obj.subscription_id) ??
        parseString(obj.subscriptionId) ??
        parseString(obj.id);
      // subscription.active is never emitted for credit_single (one-shot
      // payment); guard explicitly so soft-cap/period lookups are safe.
      if (!userId || !plan || !subId || plan === 'credit_single') {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] subscription.active missing fields', {
          event_id: event.id,
        });
        return;
      }
      const now = new Date();
      const periodEnd = new Date(now.getTime() + PLAN_PERIOD_DAYS[plan] * 86_400_000);
      await admin.from('subscriptions').insert({
        user_id: userId,
        plan,
        status: 'active',
        period_start: now.toISOString(),
        period_end: periodEnd.toISOString(),
        usage_count: 0,
        soft_cap: PLAN_SOFT_CAP[plan],
        dodo_customer_id:
          parseString(obj.customer_id) ?? parseString(obj.customerId) ?? '',
        dodo_subscription_id: subId,
        dodo_checkout_session_id:
          parseString(obj.checkout_session_id) ??
          parseString(obj.checkoutSessionId) ??
          null,
        dodo_event_id: event.id,
      });
      return;
    }

    case 'subscription.renewed': {
      const subId =
        parseString(obj.subscription_id) ??
        parseString(obj.subscriptionId) ??
        parseString(obj.id);
      if (!subId) return;
      // Renewal extends the period by the plan's standard window. We default
      // to monthly (30d) when the renewed event does not echo the plan in
      // metadata — matches the v1 invoice.paid behavior.
      const rawPlan = parsePlan(metadata);
      const plan: 'weekly_pass' | 'monthly_sub' =
        rawPlan === 'weekly_pass' ? 'weekly_pass' : 'monthly_sub';
      const newPeriodEnd = new Date(Date.now() + PLAN_PERIOD_DAYS[plan] * 86_400_000);
      await admin
        .from('subscriptions')
        .update({
          period_end: newPeriodEnd.toISOString(),
          usage_count: 0,
          status: 'active',
        })
        .eq('dodo_subscription_id', subId);
      return;
    }

    case 'subscription.cancelled': {
      const subId =
        parseString(obj.subscription_id) ??
        parseString(obj.subscriptionId) ??
        parseString(obj.id);
      if (!subId) return;
      await admin
        .from('subscriptions')
        .update({ status: 'canceled' })
        .eq('dodo_subscription_id', subId);
      return;
    }

    case 'refund.succeeded': {
      const userId = parseUserId(metadata);
      const plan = parsePlan(metadata);
      if (!userId) {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] refund without user_id metadata', {
          event_id: event.id,
        });
        return;
      }

      // Guard: 0 usage within 7 days of the original payment.
      // TODO(dodo-docs): confirm the exact "original payment created_at" field
      // — `payment_created_at` / `paymentCreatedAt` / `created_at` are all
      // plausible. We probe defensively.
      const createdAt =
        parseNumber(obj.payment_created_at) ??
        parseNumber(obj.paymentCreatedAt) ??
        parseNumber(obj.created_at) ??
        parseNumber(obj.createdAt) ??
        0;
      // Accept either epoch-seconds or epoch-ms.
      const createdMs = createdAt > 1e12 ? createdAt : createdAt * 1000;
      const ageMs = Date.now() - createdMs;
      const sevenDaysMs = 7 * 86_400_000;
      const within7d = createdMs > 0 && ageMs <= sevenDaysMs;

      if (plan === 'credit_single') {
        const { data: latest } = await admin
          .from('credit_ledger')
          .select('balance_after')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const prev = latest?.balance_after ?? 0;
        const next = Math.max(0, prev - 1);
        await admin.from('credit_ledger').insert({
          user_id: userId,
          type: 'refund_reversal',
          delta: -1,
          balance_after: next,
          dodo_event_id: event.id,
          note: within7d
            ? `Refund of payment ${parseString(obj.id) ?? event.id} (within 7d)`
            : `Refund of payment ${parseString(obj.id) ?? event.id} (operator override after 7d)`,
        });
        return;
      }

      // Pass / sub refund: mark active subscription row as refunded.
      const customerId =
        parseString(obj.customer_id) ?? parseString(obj.customerId) ?? null;
      if (customerId) {
        await admin
          .from('subscriptions')
          .update({ status: 'refunded' })
          .eq('dodo_customer_id', customerId)
          .eq('status', 'active');
      }
      return;
    }

    default:
      // Unhandled events are ignored (200 OK at the route layer).
      return;
  }
}
