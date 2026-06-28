import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractUpworkCoreText, extractUpworkJobTitle } from "../upwork";

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../../../tests/fixtures/upwork-sample.txt",
);

const goldenFixture = readFileSync(FIXTURE_PATH, "utf-8");

describe("extractUpworkCoreText — spec/02 §3.3.4 T1~T6", () => {
  it("T1: golden fixture — strips top nav header and bottom footer, preserves core signals", () => {
    const out = extractUpworkCoreText(goldenFixture);

    // Header cut: 'Find Work', 'Search for Jobs', 'Home /' must be gone
    expect(out.startsWith("Job details")).toBe(true);
    expect(out).not.toContain("Find Work Deliver Work");
    expect(out).not.toContain("Search for Jobs, Freelancers");
    expect(out).not.toContain("Home / Find Work");

    // Footer cut: 'Browse jobs', '© 2015', 'Terms of Service' must be gone
    expect(out).not.toContain("Browse jobs Development");
    expect(out).not.toContain("© 2015 - 2026");
    expect(out).not.toContain("Terms of Service Privacy");

    // Core signal preservation
    expect(out).toContain("Telegram @scam_handler_test");
    expect(out).toContain("45% hire rate");
    expect(out).toContain("$10k+ total spent");
    expect(out).toContain("5.00 of 5 reviews");
    expect(out).toContain("Payment method verified");
  });

  it("T2: empty string → empty string", () => {
    expect(extractUpworkCoreText("")).toBe("");
  });

  it("T3: missing 'Job details' keyword → returns trimmed original (no header cut)", () => {
    const input =
      "Some random text that does not contain the trigger keywords. Hourly range $40.";
    const out = extractUpworkCoreText(input);
    expect(out).toBe(input.replace(/\s+/g, " ").trim());
  });

  it("T4: only 'Browse jobs' footer present → footer cut, header preserved", () => {
    const input =
      "This is the job body content describing the project requirements. Browse jobs Development & IT Front-End";
    const out = extractUpworkCoreText(input);
    expect(out).toContain("This is the job body content");
    expect(out).not.toContain("Browse jobs");
  });

  it("T5: 'Job Description' (capital D) variant → matched via /i flag", () => {
    const input =
      "Nav junk Home / Find Work Job Description: build a Next.js app. About the client";
    const out = extractUpworkCoreText(input);
    expect(out.startsWith("Job Description")).toBe(true);
    expect(out).not.toContain("Nav junk Home");
  });

  it("T6: 'BACK TO JOB POST' (all caps) variant → matched via /i flag", () => {
    const input =
      "Header garbage Notifications Messages BACK TO JOB POST Senior React role posted recently.";
    const out = extractUpworkCoreText(input);
    expect(out.toUpperCase().startsWith("BACK TO JOB POST")).toBe(true);
    expect(out).not.toContain("Header garbage");
  });
});

describe("extractUpworkJobTitle", () => {
  it("extracts the title from the Upwork breadcrumb in the golden fixture", () => {
    expect(extractUpworkJobTitle(goldenFixture)).toBe(
      "React Developer for AI SaaS Platform Integration",
    );
  });

  it("extracts the title after Job details when breadcrumb is absent", () => {
    const input = [
      "Find Work Deliver Work",
      "Job details",
      "Senior Next.js Engineer for SaaS Dashboard",
      "Posted 1 hour ago",
      "Worldwide",
      "Job Description:",
      "Build a product dashboard.",
    ].join("\n");

    expect(extractUpworkJobTitle(input)).toBe(
      "Senior Next.js Engineer for SaaS Dashboard",
    );
  });

  it("falls back to compact preprocessed text", () => {
    const input =
      "Job details UX Designer for Fintech Landing Page Posted 2 hours ago Worldwide Job Description: Need help.";

    expect(extractUpworkJobTitle(input)).toBe(
      "UX Designer for Fintech Landing Page",
    );
  });

  it("returns null when no Upwork title marker is present", () => {
    expect(extractUpworkJobTitle("Plain description without page markers.")).toBeNull();
  });
});
