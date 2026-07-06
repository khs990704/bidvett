# API 초안 — BidVett

> [PIVOT-01 rev2 — 2026-05-29] 결제 인프라 Stripe → Dodo Payments. §2 #9~#10, §3.7~§3.8, §4 webhook code, 에러 코드(`ERR_WEBHOOK_SIGNATURE`, `ERR_STRIPE_UPSTREAM` → `ERR_DODO_UPSTREAM`)를 갱신했다. 결정 매트릭스는 `_workspace/00_input.md §11`.
> Base URL: `https://app.bidvett.com/api` (production), `http://localhost:3000/api` (dev)
> Auth scheme: Supabase JWT via `Authorization: Bearer <access_token>` OR session cookie set by `@supabase/ssr`
> Response: `application/json` (UTF-8)
> All user-facing strings: English (Q5)

---

## 1. 인증 방식

- Google OAuth via Supabase Auth로 로그인
- Frontend는 `supabase.auth.signInWithOAuth({ provider: 'google' })` 호출
- Callback에서 Supabase가 세션 쿠키를 set → 이후 모든 `/api/*` 요청은 Next.js Middleware에서 세션 검증
- Server-only routes는 `getUser()`로 사용자 식별, RLS로 데이터 인가

## 2. 핵심 엔드포인트 목록

| # | Method | Path | 설명 | 인증 | Body / Params |
|---|--------|------|------|------|---------------|
| 1 | POST | `/api/auth/callback` | OAuth 콜백, 세션 교환 + 신규 가입 시 무료 크레딧 5개 지급 | Public (signed by Supabase) | `?code=<oauth_code>` |
| 2 | POST | `/api/profile/extract` | 자유 텍스트 이력서 → 구조화 4필드 추출 (LLM) | Required | `{ "resume_text": string }` |
| 3 | GET | `/api/profile` | 현재 사용자 프로필 조회 | Required | — |
| 4 | PUT | `/api/profile` | 프로필 저장/수정 | Required | `{ skills, years_of_experience, target_hourly_rate, timezone, resume_text? }` |
| 5 | POST | `/api/analyze` | 공고 분석 핵심 엔드포인트 | Required | `{ "job_text": string }` |
| 6 | GET | `/api/analyses` | 분석 이력 페이지네이션 | Required | `?cursor=<id>&limit=<n>` |
| 7 | GET | `/api/analyses/[id]` | 단건 상세 | Required | path param `id` |
| 8 | GET | `/api/credits` | 잔여 크레딧 + 활성 패스/구독 요약 | Required | — |
| 9 | POST | `/api/checkout` | Dodo Hosted Checkout Session 생성 | Required | `{ "plan": "credit_single" \| "weekly_pass" \| "monthly_sub" }` |
| 10 | POST | `/api/webhooks/dodo` | Dodo Payments Webhook 수신 | Standard Webhooks signature | raw body, headers `webhook-id` / `webhook-timestamp` / `webhook-signature` |
| 11 | POST | `/api/report-scam` | 분석 결과를 사기 신고 | Required | `{ "analysis_id": uuid, "reason": string }` |

> 참고: 운영자 어드민 페이지는 개발하지 않음 (Q4-A) — 모든 운영은 Supabase Data Browser + Dodo Dashboard에서 수행.

## 3. 주요 요청/응답 예시

### 3.1 POST `/api/auth/callback`

Supabase Auth가 자동 처리하지만, Server Action 단에서 신규 가입자 후처리를 수행:

- 신규 user → `users_profile`에 row 없음 → `credit_ledger`에 `{type: 'free_grant', delta: +5}` insert
- 기존 user → no-op

응답: `302 Redirect` → 신규 가입 시 `/onboarding`, 기존 사용자는 `/dashboard`.

### 3.2 POST `/api/profile/extract`

Request:

```json
{
  "resume_text": "I'm a full-stack developer with 4 years of experience in React, Node.js, and TypeScript. I'm based in Seoul, Korea (UTC+9). My rate is around $40/hr."
}
```

Response 200:

```json
{
  "extracted": {
    "skills": ["React", "Node.js", "TypeScript"],
    "years_of_experience": 4,
    "target_hourly_rate": 40,
    "timezone": "UTC+9"
  },
  "warnings": []
}
```

- 이 엔드포인트는 **크레딧을 차감하지 않는다** (온보딩 UX).
- 단, per-user rate limit 5/min 적용. OpenAI 호출이므로 input length cap 16k.

