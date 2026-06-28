/**
 * Credit & subscription pre-check helpers + RPC wrapper.
 * Source: _workspace/02_api_spec.md §3.5 step 7 (pre-check),
 *         _workspace/03_db_schema.md §5.3 (record_analysis_and_deduct).
 *
 * Pre-check is advisory — the RPC is the race-free authority. Caller
 * surfaces ERR_OUT_OF_CREDITS / ERR_SOFT_CAP_REACHED based on pre-check,
 * and falls back to the same codes if the RPC raises P0001.
 */
import { supabaseAdmin } from '@/lib/supabase/admin';

export interface PreCheckOk {
  ok: true;
  source: 'subscription' | 'credit';
  balance: number;
  active_sub?: {
    id: string;
    plan: 'weekly_pass' | 'monthly_sub';
    usage_count: number;
    soft_cap: number;
    period_end: string;
  };
}

export interface PreCheckFail {
  ok: false;
  code: 'ERR_OUT_OF_CREDITS' | 'ERR_SOFT_CAP_REACHED';
  details: Record<string, unknown>;
}

export type PreCheckResult = PreCheckOk | PreCheckFail;

export async function preCheckCredits(userId: string): Promise<PreCheckResult> {
  const admin = supabaseAdmin();

  // Latest credit balance
  const { data: ledger } = await admin
    .from('credit_ledger')
    .select('balance_after')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const balance = ledger?.balance_after ?? 0;

  // Active sub/pass (oldest active wins, matches RPC FIFO)
  const { data: subs } = await admin
    .from('subscriptions')
    .select('id, plan, usage_count, soft_cap, period_end')
    .eq('user_id', userId)
    .eq('status', 'active')
    .gt('period_end', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(1);
  const sub = subs?.[0];

  if (sub) {
    if (sub.usage_count < sub.soft_cap) {
      return {
        ok: true,
        source: 'subscription',
        balance,
        active_sub: {
          id: sub.id,
          plan: sub.plan as 'weekly_pass' | 'monthly_sub',
          usage_count: sub.usage_count,
          soft_cap: sub.soft_cap,
          period_end: sub.period_end,
        },
      };
    }
    // Active sub but cap reached. If there are credits, fall through to use them.
    if (balance >= 1) {
      return { ok: true, source: 'credit', balance };
    }
    return {
      ok: false,
      code: 'ERR_SOFT_CAP_REACHED',
      details: {
        plan: sub.plan,
        usage_count: sub.usage_count,
        soft_cap: sub.soft_cap,
        period_end: sub.period_end,
      },
    };
  }

  if (balance >= 1) {
    return { ok: true, source: 'credit', balance };
  }
  return {
    ok: false,
    code: 'ERR_OUT_OF_CREDITS',
    details: { balance },
  };
}

export interface RpcParams {
  p_user_id: string;
  p_verdict: 'SHOW_REPORT' | 'DO_NOT_APPLY';
  p_backend_critical: boolean;
  p_backend_rules_triggered: string[];
  p_ai_risk_level: 'SAFE' | 'WARNING' | 'DANGER';
  p_contextual_red_flags: string[];
  p_match_score: number | null;
  p_score_reason: string | null;
  p_action_tip: string;
  p_extracted_signals: Record<string, unknown>;
  p_evidence_quotes: string[];
  p_reasoning_bullets: string[];
  p_prompt_version: number;
  p_input_tokens: number;
  p_output_tokens: number;
  p_took_ms: number;
  p_job_text_hash: string;
  p_job_title: string | null;
}

export interface RpcRow {
  analysis_id: string;
  balance_after: number;
  source: string;
}

export async function recordAnalysisAndDeduct(
  params: RpcParams,
): Promise<{ ok: true; row: RpcRow } | { ok: false; insufficient: boolean }> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('record_analysis_and_deduct', params);
  if (error) {
    // Postgres custom errcode P0001 means INSUFFICIENT_CREDIT (race fallback).
    if (error.code === 'P0001' || /INSUFFICIENT_CREDIT/i.test(error.message ?? '')) {
      return { ok: false, insufficient: true };
    }
    // eslint-disable-next-line no-console
    console.error('[rpc] record_analysis_and_deduct', error);
    return { ok: false, insufficient: false };
  }
  // Supabase returns the SETOF row as an array.
  const row = Array.isArray(data) ? data[0] : (data as RpcRow | null);
  if (!row) return { ok: false, insufficient: false };
  return { ok: true, row };
}
