/**
 * Dodo Payments Webhook router.
 *
 * Verification: Standard Webhooks (https://www.standardwebhooks.com/).
 * Required headers on inbound POST:
 *   - webhook-id        ← also the event/idempotency id (body has no `id`).
 *   - webhook-timestamp
 *   - webhook-signature
 *
 * Subscribed events (Dodo Dashboard → Webhook endpoint):
 *   - payment.succeeded      → credit_single only (one-time credit purchase).
 *   - subscription.active    → weekly_pass / monthly_sub upsert.
 *   - subscription.renewed   → extend period, reset usage_count + cancelled_at.
 *   - subscription.cancelled → record cancelled_at; status unchanged.
 *
 * Payload shape is per `dodopayments` SDK `WebhookPayload`:
 *   { business_id, type, timestamp, data: Payment | Subscription | Refund | ... }
 * `data` IS the underlying entity (no `data.object` wrapper).
 */
import { Webhook } from 'standardwebhooks';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env';
import { PLAN_SOFT_CAP, PLAN_PERIOD_DAYS } from '@/lib/dodo/plans';

export interface VerifiedDodoPayload {
  type: string;
  data: Record<string, unknown>;
}

export interface DodoEvent {
  /** Sourced from the `webhook-id` HTTP header (Standard Webhooks message id). */
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
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function parseString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ── Signature verification (Standard Webhooks) ────────────────────────
export interface VerifyArgs {
  rawBody: string;
  headers: Record<string, string>;
  secret?: string;
}

/**
 * Verifies the Standard Webhooks signature and returns the parsed payload.
 * Throws WebhookVerificationError (or similar) on invalid sig / timestamp.
 *
 * The Dodo secret is issued as `whsec_<base64>`. The `standardwebhooks` lib
 * strips the prefix and base64-decodes automatically — pass it as-is.
 */
export function verifyDodoSignature(args: VerifyArgs): VerifiedDodoPayload {
  const secret = args.secret ?? serverEnv().DODO_WEBHOOK_SECRET;
  const wh = new Webhook(secret);
  const verified = wh.verify(args.rawBody, args.headers) as unknown;
  const evt = asRecord(verified);
  if (!evt || typeof evt.type !== 'string') {
    throw new Error('Verified payload is not a valid Dodo event envelope');
  }
  return {
    type: evt.type,
    data: asRecord(evt.data) ?? {},
  };
}

// ── Event dispatch ────────────────────────────────────────────────────
export async function handleDodoEvent(event: DodoEvent): Promise<void> {
  const admin = supabaseAdmin();
  const data = event.data;
  const metadata = asRecord(data.metadata);
  const customer = asRecord(data.customer);

  switch (event.type) {
    case 'payment.succeeded': {
      // One-time credit purchase only. Subscription-plan first payments are
      // handled by subscription.active (the recurring source of truth).
      const userId = parseUserId(metadata);
      const plan = parsePlan(metadata);
      if (!userId || !plan) {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] payment.succeeded missing metadata', {
          event_id: event.id,
        });
        return;
      }
      if (plan !== 'credit_single') {
        // weekly_pass / monthly_sub → defer to subscription.active.
        return;
      }

