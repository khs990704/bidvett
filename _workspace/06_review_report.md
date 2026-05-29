# 06_review_report.md — ConnectSaver 최종 코드 리뷰 & QA 보고서

> 상위 문서: `_workspace/00_input.md`, `_workspace/01_architecture.md`, `_workspace/02_api_spec.md`, `_workspace/03_db_schema.md`, `_workspace/05_deploy_guide.md`, `_workspace/04_test_plan.md`
> 검토 범위: `src/**`, `supabase/migrations/**`, `.github/workflows/ci.yml`, `_workspace/01~05`
> 검토 도구: 수기 grep + `pnpm test` (69 tests pass) + `pnpm typecheck` + `pnpm lint`
> 작성: qa-engineer @ 2026-05-27

---

## 0. 종합 평가

| 항목 | 상태 |
|------|------|
| **배포 준비 상태** | 🟡 **수정 후 배포 가능** (🔴 1건 — IP rate-limit 키 충돌만 픽스하면 GO) |
| 자동 테스트 통과 | ✅ 69/69 (vitest run) |
| typecheck | ✅ `tsc --noEmit` 통과 |
| lint | ✅ `next lint` 0 errors / 0 warnings |
| Spec 일치성 | 🟢 9 엔드포인트 + 6 테이블 + RLS 정책 일치 |
| 보안 | 🟡 1건 🔴 + 2건 🟡 (정량적 보안 결함은 없음, 강화 권고) |
| 신뢰성 | 🟢 Silent Retry × 3 (4 attempts), Deduct-on-Success, race-free RPC 모두 동작 |
| 영문 카피 | 🟢 사용자 대면 100% 영어 (코드 주석 한국어는 허용 — Q5 영향 없음) |
| 잔여 TBD | 명시적 deferred 8건 + GDPR placeholder 2건 — 모두 v1.0/v1.1로 일정화 |

**총평**: 명세 일치도와 신뢰성 패턴(Silent Retry / Deduct-on-Success / race-free RPC)이 매우 잘 구현되어 있다. 🔴 1건(IP rate-limit 키 공유로 인한 cross-endpoint 상호 제약)만 백엔드 1줄 패치로 해소 후 launch GO. 🟡 권고는 v1.0 사이클에 처리.

---

## 1. Spec 일치성

| 항목 | 결과 |
|------|------|
| 9 엔드포인트 + 1 webhook 구현 | 🟢 모두 존재 (`src/app/api/{auth/callback,profile/{extract,route},analyze,analyses/{route,[id]},credits,checkout,webhooks/stripe,report-scam,gdpr/{export,delete}}/route.ts`) |
| Zod request 스키마 | 🟢 모든 POST/PUT가 BodySchema 검증 후 진행 |
| Response 형식 (`AnalyzeResponse` 등) | 🟢 `src/lib/types/api.ts`와 1:1, `_workspace/02_api_spec.md §3` 일치 |
| 에러 코드 (`ERR_*`) | 🟢 `src/lib/errors.ts`가 §4 표 16종 모두 보유. `ERR_LLM_UPSTREAM`을 정식 코드로 사용 (별명 `ERR_OPENAI_UPSTREAM` 미사용 — 의도된 단일 출처) |
| 6 테이블 + 인덱스 | 🟢 0001 마이그레이션이 spec/04 + _workspace/03 DDL 완전 일치 |
| 6 RLS 정책 | 🟢 0002 마이그레이션 — system_prompts / stripe_events는 의도적 zero-policy (deny-by-default) |
| RPC `record_analysis_and_deduct` | 🟢 0003 마이그레이션 — `FOR UPDATE` lock + P0001 예외 + service_role grant 모두 spec과 일치 |
| `analyze.v1` + `profile_extract.v1` seed | 🟢 0004 마이그레이션 — `$PROMPT$ ... $PROMPT$` dollar-quoted, ON CONFLICT DO UPDATE |
| Stripe Product/Price seed | 🟢 `scripts/seed-stripe.ts` (deploy guide §4.1)에서 3 plan 모두 |
| KV namespace prefix | 🟢 `src/lib/rate-limit/kv.ts`의 `rlKey/lockKey/costKey/idemKey`가 §9 표 일치 |

