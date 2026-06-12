/**
 * Integration test — Dodo Payments webhook signature verification (Standard
 * Webhooks spec), idempotency, and 3-event dispatch.
 *
 * Event split (per webhook completion decision):
 *   - payment.succeeded     → credit_single only.
 *   - subscription.active   → weekly_pass / monthly_sub upsert.
 *   - subscription.cancelled → record cancelled_at; status unchanged.
 *
 * Strategy:
 *   - Mock `standardwebhooks` so we can drive verify() success/failure
 *     deterministically without depending on the real lib being installed
 *     in the test env.
 *   - Mock supabaseAdmin() so we can observe inserts/updates.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "stub-anon";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stub-srk";
  process.env.OPENAI_API_KEY = "stub-openai";
  process.env.DODO_API_KEY = "dodo_test_stub";
  process.env.DODO_WEBHOOK_SECRET = "whsec_stub";
});

// ── Mock supabase admin ─────────────────────────────────────────────
type Captured = {
  table: string;
  op: "insert" | "update";
  payload: Record<string, unknown>;
  match?: Record<string, unknown>;
};

const captured: Captured[] = [];
let nextLedgerBalance: number | null = null;
let nextSubscriptionRow: { id: string } | null = null;

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown) {
      return Promise.resolve(value).then(resolve);
    },
  };
}

function mkChain(table: string) {
  return {
    insert(payload: Record<string, unknown>) {
      captured.push({ table, op: "insert", payload });
      const result = { data: { id: payload.id }, error: null };
      return {
        select() {
          return {
            maybeSingle: async () => result,
          };
        },
        then(resolve: (v: typeof result) => unknown) {
          return Promise.resolve(result).then(resolve);
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
        neq(col: string, val: unknown) {
          match[`not_${col}`] = val;
          return chain;
        },
        then(resolve: (v: { data: null; error: null }) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      captured.push({ table, op: "update", payload, match });
      return chain;
    },
    select() {
      // Supports two read patterns:
      //   1) .eq().order().limit().maybeSingle()  — credit_ledger latest balance
      //   2) .eq().maybeSingle()                  — subscriptions exists-check
      const eqChain = {
        eq() {
          return eqChain;
        },
        order() {
          return {
            limit() {
              return {
                maybeSingle: async () => {
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
        gt() {
          return eqChain;
        },
        maybeSingle: async () => {
          if (table === "subscriptions") {
            return { data: nextSubscriptionRow, error: null };
          }
          return { data: null, error: null };
        },
      };
      return eqChain;
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
    DODO_API_KEY: "dodo_test_stub",
    DODO_WEBHOOK_SECRET: "whsec_stub",
    SUPABASE_SERVICE_ROLE_KEY: "stub-srk",
    OPENAI_API_KEY: "stub-openai",
    SYSTEM_PROMPT_VERSION: 1,
  }),
  publicEnv: {
    NEXT_PUBLIC_SUPABASE_URL: "https://stub.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "stub-anon",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));

// ── Mock the Standard Webhooks library ──────────────────────────────
// Behavior contract: `new Webhook(secret).verify(body, headers)` returns the
// parsed JSON payload on success, throws on failure. The mock honors a
// known-good signature string and rejects anything else.
const VALID_SIG = "v1,stub-valid-signature";
vi.mock("standardwebhooks", () => {
  return {
    Webhook: class FakeWebhook {
      private readonly secret: string;
      constructor(secret: string) {
        this.secret = secret;
      }
      verify(body: string, headers: Record<string, string>) {
        if (this.secret !== "whsec_stub") {
          throw new Error("invalid secret");
        }
        const sig = headers["webhook-signature"];
        if (sig !== VALID_SIG) {
          throw new Error("invalid signature");
        }
        return JSON.parse(body);
      }
    },
  };
});

beforeEach(() => {
  captured.length = 0;
  nextLedgerBalance = null;
  nextSubscriptionRow = null;
});

// ── Helpers ─────────────────────────────────────────────────────────
function validHeaders(): Record<string, string> {
  return {
    "webhook-id": "msg_test_" + Math.random().toString(36).slice(2),
    "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
    "webhook-signature": VALID_SIG,
  };
}

function makePaymentSucceeded(opts: {
  plan: "credit_single" | "weekly_pass" | "monthly_sub";
  userId: string;
  eventId?: string;
}) {
  return {
    id: opts.eventId ?? `msg_pay_${Math.random().toString(36).slice(2)}`,
    type: "payment.succeeded",
    data: {
      payload_type: "Payment",
      payment_id: `pay_${Math.random().toString(36).slice(2)}`,
      customer: { customer_id: "cus_stub", email: "u@example.com", name: "U" },
      subscription_id: opts.plan === "credit_single" ? null : "sub_stub",
      metadata: { user_id: opts.userId, plan: opts.plan },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("dodo webhook — signature verification (Standard Webhooks)", () => {
  it("verify() passes for a properly signed payload and returns {type, data}", async () => {
    const { verifyDodoSignature } = await import("@/lib/dodo/webhook");
    const body = JSON.stringify({
      business_id: "biz_1",
      type: "ping",
      timestamp: new Date().toISOString(),
      data: { ok: true },
    });
    const out = verifyDodoSignature({ rawBody: body, headers: validHeaders() });
    expect(out.type).toBe("ping");
    expect(out.data).toEqual({ ok: true });
  });

  it("verify() throws for an invalid signature (ERR_WEBHOOK_SIGNATURE source)", async () => {
    const { verifyDodoSignature } = await import("@/lib/dodo/webhook");
    const body = JSON.stringify({ type: "ping", data: {} });
    const badHeaders = { ...validHeaders(), "webhook-signature": "v1,nope" };
    expect(() =>
      verifyDodoSignature({ rawBody: body, headers: badHeaders }),
    ).toThrow();
  });

  it("verify() throws when the secret is wrong", async () => {
    const { verifyDodoSignature } = await import("@/lib/dodo/webhook");
    const body = JSON.stringify({ type: "ping", data: {} });
    expect(() =>
      verifyDodoSignature({
        rawBody: body,
        headers: validHeaders(),
        secret: "whsec_wrong",
      }),
    ).toThrow();
  });
});

describe("dodo webhook — handleDodoEvent dispatch", () => {
  it("payment.succeeded + plan=credit_single inserts into credit_ledger (+1)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextLedgerBalance = 2;
    await handleDodoEvent(
      makePaymentSucceeded({ plan: "credit_single", userId: "user-1" }),
    );
    const insert = captured.find(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.type).toBe("purchase_single");
    expect(insert?.payload.delta).toBe(1);
    expect(insert?.payload.balance_after).toBe(3); // 2 + 1
    expect(String(insert?.payload.note)).toMatch(/Dodo purchase/);
  });

  it("payment.succeeded + plan=weekly_pass is a no-op (subscription.active is the source of truth)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent(
      makePaymentSucceeded({ plan: "weekly_pass", userId: "user-2" }),
    );
    expect(captured).toHaveLength(0);
  });

  it("payment.succeeded + plan=monthly_sub is a no-op (subscription.active is the source of truth)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent(
      makePaymentSucceeded({ plan: "monthly_sub", userId: "user-3" }),
    );
    expect(captured).toHaveLength(0);
  });

  it("subscription.active (new sub_id) inserts an active subscriptions row with Dodo period bounds", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextSubscriptionRow = null;
    const previous = new Date(Date.now() - 1_000).toISOString();
    const next = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await handleDodoEvent({
      id: "msg_sub_active",
      type: "subscription.active",
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_active",
        customer: { customer_id: "cus_stub", email: "u@example.com", name: "U" },
        metadata: { user_id: "user-9", plan: "monthly_sub" },
        previous_billing_date: previous,
        next_billing_date: next,
      },
    });
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.status).toBe("active");
    expect(insert?.payload.plan).toBe("monthly_sub");
    expect(insert?.payload.dodo_subscription_id).toBe("sub_active");
    expect(insert?.payload.dodo_customer_id).toBe("cus_stub");
    expect(insert?.payload.period_start).toBe(previous);
    expect(insert?.payload.period_end).toBe(next);
    expect(insert?.payload.soft_cap).toBe(500);
  });

  it("subscription.active (existing sub_id) updates the row (idempotent on retries / on_hold→active)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextSubscriptionRow = { id: "sub_db_row_1" };
    const next = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await handleDodoEvent({
      id: "msg_sub_reactivate",
      type: "subscription.active",
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_active",
        customer: { customer_id: "cus_stub", email: "u@example.com", name: "U" },
        metadata: { user_id: "user-9", plan: "weekly_pass" },
        next_billing_date: next,
      },
    });
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeUndefined();
    const upd = captured.find(
      (c) => c.table === "subscriptions" && c.op === "update",
    );
    expect(upd).toBeDefined();
    expect(upd?.payload.status).toBe("active");
    expect(upd?.payload.usage_count).toBe(0);
    expect(upd?.payload.cancelled_at).toBeNull();
    expect(upd?.payload.period_end).toBe(next);
    expect(upd?.match?.id).toBe("sub_db_row_1");
  });

  it("subscription.active (new sub_id, user has other active row) cancels old row before insert (plan upgrade)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextSubscriptionRow = null; // no row matches new dodo_subscription_id
    const next = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await handleDodoEvent({
      id: "msg_upgrade",
      type: "subscription.active",
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_new_monthly",
        customer: { customer_id: "cus_stub", email: "u@example.com", name: "U" },
        metadata: { user_id: "user-upgrade", plan: "monthly_sub" },
        next_billing_date: next,
      },
    });
    const upgradeCancel = captured.find(
      (c) =>
        c.table === "subscriptions" &&
        c.op === "update" &&
        c.payload.status === "canceled",
    );
    expect(upgradeCancel).toBeDefined();
    expect(upgradeCancel?.match?.user_id).toBe("user-upgrade");
    expect(upgradeCancel?.match?.status).toBe("active");
    expect(upgradeCancel?.match?.not_dodo_subscription_id).toBe("sub_new_monthly");
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.dodo_subscription_id).toBe("sub_new_monthly");
    // Order matters: cancel old row first, then insert new.
    const cancelIdx = captured.indexOf(upgradeCancel!);
    const insertIdx = captured.indexOf(insert!);
    expect(cancelIdx).toBeLessThan(insertIdx);
  });

  it("subscription.renewed extends period_end, resets usage_count and cancelled_at", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    const previous = new Date(Date.now() - 1_000).toISOString();
    const next = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await handleDodoEvent({
      id: "msg_renew",
      type: "subscription.renewed",
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_stub",
        previous_billing_date: previous,
        next_billing_date: next,
        metadata: { user_id: "user-9", plan: "monthly_sub" },
      },
    });
    const upd = captured.find(
      (c) => c.table === "subscriptions" && c.op === "update",
    );
    expect(upd).toBeDefined();
    expect(upd?.payload.status).toBe("active");
    expect(upd?.payload.period_start).toBe(previous);
    expect(upd?.payload.period_end).toBe(next);
    expect(upd?.payload.usage_count).toBe(0);
    expect(upd?.payload.cancelled_at).toBeNull();
    expect(upd?.match?.dodo_subscription_id).toBe("sub_stub");
  });

  it("subscription.renewed without next_billing_date is a no-op (warn-only)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "msg_renew_bad",
      type: "subscription.renewed",
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_stub",
      },
    });
    expect(captured).toHaveLength(0);
  });

  it("subscription.cancelled records cancelled_at and does NOT change status", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    const cancelledAt = new Date().toISOString();
    await handleDodoEvent({
      id: "msg_cancel",
      type: "subscription.cancelled",
      data: {
        payload_type: "Subscription",
        subscription_id: "sub_stub",
        cancelled_at: cancelledAt,
      },
    });
    const upd = captured.find(
      (c) => c.table === "subscriptions" && c.op === "update",
    );
    expect(upd).toBeDefined();
    expect(upd?.payload.cancelled_at).toBe(cancelledAt);
    expect(upd?.payload).not.toHaveProperty("status");
    expect(upd?.match?.dodo_subscription_id).toBe("sub_stub");
  });

  it("unhandled event type is a silent no-op (200 OK at the route layer)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "msg_unknown",
      type: "payment.failed",
      data: { payload_type: "Payment" },
    });
    expect(captured).toHaveLength(0);
  });

  it("missing metadata.user_id or plan on payment.succeeded is a no-op (warn-only)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "msg_bad_meta",
      type: "payment.succeeded",
      data: {
        payload_type: "Payment",
        payment_id: "pay_bad",
        // no metadata
      },
    });
    expect(captured).toHaveLength(0);
  });

  it("subscription.cancelled without subscription_id is a no-op (warn-only)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "msg_cancel_bad",
      type: "subscription.cancelled",
      data: { payload_type: "Subscription" },
    });
    expect(captured).toHaveLength(0);
  });
});

describe("dodo webhook — idempotency contract", () => {
  it("event.id (sourced from webhook-id header) is stamped on the ledger row for ON CONFLICT dedup", async () => {
    // The route handler relies on INSERT INTO dodo_events ON CONFLICT (id) DO
    // NOTHING and treats 23505 unique_violation as "already processed → 200 OK".
    // The handler also stamps dodo_event_id on credit_ledger so a second-pass
    // INSERT collides on uniq_credit_ledger_dodo_event.
    const eventId = "msg_dup_42";
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextLedgerBalance = 1;
    await handleDodoEvent(
      makePaymentSucceeded({
        plan: "credit_single",
        userId: "user-7",
        eventId,
      }),
    );
    const inserts = captured.filter(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.payload.dodo_event_id).toBe(eventId);
  });
});