      const { data: latest } = await admin
        .from('credit_ledger')
        .select('balance_after')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const prev = latest?.balance_after ?? 0;
      const insertRes = await admin.from('credit_ledger').insert({
        user_id: userId,
        type: 'purchase_single',
        delta: 1,
        balance_after: prev + 1,
        dodo_event_id: event.id,
        note: `Dodo purchase ${parseString(data.payment_id) ?? event.id}`,
      });
      // 23505 = unique_violation on uniq_credit_ledger_dodo_event — duplicate
      // delivery already credited, safe to swallow.
      if (insertRes.error && insertRes.error.code !== '23505') {
        throw insertRes.error;
      }
      return;
    }

    case 'subscription.active': {
      const userId = parseUserId(metadata);
      const plan = parsePlan(metadata);
      const subId = parseString(data.subscription_id);
      const customerId = parseString(customer?.customer_id);

      if (!userId || !plan || !subId || !customerId || plan === 'credit_single') {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] subscription.active missing fields', {
          event_id: event.id,
          have: {
            userId: !!userId,
            plan,
            subId: !!subId,
            customerId: !!customerId,
          },
        });
        return;
      }

      const periodStart =
        parseString(data.previous_billing_date) ?? new Date().toISOString();
      const periodEnd =
        parseString(data.next_billing_date) ??
        new Date(Date.now() + PLAN_PERIOD_DAYS[plan] * 86_400_000).toISOString();

      // Idempotent upsert by dodo_subscription_id. The dodo_events PK guards
      // same-delivery retries; this guards repeat subscription.active events
      // (e.g., on_hold → active transitions).
      const { data: existing } = await admin
        .from('subscriptions')
        .select('id')
        .eq('dodo_subscription_id', subId)
        .maybeSingle();

      if (existing) {
        await admin
          .from('subscriptions')
          .update({
            status: 'active',
            period_start: periodStart,
            period_end: periodEnd,
            usage_count: 0,
            cancelled_at: null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
      } else {
        // Plan-upgrade reconciliation: the partial index
        // uniq_subscriptions_active_per_user permits only one active row per
        // user. Cancel any other active row before inserting the new one so a
        // weekly→monthly upgrade does not 23505. The previous row keeps its
        // dodo_subscription_id, so refund / cancel webhooks can still target it.
        await admin
          .from('subscriptions')
          .update({
            status: 'canceled',
            cancelled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
          .eq('status', 'active')
          .neq('dodo_subscription_id', subId);

        const insertRes = await admin.from('subscriptions').insert({
          user_id: userId,
          plan,
          status: 'active',
          period_start: periodStart,
          period_end: periodEnd,
          usage_count: 0,
          soft_cap: PLAN_SOFT_CAP[plan],
          dodo_customer_id: customerId,
          dodo_subscription_id: subId,
          dodo_event_id: event.id,
        });
        if (insertRes.error && insertRes.error.code !== '23505') {
          throw insertRes.error;
        }
      }
      return;
    }

    case 'subscription.renewed': {
      // Recurring payment succeeded → roll the billing window forward and
      // reset the usage counter. cancelled_at is nulled defensively (a renewal
      // should not happen with a pending cancel, but if it does, the user paid
      // so they get the new period).
      const subId = parseString(data.subscription_id);
      if (!subId) {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] subscription.renewed missing subscription_id', {
          event_id: event.id,
        });
        return;
      }
      const periodStart =
        parseString(data.previous_billing_date) ?? new Date().toISOString();
      const periodEnd = parseString(data.next_billing_date);
      if (!periodEnd) {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] subscription.renewed missing next_billing_date', {
          event_id: event.id,
        });
        return;
      }
      await admin
        .from('subscriptions')
        .update({
          status: 'active',
          period_start: periodStart,
          period_end: periodEnd,
          usage_count: 0,
          cancelled_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('dodo_subscription_id', subId);
      return;
    }

    case 'subscription.cancelled': {
      // Record cancelled_at only; status remains 'active' so the user keeps
      // access until period_end. /api/credits derives cancel_at_period_end
      // from cancelled_at IS NOT NULL.
      const subId = parseString(data.subscription_id);
      if (!subId) {
        // eslint-disable-next-line no-console
        console.warn('[dodo.webhook] subscription.cancelled missing subscription_id', {
          event_id: event.id,
        });
        return;
      }
      const cancelledAt =
        parseString(data.cancelled_at) ?? new Date().toISOString();
      await admin
        .from('subscriptions')
        .update({
          cancelled_at: cancelledAt,
          updated_at: new Date().toISOString(),
        })
        .eq('dodo_subscription_id', subId);
      return;
    }

    default:
      // Not subscribed in the current Dodo dashboard config — silently ignore.
      return;
  }
}
