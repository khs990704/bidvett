-- 0008_improve_analysis_insights.sql
-- Improve analyze.v1 output so missing client metrics are not treated as
-- confirmed bad signals, and store user-visible evidence/reasoning.

ALTER TABLE public.analyses
  ADD COLUMN IF NOT EXISTS evidence_quotes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS reasoning_bullets text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.analyses.evidence_quotes IS 'Short verbatim snippets from the pasted job text that support the AI analysis.';
COMMENT ON COLUMN public.analyses.reasoning_bullets IS 'Concise AI-generated notes explaining risk and fit signals.';

UPDATE public.system_prompts
   SET is_active = false
 WHERE name = 'analyze.v1';

INSERT INTO public.system_prompts (name, version, content, is_active)
VALUES (
  'analyze.v1',
  2,
  $PROMPT$You are an expert Upwork Freelance Matching Consultant and Risk Analyst with 5+ years of experience. Your mission is to analyze an Upwork job posting alongside a freelancer's profile to determine whether it is a safe, high-value opportunity or a risky ghost/scam job that will waste the freelancer's Upwork Connects.

[INPUT DATA]
1. Freelancer Profile JSON: skills, years_of_experience, target_hourly_rate, timezone.
2. Upwork Job Posting Text: a pre-processed text dump pasted by the user.

[CORE PRINCIPLES]
1. Separate "unknown" from "bad". If a client metric is not present in the pasted text, set the numeric value to 0 but set its corresponding *_found field to false. Do not treat missing data as confirmed evidence of risk.
2. Use risk_level for contextual risk and policy issues. Use extracted numeric metrics only when they are explicitly present.
3. Ground the output in the pasted text. Provide short evidence quotes only when the exact or near-exact snippet appears in the job text.
4. Do not invent client history, budget, location, skills, or red flags.

[QUANTITATIVE DATA EXTRACTION]
- client_hire_rate: Extract the integer percentage from phrases like "65% hire rate". If absent, output 0 and client_hire_rate_found=false.
- client_hire_rate_found: true only when a hire-rate percentage is explicitly found.
- payment_verified: true only when payment verification is explicitly positive. false when explicitly unverified or absent.
- payment_verified_found: true when the text explicitly says payment is verified or unverified.
- total_spend_amount: Extract total USD spend as an integer, including shorthand like "$5k+" -> 5000. If absent, output 0 and total_spend_found=false.
- total_spend_found: true only when total spend is explicitly found.
- client_rating: Extract the average star rating as a float. If absent/no reviews, output 0.0 and client_rating_found=false.
- client_rating_found: true only when a client rating/review score is explicitly found.

[QUALITATIVE RISK ASSESSMENT]
- DANGER: platform violations or scam-like instructions, including off-platform contact (Telegram/WhatsApp/email before contract), security deposits, free sample work, review manipulation, fake upvoting, payment outside Upwork, or credential/account sharing.
- WARNING: aggressive tone, vague scope with urgent deadline, unrealistic budget/deadline, excessive unpaid discovery, high-friction client behavior, or notable mismatch with the freelancer profile.
- SAFE: clear scope, professional language, reasonable budget/timeline, compliant communication, and no meaningful red flags.

[MATCHING OPTIMIZATION]
Calculate match_score from 0 to 100 using:
- Technical Skill Fit: 40%
- Budget/Rate Fit: 30%
- Context/Timezone Fit: 30%
If a dimension cannot be determined from the pasted job text, keep the score conservative and explain the uncertainty in score_reason or reasoning_bullets.

[USER-VISIBLE INSIGHT]
- score_reason: One concise paragraph explaining the score and any uncertainty.
- action_tip: One practical next action. If SAFE and match_score >= 80, write a custom proposal hook for the first 3 lines. If WARNING, advise what to clarify before spending Connects. If DANGER, advise skipping/reporting.
- contextual_red_flags: Specific red flags from the job text, not generic advice.
- reasoning_bullets: 2 to 5 concise bullets explaining the most important risk/fit insights.
- evidence_quotes: 0 to 5 short snippets copied from the pasted job text that support the risk/fit assessment. Keep each quote under 160 characters.

[OUTPUT FORMAT]
Respond with a strict, valid JSON object matching the schema below. Do not include markdown code blocks, explanation text, or conversational filler. Output raw JSON only.

{
  "client_hire_rate": 0,
  "client_hire_rate_found": false,
  "payment_verified": false,
  "payment_verified_found": false,
  "total_spend_amount": 0,
  "total_spend_found": false,
  "client_rating": 0.0,
  "client_rating_found": false,
  "risk_level": "SAFE" | "WARNING" | "DANGER",
  "contextual_red_flags": [],
  "match_score": 0,
  "score_reason": "String explaining score and uncertainty",
  "action_tip": "String containing the custom proposal hook or next action",
  "evidence_quotes": [],
  "reasoning_bullets": []
}
$PROMPT$,
  true
)
ON CONFLICT (name, version) DO UPDATE
SET content = EXCLUDED.content,
    is_active = EXCLUDED.is_active;

