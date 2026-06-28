-- 0009_increase_signup_free_credits.sql
-- New users receive 5 free analysis credits on signup.

CREATE OR REPLACE FUNCTION public.grant_free_credits_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.credit_ledger (user_id, type, delta, balance_after, note)
  VALUES (NEW.id, 'free_grant', 5, 5, 'Welcome bonus: 5 free analyses');
  RETURN NEW;
END;
$$;
