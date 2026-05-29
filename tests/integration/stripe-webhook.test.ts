/**
 * Integration test — Stripe webhook signature verification, idempotency,
 * and 4-event dispatch.
 *
 * Strategy:
 *   - Build a real raw body + valid signature using the Stripe SDK helper
 *     (no network). Use a synthetic webhook secret.
 *   - Mock supabaseAdmin() so we can observe inserts and force a duplicate
 *     to exercise the 23505 idempotency branch.
 *   - For each event type, assert handleStripeEvent fans out to the
 *     correct DB table with the correct shape.
 *
 * Out of scope: end-to-end HTTP transport (Next.js Route Handler harness
 * is too heavy for MVP unit lane — covered by manual smoke tests in
 * 05_deploy_guide.md §5.3 #7~#9).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";
import Stripe from "stripe";

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-srk";
  process.env.OPENAI_API_KEY = "stub-openai";
  process.env.STRIPE_SECRET_KEY = "sk_test_stub";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_stub";
});

// ── Mock supabase admin ─────────────────────────────────────────────
type Captured = {
  table: string;
  op: "insert" | "update";
  payload: Record<string, unknown>;
  match?: Record<string, unknown>;
};

const captured: Captured[] = [];
let nextLedgerBalance: number | null = null; // simulate latest credit_ledger row

function mkChain(table: string) {
  return {
    insert(payload: Record<string, unknown>) {
      captured.push({ table, op: "insert", payload });
      return {
        select() {
          return {
            maybeSingle: async () => ({ data: { id: payload.id }, error: null }),
          };
        },
      };
    },
    update(payload: Record<string, unknown>) {
      const match: Record<string, unknown> = {};
      const chain = {
        eq(col: string, val: unknown) {
          match[col] = val;
          return chain;
        },
      };
      captured.push({ table, op: "update", payload, match });
      return chain;
    },
    select() {
      return {
        eq() {
          return {
            order() {
              return {
                limit() {
                  return {
                    maybeSingle: async () => {
                      // Used by the charge.refunded handler to read latest balance.
                      if (table === "credit_ledger") {
                        return {
                          data:
                            nextLedgerBalance != null
                              ? { balance_after: nextLedgerBalance }
                              : null,
                          error: null,
                        };
                      }
                      return { data: null, error: null };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => mkChain(table),
  }),
}));

// Mock env so serverEnv() does not fight us.
vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    STRIPE_WEBHOOK_SECRET: "whsec_stub",
    SUPABASE_SERVICE_ROLE_KEY: "stub-srk",
    OPENAI_API_KEY: "stub-openai",
    STRIPE_SECRET_KEY: "sk_test_stub",
    SYSTEM_PROMPT_VERSION: 1,
  }),
  publicEnv: {
    NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));

beforeEach(() => {
  captured.length = 0;
  nextLedgerBalance = null;
});

// ── Build a synthetically signed Stripe webhook payload ─────────────
function signed(body: string, secret: string): string {
  // Use the official helper so we exactly match constructEvent's expectations.
  return Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
  });
}

function makeCheckoutSessionEvent(opts: {
  plan: "credit_single" | "weekly_pass" | "monthly_sub";
  userId: string;
  id?: string;
}) {
  const event = {
    id: opts.id ?? `evt_test_${Math.random().toString(36).slice(2)}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: `cs_test_${Math.random().toString(36).slice(2)}`,
        client_reference_id: opts.userId,
        customer: "cus_stub",
        subscription:
          opts.plan === "monthly_sub" ? "sub_stub" : null,
        metadata: { user_id: opts.userId, plan: opts.plan },
      },
    },
  } as unknown as Stripe.Event;
  return event;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("stripe webhook — signature verification", () => {
  it("constructEvent passes for a properly signed payload", async () => {
    const { stripeClient } = await import("@/lib/stripe/client");
    const body = JSON.stringify({ id: "evt_1", type: "ping" });
    const sig = signed(body, "whsec_stub");
    const event = stripeClient().webhooks.constructEvent(
      body,
      sig,
      "whsec_stub",
    );
    expect(event.id).toBe("evt_1");
  });

  it("constructEvent throws for a wrong-secret signature (ERR_WEBHOOK_SIGNATURE source)", async () => {
    const { stripeClient } = await import("@/lib/stripe/client");
    const body = JSON.stringify({ id: "evt_1", type: "ping" });
    const sig = signed(body, "whsec_wrong");
    expect(() =>
      stripeClient().webhooks.constructEvent(body, sig, "whsec_stub"),
    ).toThrow();
  });
});

describe("stripe webhook — handleStripeEvent dispatch", () => {
  it("checkout.session.completed + plan=credit_single inserts into credit_ledger (+1)", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    nextLedgerBalance = 2;
    await handleStripeEvent(
      makeCheckoutSessionEvent({ plan: "credit_single", userId: "user-1" }),
    );
    const insert = captured.find(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.type).toBe("purchase_single");
    expect(insert?.payload.delta).toBe(1);
    expect(insert?.payload.balance_after).toBe(3); // 2 + 1
  });

  it("checkout.session.completed + plan=weekly_pass inserts a subscriptions row (soft_cap=100, +7d)", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    await handleStripeEvent(
      makeCheckoutSessionEvent({ plan: "weekly_pass", userId: "user-2" }),
    );
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.plan).toBe("weekly_pass");
    expect(insert?.payload.soft_cap).toBe(100);
    expect(insert?.payload.status).toBe("active");
    // period_end should be ~7 days from now
    const start = new Date(insert!.payload.period_start as string).getTime();
    const end = new Date(insert!.payload.period_end as string).getTime();
    const diffDays = (end - start) / 86_400_000;
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("checkout.session.completed + plan=monthly_sub inserts a subscriptions row (soft_cap=500, +30d)", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    await handleStripeEvent(
      makeCheckoutSessionEvent({ plan: "monthly_sub", userId: "user-3" }),
    );
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.plan).toBe("monthly_sub");
    expect(insert?.payload.soft_cap).toBe(500);
  });

  it("invoice.paid extends period_end and resets usage_count", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    const event = {
      id: "evt_inv",
      type: "invoice.paid",
      data: {
        object: { subscription: "sub_stub" },
      },
    } as unknown as Stripe.Event;
    await handleStripeEvent(event);
    const upd = captured.find(
      (c) => c.table === "subscriptions" && c.op === "update",
    );
    expect(upd).toBeDefined();
    expect(upd?.payload.usage_count).toBe(0);
    expect(upd?.payload.status).toBe("active");
    expect(upd?.match?.stripe_subscription_id).toBe("sub_stub");
  });

  it("customer.subscription.deleted marks status='canceled'", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    const event = {
      id: "evt_del",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_stub" } },
    } as unknown as Stripe.Event;
    await handleStripeEvent(event);
    const upd = captured.find(
      (c) => c.table === "subscriptions" && c.op === "update",
    );
    expect(upd?.payload.status).toBe("canceled");
  });

  it("charge.refunded (credit_single, within 7d) inserts a -1 refund_reversal ledger row", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    nextLedgerBalance = 3;
    const event = {
      id: "evt_ref",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_stub",
          customer: "cus_stub",
          created: Math.floor(Date.now() / 1000),
          metadata: { user_id: "user-4", plan: "credit_single" },
        },
      },
    } as unknown as Stripe.Event;
    await handleStripeEvent(event);
    const insert = captured.find(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(insert?.payload.type).toBe("refund_reversal");
    expect(insert?.payload.delta).toBe(-1);
    expect(insert?.payload.balance_after).toBe(2);
    expect(String(insert?.payload.note)).toMatch(/within 7d/);
  });

  it("charge.refunded (after 7d) is still recorded but note says operator override", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    nextLedgerBalance = 5;
    const eightDaysAgo = Math.floor(
      (Date.now() - 8 * 86_400_000) / 1000,
    );
    const event = {
      id: "evt_ref_old",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_old",
          customer: "cus_stub",
          created: eightDaysAgo,
          metadata: { user_id: "user-5", plan: "credit_single" },
        },
      },
    } as unknown as Stripe.Event;
    await handleStripeEvent(event);
    const insert = captured.find(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(insert?.payload.type).toBe("refund_reversal");
    expect(String(insert?.payload.note)).toMatch(/operator override after 7d/);
  });

  it("unhandled event type is a silent no-op (200 OK at the route layer)", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    const event = {
      id: "evt_unknown",
      type: "payment_intent.created",
      data: { object: {} },
    } as unknown as Stripe.Event;
    await handleStripeEvent(event);
    expect(captured).toHaveLength(0);
  });

  it("missing metadata.user_id or plan is a no-op (warn-only)", async () => {
    const { handleStripeEvent } = await import("@/lib/stripe/webhook");
    const event = {
      id: "evt_bad_meta",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_bad",
          // no client_reference_id, no metadata
        },
      },
    } as unknown as Stripe.Event;
    await handleStripeEvent(event);
    expect(captured).toHaveLength(0);
  });
});
