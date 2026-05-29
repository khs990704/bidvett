/**
 * Stripe SDK singleton + Checkout Session builder.
 * Source: _workspace/02_api_spec.md §3.8.
 */
import Stripe from 'stripe';
import { serverEnv, publicEnv } from '@/lib/env';
import { ApiError, ErrorCode } from '@/lib/errors';
import type { PlanKey } from '@/lib/types/api';
type PlanCode = PlanKey;

let _stripe: Stripe | null = null;
export function stripeClient(): Stripe {
  if (_stripe) return _stripe;
  _stripe = new Stripe(serverEnv().STRIPE_SECRET_KEY, {
    // Pin API version to align with seed-stripe script.
    apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion,
  });
  return _stripe;
}

interface PlanCfg {
  priceEnvVar: string;
  mode: 'payment' | 'subscription';
}

const PLAN_MAP: Record<PlanCode, PlanCfg> = {
  credit_single: { priceEnvVar: 'NEXT_PUBLIC_STRIPE_PRICE_SINGLE', mode: 'payment' },
  weekly_pass: { priceEnvVar: 'NEXT_PUBLIC_STRIPE_PRICE_WEEKLY', mode: 'payment' },
  monthly_sub: { priceEnvVar: 'NEXT_PUBLIC_STRIPE_PRICE_MONTHLY', mode: 'subscription' },
};

export interface CreateCheckoutArgs {
  userId: string;
  plan: PlanCode;
  idempotencyKey?: string;
}

export async function createCheckoutSession(
  args: CreateCheckoutArgs,
): Promise<{ url: string; sessionId: string }> {
  const cfg = PLAN_MAP[args.plan];
  if (!cfg) {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, { reason: 'unknown_plan' });
  }
  const priceId = process.env[cfg.priceEnvVar];
  if (!priceId) {
    throw new ApiError(500, ErrorCode.INTERNAL, {
      reason: 'missing_price_env',
      env_var: cfg.priceEnvVar,
    });
  }

  const baseUrl = publicEnv.NEXT_PUBLIC_APP_URL;

  try {
    const session = await stripeClient().checkout.sessions.create(
      {
        mode: cfg.mode,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${baseUrl}/account?checkout=success`,
        cancel_url: `${baseUrl}/pricing?checkout=cancelled`,
        client_reference_id: args.userId,
        metadata: { user_id: args.userId, plan: args.plan },
        // For subscriptions, also stamp metadata on the subscription itself
        // so webhooks can recover the plan reliably.
        ...(cfg.mode === 'subscription'
          ? { subscription_data: { metadata: { user_id: args.userId, plan: args.plan } } }
          : { payment_intent_data: { metadata: { user_id: args.userId, plan: args.plan } } }),
      },
      args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined,
    );

    if (!session.url) {
      throw new ApiError(502, ErrorCode.STRIPE_UPSTREAM, { reason: 'no_url' });
    }
    return { url: session.url, sessionId: session.id };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // eslint-disable-next-line no-console
    console.error('[stripe.checkout]', err);
    throw new ApiError(502, ErrorCode.STRIPE_UPSTREAM);
  }
}
