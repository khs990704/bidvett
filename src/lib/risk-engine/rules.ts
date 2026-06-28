/**
 * Quantitative Risk Engine.
 * Source: _workspace/01_architecture.md §6.2, spec/03 §6.1 thresholds.
 *
 * Pure function — no side effects, no DB. 100% unit-testable.
 *
 * Thresholds:
 *   LOW_HIRE_RATE                  := hire rate was found AND client_hire_rate < 20
 *   PAYMENT_UNVERIFIED_ZERO_SPEND  := payment and spend were found AND !payment_verified AND spend === 0
 *   LOW_RATING                     := rating was found AND client_rating > 0 AND <= 3.5
 *
 * If ANY rule fires, `critical = true`.
 */

export interface QuantSignals {
  client_hire_rate: number;
  client_hire_rate_found?: boolean;
  payment_verified: boolean;
  payment_verified_found?: boolean;
  total_spend_amount: number;
  total_spend_found?: boolean;
  client_rating: number;
  client_rating_found?: boolean;
}

export type RuleTriggerCode =
  | 'LOW_HIRE_RATE'
  | 'PAYMENT_UNVERIFIED_ZERO_SPEND'
  | 'LOW_RATING';

export interface RuleResult {
  critical: boolean;
  rules_triggered: RuleTriggerCode[];
}

export function evaluate(q: QuantSignals): RuleResult {
  const triggered: RuleTriggerCode[] = [];
  const hireRateKnown = q.client_hire_rate_found ?? true;
  const paymentKnown = q.payment_verified_found ?? true;
  const spendKnown = q.total_spend_found ?? true;
  const ratingKnown = q.client_rating_found ?? true;

  if (hireRateKnown && q.client_hire_rate < 20) {
    triggered.push('LOW_HIRE_RATE');
  }

  if (paymentKnown && spendKnown && !q.payment_verified && q.total_spend_amount === 0) {
    triggered.push('PAYMENT_UNVERIFIED_ZERO_SPEND');
  }

  if (ratingKnown && q.client_rating > 0 && q.client_rating <= 3.5) {
    triggered.push('LOW_RATING');
  }

  return {
    critical: triggered.length > 0,
    rules_triggered: triggered,
  };
}
