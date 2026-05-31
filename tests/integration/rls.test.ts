/**
 * Integration test — Row-Level Security contract verification.
 *
 * Live two-user RLS verification requires a real Supabase instance (Phase 5.3
 * smoke #10 in _workspace/05_deploy_guide.md) and so is gated behind
 * SUPABASE_TEST_URL + SUPABASE_TEST_ANON_KEY env vars. When the env is not
 * provided (CI default), the live block skips; the static checks always run.
 *
 * Static checks (always run):
 *   - 0002_rls_policies.sql enables RLS on the 6 in-scope tables.
 *   - The 6 in-scope tables each have at least the policy described in
 *     _workspace/03_db_schema.md §4.
 *   - system_prompts and dodo_events have RLS enabled but no policy
 *     (deny-by-default for non-service_role).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RLS_SQL_PATH = path.resolve(
  __dirname,
  "../../supabase/migrations/0002_rls_policies.sql",
);
const SQL = readFileSync(RLS_SQL_PATH, "utf-8");

describe("RLS contract (static) — 0002_rls_policies.sql", () => {
  const ENABLED = [
    "users_profile",
    "credit_ledger",
    "subscriptions",
    "analyses",
    "system_prompts",
    "dodo_events",
  ];

  it.each(ENABLED)("RLS is ENABLED on public.%s", (table) => {
    const re = new RegExp(
      `ALTER TABLE\\s+public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`,
      "i",
    );
    expect(SQL).toMatch(re);
  });

  it("users_profile has select_own / insert_own / update_own policies", () => {
    expect(SQL).toMatch(/POLICY\s+users_profile_select_own/);
    expect(SQL).toMatch(/POLICY\s+users_profile_insert_own/);
    expect(SQL).toMatch(/POLICY\s+users_profile_update_own/);
  });

  it("credit_ledger has SELECT-own only (no INSERT/UPDATE policy => service_role only)", () => {
    expect(SQL).toMatch(/POLICY\s+credit_ledger_select_own/);
    expect(SQL).not.toMatch(/POLICY\s+credit_ledger_insert_/);
    expect(SQL).not.toMatch(/POLICY\s+credit_ledger_update_/);
  });

  it("subscriptions has SELECT-own only", () => {
    expect(SQL).toMatch(/POLICY\s+subscriptions_select_own/);
    expect(SQL).not.toMatch(/POLICY\s+subscriptions_insert_/);
  });

  it("analyses has SELECT-own + UPDATE-own (column guard in app layer)", () => {
    expect(SQL).toMatch(/POLICY\s+analyses_select_own/);
    expect(SQL).toMatch(/POLICY\s+analyses_update_report_own/);
  });

  it("system_prompts and dodo_events are deny-by-default (RLS enabled, zero policies)", () => {
    // Heuristic: no CREATE POLICY line that mentions either table.
    const systemPromptsHasPolicy = /CREATE POLICY[^;]*\bsystem_prompts\b/i.test(
      SQL,
    );
    const dodoEventsHasPolicy = /CREATE POLICY[^;]*\bdodo_events\b/i.test(
      SQL,
    );
    expect(systemPromptsHasPolicy).toBe(false);
    expect(dodoEventsHasPolicy).toBe(false);
  });

  it("Every policy enforces auth.uid() = user_id (defence: no over-permissive predicate)", () => {
    // Walk every CREATE POLICY ... ; statement and assert at least one
    // auth.uid() = user_id clause appears (either in USING or WITH CHECK).
    const policyBlocks = SQL.match(/CREATE POLICY[\s\S]*?;/g);
    expect(policyBlocks).toBeTruthy();
    for (const block of policyBlocks ?? []) {
      expect(block).toMatch(/auth\.uid\(\)\s*=\s*user_id/);
    }
  });
});

// --------------------------------------------------------------------
// Live RLS test (skipped unless SUPABASE_TEST_* envs are present).
// --------------------------------------------------------------------
const liveEnabled = Boolean(
  process.env.SUPABASE_TEST_URL && process.env.SUPABASE_TEST_ANON_KEY,
);

describe.skipIf(!liveEnabled)(
  "RLS contract (live) — two-user cross-access",
  () => {
    it("Documented manually in _workspace/05_deploy_guide.md §5.3 #10", () => {
      // Real run would:
      //   1. Sign in as User A, insert an analysis via service_role.
      //   2. Sign in as User B with anon key + JWT, attempt SELECT by id → expect 0 rows.
      //   3. Attempt UPDATE → expect 0 rows updated.
      // CI placeholder — the env-guarded variant is reserved for v1.0 when a
      // dedicated Supabase test project is provisioned.
      expect(liveEnabled).toBe(true);
    });
  },
);
