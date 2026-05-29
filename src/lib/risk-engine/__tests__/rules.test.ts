/**
 * Unit tests for the quantitative Risk Engine.
 * Source: _workspace/01_architecture.md §6.2, spec/03 §6.1 thresholds.
 *
 * Coverage targets:
 *   - Each rule fires in isolation
 *   - Combinations of rules
 *   - Boundary values for every threshold
 *   - "Safe" cases that must NOT trigger anything
 */
import { describe, it, expect } from "vitest";
import { evaluate, type QuantSignals } from "../rules";

function q(overrides: Partial<QuantSignals> = {}): QuantSignals {
  return {
    client_hire_rate: 80,
    payment_verified: true,
    total_spend_amount: 5_000,
    client_rating: 4.8,
    ...overrides,
  };
}

describe("risk-engine/rules.evaluate — single-rule triggers", () => {
  it("LOW_HIRE_RATE fires when client_hire_rate < 20", () => {
    const r = evaluate(q({ client_hire_rate: 5 }));
    expect(r.critical).toBe(true);
    expect(r.rules_triggered).toEqual(["LOW_HIRE_RATE"]);
  });

  it("LOW_HIRE_RATE fires at the lowest boundary (0)", () => {
    expect(evaluate(q({ client_hire_rate: 0 })).rules_triggered).toContain(
      "LOW_HIRE_RATE",
    );
  });

  it("LOW_HIRE_RATE fires at boundary 19 (strict <)", () => {
    expect(evaluate(q({ client_hire_rate: 19 })).rules_triggered).toContain(
      "LOW_HIRE_RATE",
    );
  });

  it("LOW_HIRE_RATE does NOT fire at exactly 20 (strict <)", () => {
    expect(evaluate(q({ client_hire_rate: 20 })).rules_triggered).not.toContain(
      "LOW_HIRE_RATE",
    );
  });

  it("PAYMENT_UNVERIFIED_ZERO_SPEND fires only with both flags", () => {
    const r = evaluate(
      q({ payment_verified: false, total_spend_amount: 0 }),
    );
    expect(r.critical).toBe(true);
    expect(r.rules_triggered).toContain("PAYMENT_UNVERIFIED_ZERO_SPEND");
  });

  it("PAYMENT_UNVERIFIED_ZERO_SPEND does NOT fire with payment_verified=true even if spend=0", () => {
    const r = evaluate(q({ payment_verified: true, total_spend_amount: 0 }));
    expect(r.rules_triggered).not.toContain("PAYMENT_UNVERIFIED_ZERO_SPEND");
  });

  it("PAYMENT_UNVERIFIED_ZERO_SPEND does NOT fire when spend > 0 even if unverified", () => {
    const r = evaluate(
      q({ payment_verified: false, total_spend_amount: 1 }),
    );
    expect(r.rules_triggered).not.toContain("PAYMENT_UNVERIFIED_ZERO_SPEND");
  });

  it("LOW_RATING fires when client_rating > 0 AND <= 3.5", () => {
    const r = evaluate(q({ client_rating: 3.5 }));
    expect(r.critical).toBe(true);
    expect(r.rules_triggered).toEqual(["LOW_RATING"]);
  });

  it("LOW_RATING fires at boundary just above 0 (0.1)", () => {
    expect(evaluate(q({ client_rating: 0.1 })).rules_triggered).toContain(
      "LOW_RATING",
    );
  });

  it("LOW_RATING does NOT fire at exactly 0 (new client / no reviews)", () => {
    const r = evaluate(q({ client_rating: 0 }));
    expect(r.rules_triggered).not.toContain("LOW_RATING");
  });

  it("LOW_RATING does NOT fire at 3.51 (just above threshold)", () => {
    expect(evaluate(q({ client_rating: 3.51 })).rules_triggered).not.toContain(
      "LOW_RATING",
    );
  });

  it("LOW_RATING does NOT fire at 5.0", () => {
    expect(evaluate(q({ client_rating: 5.0 })).rules_triggered).not.toContain(
      "LOW_RATING",
    );
  });
});

describe("risk-engine/rules.evaluate — combinations", () => {
  it("All three rules fire simultaneously => critical with 3 codes (order preserved)", () => {
    const r = evaluate({
      client_hire_rate: 0,
      payment_verified: false,
      total_spend_amount: 0,
      client_rating: 1.0,
    });
    expect(r.critical).toBe(true);
    expect(r.rules_triggered).toEqual([
      "LOW_HIRE_RATE",
      "PAYMENT_UNVERIFIED_ZERO_SPEND",
      "LOW_RATING",
    ]);
  });

  it("LOW_HIRE_RATE + PAYMENT_UNVERIFIED_ZERO_SPEND combination", () => {
    const r = evaluate({
      client_hire_rate: 8,
      payment_verified: false,
      total_spend_amount: 0,
      client_rating: 4.9,
    });
    expect(r.critical).toBe(true);
    expect(r.rules_triggered).toEqual([
      "LOW_HIRE_RATE",
      "PAYMENT_UNVERIFIED_ZERO_SPEND",
    ]);
  });

  it("PAYMENT_UNVERIFIED_ZERO_SPEND + LOW_RATING combination", () => {
    const r = evaluate({
      client_hire_rate: 50,
      payment_verified: false,
      total_spend_amount: 0,
      client_rating: 2.0,
    });
    expect(r.rules_triggered).toEqual([
      "PAYMENT_UNVERIFIED_ZERO_SPEND",
      "LOW_RATING",
    ]);
  });
});

describe("risk-engine/rules.evaluate — safe (no rules)", () => {
  it("Healthy client metrics => critical=false, rules_triggered=[]", () => {
    const r = evaluate({
      client_hire_rate: 78,
      payment_verified: true,
      total_spend_amount: 12_400,
      client_rating: 4.9,
    });
    expect(r.critical).toBe(false);
    expect(r.rules_triggered).toEqual([]);
  });

  it("New client (rating=0, spend=0) but payment_verified=true => safe (no rules)", () => {
    // Verified payment is the strongest signal. Zero spend alone is fine.
    const r = evaluate({
      client_hire_rate: 50,
      payment_verified: true,
      total_spend_amount: 0,
      client_rating: 0,
    });
    expect(r.critical).toBe(false);
    expect(r.rules_triggered).toEqual([]);
  });

  it("Boundary safe: client_hire_rate=20, rating=3.51, verified, spend=1 => no rules", () => {
    const r = evaluate({
      client_hire_rate: 20,
      payment_verified: true,
      total_spend_amount: 1,
      client_rating: 3.51,
    });
    expect(r.critical).toBe(false);
    expect(r.rules_triggered).toEqual([]);
  });
});
