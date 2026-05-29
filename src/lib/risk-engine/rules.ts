/**
 * Quantitative Risk Engine.
 * Source: _workspace/01_architecture.md §6.2, spec/03 §6.1 thresholds.
 *
 * Pure function — no side effects, no DB. 100% unit-testable.
 *
 * Thresholds:
 *   LOW_HIRE_RATE                  := client_hire_rate < 20
 *   PAYMENT_UNVERIFIED_ZERO_SPEND  := !payment_verified && total_spend_amount === 0
 *   LOW_RATING                     := client_rating > 0 && client_rating <= 3.5
 *
 * If ANY rule fires, `critical = true`.
 */

export interface QuantSignals {
  client_hire_rate: number;
  payment_verified: boolean;
  total_spend_amount: number;
  client_rating: number;
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

  if (q.client_hire_rate < 20) {
    triggered.push('LOW_HIRE_RATE');
  }

  if (!q.payment_verified && q.total_spend_amount === 0) {
    triggered.push('PAYMENT_UNVERIFIED_ZERO_SPEND');
  }

  if (q.client_rating > 0 && q.client_rating <= 3.5) {
    triggered.push('LOW_RATING');
  }

  return {
    critical: triggered.length > 0,
    rules_triggered: triggered,
  };
}