### 3.3 PUT `/api/profile`

Request:

```json
{
  "skills": ["React", "Node.js", "TypeScript", "PostgreSQL"],
  "years_of_experience": 4,
  "target_hourly_rate": 45,
  "timezone": "UTC+9",
  "resume_text": "(optional raw text)"
}
```

Response 200:

```json
{
  "user_id": "8a4f...e2",
  "skills": ["React", "Node.js", "TypeScript", "PostgreSQL"],
  "years_of_experience": 4,
  "target_hourly_rate": 45,
  "timezone": "UTC+9",
  "updated_at": "2026-05-27T11:24:01Z"
}
```

### 3.4 POST `/api/analyze` ★ Core

Request:

```json
{
  "job_text": "(Upwork job posting full page text — already pre-processed on the client)"
}
```

Response 200 (Safe case):

```json
{
  "analysis_id": "9b1f...11",
  "verdict": "SHOW_REPORT",
  "backend_risk": {
    "critical": false,
    "rules_triggered": []
  },
  "ai_risk": {
    "risk_level": "SAFE",
    "contextual_red_flags": []
  },
  "match_score": 82,
  "score_reason": "Strong skill overlap (React, Node.js, TypeScript). Budget within 10% of your $45/hr target. Client timezone overlaps 4 hours with your UTC+9.",
  "action_tip": "Lead your proposal with the React performance optimization case from your portfolio. Quote $45/hr; the client's prior hires averaged $42-$48.",
  "extracted_signals": {
    "client_hire_rate": 78,
    "payment_verified": true,
    "total_spend_amount": 12400,
    "client_rating": 4.9
  },
  "credit_after": 2,
  "took_ms": 2410
}
```

Response 200 (Risk case):

```json
{
  "analysis_id": "9b1f...12",
  "verdict": "DO_NOT_APPLY",
  "backend_risk": {
    "critical": true,
    "rules_triggered": ["LOW_HIRE_RATE", "PAYMENT_UNVERIFIED_ZERO_SPEND"]
  },
  "ai_risk": {
    "risk_level": "DANGER",
    "contextual_red_flags": [
      "Client asks to move communication to Telegram.",
      "Requests upfront deposit before NDA."
    ]
  },
  "match_score": null,
  "score_reason": null,
  "action_tip": "Skip this job and report it to Upwork TOS team.",
  "extracted_signals": {
    "client_hire_rate": 8,
    "payment_verified": false,
    "total_spend_amount": 0,
    "client_rating": 0.0
  },
  "credit_after": 2,
  "took_ms": 2880
}
```

Error responses (see §4).

#### Internal sequence

1. Middleware: Auth + Rate Limit (60/min)
2. Pre-check: `credit_ledger` balance >= 1 OR active pass/subscription within soft cap → else 402
3. Build OpenAI request with Structured Outputs schema combining quant 4 fields + qual 5 fields
4. Silent Retry x3 on 5xx/timeout (backoff 200/500/1200ms)
5. On success: Rule Engine + Score Engine → persist `analyses` row → Deduct 1 credit (or increment pass/sub usage counter)
6. Return JSON

### 3.5 GET `/api/analyses`

Request: `GET /api/analyses?limit=20&cursor=2026-05-27T10:00:00Z`

Response 200:

```json
{
  "items": [
    {
      "id": "9b1f...11",
      "verdict": "SHOW_REPORT",
      "risk_level": "SAFE",
      "match_score": 82,
      "created_at": "2026-05-27T11:24:01Z"
    }
  ],
  "next_cursor": "2026-05-27T11:20:00Z"
}
```

### 3.6 GET `/api/credits`

Response 200:

```json
{
  "balance": 2,
  "active_pass": {
    "type": "weekly",
    "expires_at": "2026-06-03T11:24:01Z",
    "usage_this_period": 14,
    "soft_cap": 100,
    "is_recurring": true,
    "cancel_at_period_end": false
  },
  "active_subscription": null
}
```

### 3.7 POST `/api/checkout`

Request:

```json
{ "plan": "weekly_pass" }
```

Plan 종류: `credit_single` ($0.99), `weekly_pass` ($4.99), `monthly_sub` ($19).

Response 200:

```json
{
  "checkout_url": "https://checkout.dodopayments.com/<session-id>",
  "session_id": "<dodo-checkout-session-id>"
}
```

