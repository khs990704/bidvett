# 02_api_spec.md — ConnectSaver API 명세 확정본

> [PIVOT-01 rev2 — 2026-05-29] 결제 인프라 Stripe → Dodo Payments. §2 webhook path, §3.7 checkout, §3.8 webhook full rewrite, §4 에러 코드(`ERR_DODO_UPSTREAM`)를 갱신. 결정 매트릭스는 `_workspace/00_input.md §11`.
> 상위 문서: `_workspace/00_input.md`, `_workspace/01_architecture.md`
> 초안 출처: `spec/03_api_preview.md` (🔒 FROZEN-rev2 2026-05-29)
> `analyze.v1` 본문은 spec/03 §7 그대로 (재작성 금지). 본 문서 §8에 `profile_extract.v1` 본문을 새로 확정.

---

## 1. 기본 정보

| 항목 | 값 |
|------|---|
| **Base URL (dev)** | `http://localhost:3000/api` |
| **Base URL (prod)** | `https://app.connectsaver.com/api` |
| **인증 방식** | Supabase JWT (`Authorization: Bearer <access_token>`) 또는 `@supabase/ssr` cookie 세션 |
| **응답 형식** | `application/json; charset=utf-8` |
| **시간 표기** | ISO 8601 UTC (예: `2026-05-27T11:24:01Z`) |
| **금액 단위** | USD, 정수 cents |
| **언어** | 영어 단일 (Q5) — 모든 사용자 대면 메시지 |

## 2. 엔드포인트 목록 (9개 + 1 webhook)

| # | Method | Path | 인증 | Rate Limit | 멱등성 |
|---|--------|------|------|-----------|-------|
| 1 | GET | `/api/auth/callback` | Public (Supabase signed) | — | n/a |
| 2 | POST | `/api/profile/extract` | Required | per-user 5/min, per-IP 10/min | n/a (read-only LLM) |
| 3 | GET | `/api/profile` | Required | per-IP 120/min | n/a |
| 4 | PUT | `/api/profile` | Required | per-IP 120/min | last-write-wins (upsert) |
| 5 | POST | `/api/analyze` | Required | per-user 60/min, per-IP 120/min, 동시 1 | `Idempotency-Key` 헤더 허용 (KV TTL 60s) |
| 6 | GET | `/api/analyses` | Required | per-IP 120/min | n/a |
| 6b | GET | `/api/analyses/[id]` | Required | per-IP 120/min | n/a |
| 7 | GET | `/api/credits` | Required | per-IP 120/min | n/a |
| 8 | POST | `/api/checkout` | Required | per-user 10/min | `Idempotency-Key` 헤더 허용 (Dodo SDK 전달, 의사 시그니처 — `// [TBD: confirm exact Dodo Payments SDK signature]`) |
| 9 | POST | `/api/webhooks/dodo` | Standard Webhooks signature | (Dodo 자체 재시도) | `dodo_events` PK 유니크 (Standard Webhooks `webhook-id` 헤더 값) |
| 10 | POST | `/api/report-scam` | Required | per-user 30/min | analysis_id별 1회 (DB unique constraint X, 앱 단언) |

---

## 3. 엔드포인트 상세

### 3.1 GET `/api/auth/callback`

Supabase OAuth 후 자동 리다이렉트. Next.js Route Handler가 코드 교환 + 신규 가입자 후처리.

**Query**: `?code=<string>&state=<string>`

**Response**: `302 Redirect`
- 신규 user (no `users_profile`) → `/onboarding`
- 기존 user → `/dashboard`

**Internal sequence**:
1. `supabase.auth.exchangeCodeForSession(code)`
2. `auth.users` insert 트리거가 자동으로 `credit_ledger`에 free_grant +5 삽입 (DB 레벨)
3. `users_profile` 존재 여부 확인 → 라우팅

**에러 처리**:
- 코드 교환 실패 → `302 → /login?error=oauth_failed`
- 트리거 실패 → Sentry capture, `/dashboard?warn=credits_pending` (사용자 차단 X)

---

### 3.2 POST `/api/profile/extract`

