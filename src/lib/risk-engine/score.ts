/**
 * Match score finalizer.
 * Source: _workspace/01_architecture.md §6.3.
 *
 * The LLM (analyze.v1) computes 40/30/30 weighting internally. This
 * module is post-LLM and only enforces:
 *   - Range clamp [0, 100]
 *   - DANGER or backend-critical => match_score = null, verdict = DO_NOT_APPLY
 *   - Otherwise => verdict = SHOW_REPORT
 */
import type { RiskLevel, Verdict } from '@/lib/types/api';

export interface FinalizeInput {
  llm_match_score: number;
  risk_level: RiskLevel;
  backend_critical: boolean;
}

export interface FinalizeOutput {
  match_score: number | null;
  verdict: Verdict;
}

export function finalizeScore(input: FinalizeInput): FinalizeOutput {
  const isDanger = input.risk_level === 'DANGER';
  if (isDanger || input.backend_critical) {
    return { match_score: null, verdict: 'DO_NOT_APPLY' };
  }
  const clamped = Math.max(0, Math.min(100, Math.trunc(input.llm_match_score)));
  return { match_score: clamped, verdict: 'SHOW_REPORT' };
}
