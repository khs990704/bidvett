-- 0007_add_analysis_job_title.sql
-- Store a human-readable title for each analysis when it can be extracted
-- from the pasted Upwork job page.

ALTER TABLE public.analyses
  ADD COLUMN IF NOT EXISTS job_title text;

COMMENT ON COLUMN public.analyses.job_title IS 'Nullable extracted Upwork job title shown in analysis history.';

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
  p_prompt_version           int,
  p_input_tokens             int,
  p_output_tokens            int,
  p_took_ms                  int,
  p_job_text_hash            text,
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
    extracted_signals, prompt_version, input_tokens, output_tokens, took_ms
  )
  VALUES (
    p_user_id, p_job_text_hash, NULLIF(btrim(p_job_title), ''), p_verdict, p_backend_critical, p_backend_rules_triggered,
    p_ai_risk_level, p_contextual_red_flags, p_match_score, p_score_reason, p_action_tip,
    p_extracted_signals, p_prompt_version, p_input_tokens, p_output_tokens, p_took_ms
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
