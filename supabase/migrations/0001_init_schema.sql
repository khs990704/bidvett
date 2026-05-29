-- 0001_init_schema.sql — ConnectSaver core tables
-- Source: _workspace/03_db_schema.md §3
-- PostgreSQL 15 + Supabase. Apply via `supabase db push`.

-- ====================================================================
-- Extensions
-- ====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ====================================================================
-- 1) users_profile — 1:1 with auth.users
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.users_profile (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  skills               text[]      NOT NULL DEFAULT '{}',
  years_of_experience  int         NOT NULL DEFAULT 0 CHECK (years_of_experience >= 0 AND years_of_experience <= 60),
  target_hourly_rate   int         NOT NULL DEFAULT 0 CHECK (target_hourly_rate >= 0 AND target_hourly_rate <= 1000),
  timezone             text        NOT NULL DEFAULT '',
  resume_text          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  public.users_profile IS '1:1 with auth.users. Used by /api/analyze to compose user-message JSON for the LLM.';
COMMENT ON COLUMN public.users_profile.timezone IS 'Free-form. IANA preferred (e.g. Asia/Seoul). UTC offset (UTC+9) also accepted.';

-- ====================================================================
-- 2) stripe_events — created BEFORE credit_ledger / subscriptions (FK targets)
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id            text        PRIMARY KEY,
  type          text        NOT NULL,
  payload       jsonb       NOT NULL,
  processed     bool        NOT NULL DEFAULT false,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_received
  ON public.stripe_events (received_at DESC);

COMMENT ON TABLE public.stripe_events IS 'Idempotency log. Webhook handler inserts ON CONFLICT DO NOTHING; if already processed=true, returns 200 immediately.';

-- ====================================================================
-- 3) analyses — created BEFORE credit_ledger (FK target)
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.analyses (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_text_hash             text        NOT NULL,
  verdict                   text        NOT NULL CHECK (verdict IN ('SHOW_REPORT','DO_NOT_APPLY')),
  backend_critical          bool        NOT NULL,
  backend_rules_triggered   text[]      NOT NULL DEFAULT '{}',
  ai_risk_level             text        NOT NULL CHECK (ai_risk_level IN ('SAFE','WARNING','DANGER')),
  contextual_red_flags      text[]      NOT NULL DEFAULT '{}',
  match_score               int         CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 100)),
  score_reason              text,
  action_tip                text        NOT NULL,
  extracted_signals         jsonb       NOT NULL,
  prompt_version            int         NOT NULL,
  input_tokens              int         NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens             int         NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  took_ms                   int         NOT NULL DEFAULT 0 CHECK (took_ms >= 0),
  is_reported               bool        NOT NULL DEFAULT false,
  report_reason             text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analyses_user_created
  ON public.analyses (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analyses_reported
  ON public.analyses (is_reported, created_at DESC)
  WHERE is_reported = true;

CREATE INDEX IF NOT EXISTS idx_analyses_hash_user
  ON public.analyses (job_text_hash, user_id);

COMMENT ON COLUMN public.analyses.match_score IS 'Nullable. DANGER OR backend_critical => null (masked in API response).';
COMMENT ON COLUMN public.analyses.extracted_signals IS '{ client_hire_rate: int 0-100, payment_verified: bool, total_spend_amount: int USD, client_rating: float 0-5 } — 1:1 with analyze.v1 prompt output (spec/03 §6.1).';
COMMENT ON COLUMN public.analyses.job_text_hash IS 'sha256(cleaned input). Reserved for v2 dedup cache. No unique constraint at MVP.';
COMMENT ON COLUMN public.analyses.prompt_version IS 'References system_prompts.version. No FK to preserve history when admin deletes prompts.';

-- ====================================================================
-- 4) credit_ledger — append-only
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.credit_ledger (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type              text        NOT NULL CHECK (type IN ('free_grant','purchase_single','consume','refund_reversal','admin_adjust')),
  delta             int         NOT NULL,
  balance_after     int         NOT NULL CHECK (balance_after >= 0),
  analysis_id       uuid        REFERENCES public.analyses(id) ON DELETE SET NULL,
  stripe_event_id   text        REFERENCES public.stripe_events(id) ON DELETE SET NULL,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created
  ON public.credit_ledger (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_credit_ledger_stripe_event
  ON public.credit_ledger (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;

COMMENT ON TABLE public.credit_ledger IS 'Append-only ledger. Balance is computed as latest row balance_after.';

-- ====================================================================
-- 5) subscriptions
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                            text        NOT NULL CHECK (plan IN ('weekly_pass','monthly_sub')),
  status                          text        NOT NULL CHECK (status IN ('active','expired','canceled','refunded')),
  period_start                    timestamptz NOT NULL,
  period_end                      timestamptz NOT NULL,
  usage_count                     int         NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  soft_cap                        int         NOT NULL CHECK (soft_cap > 0),
  stripe_customer_id              text        NOT NULL,
  stripe_subscription_id          text,
  stripe_checkout_session_id      text,
  stripe_event_id                 text        REFERENCES public.stripe_events(id) ON DELETE SET NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON public.subscriptions (user_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscriptions_active_per_user
  ON public.subscriptions (user_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscriptions_checkout_session
  ON public.subscriptions (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_subscriptions_stripe_sub
  ON public.subscriptions (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- ====================================================================
-- 6) system_prompts
-- ====================================================================
CREATE TABLE IF NOT EXISTS public.system_prompts (
  id          bigserial   PRIMARY KEY,
  name        text        NOT NULL,
  version     int         NOT NULL CHECK (version >= 1),
  content     text        NOT NULL,
  is_active   bool        NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_system_prompts_name_version
  ON public.system_prompts (name, version);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_system_prompts_active_per_name
  ON public.system_prompts (name)
  WHERE is_active = true;

COMMENT ON TABLE public.system_prompts IS 'Operator-editable prompt store. Single source of truth — no code hardcoding.';
