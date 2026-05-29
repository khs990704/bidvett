/**
 * POST /api/analyze — core endpoint.
 * Source: _workspace/02_api_spec.md §3.5, _workspace/01_architecture.md §7.1.
 *
 * Sequence:
 *   1. Auth check
 *   2. Body parse (Zod) + length cap (64k chars HTTP gate, 16k LLM)
 *   3. IP rate limit (120/min)
 *   4. Per-user rate limit (60/min)
 *   5. Per-user in-flight lock (SET NX EX 30)
 *   6. Daily safety cap (min(soft_cap, 200))
 *   7. Pre-check credits (balance OR active sub/pass + soft cap)
 *   8. Load active analyze.v1 prompt + user profile
 *   9. OpenAI Structured Outputs with Silent Retry x3
 *   10. Rule engine + score finalize
 *   11. record_analysis_and_deduct RPC (race-free)
 *   12. Release lock
 *   13. Build response (mask match_score if DO_NOT_APPLY)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { withErrorHandling, ApiError, ErrorCode } from '@/lib/errors';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/supabase/require-user';
import {
  checkRate,
  acquireLock,
  releaseLock,
  incrDailyCap,
  kvGetJson,
  kvSetJsonEx,
  rlKey,
  lockKey,
  costKey,
  idemKey,
  clientIpFromHeaders,
} from '@/lib/rate-limit/kv';
import { getActivePrompt } from '@/lib/openai/prompts';
import { callStructuredWithRetry } from '@/lib/openai/client';
import {
  AnalysisResultJsonSchema,
  AnalysisResultZod,
} from '@/lib/openai/schemas';
import { evaluate } from '@/lib/risk-engine/rules';
import { finalizeScore } from '@/lib/risk-engine/score';
import { preCheckCredits, recordAnalysisAndDeduct } from '@/lib/credits/ledger';
import type { AnalyzeResponse } from '@/lib/types/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  job_text: z.string().min(50).max(64_000),
});

const SCAM_TIP = 'Skip this job and report it to Upwork TOS team.';

// Per-spec NFR-2: HTTP gate 64k chars; LLM input cap 16k chars.
const HTTP_CHAR_CAP = 64_000;
const LLM_CHAR_CAP = 16_000;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function buildUserMessage(args: {
  profile: {
    skills: string[];
    years_of_experience: number;
    target_hourly_rate: number;
    timezone: string;
  };
  jobText: string;
}): string {
  // Spec/03 §7.1: "[Freelancer Profile JSON]\n{...}\n\n[Job Posting Text]\n{...}"
  const profileJson = JSON.stringify(
    {
      skills: args.profile.skills,
      years_of_experience: args.profile.years_of_experience,
      target_hourly_rate: args.profile.target_hourly_rate,
      timezone: args.profile.timezone,
    },
    null,
    2,
  );
  return `[Freelancer Profile JSON]\n${profileJson}\n\n[Job Posting Text]\n${args.jobText}`;
}

export const POST = withErrorHandling(async (req: Request) => {
  const t0 = Date.now();

  // 1) Auth
  const user = await requireUser();

  // 2) Idempotency-Key short-circuit (returns cached response if within 60s)
  const idempotencyKey = req.headers.get('idempotency-key');
  if (idempotencyKey) {
    const cached = await kvGetJson<AnalyzeResponse>(
      idemKey.analyze(user.id, idempotencyKey),
    );
    if (cached) return NextResponse.json(cached);
  }

  // 3) IP rate limit
  const ip = clientIpFromHeaders(req.headers);
  const ipRl = await checkRate({ key: rlKey.ip(ip), windowSec: 60, limit: 120 });
  if (!ipRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'ip' });
  }

  // 4) Body parse + length gate
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, { reason: 'invalid_json' });
  }
  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new ApiError(400, ErrorCode.VALIDATION, {
      issues: parsed.error.issues.slice(0, 5),
    });
  }
  const jobText = parsed.data.job_text;
  if (jobText.length > HTTP_CHAR_CAP) {
    throw new ApiError(413, ErrorCode.INPUT_TOO_LARGE, {
      length: jobText.length,
      limit: HTTP_CHAR_CAP,
    });
  }
  if (jobText.length > LLM_CHAR_CAP) {
    // Soft cost guard — reject early before any LLM spend.
    throw new ApiError(413, ErrorCode.INPUT_TOO_LARGE, {
      length: jobText.length,
      limit: LLM_CHAR_CAP,
      hint: 'Pre-process before sending; LLM input is capped at 16k characters.',
    });
  }

  // 5) Per-user rate limit
  const userRl = await checkRate({
    key: rlKey.analyzeUser(user.id),
    windowSec: 60,
    limit: 60,
  });
  if (!userRl.allowed) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, { scope: 'user' });
  }

  // 6) In-flight lock (concurrent=1)
  const lockHeld = await acquireLock(lockKey.analyzeUser(user.id), 30);
  if (!lockHeld) {
    throw new ApiError(429, ErrorCode.RATE_LIMITED, {
      scope: 'concurrent',
      message: 'Another analysis is in flight.',
    });
  }

  try {
    // 7) Daily safety cap
    const daily = await incrDailyCap(costKey.dailyUser(user.id), 24 * 3600);
    // Conservative ceiling: min(soft_cap, 200). MVP defaults to 200.
    const DAILY_CAP = 200;
    if (daily > DAILY_CAP) {
      throw new ApiError(429, ErrorCode.RATE_LIMITED, {
        reason: 'daily_safety_cap',
        cap: DAILY_CAP,
      });
    }

    // 8) Pre-check credits
    const pre = await preCheckCredits(user.id);
    if (!pre.ok) {
      const code = pre.code === 'ERR_SOFT_CAP_REACHED'
        ? ErrorCode.SOFT_CAP_REACHED
        : ErrorCode.OUT_OF_CREDITS;
      throw new ApiError(402, code, pre.details);
    }

    // 9) Load profile (RLS, user-scoped)
    const supabase = await createSupabaseServerClient();
    const { data: profileRow, error: profileErr } = await supabase
      .from('users_profile')
      .select('skills, years_of_experience, target_hourly_rate, timezone')
      .eq('user_id', user.id)
      .maybeSingle();
    if (profileErr) {
      throw new ApiError(500, ErrorCode.INTERNAL, { reason: 'profile_select_failed' });
    }
    if (!profileRow) {
      // No profile yet → onboarding incomplete. Treat as bad request with hint.
      throw new ApiError(400, ErrorCode.BAD_REQUEST, {
        reason: 'profile_missing',
        hint: 'Complete onboarding before analyzing.',
      });
    }

    // 10) Load prompt + call OpenAI with Silent Retry x3
    const prompt = await getActivePrompt('analyze.v1');
    const userMsg = buildUserMessage({
      profile: {
        skills: profileRow.skills as string[],
        years_of_experience: profileRow.years_of_experience as number,
        target_hourly_rate: profileRow.target_hourly_rate as number,
        timezone: profileRow.timezone as string,
      },
      jobText,
    });

    const llm = await callStructuredWithRetry({
      promptName: 'analyze.v1',
      systemPrompt: prompt.content,
      userMessage: userMsg,
      schemaName: AnalysisResultJsonSchema.name,
      jsonSchema: AnalysisResultJsonSchema.schema as Record<string, unknown>,
      zodSchema: AnalysisResultZod,
      maxInputChars: LLM_CHAR_CAP,
    });

    // 11) Rule engine + score finalize
    const quant = {
      client_hire_rate: llm.data.client_hire_rate,
      payment_verified: llm.data.payment_verified,
      total_spend_amount: llm.data.total_spend_amount,
      client_rating: llm.data.client_rating,
    };
    const rule = evaluate(quant);
    const finalized = finalizeScore({
      llm_match_score: llm.data.match_score,
      risk_level: llm.data.risk_level,
      backend_critical: rule.critical,
    });

    const actionTip =
      rule.critical || llm.data.risk_level === 'DANGER'
        ? SCAM_TIP
        : llm.data.action_tip;

    const tookMs = Date.now() - t0;
    const jobHash = sha256Hex(jobText);

    // 12) Race-free record + deduct
    const rpc = await recordAnalysisAndDeduct({
      p_user_id: user.id,
      p_verdict: finalized.verdict,
      p_backend_critical: rule.critical,
      p_backend_rules_triggered: rule.rules_triggered,
      p_ai_risk_level: llm.data.risk_level,
      p_contextual_red_flags: llm.data.contextual_red_flags,
      p_match_score: finalized.match_score,
      p_score_reason: finalized.verdict === 'DO_NOT_APPLY' ? null : llm.data.score_reason,
      p_action_tip: actionTip,
      p_extracted_signals: quant,
      p_prompt_version: prompt.version,
      p_input_tokens: llm.usage.prompt_tokens,
      p_output_tokens: llm.usage.completion_tokens,
      p_took_ms: tookMs,
      p_job_text_hash: jobHash,
    });

    if (!rpc.ok) {
      if (rpc.insufficient) {
        throw new ApiError(402, ErrorCode.OUT_OF_CREDITS, { balance: 0 });
      }
      throw new ApiError(500, ErrorCode.INTERNAL, { reason: 'rpc_failed' });
    }

    // 13) Build response
    const response: AnalyzeResponse = {
      analysis_id: rpc.row.analysis_id,
      verdict: finalized.verdict,
      backend_risk: {
        critical: rule.critical,
        rules_triggered: rule.rules_triggered,
      },
      ai_risk: {
        risk_level: llm.data.risk_level,
        contextual_red_flags: llm.data.contextual_red_flags,
      },
      match_score: finalized.match_score,
      score_reason: finalized.verdict === 'DO_NOT_APPLY' ? null : llm.data.score_reason,
      action_tip: actionTip,
      extracted_signals: quant,
      credit_after: rpc.row.balance_after,
      took_ms: tookMs,
      prompt_version: prompt.version,
    };

    if (idempotencyKey) {
      await kvSetJsonEx(idemKey.analyze(user.id, idempotencyKey), response, 60);
    }

    return NextResponse.json(response);
  } finally {
    await releaseLock(lockKey.analyzeUser(user.id));
  }
});
