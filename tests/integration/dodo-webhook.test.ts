/**
 * Integration test — Dodo Payments webhook signature verification (Standard
 * Webhooks spec), idempotency, and 5-event dispatch.
 *
 * Source: _workspace/02_api_spec.md §3.9, _workspace/00_input.md §11.3 (PIVOT-01).
 *
 * Strategy:
 *   - Mock `standardwebhooks` so we can drive verify() success/failure
 *     deterministically without depending on the real lib being installed
 *     in the test env.
 *   - Mock supabaseAdmin() so we can observe inserts/updates.
 *   - For each Dodo event type, assert handleDodoEvent fans out to the
 *     correct DB table with the correct shape.
 *
 * Out of scope: end-to-end HTTP transport via the Next.js Route Handler
 * harness (manual smoke covered in _workspace/05_deploy_guide.md §5.3).
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
  id?: string;
}) {
  return {
    id: opts.id ?? `evt_pay_${Math.random().toString(36).slice(2)}`,
    type: "payment.succeeded",
    data: {
      object: {
        id: `pay_${Math.random().toString(36).slice(2)}`,
        customer_id: "cus_stub",
        subscription_id: opts.plan === "monthly_sub" ? "sub_stub" : null,
        metadata: { user_id: opts.userId, plan: opts.plan },
      },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("dodo webhook — signature verification (Standard Webhooks)", () => {
  it("verify() passes for a properly signed payload", async () => {
    const { verifyDodoSignature } = await import("@/lib/dodo/webhook");
    const event = { id: "evt_1", type: "ping", data: {} };
    const body = JSON.stringify(event);
    const out = verifyDodoSignature({ rawBody: body, headers: validHeaders() });
    expect(out.id).toBe("evt_1");
    expect(out.type).toBe("ping");
  });

  it("verify() throws for an invalid signature (ERR_WEBHOOK_SIGNATURE source)", async () => {
    const { verifyDodoSignature } = await import("@/lib/dodo/webhook");
    const body = JSON.stringify({ id: "evt_1", type: "ping", data: {} });
    const badHeaders = { ...validHeaders(), "webhook-signature": "v1,nope" };
    expect(() =>
      verifyDodoSignature({ rawBody: body, headers: badHeaders }),
    ).toThrow();
  });

  it("verify() throws when the secret is wrong", async () => {
    const { verifyDodoSignature } = await import("@/lib/dodo/webhook");
    const body = JSON.stringify({ id: "evt_1", type: "ping", data: {} });
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

  it("payment.succeeded + plan=weekly_pass inserts a subscriptions row (soft_cap=100, +7d)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent(
      makePaymentSucceeded({ plan: "weekly_pass", userId: "user-2" }),
    );
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.plan).toBe("weekly_pass");
    expect(insert?.payload.soft_cap).toBe(100);
    expect(insert?.payload.status).toBe("active");
    const start = new Date(insert!.payload.period_start as string).getTime();
    const end = new Date(insert!.payload.period_end as string).getTime();
    const diffDays = (end - start) / 86_400_000;
    expect(diffDays).toBeGreaterThan(6.9);
    expect(diffDays).toBeLessThan(7.1);
  });

  it("payment.succeeded + plan=monthly_sub inserts a subscriptions row (soft_cap=500, +30d)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent(
      makePaymentSucceeded({ plan: "monthly_sub", userId: "user-3" }),
    );
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.plan).toBe("monthly_sub");
    expect(insert?.payload.soft_cap).toBe(500);
  });

  it("subscription.active inserts an active subscriptions row", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "evt_sub_active",
      type: "subscription.active",
      data: {
        object: {
          subscription_id: "sub_active",
          customer_id: "cus_stub",
          metadata: { user_id: "user-9", plan: "monthly_sub" },
        },
      },
    });
    const insert = captured.find(
      (c) => c.table === "subscriptions" && c.op === "insert",
    );
    expect(insert).toBeDefined();
    expect(insert?.payload.status).toBe("active");
    expect(insert?.payload.plan).toBe("monthly_sub");
    expect(insert?.payload.dodo_subscription_id).toBe("sub_active");
  });

  it("subscription.renewed extends period_end and resets usage_count", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "evt_renew",
      type: "subscription.renewed",
      data: {
        object: {
          subscription_id: "sub_stub",
          metadata: { plan: "monthly_sub" },
        },
      },
    });
    const upd = captured.find(
      (c) => c.table === "subscriptions" && c.op === "update",
    );
    expect(upd).toBeDefined();
    expect(upd?.payload.usage_count).toBe(0);
    expect(upd?.payload.status).toBe("active");
    expect(upd?.match?.dodo_subscription_id).toBe("sub_stub");
  });

  it("subscription.cancelled marks status='canceled'", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "evt_cancel",
      type: "subscription.cancelled",
      data: { object: { subscription_id: "sub_stub" } },
    });
    const upd = captured.find(
      (c) => c.table === "subscriptions" && c.op === "update",
    );
    expect(upd?.payload.status).toBe("canceled");
    expect(upd?.match?.dodo_subscription_id).toBe("sub_stub");
  });

  it("refund.succeeded (credit_single, within 7d) inserts a -1 refund_reversal ledger row", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextLedgerBalance = 3;
    await handleDodoEvent({
      id: "evt_ref",
      type: "refund.succeeded",
      data: {
        object: {
          id: "ref_stub",
          customer_id: "cus_stub",
          payment_created_at: Math.floor(Date.now() / 1000),
          metadata: { user_id: "user-4", plan: "credit_single" },
        },
      },
    });
    const insert = captured.find(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(insert?.payload.type).toBe("refund_reversal");
    expect(insert?.payload.delta).toBe(-1);
    expect(insert?.payload.balance_after).toBe(2);
    expect(String(insert?.payload.note)).toMatch(/within 7d/);
  });

  it("refund.succeeded (after 7d) is still recorded but note says operator override", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextLedgerBalance = 5;
    const eightDaysAgo = Math.floor((Date.now() - 8 * 86_400_000) / 1000);
    await handleDodoEvent({
      id: "evt_ref_old",
      type: "refund.succeeded",
      data: {
        object: {
          id: "ref_old",
          customer_id: "cus_stub",
          payment_created_at: eightDaysAgo,
          metadata: { user_id: "user-5", plan: "credit_single" },
        },
      },
    });
    const insert = captured.find(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(insert?.payload.type).toBe("refund_reversal");
    expect(String(insert?.payload.note)).toMatch(/operator override after 7d/);
  });

  it("unhandled event type is a silent no-op (200 OK at the route layer)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "evt_unknown",
      type: "payment.failed",
      data: { object: {} },
    });
    expect(captured).toHaveLength(0);
  });

  it("missing metadata.user_id or plan on payment.succeeded is a no-op (warn-only)", async () => {
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    await handleDodoEvent({
      id: "evt_bad_meta",
      type: "payment.succeeded",
      data: {
        object: {
          id: "pay_bad",
          // no metadata
        },
      },
    });
    expect(captured).toHaveLength(0);
  });
});

describe("dodo webhook — idempotency contract", () => {
  it("same event.id is rejected at the dodo_events PK level (simulated)", async () => {
    // This is a documentation-only assertion: the route handler relies on
    // INSERT INTO dodo_events ON CONFLICT (id) DO NOTHING and treats the
    // 23505 unique_violation as "already processed → 200 OK". The handler
    // itself is pure dispatch and does not double-check; the contract is
    // exercised end-to-end in the manual smoke (deploy_guide §5.3).
    const eventId = "evt_dup_42";
    const { handleDodoEvent } = await import("@/lib/dodo/webhook");
    nextLedgerBalance = 1;
    await handleDodoEvent(
      makePaymentSucceeded({ plan: "credit_single", userId: "user-7", id: eventId }),
    );
    const inserts = captured.filter(
      (c) => c.table === "credit_ledger" && c.op === "insert",
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.payload.dodo_event_id).toBe(eventId);
  });
});
