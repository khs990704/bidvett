-- 0002_rls_policies.sql — Row Level Security policies
-- Source: _workspace/03_db_schema.md §4

-- ====================================================================
-- Enable RLS on all user-owned tables (and operator-only tables)
-- ====================================================================
ALTER TABLE public.users_profile  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analyses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_events  ENABLE ROW LEVEL SECURITY;

-- ====================================================================
-- users_profile — own SELECT/INSERT/UPDATE
-- ====================================================================
DROP POLICY IF EXISTS users_profile_select_own ON public.users_profile;
CREATE POLICY users_profile_select_own ON public.users_profile
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS users_profile_insert_own ON public.users_profile;
CREATE POLICY users_profile_insert_own ON public.users_profile
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS users_profile_update_own ON public.users_profile;
CREATE POLICY users_profile_update_own ON public.users_profile
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ====================================================================
-- credit_ledger — own SELECT only (INSERT/UPDATE via service_role only)
-- ====================================================================
DROP POLICY IF EXISTS credit_ledger_select_own ON public.credit_ledger;
CREATE POLICY credit_ledger_select_own ON public.credit_ledger
  FOR SELECT USING (auth.uid() = user_id);

-- ====================================================================
-- subscriptions — own SELECT only
-- ====================================================================
DROP POLICY IF EXISTS subscriptions_select_own ON public.subscriptions;
CREATE POLICY subscriptions_select_own ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- ====================================================================
-- analyses — own SELECT + UPDATE (column-level guard in app layer)
-- ====================================================================
DROP POLICY IF EXISTS analyses_select_own ON public.analyses;
CREATE POLICY analyses_select_own ON public.analyses
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS analyses_update_report_own ON public.analyses;
CREATE POLICY analyses_update_report_own ON public.analyses
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ====================================================================
-- system_prompts & stripe_events — no policy => deny all for anon/auth.
-- service_role bypasses RLS. Supabase Data Browser is service_role.
-- ====================================================================
-- Intentionally no policies.
