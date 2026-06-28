/**
 * API DTOs — must match _workspace/02_api_spec.md exactly.
 * Backend will conform to these shapes. Do not drift.
 */

export type RiskLevel = "SAFE" | "WARNING" | "DANGER";
export type Verdict = "SHOW_REPORT" | "DO_NOT_APPLY";
export type RuleTriggered =
  | "LOW_HIRE_RATE"
  | "PAYMENT_UNVERIFIED_ZERO_SPEND"
  | "LOW_RATING";

export type PlanKey = "credit_single" | "weekly_pass" | "monthly_sub";

// ── 3.2 POST /api/profile/extract ─────────────────────────────────────────
export interface ProfileExtractRequest {
  resume_text: string;
}

export interface ProfileExtractResponse {
  extracted: {
    skills: string[];
    years_of_experience: number;
    target_hourly_rate: number;
    timezone: string;
  };
  warnings: string[];
}

// ── 3.3 GET /api/profile, 3.4 PUT /api/profile ───────────────────────────
export interface ProfileResponse {
  user_id: string;
  skills: string[];
  years_of_experience: number;
  target_hourly_rate: number;
  timezone: string;
  resume_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileUpdateRequest {
  skills: string[];
  years_of_experience: number;
  target_hourly_rate: number;
  timezone: string;
  resume_text?: string;
}

// ── 3.5 POST /api/analyze ─────────────────────────────────────────────────
export interface AnalyzeRequest {
  job_text: string;
  job_title?: string | null;
}

export interface AnalyzeResponse {
  analysis_id: string;
  job_title: string | null;
  verdict: Verdict;
  backend_risk: {
    critical: boolean;
    rules_triggered: RuleTriggered[];
  };
  ai_risk: {
    risk_level: RiskLevel;
    contextual_red_flags: string[];
  };
  match_score: number | null;
  score_reason: string | null;
  action_tip: string;
  extracted_signals: {
    client_hire_rate: number;
    client_hire_rate_found: boolean;
    payment_verified: boolean;
    payment_verified_found: boolean;
    total_spend_amount: number;
    total_spend_found: boolean;
    client_rating: number;
    client_rating_found: boolean;
  };
  evidence_quotes: string[];
  reasoning_bullets: string[];
  credit_after: number;
  took_ms: number;
  prompt_version: number;
}

// ── 3.6 GET /api/analyses ─────────────────────────────────────────────────
export interface AnalysesListItem {
  id: string;
  job_title: string | null;
  verdict: Verdict;
  risk_level: RiskLevel;
  match_score: number | null;
  is_reported: boolean;
  created_at: string;
}

export interface AnalysesListResponse {
  items: AnalysesListItem[];
  next_cursor: string | null;
}

// ── 3.7 GET /api/credits ──────────────────────────────────────────────────
export interface CreditsResponse {
  balance: number;
  active_pass: {
    type: "weekly";
    expires_at: string;
    usage_this_period: number;
    soft_cap: number;
  } | null;
  active_subscription: {
    type: "monthly";
    period_end: string;
    usage_this_period: number;
    soft_cap: number;
    cancel_at_period_end: boolean;
  } | null;
}

// ── 3.8 POST /api/checkout ────────────────────────────────────────────────
export interface CheckoutRequest {
  plan: PlanKey;
}

export interface CheckoutResponse {
  checkout_url: string;
  session_id: string;
}

// ── POST /api/subscription/cancel ─────────────────────────────────────────
export interface CancelSubscriptionResponse {
  ok: true;
  already_cancelled?: boolean;
}

// ── 3.10 POST /api/report-scam ────────────────────────────────────────────
export interface ReportScamRequest {
  analysis_id: string;
  reason: string;
}

export interface ReportScamResponse {
  ok: true;
}

// ── Standard error envelope ───────────────────────────────────────────────
export type ApiErrorCode =
  | "ERR_BAD_REQUEST"
  | "ERR_WEBHOOK_SIGNATURE"
  | "ERR_UNAUTHENTICATED"
  | "ERR_OUT_OF_CREDITS"
  | "ERR_SOFT_CAP_REACHED"
  | "ERR_FORBIDDEN"
  | "ERR_NOT_FOUND"
  | "ERR_DUPLICATE_REFUND"
  | "ERR_INPUT_TOO_LARGE"
  | "ERR_VALIDATION"
  | "ERR_RATE_LIMITED"
  | "ERR_INTERNAL"
  | "ERR_PROMPT_NOT_FOUND"
  | "ERR_LLM_UPSTREAM"
  | "ERR_PAYMENT_UPSTREAM";

export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}