이력서 자유 텍스트 → 4 필드 구조화. **크레딧 차감 없음** (온보딩 UX).

**Request body** (Zod):
```ts
z.object({
  resume_text: z.string().min(1).max(16_000),
})
```

**Response 200**:
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

**Response schema** (Zod):
```ts
z.object({
  extracted: z.object({
    skills: z.array(z.string()),
    years_of_experience: z.number().int().min(0).max(60),
    target_hourly_rate: z.number().int().min(0).max(1000),
    timezone: z.string(),
  }),
  warnings: z.array(z.string()),
})
```

**Errors**:
| HTTP | code | 조건 |
|------|------|------|
| 400 | `ERR_BAD_REQUEST` | resume_text 누락/공백 |
| 401 | `ERR_UNAUTHENTICATED` | 세션 없음 |
| 413 | `ERR_INPUT_TOO_LARGE` | resume_text > 16k chars |
| 429 | `ERR_RATE_LIMITED` | per-user 5/min 또는 per-IP 10/min 초과 |
| 422 | `ERR_VALIDATION` | OpenAI 출력이 Structured Outputs 스키마 미준수 (희박) |
| 502 | `ERR_LLM_UPSTREAM` | Silent Retry ×3 실패 |
| 500 | `ERR_INTERNAL` | 미분류 |

**Internal sequence**:
1. middleware: auth + per-IP rate limit
2. per-user rate limit (`rl:extract:user:{uid}`)
3. char length 16k cap (선검사)
4. `getActivePrompt('profile_extract.v1')` → in-memory TTL 60s
5. `callStructured<ProfileExtract>({ promptName, userMessage: resume_text, schema: ProfileExtractSchema, maxInputChars: 16_000 })`
6. 결과 반환 (DB 미저장 — `PUT /api/profile`이 저장)

---

### 3.3 GET `/api/profile`

**Response 200**:
```json
{
  "user_id": "8a4f-...-e2",
  "skills": ["React", "Node.js", "TypeScript"],
  "years_of_experience": 4,
  "target_hourly_rate": 45,
  "timezone": "UTC+9",
  "resume_text": null,
  "created_at": "2026-05-27T10:00:00Z",
  "updated_at": "2026-05-27T11:24:01Z"
}
```

**Errors**: `401`, `404 ERR_NOT_FOUND` (프로필 미생성), `500`.

---

### 3.4 PUT `/api/profile`

**Request body** (Zod):
```ts
z.object({
  skills: z.array(z.string().min(1).max(50)).max(20),
  years_of_experience: z.number().int().min(0).max(60),
  target_hourly_rate: z.number().int().min(0).max(1000),
  timezone: z.string().min(1).max(64),
  resume_text: z.string().max(32_000).optional(),
})
```

**Response 200**: 저장된 row (3.3과 동일 shape).

**Errors**: `400 ERR_VALIDATION`, `401`, `500`.

**Internal sequence**:
1. middleware: auth
2. Zod validation
3. `supabase.from('users_profile').upsert({ user_id: uid, ...body, updated_at: now() })` — RLS 통과
4. 반환

**멱등성**: upsert (last-write-wins). PUT 자체가 멱등.

---

### 3.5 POST `/api/analyze` ★ Core

**Request headers** (선택):
- `Idempotency-Key: <string>` — 동일 키로 60s 내 재요청 시 첫 결과 반환 (KV `idem:analyze:{uid}:{key}`).

**Request body** (Zod):
```ts
z.object({
  job_text: z.string().min(50).max(64_000),
})
```

**Response 200** (Safe):
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
  "took_ms": 2410,
  "prompt_version": 1
}
```

**Response 200** (Risk — DO_NOT_APPLY):
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
  "took_ms": 2880,
  "prompt_version": 1
}
```

