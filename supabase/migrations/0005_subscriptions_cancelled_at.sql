-- 0005_subscriptions_cancelled_at.sql
-- Records the Dodo `subscription.cancelled` event without flipping `status`.
-- Business rule (PIVOT-01 webhook completion): subscription.cancelled signals
-- "no future renewals" (권한 회수). The current paid period is still honored
-- via period_end > now in /api/credits; cancel_at_period_end in the API
-- response is driven by cancelled_at IS NOT NULL.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.subscriptions.cancelled_at IS
  'Set by Dodo subscription.cancelled webhook. Independent of status — caller still has access until period_end.';
