/**
 * Plan ↔ soft cap mapping.
 * Source: _workspace/02_api_spec.md §3.9 (webhook handlers).
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