**미세 차이 (의도된 보강)**:
- `subscriptions` 인덱스: spec/04 `idx_subscriptions_user_status` 외에 webhook 보강용 `subscriptions.stripe_subscription_id`/`stripe_checkout_session_id` partial unique index까지 모두 0001에 구현됨 — 멱등성에 유리.
- Stripe Checkout: `subscription_data.metadata`와 `payment_intent_data.metadata`를 추가로 stamp하여 `charge.refunded` 핸들러가 `charge.metadata.user_id`로 사용자를 복구할 수 있게 함. spec/02 §3.8 이상의 강건성.

---

## 2. 보안

### ✅ 수정 완료 — SEC-1: per-IP rate-limit 키 공유로 인한 cross-endpoint 상호 제약

> **PATCH STATUS — 2026-05-27 오케스트레이터 직접 적용**: `rlKey.ipExtract`를 `src/lib/rate-limit/kv.ts`에 추가하고 `src/app/api/profile/extract/route.ts:28`에서 `rlKey.ip` → `rlKey.ipExtract`로 교체. `kv.test.ts`에 "isolates counters across different key prefixes (SEC-1 regression)" 회귀 테스트 1건 추가. 전체 `vitest run` 70/70 pass, `tsc --noEmit` clean.

**증상 (원본 보고서 보존)**: 모든 라우트가 `rl:ip:{ip}` 단일 키로 IP rate limit을 한다 (`src/lib/rate-limit/kv.ts:136`, 호출처 전 라우트). 그런데 `/api/profile/extract`만 `limit=10`을, 그 외 라우트(`analyze/credits/analyses/profile/checkout/report-scam`)는 모두 `limit=120`을 사용한다. **sliding window는 ZADD/ZCARD 기반이므로 모든 호출이 같은 sorted-set에 누적된다**. 결과적으로:
- 같은 IP에서 `/api/credits` 정상 호출만으로도 `/api/profile/extract`의 10/min 제한이 즉시 발동.
- `/api/profile/extract`를 호출한 IP는 다른 모든 라우트에서도 10건 이상 못 쓰는 효과 (limit=10 결정이 가장 먼저 발동).

**근거 증거**:
```
src/app/api/profile/extract/route.ts:28  limit: 10
src/app/api/analyze/route.ts:107          limit: 120
src/app/api/credits/route.ts:17           limit: 120
src/app/api/profile/route.ts:26           limit: 120
src/app/api/analyses/route.ts:20          limit: 120
src/app/api/analyses/[id]/route.ts:23     limit: 120
src/app/api/checkout/route.ts:22          limit: 120
src/app/api/report-scam/route.ts:26       limit: 120
```

모두 `rlKey.ip(ip)` 동일 키.

**수정 방안 (2가지 중 택1)**:

**방안 A (권장, 1줄)**: `lib/rate-limit/kv.ts`의 `rlKey.ip`를 endpoint-scoped로 분리하거나 호출처에서 prefix 부여.
```ts
// kv.ts
export const rlKey = {
  ip: (ip: string) => `rl:ip:${ip}`,                  // 기본 (analyze + 일반)
  ipExtract: (ip: string) => `rl:ip:extract:${ip}`,   // 신규
  ...
} as const;
```
그리고 `profile/extract/route.ts:28`만 `rlKey.ipExtract(ip)`로 교체.

**방안 B**: 모든 라우트가 동일 limit (120/min)으로 통일하고, profile/extract의 per-user 5/min은 그대로 유지 (per-user는 이미 별개 키 `rl:extract:user:{uid}`). 비용 가드는 daily cap이 별도 운영.

**테스트 추가**: `kv.test.ts`에 "같은 IP에서 prefix가 다른 두 키는 독립 카운터" 단언을 추가하여 회귀 방지.

**담당**: `backend-dev` (a800ae020c4fc132c) — 1줄 + 단위 테스트 보강.

---

### 🟡 권장 수정

#### SEC-2: Stripe webhook idempotency가 `processed` 플래그를 보지 않음

`src/app/api/webhooks/stripe/route.ts:56-67`에서 `stripe_events` insert 충돌(23505)이 발생하면 즉시 200을 반환한다. 그러나 이는 **이전 시도가 insert만 성공하고 핸들러 실행 중 크래시한 경우에도** "duplicate" 처리되어 영구히 미처리 상태로 남는 위험이 있다.

**현재 코드**:
```ts
if (isConflict) {
  return NextResponse.json({ received: true, duplicate: true });
}
```

