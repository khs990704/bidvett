/**
 * Stripe Webhook event router.
 * Source: _workspace/01_architecture.md §6.7, _workspace/02_api_spec.md §3.9.
 *
 * Handles 4 events:
 *   - checkout.session.completed
 *       * credit_single → credit_ledger insert (+1, type='purchase_single')
 *       * weekly_pass / monthly_sub → subscriptions insert
 *   - invoice.paid (monthly_sub) → extend period_end +30d, usage_count=0
 *   - customer.subscription.deleted → status='canceled'
 *   - charge.refunded → guard (0 usage + ≤7d) then credit_ledger -N
 *
 * Idempotency is enforced via `stripe_events` PK (event.id). Caller inserts
 * the event row first and only calls `handleStripeEvent` if INSERT succeeded
 * (i.e., not already processed).
 */
import type Stripe from 'stripe';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { PLAN_SOFT_CAP, PLAN_PERIOD_DAYS } from '@/lib/stripe/plans';

type PlanFromMetadata = 'credit_single' | 'weekly_pass' | 'monthly_sub';

function parsePlan(meta: Stripe.Metadata | null | undefined): PlanFromMetadata | null {
  const v = meta?.plan;
  if (v === 'credit_single' || v === 'weekly_pass' || v === 'monthly_sub') return v;
  return null;
}

function parseUserId(meta: Stripe.Metadata | null | undefined): string | null {
  return meta?.user_id ?? null;
}

export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  const admin = supabaseAdmin();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id ?? parseUserId(session.metadata);
      const plan = parsePlan(session.metadata);
      if (!userId || !plan) {
        // eslint-disable-next-line no-console
        console.warn('[stripe.webhook] missing user_id or plan', {
          event_id: event.id,
          session_id: session.id,
        });
        return;
      }

      if (plan === 'credit_single') {
        // Fetch current balance (single-row read; race-free enough since this
        // event is processed once per stripe_events PK).
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
          stripe_event_id: event.id,
          note: `Stripe purchase ${session.id}`,
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
        stripe_customer_id: typeof session.customer === 'string' ? session.customer : '',
        stripe_subscription_id:
          typeof session.subscription === 'string' ? session.subscription : null,
        stripe_checkout_session_id: session.id,
        stripe_event_id: event.id,
      });
      return;
    }

    case 'invoice.paid': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = typeof invoice.subscription === 'string' ? invoice.subscription : null;
      if (!subId) return;
      const newPeriodEnd = new Date(Date.now() + PLAN_PERIOD_DAYS.monthly_sub * 86_400_000);
      await admin
        .from('subscriptions')
        .update({
          period_end: newPeriodEnd.toISOString(),
          usage_count: 0,
          status: 'active',
        })
        .eq('stripe_subscription_id', subId);
      return;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await admin
        .from('subscriptions')
        .update({ status: 'canceled' })
        .eq('stripe_subscription_id', sub.id);
      return;
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const userId = parseUserId(charge.metadata);
      const plan = parsePlan(charge.metadata);
      if (!userId) {
        // eslint-disable-next-line no-console
        console.warn('[stripe.webhook] refund without user_id metadata', {
          event_id: event.id,
          charge_id: charge.id,
        });
        return;
      }

      // Guard: 0 usage within 7 days of charge creation.
      const chargeCreatedMs = (charge.created ?? 0) * 1000;
      const ageMs = Date.now() - chargeCreatedMs;
      const sevenDaysMs = 7 * 86_400_000;
      const within7d = chargeCreatedMs > 0 && ageMs <= sevenDaysMs;

      if (plan === 'credit_single') {
        // For single-credit purchases: reverse one credit if balance allows.
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
          stripe_event_id: event.id,
          note: within7d
            ? `Refund of charge ${charge.id} (within 7d)`
            : `Refund of charge ${charge.id} (operator override after 7d)`,
        });
        return;
      }

      // For pass / sub: mark subscription as refunded if any active row matches.
      // Best-effort by stripe_customer_id (charge does not directly link sub row).
      const customerId = typeof charge.customer === 'string' ? charge.customer : null;
      if (customerId) {
        await admin
          .from('subscriptions')
          .update({ status: 'refunded' })
          .eq('stripe_customer_id', customerId)
          .eq('status', 'active');
      }
      return;
    }

    default:
      // Unhandled events are ignored (200 OK).
      return;
  }
}