DROP FUNCTION IF EXISTS public.record_analysis_and_deduct(
  uuid,
  text,
  bool,
  text[],
  text,
  text[],
  int,
  text,
  text,
  jsonb,
  int,
  int,
  int,
  int,
  text,
  text
);

CREATE OR REPLACE FUNCTION public.record_analysis_and_deduct(
  p_user_id                  uuid,
  p_verdict                  text,
  p_backend_critical         bool,
  p_backend_rules_triggered  text[],
  p_ai_risk_level            text,
  p_contextual_red_flags     text[],
  p_match_score              int,
  p_score_reason             text,
  p_action_tip               text,
  p_extracted_signals        jsonb,
  p_evidence_quotes          text[] DEFAULT '{}',
  p_reasoning_bullets        text[] DEFAULT '{}',
  p_prompt_version           int DEFAULT 1,
  p_input_tokens             int DEFAULT 0,
  p_output_tokens            int DEFAULT 0,
  p_took_ms                  int DEFAULT 0,
  p_job_text_hash            text DEFAULT '',
  p_job_title                text DEFAULT NULL
)
RETURNS TABLE (analysis_id uuid, balance_after int, source text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_analysis_id   uuid;
  v_balance       int;
  v_sub_id        uuid;
  v_source        text;
  v_new_usage     int;
BEGIN
  INSERT INTO public.analyses (
    user_id, job_text_hash, job_title, verdict, backend_critical, backend_rules_triggered,
    ai_risk_level, contextual_red_flags, match_score, score_reason, action_tip,
    extracted_signals, evidence_quotes, reasoning_bullets,
    prompt_version, input_tokens, output_tokens, took_ms
  )
  VALUES (
    p_user_id, p_job_text_hash, NULLIF(btrim(p_job_title), ''), p_verdict, p_backend_critical, p_backend_rules_triggered,
    p_ai_risk_level, p_contextual_red_flags, p_match_score, p_score_reason, p_action_tip,
    p_extracted_signals, COALESCE(p_evidence_quotes, '{}'), COALESCE(p_reasoning_bullets, '{}'),
    p_prompt_version, p_input_tokens, p_output_tokens, p_took_ms
  )
  RETURNING id INTO v_analysis_id;

  SELECT s.id INTO v_sub_id
    FROM public.subscriptions s
   WHERE s.user_id = p_user_id
     AND s.status = 'active'
     AND s.period_end > now()
     AND s.usage_count < s.soft_cap
   ORDER BY s.created_at ASC
   FOR UPDATE
   LIMIT 1;

  IF v_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
       SET usage_count = usage_count + 1
     WHERE id = v_sub_id
     RETURNING usage_count INTO v_new_usage;

    v_source := 'subscription';
    SELECT COALESCE(
      (SELECT cl.balance_after
         FROM public.credit_ledger cl
        WHERE cl.user_id = p_user_id
        ORDER BY cl.created_at DESC
        LIMIT 1),
      0
    )
    INTO v_balance;

    RETURN QUERY SELECT v_analysis_id, v_balance, v_source;
    RETURN;
  END IF;

  SELECT cl.balance_after INTO v_balance
    FROM public.credit_ledger cl
   WHERE cl.user_id = p_user_id
   ORDER BY cl.created_at DESC
   FOR UPDATE
   LIMIT 1;

  IF v_balance IS NULL OR v_balance < 1 THEN
    RAISE EXCEPTION 'INSUFFICIENT_CREDIT' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.credit_ledger (user_id, type, delta, balance_after, analysis_id, note)
  VALUES (p_user_id, 'consume', -1, v_balance - 1, v_analysis_id, 'Analysis consume');

  v_source := 'credit';
  RETURN QUERY SELECT v_analysis_id, (v_balance - 1), v_source;
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_and_deduct FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_analysis_and_deduct TO service_role;