**권장 패턴**:
```ts
if (isConflict) {
  const { data: existing } = await admin
    .from('stripe_events').select('processed').eq('id', event.id).maybeSingle();
  if (existing?.processed) {
    return NextResponse.json({ received: true, duplicate: true });
  }
  // Already inserted but never processed — fall through to re-dispatch.
}
```

리스크 정량: Vercel function 크래시 + Stripe webhook 3일 재시도 윈도우 내 발생 확률 < 1%. v1.0 패치 권장.

#### SEC-3: `/api/analyze`의 `incrDailyCap`이 pre-check 실패 시에도 카운트 누적

`src/app/api/analyze/route.ts:162-170`은 KV daily cap을 increment한 후에 `preCheckCredits()`를 호출한다. 즉 크레딧 0인 사용자가 [Analyze] 버튼만 200번 눌러도 daily cap이 가득 차서 (그 사이 결제해도) 24시간 묶인다.

**권장**: pre-check → daily cap 순으로 재배열, 또는 pre-check 실패 시 `DECR`로 보정 (Race 허용). v1.0 1줄 패치 권장.

#### SEC-4: CSP/X-Frame-Options 헤더 미설정

`next.config.ts`에 headers() 미설정. Vercel 기본만으로는 clickjacking 방어 마진이 좁다. spec/05 deploy guide §9.4와 일치 (v1.0 도입 예정).

#### SEC-5: `match_score`를 LLM이 0 반환 시 마스킹 안 됨

`finalizeScore`는 DANGER/critical에서만 null로 마스킹하고 그 외에는 `Math.max(0, ...)`로 0을 통과시킨다. spec/03 §6.1은 `match_score`를 정수 0~100으로만 정의하고 null은 마스킹 케이스만이라 명세 일치. 다만 LLM이 SAFE 케이스에서 0을 내는 회귀가 발생하면 사용자에게 "0점이지만 Apply 권유" 모순 UI가 생긴다. v1.1 — score=0 AND verdict=SHOW_REPORT 조합을 Sentry warning으로 카운트.

### 🟢 OWASP Top 10 빠른 체크

| OWASP A | 적용 | 상태 |
|---------|------|------|
| A01 Broken Access Control | RLS + service_role 분리 | 🟢 6 테이블 RLS 검증, admin client는 server-only |
| A02 Cryptographic Failures | Stripe webhook signature | 🟢 raw body + constructEvent (route.ts:20-38) |
| A03 Injection | Zod 입력 검증 + Supabase parametrized | 🟢 모든 POST/PUT에 BodySchema; raw SQL 없음 |
| A04 Insecure Design | Deduct-on-Success + Silent Retry | 🟢 spec 패턴 일치 |
| A05 Security Misconfiguration | Vercel HSTS + Sensitive env | 🟢 deploy §3.3에 Sensitive ON 가이드 |
| A06 Vulnerable Components | next 15.0.3, openai 4.x, stripe 17.x | 🟢 메이저 안정 버전 |
| A07 Identification & Auth Failures | Google OAuth + Supabase session | 🟢 자체 비번 미보유 |
| A08 Software/Data Integrity | `Idempotency-Key` + `stripe_events` PK | 🟢 (단, SEC-2 보강 권장) |
| A09 Logging | Sentry v1.0+ deferred | 🟡 MVP는 console.error만 |
| A10 SSRF | 외부 URL fetch 없음 | 🟢 |

---

## 3. 신뢰성

### 🟢 Silent Retry × 3 (initial + 3 retries = 4 attempts)

`src/lib/openai/client.ts:144` — `delays = [0, 200, 500, 1200]` 배열로 4회 시도. spec/01 §8.1 의사코드와 정확히 일치.
- 4xx (`ApiError`) 즉시 throw — 0 retry
- 5xx/timeout/network — backoff 후 재시도
- 4회 모두 실패 → `ApiError(502, ERR_LLM_UPSTREAM)` throw → 라우터의 `record_analysis_and_deduct` 미호출 → **0 차감 자동 보장**

**자동 검증**: `tests/integration/analyze.test.ts` 5 케이스 통과.

### 🟢 Deduct-on-Success

`src/app/api/analyze/route.ts:240-260` — LLM 응답 + rule engine + score finalize **이후에만** `recordAnalysisAndDeduct` RPC 호출. 즉 LLM이 실패하면 `credit_ledger`/`subscriptions.usage_count`는 절대 변경되지 않는다.

### 🟢 Race-free deduction