활성 주간/월간 구독이 이미 있으면 새 주간/월간 checkout은 `409 ERR_BAD_REQUEST`로 차단한다. 단건 크레딧 구매는 기존 구독과 무관하게 허용한다. MVP에서는 proration/즉시 플랜 변경을 지원하지 않으므로, 사용자는 기존 구독을 취소하고 현재 paid period가 끝난 뒤 다른 recurring plan을 시작한다.

내부 호출 (의사 시그니처 — `// [TBD: confirm exact Dodo Payments SDK signature]`):

```ts
// import Dodo from 'dodopayments';
// const dodo = new Dodo({ apiKey: process.env.DODO_API_KEY! });
const session = await dodo.checkoutSessions.create({  // [TBD: confirm exact Dodo Payments SDK signature]
  productId: process.env.NEXT_PUBLIC_DODO_PRODUCT_WEEKLY!,
  successUrl: `${appUrl}/dashboard?status=success`,
  cancelUrl: `${appUrl}/pricing?status=cancel`,
  customerReferenceId: user.id,
  metadata: { user_id: user.id, plan: 'weekly_pass' },
});
```

> Dodo는 publishable key가 없으므로 클라이언트는 받은 `checkout_url`로 단순 redirect만 한다 (Stripe.js 같은 클라이언트 SDK 의존성 없음).

### 3.8 POST `/api/webhooks/dodo`

Headers (Standard Webhooks 스펙):
- `webhook-id`: 고유 이벤트 식별자 (멱등성 키)
- `webhook-timestamp`: Unix epoch seconds
- `webhook-signature`: `v1,<base64(HMAC-SHA256(webhook-id.webhook-timestamp.body, DODO_WEBHOOK_SECRET))>`

Body: raw bytes (JSON parse 전 반드시 signature 검증 — `req.text()` 사용)

검증은 `standardwebhooks` npm 라이브러리 권장 (자체 구현 시 timing-safe compare 실수 위험):

```ts
// import { Webhook } from 'standardwebhooks';
// const wh = new Webhook(process.env.DODO_WEBHOOK_SECRET!);
const event = wh.verify(rawBody, {
  'webhook-id': req.headers.get('webhook-id')!,
  'webhook-timestamp': req.headers.get('webhook-timestamp')!,
  'webhook-signature': req.headers.get('webhook-signature')!,
});
// [TBD: confirm exact Dodo Payments SDK signature]
```

**처리하는 이벤트**:

| Event | Action |
|-------|--------|
| `payment.succeeded` | one-time 결제(single) 처리. 구독 플랜은 `subscription.active`를 source of truth로 사용 |
| `subscription.active` | 신규 weekly_pass/monthly_sub 활성화 — `subscriptions` insert(period_end=next_billing_date, usage_count=0) |
| `subscription.renewed` | weekly_pass/monthly_sub 갱신 — `subscriptions.period_end = next_billing_date`, `usage_count = 0`, `cancelled_at = null` |
| `subscription.cancelled` | 구독 갱신 취소 — `subscriptions.cancelled_at` 기록, 현재 period_end까지 접근 유지 |
| `refund.succeeded` | 7일/0회 사용 검증 후 크레딧 무효화 — `credit_ledger` `type='refund_reversal'` 음수 row, subscription이면 `status='refunded'` |

Response: `200 {received: true}` (Dodo는 200 이외는 자동 재시도)

### 3.9 POST `/api/report-scam`

Request:

```json
{
  "analysis_id": "9b1f...11",
  "reason": "Client offered to pay outside Upwork after deposit."
}
```

Response 200:

```json
{ "ok": true }
```

내부적으로 `analyses.is_reported = true`, `analyses.report_reason = reason` 업데이트.

## 4. 에러 코드 규약

표준 응답:

```json
{
  "error": {
    "code": "ERR_OUT_OF_CREDITS",
    "message": "You have no remaining credits. Please purchase a plan.",
    "details": { "balance": 0 }
  }
}
```

