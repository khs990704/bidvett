-- 0003_triggers_and_rpc.sql — updated_at triggers + signup grant + record_analysis_and_deduct
-- Source: _workspace/03_db_schema.md §5

-- ====================================================================
-- 1) updated_at trigger helper
-- ====================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_profile_updated_at ON public.users_profile;
CREATE TRIGGER trg_users_profile_updated_at
  BEFORE UPDATE ON public.users_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON public.subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ====================================================================
-- 2) grant_free_credits_on_signup — +3 credits on new auth.users insert
-- ====================================================================
CREATE OR REPLACE FUNCTION public.grant_free_credits_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.credit_ledger (user_id, type, delta, balance_after, note)
  VALUES (NEW.id, 'free_grant', 3, 3, 'Welcome bonus: 3 free analyses');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_grant_free_credits_on_signup ON auth.users;
CREATE TRIGGER trg_grant_free_credits_on_signup
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.grant_free_credits_on_signup();

-- ====================================================================
-- 3) record_analysis_and_deduct — race-free analyze + deduct
-- ====================================================================
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
  p_job_text_hash            text
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
  -- 1) Insert the analysis row first (always)
  INSERT INTO public.analyses (
    user_id, job_text_hash, verdict, backend_critical, backend_rules_triggered,
    ai_risk_level, contextual_red_flags, match_score, score_reason, action_tip,
    extracted_signals, prompt_version, input_tokens, output_tokens, took_ms
  )
  VALUES (
    p_user_id, p_job_text_hash, p_verdict, p_backend_critical, p_backend_rules_triggered,
    p_ai_risk_level, p_contextual_red_flags, p_match_score, p_score_reason, p_action_tip,
    p_extracted_signals, p_prompt_version, p_input_tokens, p_output_tokens, p_took_ms
  )
  RETURNING id INTO v_analysis_id;

  -- 2) Try to consume from active subscription/pass first (FIFO)
  SELECT id INTO v_sub_id
    FROM public.subscriptions
   WHERE user_id = p_user_id
     AND status = 'active'
     AND period_end > now()
     AND usage_count < soft_cap
   ORDER BY created_at ASC
   FOR UPDATE
   LIMIT 1;

  IF v_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
       SET usage_count = usage_count + 1
     WHERE id = v_sub_id
     RETURNING usage_count INTO v_new_usage;

    v_source := 'subscription';
    SELECT COALESCE((SELECT balance_after FROM public.credit_ledger WHERE user_id = p_user_id ORDER BY created_at DESC LIMIT 1), 0)
      INTO v_balance;

    RETURN QUERY SELECT v_analysis_id, v_balance, v_source;
    RETURN;
  END IF;

  -- 3) Fall through: consume from credit_ledger
  SELECT balance_after INTO v_balance
    FROM public.credit_ledger
   WHERE user_id = p_user_id
   ORDER BY created_at DESC
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

-- ====================================================================
-- 4) consume_pass_usage — placeholder helper for ad-hoc operator use
--    (not called by analyze flow; record_analysis_and_deduct handles it)
-- ====================================================================
CREATE OR REPLACE FUNCTION public.consume_pass_usage(
  p_user_id uuid,
  p_n       int DEFAULT 1
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub_id     uuid;
  v_new_usage  int;
BEGIN
  SELECT id INTO v_sub_id
    FROM public.subscriptions
   WHERE user_id = p_user_id
     AND status = 'active'
     AND period_end > now()
     AND usage_count + p_n <= soft_cap
   ORDER BY created_at ASC
   FOR UPDATE
   LIMIT 1;

  IF v_sub_id IS NULL THEN
    RAISE EXCEPTION 'NO_ACTIVE_PASS_OR_CAP_EXCEEDED' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.subscriptions
     SET usage_count = usage_count + p_n
   WHERE id = v_sub_id
   RETURNING usage_count INTO v_new_usage;

  RETURN v_new_usage;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_pass_usage FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_pass_usage TO service_role;
