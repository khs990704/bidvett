/**
 * Dodo Payments SDK singleton + Hosted Checkout Session builder.
 * Source: _workspace/02_api_spec.md §3.8, _workspace/00_input.md §11.3 (PIVOT-01).
 *
 * v1 used Stripe Checkout Sessions; v2 uses Dodo Payments Hosted Checkout.
 * Business model (plans, soft caps, refund window) is unchanged — only the
 * payment provider integration layer changes.
 */
import DodoPayments from 'dodopayments';
import { serverEnv, publicEnv } from '@/lib/env';
import { ApiError, ErrorCode } from '@/lib/errors';
import type { PlanKey } from '@/lib/types/api';
type PlanCode = PlanKey;

let _dodo: DodoPayments | null = null;
export function dodoClient(): DodoPayments {
  if (_dodo) return _dodo;
  _dodo = new DodoPayments({
    bearerToken: serverEnv().DODO_API_KEY,
    environment: process.env.NODE_ENV === 'production' ? 'live_mode' : 'test_mode',
  });
  return _dodo;
}

const PLAN_PRODUCT_ENV: Record<PlanCode, string> = {
  credit_single: 'NEXT_PUBLIC_DODO_PRODUCT_SINGLE',
  weekly_pass: 'NEXT_PUBLIC_DODO_PRODUCT_WEEKLY',
  monthly_sub: 'NEXT_PUBLIC_DODO_PRODUCT_MONTHLY',
};

export interface CreateCheckoutArgs {
  userId: string;
  plan: PlanCode;
  idempotencyKey?: string;
}

export async function createCheckoutSession(
  args: CreateCheckoutArgs,
): Promise<{ url: string; sessionId: string }> {
  const envVar = PLAN_PRODUCT_ENV[args.plan];
  if (!envVar) {
    throw new ApiError(400, ErrorCode.BAD_REQUEST, { reason: 'unknown_plan' });
  }
  const productId = process.env[envVar];
  if (!productId) {
    throw new ApiError(500, ErrorCode.INTERNAL, {
      reason: 'missing_product_env',
      env_var: envVar,
    });
  }

  const baseUrl = publicEnv.NEXT_PUBLIC_APP_URL;

  try {
    const session = await dodoClient().checkoutSessions.create(
      {
        product_cart: [{ product_id: productId, quantity: 1 }],
        return_url: `${baseUrl}/account?dodo=success`,
        // Metadata stamped on the checkout session is echoed back on every
        // downstream webhook event (`payment.succeeded`, `subscription.*`),
        // letting the handler recover user_id + plan without DB lookups.
        metadata: { user_id: args.userId, plan: args.plan },
      },
      args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : undefined,
    );

    if (!session.checkout_url) {
      throw new ApiError(502, ErrorCode.PAYMENT_UPSTREAM, { reason: 'no_url' });
    }
    return { url: session.checkout_url, sessionId: session.session_id };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // eslint-disable-next-line no-console
    console.error('[dodo.checkout]', err);
    throw new ApiError(502, ErrorCode.PAYMENT_UPSTREAM);
  }
}