| HTTP | code | 발생 시 |
|------|------|--------|
| 400 | `ERR_BAD_REQUEST` | Validation 실패, 누락 필드 |
| 401 | `ERR_UNAUTHENTICATED` | 세션 없음 / 만료 |
| 402 | `ERR_OUT_OF_CREDITS` | 크레딧 0 + 활성 패스/구독 없음 |
| 402 | `ERR_SOFT_CAP_REACHED` | 주간/월간 캡 초과 |
| 403 | `ERR_FORBIDDEN` | RLS 위반 (타인 리소스 접근) |
| 404 | `ERR_NOT_FOUND` | 분석/리소스 없음 |
| 409 | `ERR_DUPLICATE_REFUND` | 환불 중복 처리 |
| 413 | `ERR_INPUT_TOO_LARGE` | Job text > 64k chars |
| 422 | `ERR_VALIDATION` | Structured Outputs 파싱 실패 |
| 429 | `ERR_RATE_LIMITED` | Per-user/IP rate limit 초과 |
| 502 | `ERR_OPENAI_UPSTREAM` | Silent Retry x3 실패 → 0 차감 |
| 502 | `ERR_DODO_UPSTREAM` | Dodo Payments 호출 실패 |
| 400 | `ERR_WEBHOOK_SIGNATURE` | Dodo webhook Standard Webhooks signature 검증 실패 |
| 500 | `ERR_INTERNAL` | 미분류 서버 오류 |

## 5. 공통 동작

- **Idempotency**: `/api/checkout`, `/api/analyze`는 `Idempotency-Key` 헤더 허용 `[가정]`. Webhook 멱등성은 Standard Webhooks `webhook-id` 헤더 → `dodo_events.id` PK로 보장.
- **Pagination**: cursor 기반(`created_at` desc + `id` tiebreak)
- **Timestamps**: 모든 응답은 ISO 8601 UTC
- **Currency**: 모든 금액은 USD, 정수 cents 단위
- **Locale**: `en` 단일

## 6. OpenAI Structured Outputs 스키마 (참고)

`POST /api/analyze`가 OpenAI에 강제하는 JSON Schema. 프롬프트 v1(§7)의 [OUTPUT FORMAT]과 1:1 일치하는 flat 구조:

```json
{
  "name": "AnalysisResult",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "client_hire_rate",
      "payment_verified",
      "total_spend_amount",
      "client_rating",
      "risk_level",
      "contextual_red_flags",
      "match_score",
      "score_reason",
      "action_tip"
    ],
    "properties": {
      "client_hire_rate":   {"type": "integer", "minimum": 0, "maximum": 100},
      "payment_verified":   {"type": "boolean"},
      "total_spend_amount": {"type": "integer", "minimum": 0},
      "client_rating":      {"type": "number",  "minimum": 0, "maximum": 5},
      "risk_level":         {"type": "string",  "enum": ["SAFE", "WARNING", "DANGER"]},
      "contextual_red_flags": {"type": "array", "items": {"type": "string"}},
      "match_score":        {"type": "integer", "minimum": 0, "maximum": 100},
      "score_reason":       {"type": "string"},
      "action_tip":         {"type": "string"}
    }
  },
  "strict": true
}
```

### 6.1 키 명명 / 단위 매핑 메모

| 프롬프트(LLM) 출력 키 | API Response 위치 | 단위/규약 |
|----------------------|------------------|----------|
| `client_hire_rate` | `extracted_signals.client_hire_rate` | 정수 0–100 (퍼센트). 신규/미발견 시 `0` |
| `payment_verified` | `extracted_signals.payment_verified` | boolean |
| `total_spend_amount` | `extracted_signals.total_spend_amount` | 정수 USD. 미발견/$0 시 `0` |
| `client_rating` | `extracted_signals.client_rating` | float 0.0–5.0. 리뷰 없음 시 `0.0` |
| `risk_level` | `ai_risk.risk_level` | enum |
| `contextual_red_flags` | `ai_risk.contextual_red_flags` | string[] |
| `match_score` | `match_score` | 정수 0–100. DANGER 시 응답에서 `null`로 마스킹 |
| `score_reason`, `action_tip` | 동일 키로 패스스루 | string |

Rule Engine 룰 임계값도 이 단위에 맞춘다: `LOW_HIRE_RATE := client_hire_rate < 20`, `PAYMENT_UNVERIFIED_ZERO_SPEND := !payment_verified && total_spend_amount == 0`, `LOW_RATING := client_rating > 0 && client_rating <= 3.5`.

Profile 추출용 별도 스키마:

```json
{
  "name": "ProfileExtract",
  "schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["skills", "years_of_experience", "target_hourly_rate", "timezone"],
    "properties": {
      "skills": {"type": "array", "items": {"type": "string"}},
      "years_of_experience": {"type": "integer", "minimum": 0, "maximum": 60},
      "target_hourly_rate": {"type": "integer", "minimum": 0, "maximum": 1000},
      "timezone": {"type": "string"}
    }
  },
  "strict": true
}
```

## 7. System Prompt v1 — `analyze.v1` (확정 본문)

`system_prompts` 테이블의 v1 활성 row로 그대로 적재한다. 영어 단일 (Q5).
입력 변수 인터폴레이션은 OpenAI 호출 시 `messages[1]` (user role)에서 처리하고, system 메시지에는 **아래 본문만** 들어간다.

```text
You are an expert Upwork Freelance Matching Consultant and Risk Analyst with 5+ years of experience. Your mission is to analyze an Upwork job posting alongside a freelancer's profile to determine if it is a safe, high-value opportunity or a risky ghost/scam job that will waste their "Connects" tokens.

[INPUT DATA]
1. Freelancer Profile (Structured): Contains core skills, experience years, target rate, and preferred timezone.
2. Upwork Job Posting (Pre-processed text dump).

[ANALYSIS & PARSING RULES]
1. Quantitative Data Extraction (Strict & Verbatim):
   - Carefully locate the client's historical metrics hidden within the job posting text.
   - "client_hire_rate": Extract the integer percentage (e.g., 65 for "65% hire rate"). If new client or not found, output 0.
   - "payment_verified": Set to true if "Payment verified" is explicitly found in the text; otherwise, set to false.
   - "total_spend_amount": Extract the total USD spent by the client as an integer (e.g., 5000 for "$5k+ spent"). If $0 or not found, output 0.
   - "client_rating": Extract the average star rating as a float (e.g., 4.8). If no reviews, output 0.0.

2. Qualitative Contextual Risk Assessment (risk_level):
   - "DANGER": If the text contains platform violations (e.g., "contact via Telegram/WhatsApp", "pay security deposit", "free sample work required", "review manipulation/fake upvoting").
   - "WARNING": If the text exhibits highly aggressive language, impossible deadlines, extreme budget undercutting, or signs of high friction.
   - "SAFE": If the requirements are clear, professional, reasonable, and compliant with Upwork terms of service.

3. Matching Optimization (match_score):
   - Calculate an integer score from 1 to 100 based on three matrix indicators: Technical Skill Fit (40%), Budget/Rate Fit (30%), and Context/Timezone Fit (30%).

4. Action Plan (action_tip):
   - If the risk_level is SAFE and match_score is 80 or above, provide a 1-sentence, high-impact selling point tailored specifically to the freelancer's profile that they can use as the ultimate hook in the first 3 lines of their proposal. Do not use generic phrases.

[OUTPUT FORMAT]
You must respond with a strict, valid JSON object matching the schema below. Do not include any markdown code blocks (e.g., ```json), explanation text, or conversational filler. Output raw JSON only.

{
  "client_hire_rate": 0,
  "payment_verified": false,
  "total_spend_amount": 0,
  "client_rating": 0.0,
  "risk_level": "SAFE" | "WARNING" | "DANGER",
  "contextual_red_flags": [],
  "match_score": 0,
  "score_reason": "String summarizing why this score was derived",
  "action_tip": "String containing the custom proposal hook line"
}
```

### 7.1 운영 노트

- **단일 출처 원칙**: 이 본문은 `system_prompts(name='analyze.v1', is_active=true)` row의 `content` 컬럼에만 보관한다. 코드에 하드코딩 금지. 백엔드는 시작 시 1회 로드 + Supabase Realtime 또는 짧은 in-memory TTL(60s)로 갱신.
- **버전 전환**: v2 작성 시 `system_prompts` 신규 row 추가 → 검증 후 `analyze.v1` 비활성화 + `analyze.v2` 활성화 (partial unique index가 동시 활성 차단).
- **입력 변수 합성**: API 핸들러는 user 메시지에 `[Freelancer Profile JSON]\n{users_profile fields}\n\n[Job Posting Text]\n{pre-processed text}` 형태로 주입.
- **Strict JSON 강제**: §6의 JSON Schema가 OpenAI Structured Outputs로 별도 강제됨. 프롬프트 안의 `[OUTPUT FORMAT]` 예시는 LLM 가독성용 백업.