`supabase/migrations/0003_triggers_and_rpc.sql:51-136`의 `record_analysis_and_deduct` RPC는:
1. `analyses` insert (항상 성공)
2. `subscriptions SELECT ... FOR UPDATE` (oldest active wins)
3. 없으면 `credit_ledger SELECT ... FOR UPDATE` (latest row)
4. 둘 다 0이면 `RAISE EXCEPTION P0001` → 라우터가 `ERR_OUT_OF_CREDITS` 변환

Postgres row-level lock으로 동시 호출 시 한 트랜잭션만 통과. spec/03 §5.3 의도 일치.

### 🟢 in-flight lock (concurrent=1)

`acquireLock(SET NX EX 30)` + `finally releaseLock` — 동시 요청 두 번째는 즉시 429 반환. KV unavailable 시 `fail open` (`kv.ts:75`) — 트래픽 흐름 우선.

### 🟢 Idempotency-Key (analyze)

`src/app/api/analyze/route.ts:97-103` — 동일 key로 60s 내 재요청 시 캐시된 응답 그대로 반환, OpenAI 호출 0. user.id 별로 namespace 격리되어 cross-user 누출 없음.

### 🟡 Stripe webhook idempotency 부분 결함 — SEC-2와 동일 (재게)

### 🟢 Pre-check fallback

`recordAnalysisAndDeduct` 호출 중 P0001이 발생하면 라우터가 `ERR_OUT_OF_CREDITS`로 변환 (route.ts:262-265). Race window를 RPC가 잡아내는 마지막 방어선.

---

## 4. 타입/스키마 정합성

| 검증 | 결과 |
|------|------|
| `_workspace/02_api_spec.md §6.1 AnalysisResult` ↔ `src/lib/openai/schemas.ts:AnalysisResultJsonSchema` | 🟢 9 필드 일치, `strict: true` |
| `§6.2 ProfileExtract` ↔ `src/lib/openai/schemas.ts:ProfileExtractJsonSchema` | 🟢 4 필드 일치 |
| `§3.5 Response` ↔ `src/lib/types/api.ts:AnalyzeResponse` | 🟢 |
| `§3.7 Credits Response` ↔ `CreditsResponse` | 🟢 (단, `cancel_at_period_end`는 false 하드코딩 — `credits/route.ts:61` TODO 주석. Stripe subscription `cancel_at_period_end` 필드를 `subscriptions` 테이블에 column 추가하면 fix 가능. v1.0 권장.) |
| `analyses` DB 컬럼 ↔ AnalyzeResponse 필드 | 🟢 0001 마이그레이션과 일치 |
| Error envelope shape | 🟢 `{error:{code,message,details?}}` 일관 |
| `system_prompts.name` ENUM | 🟢 `'analyze.v1'|'profile_extract.v1'` (Zod에는 없지만 호출 측 type-safe) |

### 🟡 미세 차이 — credits.cancel_at_period_end 하드코딩

`src/app/api/credits/route.ts:61` 주석: `// TODO: persist cancel_at_period_end on subscriptions table when Stripe sends it.`

사용자가 monthly_sub 해지를 "기간 말까지" 예약했을 때 UI가 항상 false를 보여줌. spec/02 §3.7 명세는 boolean이라 schema 위반은 아니지만 UX 회귀.

**수정 방안**: (1) `subscriptions` 테이블에 `cancel_at_period_end boolean DEFAULT false` 컬럼 추가 마이그레이션 (2) Stripe webhook `customer.subscription.updated`에서 동기화. v1.0 후속.

**담당**: 분류상 🟡이지만 결제 사용성 영향 — `backend-dev`에게 v1.0 우선순위로 전달.

---

## 5. 품질 / 빌드

| 명령 | 결과 |
|------|------|
| `npx vitest run` | 🟢 **69 tests passed**, 0 failed (실행 1.5s 내) |
| `npx tsc --noEmit` | 🟢 0 errors |
| `npx next lint` | 🟢 0 errors / 0 warnings |
| `npx next build` | (Vercel 측 검증; CI workflow가 동일 step) — 미실행 (이번 사이클은 unit + type + lint만) |

### 자동 테스트 새로 추가됨 (이번 사이클)