**Response schema** (Zod):
```ts
z.object({
  analysis_id: z.string().uuid(),
  verdict: z.enum(['SHOW_REPORT', 'DO_NOT_APPLY']),
  backend_risk: z.object({
    critical: z.boolean(),
    rules_triggered: z.array(z.enum(['LOW_HIRE_RATE', 'PAYMENT_UNVERIFIED_ZERO_SPEND', 'LOW_RATING'])),
  }),
  ai_risk: z.object({
    risk_level: z.enum(['SAFE', 'WARNING', 'DANGER']),
    contextual_red_flags: z.array(z.string()),
  }),
  match_score: z.number().int().min(0).max(100).nullable(),
  score_reason: z.string().nullable(),
  action_tip: z.string(),
  extracted_signals: z.object({
    client_hire_rate: z.number().int().min(0).max(100),
    payment_verified: z.boolean(),
    total_spend_amount: z.number().int().min(0),
    client_rating: z.number().min(0).max(5),
  }),
  credit_after: z.number().int().min(0),
  took_ms: z.number().int(),
  prompt_version: z.number().int(),
})
```

**Errors**:
| HTTP | code | 조건 |
|------|------|------|
| 400 | `ERR_BAD_REQUEST` | job_text 누락 |
| 401 | `ERR_UNAUTHENTICATED` | 세션 없음 |
| 402 | `ERR_OUT_OF_CREDITS` | balance=0 AND no active sub/pass. `details: { balance: 0 }` |
| 402 | `ERR_SOFT_CAP_REACHED` | usage_count ≥ soft_cap. `details: { plan, usage_count, soft_cap, period_end }` |
| 413 | `ERR_INPUT_TOO_LARGE` | job_text > 64k chars (`details: { length, limit: 64000 }`) |
| 422 | `ERR_VALIDATION` | LLM 출력 Structured Outputs 검증 실패 |
| 429 | `ERR_RATE_LIMITED` | per-user 60/min OR per-IP 120/min OR 동시 lock OR daily safety cap |
| 502 | `ERR_LLM_UPSTREAM` | Silent Retry ×3 실패. **0 차감** |
| 502 | `ERR_DODO_UPSTREAM` | Dodo Payments SDK 호출 실패 (checkoutSessions.create 등) |
| 500 | `ERR_INTERNAL` | 미분류 (DB 저장 실패 등) |

**Internal sequence** (pseudo):
```
1. middleware: auth + rl:ip:{ip}
2. parseAndValidate(req.json) → ZodError → 400
3. lengthGuard(job_text.length ≤ 64_000) → 413
4. rl:analyze:user:{uid} 60/min  → 429
5. lock:analyze:user:{uid} SET NX EX 30  → 429 if exists
6. dailySafetyCap incr → 429 if > min(soft_cap, 200)
7. preCheck(uid):
     a. SELECT credit_ledger balance_after WHERE user_id=uid ORDER BY created_at DESC LIMIT 1
     b. SELECT subscriptions WHERE user_id=uid AND status='active' AND period_end > now()
     c. valid = balance >= 1 OR (sub AND sub.usage_count < sub.soft_cap)
     d. !valid → 402
8. prompt = getActivePrompt('analyze.v1')   # in-memory TTL 60s
9. profile = SELECT users_profile WHERE user_id=uid (RLS)
10. userMsg = render(profile, job_text)
11. raw = callStructured<AnalysisResult>({ promptName:'analyze.v1', userMessage:userMsg, schema:AnalysisResultSchema, maxInputChars:16_000 })
       # internal: 1 initial + 3 retries (200/500/1200ms backoff)
       # all fail → throw OpenAIUpstreamError → 502 / 0 deduct
12. quant = { client_hire_rate, payment_verified, total_spend_amount, client_rating }
13. rule = evaluate(quant)                                  # rules.ts
14. score = finalizeScore({ llm_match_score, risk_level, backend_critical: rule.critical })
15. action_tip = (rule.critical || risk_level==='DANGER')
       ? 'Skip this job and report it to Upwork TOS team.'
       : raw.action_tip
16. rpcResult = supabaseAdmin.rpc('record_analysis_and_deduct', {
       p_user_id: uid,
       p_verdict: score.verdict,
       p_backend_critical: rule.critical,
       p_backend_rules_triggered: rule.rules_triggered,
       p_ai_risk_level: raw.risk_level,
       p_contextual_red_flags: raw.contextual_red_flags,
       p_match_score: score.match_score,
       p_score_reason: score.verdict==='DO_NOT_APPLY' ? null : raw.score_reason,
       p_action_tip: action_tip,
       p_extracted_signals: quant,
       p_prompt_version: prompt.version,
       p_input_tokens: usage.prompt_tokens,
       p_output_tokens: usage.completion_tokens,
       p_took_ms: elapsed,
       p_job_text_hash: sha256(job_text),
     })
17. DEL lock:analyze:user:{uid}
18. return { analysis_id, ..., credit_after: rpcResult.balance_after, took_ms, prompt_version }
```

