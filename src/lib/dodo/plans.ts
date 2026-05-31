/**
 * Plan ↔ soft cap / period mapping for Dodo Payments.
 * Source: _workspace/02_api_spec.md §3.9 (webhook handlers), §11.3 (PIVOT-01).
 *
 * Soft cap + period business logic is unchanged from the v1 (Stripe) design —
 * only the provider that triggers grants/renewals is different.
 */
import type { PlanKey } from '@/lib/types/api';
type PlanCode = PlanKey;

export const PLAN_SOFT_CAP: Record<'weekly_pass' | 'monthly_sub', number> = {
  weekly_pass: 100,
  monthly_sub: 500,
};

export const PLAN_PERIOD_DAYS: Record<'weekly_pass' | 'monthly_sub', number> = {
  weekly_pass: 7,
  monthly_sub: 30,
};

export function isSubscriptionPlan(plan: PlanCode): plan is 'weekly_pass' | 'monthly_sub' {
  return plan === 'weekly_pass' || plan === 'monthly_sub';
}

/**
 * Dodo Customer Portal URL (placeholder).
 * TODO(dodo-docs): confirm exact customer-portal URL pattern — Dodo may issue a
 * per-customer signed link rather than a single public entry point.
 */
export const DODO_CUSTOMER_PORTAL_URL = 'https://app.dodopayments.com/customer-portal';