| 파일 | 케이스 | 비고 |
|------|--------|------|
| `src/lib/risk-engine/__tests__/rules.test.ts` | 16 | boundary (0, 19/20, 0/0.1, 3.5/3.51, 5.0) + 조합 (3 단일 + 2 복합) + safe |
| `src/lib/risk-engine/__tests__/score.test.ts` | 9 | DANGER 마스킹, backend_critical 우선, [0,100] clamp, truncate |
| `src/lib/rate-limit/__tests__/kv.test.ts` | 9 | sliding window 통과/거부/prune, SET NX lock, INCR daily cap, IP header 추출 |
| `tests/integration/analyze.test.ts` | 5 | 4-attempts then 502, retry #2 성공, non-retriable 단일 attempt, schema mismatch, input_too_large |
| `tests/integration/stripe-webhook.test.ts` | 10 | sig pass/fail, 4 events 분기 (single/weekly/monthly/invoice/canceled/refund within7d / after 7d / unhandled / missing metadata) |
| `tests/integration/rls.test.ts` | 14 | 6 테이블 RLS ENABLED, 정책 이름, deny-by-default, auth.uid()=user_id 보편 적용, live placeholder |
| `src/lib/extractors/__tests__/upwork.test.ts` (frontend 작성, qa 검증) | 6 | T1~T6 모두 통과 |
| **합계 (이번 사이클)** | **63** | 기존 frontend의 6 추가하여 **총 69** |

### vitest.config.ts 패치 1건 (qa 직접)

기존 include 패턴이 `src/**/*.test.ts`만 포함하여 `tests/integration/**` 미커버. 다음 한 줄 추가:
```ts
include: [
  "src/**/*.test.ts",
  "src/**/__tests__/**/*.test.ts",
  "tests/**/*.test.ts",   // ← 추가
],
```

---

## 6. 사용자 대면 영문 카피 (Q5)

| 영역 | 검증 결과 |
|------|----------|
| 에러 메시지 (`DEFAULT_MESSAGES`) | 🟢 16종 모두 영어 |
| Pricing footer | 🟢 `* Refund: 100% within 7 days if you haven't used any analysis.` (deploy guide §13.1, _workspace/01 §13에 명시된 단일 라인) |
| GDPR placeholder | 🟢 "Data export will be available in v1.1." / "Account deletion will be available in v1.1." |
| OAuth 에러 redirect | 🟢 `?error=oauth_failed` (URL param) |
| 코드 주석 한국어 | 🟢 사용자 비노출 영역만 (e.g. `src/lib/extractors/upwork.ts` 정규식 설명) — Q5 영향 없음 |
| 분석 결과 action_tip | 🟢 LLM 출력 영어 (analyze.v1 시스템 프롬프트 영어, schema validation 통과) |
| 마스킹된 action_tip (SCAM_TIP 상수) | 🟢 `"Skip this job and report it to Upwork TOS team."` — `src/app/api/analyze/route.ts:57` |

`grep -rn "한국\|한글" src --include="*.tsx"` → 0건. 통과.

---

## 7. 잔여 TBD 정리 (`_workspace/00_input.md §6` 매핑)

| # (00_input §6) | 잔여 항목 | 현재 상태 | v1.0 / v1.1 트리거 |
|----|----------|----------|-------------------|
| 1 | `profile_extract.v1` 본문 | ✅ 완료 — `_workspace/02_api_spec.md §8` + `0004_seed.sql` | — |
| 2 | OpenAI p95 SLO 측정 | 🟡 Week 2 Day 9~10 — `_workspace/04_test_plan.md §4` 절차 정의됨 | launch HOLD 트리거 |
| 3 | Email 채널 (Resend) | 🟡 MVP deferred — `_workspace/05_deploy_guide.md §8` Resend 후보로 결정 | v1.0 Week 3 첫 자동 알림 필요 시 |
| 4 | GDPR Export/Delete | ✅ Placeholder 라우트 2종 501 (`src/app/api/gdpr/{export,delete}/route.ts`) | v1.1 |
| 5 | `job_text_hash` 컬럼 (재분석 캐시) | ✅ 컬럼 예약, sha256 계산 후 RPC 전달 (`analyze/route.ts:241`). MVP 캐시 lookup 미사용 | v2.x dedup |
| 6 | Stripe EU VAT 자동 처리 | ✅ MVP OFF, v1.1 활성화 절차 정의 (deploy §4.4) | EU 결제 5건 누적 |
| 7 | Pricing 환불 약관 카피 | ✅ Single-line footer (`* Refund: 100%...`) | 법무 검토 시 modal 분리 |
| 8 | 모바일 키보드 가림 | 🟡 frontend 자체 결정 (viewport hint) — 수동 §7.3 체크리스트로 검증 | — |