---

### 3.6 GET `/api/analyses`

**Query**:
- `limit?: number` (default 20, max 100)
- `cursor?: string` (ISO timestamp of last item's `created_at`)

**Response 200**:
```json
{
  "items": [
    {
      "id": "9b1f...11",
      "verdict": "SHOW_REPORT",
      "risk_level": "SAFE",
      "match_score": 82,
      "is_reported": false,
      "created_at": "2026-05-27T11:24:01Z"
    }
  ],
  "next_cursor": "2026-05-27T11:20:00Z"
}
```

**Errors**: `401`, `500`.

**Internal sequence**: RLS SELECT (`auth.uid()=user_id`) order by `created_at desc` + `id` tiebreak, cursor-based pagination.

---

### 3.6b GET `/api/analyses/[id]`

**Response 200**: 3.5의 full report shape (단, `credit_after`, `took_ms`, `prompt_version`은 historical snapshot).

**Errors**: `401`, `403 ERR_FORBIDDEN` (RLS 위반), `404 ERR_NOT_FOUND`.

---

### 3.7 GET `/api/credits`

**Response 200**:
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

**Schema**:
```ts
z.object({
  balance: z.number().int().min(0),
  active_pass: z.object({
    type: z.literal('weekly'),
    expires_at: z.string(),
    usage_this_period: z.number().int(),
    soft_cap: z.number().int(),
    is_recurring: z.boolean(),
    cancel_at_period_end: z.boolean(),
  }).nullable(),
  active_subscription: z.object({
    type: z.literal('monthly'),
    period_end: z.string(),
    usage_this_period: z.number().int(),
    soft_cap: z.number().int(),
    cancel_at_period_end: z.boolean(),
  }).nullable(),
})
```

---

### 3.8 POST `/api/checkout`

**Request body** (Zod):
```ts
z.object({
  plan: z.enum(['credit_single', 'weekly_pass', 'monthly_sub']),
})
```

**Response 200**:
```json
{
  "checkout_url": "https://checkout.dodopayments.com/<session-id>",
  "session_id": "<dodo-checkout-session-id>"
}
```

**Errors**: `400 ERR_BAD_REQUEST`, `401`, `429 ERR_RATE_LIMITED`, `502 ERR_DODO_UPSTREAM`.

**Internal sequence** (의사 시그니처 — `// [TBD: confirm exact Dodo Payments SDK signature]`):
```ts
// import Dodo from 'dodopayments';
// const dodo = new Dodo({ apiKey: process.env.DODO_API_KEY! });
const session = await dodo.checkoutSessions.create({  // [TBD: confirm exact Dodo Payments SDK signature]
  productId: PLAN_TO_DODO_PRODUCT_ID[plan],
  mode: plan === 'monthly_sub' ? 'subscription' : 'payment',  // [TBD: confirm field name with Dodo docs]
  successUrl: `${appUrl}/dashboard?status=success`,
  cancelUrl: `${appUrl}/pricing?status=cancel`,
  customerReferenceId: user.id,
  metadata: { user_id: user.id, plan },
});
return { checkout_url: session.url, session_id: session.id };
```

1. Map `plan` → `NEXT_PUBLIC_DODO_PRODUCT_*` ID
2. `dodo.checkoutSessions.create({...})` (Dodo SDK 의사 시그니처)
3. `Idempotency-Key` 헤더 → Dodo SDK에 그대로 전달 (지원 가정 — `// [TBD: confirm idempotency key header name with Dodo docs]`)

**Plan ↔ Dodo Product 매핑**:
| `plan` | mode | Product 환경변수 | 가격 |
|--------|------|------------------|------|
| `credit_single` | `payment` (one-time) | `NEXT_PUBLIC_DODO_PRODUCT_SINGLE` | $0.99 |
| `weekly_pass` | `subscription` | `NEXT_PUBLIC_DODO_PRODUCT_WEEKLY` | $4.99/week |
| `monthly_sub` | `subscription` | `NEXT_PUBLIC_DODO_PRODUCT_MONTHLY` | $19/month |

> **세금 처리**: Dodo Payments가 Merchant of Record로 VAT/GST/Sales Tax를 자동 계산해 가격에 합산하거나 별도 표시. 코드/명세 측에서 별도 처리 불필요.

---

### 3.9 POST `/api/webhooks/dodo`

**Headers** (Standard Webhooks 스펙):
- `webhook-id`: 고유 이벤트 식별자 (멱등성 키 — `dodo_events.id`로 그대로 저장)
- `webhook-timestamp`: Unix epoch seconds
- `webhook-signature`: `v1,<base64(HMAC-SHA256(${webhook-id}.${webhook-timestamp}.${rawBody}, DODO_WEBHOOK_SECRET))>`

**Body**: raw bytes (no JSON parse before signature verification — `req.text()` 사용 필수)

**Response 200**:
```json
{ "received": true }
```

**Response 400**:
```json
{ "error": { "code": "ERR_WEBHOOK_SIGNATURE", "message": "Invalid signature" } }
```

**처리 이벤트**:

| Event | Action |
|-------|--------|
| `payment.succeeded` | one-time 결제. metadata.plan === 'credit_single' → `credit_ledger` insert(+1, type='purchase_single', dodo_event_id=webhook-id). 구독 플랜은 `subscription.active`를 source of truth로 사용 |
| `subscription.active` | 신규 weekly_pass/monthly_sub 활성화 — `subscriptions` insert(plan, status='active', period_end=Dodo next_billing_date, soft_cap, dodo_subscription_id=<from payload>) |
| `subscription.renewed` | 구 `invoice.paid` 흡수. weekly_pass/monthly_sub 갱신: `subscriptions.period_end = next_billing_date`, `usage_count = 0`, `cancelled_at = null` |
| `subscription.cancelled` | 다음 갱신 차단 신호. `subscriptions.cancelled_at` 기록, `status='active'` 유지해서 현재 paid period는 보존 |
| `refund.succeeded` | (1) payload의 원 결제 식별 (metadata.user_id 또는 dodo_payment_id) (2) 0회 사용 + 7일 이내 검증 (3) `credit_ledger` insert(type='refund_reversal', delta=원 결제의 +N의 negative) (4) subscription이었으면 `status='refunded'` |

**Internal sequence** (의사 시그니처 — `// [TBD: confirm exact Dodo Payments SDK signature]`):
```ts
// import { Webhook } from 'standardwebhooks';
const wh = new Webhook(process.env.DODO_WEBHOOK_SECRET!);

const rawBody = await req.text();
let event;
try {
  event = wh.verify(rawBody, {
    'webhook-id': req.headers.get('webhook-id')!,
    'webhook-timestamp': req.headers.get('webhook-timestamp')!,
    'webhook-signature': req.headers.get('webhook-signature')!,
  });
} catch (e) {
  return apiError(400, 'ERR_WEBHOOK_SIGNATURE');
}

const webhookId = req.headers.get('webhook-id')!;
await supabaseAdmin.from('dodo_events').insert(
  { id: webhookId, type: event.type, payload: event },
  { onConflict: 'id', ignoreDuplicates: true }
);
// 충돌 시 processed=true면 200 즉시 반환 (멱등성)
```

1. `req.text()` → rawBody
2. Standard Webhooks verify (`standardwebhooks` npm) — 실패 시 400 `ERR_WEBHOOK_SIGNATURE`
3. `supabaseAdmin.from('dodo_events').insert({ id: webhook-id, type, payload }, { onConflict: 'id', ignoreDuplicates: true })`
4. 충돌 시 (이미 processed=true) → `200 {received:true}` 즉시 반환 (멱등성)
5. 이벤트 type별 핸들러 실행
6. `update dodo_events set processed=true, processed_at=now() where id=webhook-id`
7. `200 {received:true}`

**환불 안전성**: `refund.succeeded` 핸들러는 Dodo Dashboard에서 환불 클릭 시 자동 발생. 7일 초과 또는 사용이력 발견 시에도 환불은 **이미 Dodo Payments에서 완료**된 상태 — 운영자 책임으로 간주하고 DB 처리는 그대로 수행 (`credit_ledger` 음수 row). Sentry에 warning 캡처.

> **보안 권고**: Standard Webhooks signature는 timing-safe compare + replay window(timestamp staleness) 처리가 까다롭다. `standardwebhooks` npm 라이브러리 사용 강력 권장 — 자체 구현은 timing attack 또는 replay 결함 위험.

---

### 3.10 POST `/api/report-scam`

**Request body** (Zod):
```ts
z.object({
  analysis_id: z.string().uuid(),
  reason: z.string().min(1).max(1000),
})
```

**Response 200**: `{ "ok": true }`

**Errors**:
| HTTP | code | 조건 |
|------|------|------|
| 400 | `ERR_BAD_REQUEST` | Zod 실패 |
| 401 | `ERR_UNAUTHENTICATED` | 세션 없음 |
| 403 | `ERR_FORBIDDEN` | 타인의 analysis 신고 시도 (RLS) |
| 404 | `ERR_NOT_FOUND` | analysis_id 없음 |
| 429 | `ERR_RATE_LIMITED` | per-user 30/min 초과 |
| 500 | `ERR_INTERNAL` | DB update 실패 |

**Internal sequence**:
1. middleware: auth
2. UPDATE analyses SET is_reported=true, report_reason=reason WHERE id=analysis_id AND user_id=uid — RLS
3. affected rows = 0 → 404

---

## 4. 에러 코드 규약 (전체)

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

| HTTP | code | message (영어) | 발생 시 |
|------|------|---------------|--------|
| 400 | `ERR_BAD_REQUEST` | The request is malformed. | 필수 필드 누락, JSON 파싱 실패 |
| 400 | `ERR_WEBHOOK_SIGNATURE` | Invalid signature. | Dodo Standard Webhooks 헤더(`webhook-id` / `webhook-timestamp` / `webhook-signature`) 검증 실패 (`standardwebhooks` npm) |
| 401 | `ERR_UNAUTHENTICATED` | Sign in to continue. | 세션 없음/만료 |
| 402 | `ERR_OUT_OF_CREDITS` | You have no remaining credits. Please purchase a plan. | balance=0 AND no active sub/pass |
| 402 | `ERR_SOFT_CAP_REACHED` | You've hit this period's soft cap. Try again next period. | usage_count ≥ soft_cap |
| 402 | `ERR_INSUFFICIENT_CREDITS` | (alias of OUT_OF_CREDITS for legacy clients) | (사용하지 않음 — OUT_OF_CREDITS만 사용) |
| 403 | `ERR_FORBIDDEN` | You do not have access to this resource. | RLS 위반 |
| 404 | `ERR_NOT_FOUND` | Not found. | 리소스 없음 |
| 409 | `ERR_DUPLICATE_REFUND` | This refund was already processed. | Webhook 중복 (dodo_events 충돌 + processed=true) |
| 413 | `ERR_INPUT_TOO_LARGE` | The input exceeds the size limit. | job_text > 64k, resume_text > 16k |
| 422 | `ERR_VALIDATION` | The response failed schema validation. | LLM 출력이 Structured Outputs 스키마 미준수 |
| 429 | `ERR_RATE_LIMITED` | Too many requests. Please slow down. | Rate limit 또는 동시 lock 또는 daily cap |
| 500 | `ERR_INTERNAL` | Something went wrong. We've been notified. | 미분류 — Sentry capture |
| 500 | `ERR_PROMPT_NOT_FOUND` | System prompt not configured. | `system_prompts` 조회 실패 + env fallback도 없음 |
| 502 | `ERR_LLM_UPSTREAM` | The analyzer is temporarily unavailable. Please retry. | OpenAI Silent Retry ×3 실패 — **0 차감** |
| 502 | `ERR_DODO_UPSTREAM` | Payment provider is temporarily unavailable. | Dodo Payments API 호출 실패 (`dodopayments` SDK) |

> **별명 정리**: 본 문서는 `ERR_LLM_UPSTREAM`을 정식 코드로 사용한다. `ERR_OPENAI_UPSTREAM`(spec/03 §4)은 동일 코드의 별명이며, 구현에서는 `ERR_LLM_UPSTREAM`을 단일 출처로 한다.

---

## 5. 공통 동작

- **Pagination**: cursor 기반 (`created_at desc` + `id` tiebreak). `next_cursor`는 마지막 row의 `created_at` ISO 문자열.
- **Idempotency**: `Idempotency-Key` 헤더 허용 (analyze, checkout). KV `idem:{endpoint}:{uid}:{key}` TTL 60s에 결과 캐시. Webhook 멱등성은 Standard Webhooks `webhook-id` → `dodo_events.id` PK로 보장.
- **Timestamps**: ISO 8601 UTC.
- **Currency**: USD 정수 cents. 단, API JSON 응답에서 hourly rate 등 사용자 가시 금액은 정수 USD ($45 = 45).
- **Locale**: `en` 단일.
- **CORS**: API는 same-origin (`app.connectsaver.com`)만 허용. Dodo webhook은 cors 무관 (Standard Webhooks signature 검증).

---

## 6. OpenAI Structured Outputs 스키마

### 6.1 `AnalysisResult` (analyze.v1 출력)

spec/03 §6의 본문 그대로:
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

#### 키 매핑 (LLM → API response → DB)

| LLM 출력 키 | API response 경로 | DB 컬럼 (`analyses`) | 단위/규약 |
|------------|------------------|---------------------|----------|
| `client_hire_rate` | `extracted_signals.client_hire_rate` | `extracted_signals->>'client_hire_rate'` (jsonb) | int 0–100 (%) |
| `payment_verified` | `extracted_signals.payment_verified` | `extracted_signals->>'payment_verified'` | bool |
| `total_spend_amount` | `extracted_signals.total_spend_amount` | `extracted_signals->>'total_spend_amount'` | int USD |
| `client_rating` | `extracted_signals.client_rating` | `extracted_signals->>'client_rating'` | float 0.0–5.0 |
| `risk_level` | `ai_risk.risk_level` | `ai_risk_level` | enum |
| `contextual_red_flags` | `ai_risk.contextual_red_flags` | `contextual_red_flags` (text[]) | string[] |
| `match_score` | `match_score` (root) | `match_score` (int, nullable) | 0–100, DANGER/CRITICAL 시 null 마스킹 |
| `score_reason` | `score_reason` | `score_reason` | string, DO_NOT_APPLY 시 null |
| `action_tip` | `action_tip` | `action_tip` | string |

### 6.2 `ProfileExtract` (profile_extract.v1 출력)

spec/03 §6의 본문 그대로:
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

---

## 7. System Prompt — `analyze.v1` (참조 only)

본문은 `spec/03_api_preview.md §7`을 단일 출처로 한다. 본 문서에서는 재인용하지 않는다.

`system_prompts` 테이블 적재는 `_workspace/03_db_schema.md §5` seed SQL에서 처리.

운영 노트(spec/03 §7.1):
- 코드 하드코딩 금지. `lib/openai/prompts.ts`가 `system_prompts.is_active=true` row만 로드 (60s TTL).
- 버전 전환: `system_prompts(name, is_active)` partial unique index가 동시 활성 차단.
- 입력 변수 합성: user 메시지에 `[Freelancer Profile JSON]\n{users_profile fields}\n\n[Job Posting Text]\n{pre-processed text}` 형태로 주입.
- Strict JSON: §6.1 스키마가 OpenAI Structured Outputs로 별도 강제.

---

## 8. System Prompt — `profile_extract.v1` (확정 본문)

`system_prompts(name='profile_extract.v1', version=1, is_active=true)` row의 `content` 컬럼에 그대로 적재. 영어 단일 (Q5). Structured Outputs 스키마는 §6.2 `ProfileExtract`.

```text
You are an expert Resume Parsing Agent for a freelancer matching service. Your only job is to extract four structured fields from a freelancer's free-form resume or profile text and output a single strict JSON object that matches the required schema. You do not write narrative, you do not assess quality, and you do not infer beyond what the text reasonably supports.

[INPUT DATA]
A single block of free-form text the user pasted from a resume, LinkedIn summary, Upwork bio, portfolio about-page, or similar source. The text may be noisy, multilingual fragments may appear, and ordering is not guaranteed.

[EXTRACTION RULES]
1. "skills" (string[]):
   - Extract only role-relevant hard skills: programming languages, frameworks, libraries, databases, cloud platforms, design tools, and domain-specific tools (e.g., "React", "PostgreSQL", "Figma", "AWS Lambda").
   - Exclude soft skills and generic nouns ("teamwork", "communication", "leadership", "fast learner").
   - Prefer verbatim casing as it appears in the text (e.g., "Node.js" not "nodejs"). When the same skill appears with different casings, pick the most canonical form once.
   - Deduplicate. Aim for 5 to 15 entries. If fewer than 5 distinct skills are clearly supported by the text, return only what is supported.
   - Do not invent skills the text does not mention.

2. "years_of_experience" (integer, 0-60):
   - Pick the single most reliable signal in this order:
     a) An explicit statement such as "5 years of experience" or "since 2019" (compute years to the current year only if the year is plausibly within 60 years of now).
     b) The total span from the earliest professional job/graduation year to the most recent role end (or "Present").
     c) The sum of clearly bounded role durations, only if (a) and (b) are absent.
   - If none of the above can be determined with reasonable confidence, output 0.
   - Round down to a whole integer. Never exceed 60.

3. "target_hourly_rate" (integer, 0-1000, USD):
   - Extract the freelancer's stated hourly rate in USD.
   - If the rate is given as a range, use the midpoint rounded down.
   - If the rate is given in a non-USD currency (e.g., EUR, GBP, KRW), do not convert. Output 0.
   - If no explicit hourly rate is stated, output 0. Do not infer from project totals or annual salary.

4. "timezone" (string):
   - Prefer an IANA timezone identifier when the text gives a city or region that maps unambiguously (e.g., "based in Seoul" -> "Asia/Seoul", "Berlin, Germany" -> "Europe/Berlin").
   - Otherwise use a UTC offset form such as "UTC+9" or "UTC-5". Do not include daylight-saving qualifiers.
   - If neither location nor offset is given, output an empty string "".

[OUTPUT FORMAT]
Respond with a single strict JSON object matching the schema below. Do not include any markdown code fences (no ```), commentary, apologies, or follow-up text. Output raw JSON only.

{
  "skills": [],
  "years_of_experience": 0,
  "target_hourly_rate": 0,
  "timezone": ""
}
```

### 8.1 운영 노트

- **단일 출처 원칙**: 본 본문은 `system_prompts(name='profile_extract.v1')` row에만 보관. 코드 하드코딩 금지.
- **버전 전환**: `analyze.v1`과 동일 메커니즘. `profile_extract.v2` 신규 row insert 후 v1 비활성화.
- **입력 변수 합성**: API 핸들러는 user 메시지에 사용자가 보낸 `resume_text`를 **그대로** 주입 (별도 prefix/suffix 없음). system 메시지가 자체 완결.
- **Strict JSON 강제**: §6.2의 JSON Schema가 OpenAI Structured Outputs로 별도 강제됨. 프롬프트 안의 `[OUTPUT FORMAT]` 예시는 LLM 가독성용 백업.
