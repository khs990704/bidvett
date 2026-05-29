/**
 * Unit tests for finalizeScore.
 * Source: _workspace/01_architecture.md §6.3.
 *
 * Rules under test:
 *   - DANGER risk_level => match_score=null, verdict=DO_NOT_APPLY
 *   - backend_critical=true => match_score=null, verdict=DO_NOT_APPLY (regardless of risk_level)
 *   - Otherwise => match_score clamped to [0,100], verdict=SHOW_REPORT
 */
import { describe, it, expect } from "vitest";
import { finalizeScore } from "../score";

describe("risk-engine/score.finalizeScore — masking", () => {
  it("DANGER masks match_score to null and forces DO_NOT_APPLY", () => {
    const out = finalizeScore({
      llm_match_score: 92,
      risk_level: "DANGER",
      backend_critical: false,
    });
    expect(out.match_score).toBeNull();
    expect(out.verdict).toBe("DO_NOT_APPLY");
  });

  it("backend_critical=true with SAFE risk still masks score", () => {
    const out = finalizeScore({
      llm_match_score: 88,
      risk_level: "SAFE",
      backend_critical: true,
    });
    expect(out.match_score).toBeNull();
    expect(out.verdict).toBe("DO_NOT_APPLY");
  });

  it("DANGER + critical => masked once (no double-processing artifacts)", () => {
    const out = finalizeScore({
      llm_match_score: 50,
      risk_level: "DANGER",
      backend_critical: true,
    });
    expect(out.match_score).toBeNull();
    expect(out.verdict).toBe("DO_NOT_APPLY");
  });
});

describe("risk-engine/score.finalizeScore — pass-through", () => {
  it("SAFE + non-critical => verdict SHOW_REPORT, integer score", () => {
    const out = finalizeScore({
      llm_match_score: 82,
      risk_level: "SAFE",
      backend_critical: false,
    });
    expect(out.match_score).toBe(82);
    expect(out.verdict).toBe("SHOW_REPORT");
  });

  it("WARNING + non-critical still surfaces report (does not mask)", () => {
    const out = finalizeScore({
      llm_match_score: 55,
      risk_level: "WARNING",
      backend_critical: false,
    });
    expect(out.match_score).toBe(55);
    expect(out.verdict).toBe("SHOW_REPORT");
  });

  it("Score clamped to upper bound 100", () => {
    const out = finalizeScore({
      llm_match_score: 250,
      risk_level: "SAFE",
      backend_critical: false,
    });
    expect(out.match_score).toBe(100);
  });

  it("Score clamped to lower bound 0", () => {
    const out = finalizeScore({
      llm_match_score: -25,
      risk_level: "SAFE",
      backend_critical: false,
    });
    expect(out.match_score).toBe(0);
  });

  it("Fractional score truncated (not rounded) to satisfy DB integer column", () => {
    const out = finalizeScore({
      llm_match_score: 79.9,
      risk_level: "SAFE",
      backend_critical: false,
    });
    expect(out.match_score).toBe(79);
  });

  it("WARNING but backend_critical (rule fired) still masks", () => {
    const out = finalizeScore({
      llm_match_score: 70,
      risk_level: "WARNING",
      backend_critical: true,
    });
    expect(out.match_score).toBeNull();
    expect(out.verdict).toBe("DO_NOT_APPLY");
  });
});