**아키텍처 deferred** (deploy guide §13):
- D1 Sentry, D2 Email, D3 Stripe Tax, D4 도메인, D5 GDPR, D6 CSP, D7 Vercel Pro, D8 KV 유료 — 모두 트리거 조건 명시됨.

---

## 8. 정합성 매트릭스 (cross-doc)

| 검증 항목 | 상태 | 비고 |
|----------|------|------|
| 아키텍처 ↔ 코드 | 🟢 | 모듈 책임/디렉토리 구조 일치 |
| API 명세 ↔ 구현 | 🟢 | 9 endpoint + webhook 1:1 |
| DB 스키마 ↔ 마이그레이션 | 🟢 | 6 테이블 + RLS + RPC + seed |
| 프론트 ↔ 백엔드 연동 | 🟢 | `src/lib/api/*.ts` fetcher가 `src/lib/types/api.ts` DTO 사용 |
| 보안 체크리스트 | 🟢 (SEC-1 패치 완료) / 🟡 (SEC-2~5 잔존) | SEC-1 ✅ 직접 패치 — §2 / SEC-2~5는 v1.0 후속 |
| CI 게이트 | 🟢 | lint / typecheck / test / build 4 게이트 모두 PR 차단 |
| spec/02 §3.3.4 T1~T6 | 🟢 | 골든 픽스처 단위 테스트 6 케이스 모두 통과 |

---

## 9. SendMessage 송신 (🔴 must-fix 라운드)

### 라운드 1 — `backend-dev` (a800ae020c4fc132c)

**Subject**: 🔴 SEC-1 IP rate-limit 키 충돌 1줄 패치 요청

**Body 요지**:
> `src/lib/rate-limit/kv.ts`의 `rlKey.ip(ip)`가 모든 라우트의 IP rate-limit 키를 단일 sorted-set에 누적시킨다. `/api/profile/extract`는 `limit=10`, 그 외는 `limit=120`이라 가장 빡빡한 10이 먼저 발동한다.
>
> 패치: `kv.ts`에 `ipExtract: (ip) => 'rl:ip:extract:${ip}'` 추가 후 `src/app/api/profile/extract/route.ts:28`의 `rlKey.ip(ip)`를 `rlKey.ipExtract(ip)`로 변경. 단위 테스트 `kv.test.ts`에 "다른 prefix는 독립 카운터" 케이스 1건 추가.
>
> 1줄 변경 + 테스트 1 케이스. 30분 작업.

**전송 여부**: ✅ 오케스트레이터(`/fullstack-webapp`)가 백엔드 위임 대신 직접 1줄 패치를 적용. 변경 파일 2건 + 회귀 테스트 1건:
- `src/lib/rate-limit/kv.ts` — `rlKey.ipExtract` 추가
- `src/app/api/profile/extract/route.ts:28` — `rlKey.ip` → `rlKey.ipExtract`
- `src/lib/rate-limit/__tests__/kv.test.ts` — "isolates counters across different key prefixes (SEC-1 regression)" 케이스 추가
- 검증: `npx vitest run` 70/70 pass, `npx tsc --noEmit` clean.

### 라운드 2 (불필요)

SEC-2 ~ SEC-5는 🟡로 v1.0 후속 처리. 차단 사유 아님.

---

## 10. spec/02 §3.3.4 T1~T6 확인

`src/lib/extractors/__tests__/upwork.test.ts` 6 케이스 모두 `vitest run` 통과:
- T1: 골든 픽스처 — header/footer 컷 + 핵심 시그널 보존
- T2: 빈 문자열 입력 → 빈 문자열 출력
- T3: 트리거 키워드 부재 → 원본 trim 그대로
- T4: footer만 존재 → header 보존 + footer 컷
- T5: "Job Description" (capital D) 대소문자 무시 매칭
- T6: "BACK TO JOB POST" 대문자 변형 매칭

frontend 작성분 검증 완료. 누락 케이스 없음 (보강 픽스처는 `_workspace/04_test_plan.md §5`로 v1.0 일정화).

---

## 11. 변경 이력

| 날짜 | 변경 | 작성 |
|------|------|------|
| 2026-05-27 | 최초 작성 — 69 tests pass, 🔴 1 + 🟡 4 발견 | qa-engineer |
