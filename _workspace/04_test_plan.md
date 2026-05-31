# 04_test_plan.md — ConnectSaver QA 전략 확정본

> [PIVOT-01 rev2 — 2026-05-29] 결제 webhook 테스트가 Stripe → Dodo Standard Webhooks로 전환되었다. §2 NFR-8, §3.4 표(P1~P15), §8 통합 테스트 파일명, §7.2 수동 점검 항목을 갱신했다. 결정 매트릭스는 `_workspace/00_input.md §11`.
> 상위 문서: `_workspace/00_input.md`, `_workspace/01_architecture.md`, `_workspace/02_api_spec.md`, `_workspace/03_db_schema.md`
> 본 문서는 ConnectSaver MVP의 테스트 전략·자동화 코드·수동 체크리스트·성능 SLO 검증을 단일 문서로 정의한다.
> 상충 시 우선순위: **본 문서 > spec/06 §QA > spec/02 §3.3.4**.

---

## 1. 테스트 피라미드 (MVP)

```
            ┌──────────────────┐
            │      E2E 5%      │  Playwright (Week 2 Day 9~10, devops 박스에서 수동)
            │  Auth · Pay · Refund │
            ├──────────────────┤
            │ Integration 20%  │  vitest + mocked OpenAI/Dodo/Supabase
            │  analyze · webhook │  + RLS SQL 정적 검증
            │  · rate-limit · RLS │
            ├──────────────────┤
            │    Unit 75%      │  vitest 순수 함수 (rules / score / extractor / kv)
            └──────────────────┘
```

| 레벨 | 도구 | 위치 | 게이트 |
|------|------|------|--------|
| Unit | vitest 2.x | `src/**/__tests__/**/*.test.ts` | PR merge 차단 (CI) |
| Integration | vitest + mock SDK | `tests/integration/*.test.ts` | PR merge 차단 (CI) |
| E2E | Playwright (수동, v1.0 자동화) | `tests/e2e/**/*.spec.ts` (미작성, §6 수동 체크리스트로 갈음) | launch 직전 수동 |
| Performance | bash + curl + jq | `scripts/perf-analyze.sh` (Week 2 Day 9 작성) | launch HOLD 트리거 |
| Type | `tsc --noEmit` | 전체 | PR merge 차단 |
| Lint | `next lint` (ESLint flat) | 전체 | PR merge 차단 |

도구 선정 근거: spec/02 §1에서 Next.js 15 + Vitest 2.x 확정. Playwright는 v1.0 자동화 트리거(spec/06 TD-7)까지 deferred — MVP는 launch 직전 수동 smoke 12 step (deploy guide §5.3)로 갈음.

## 2. NFR 검증 매트릭스 (spec/01 §3 NFR ↔ 본 문서 테스트)

| # | NFR (출처) | 임계 | 검증 방식 | 위치 | 상태 |
|---|-----------|------|----------|------|------|
| NFR-1 | `/api/analyze` p50 < 3s, p95 < 6s | 50회 호출 | `scripts/perf-analyze.sh` (§4) | Week 2 Day 9~10 수동 | 🟡 launch HOLD 트리거 |
| NFR-2 | LLM input ≤ 16k chars, HTTP ≤ 64k chars | input cap | unit: `analyze.test.ts` "input_too_large" + 라우트 핸들러 검증 | `tests/integration/analyze.test.ts` | 🟢 자동 |
| NFR-3 | 99.5%/월 가용성 | — | Vercel/Supabase SLA 의존 + Sentry 5xx ratio | Sentry alert (v1.0) | 🟡 운영 |
| NFR-4 | `/api/analyze` per-user 60/min, per-IP 120/min, 동시 1 | sliding window | unit: `kv.test.ts` sliding-window/lock | `src/lib/rate-limit/__tests__/kv.test.ts` | 🟢 자동 |
| NFR-5 | `/api/profile/extract` per-user 5/min, per-IP 10/min | sliding window | 동일 unit test 패턴 (limit 변수 변경) | `kv.test.ts` (limit=5/10 변형 케이스로 충분) | 🟢 자동 |
| NFR-6 | weekly_pass 100/주, monthly_sub 500/월 soft cap | pre-check + RPC | unit: `score.test.ts` + 수동 SQL 시드 후 401회째 호출 시 ERR_SOFT_CAP_REACHED | 수동 smoke (deploy §5.3) | 🟡 수동 |
| NFR-7 | RLS 모든 user-owned 테이블 | `auth.uid()=user_id` | static SQL grep + 수동 cross-user 시도 | `tests/integration/rls.test.ts` | 🟢 정적, 🟡 live |
| NFR-8 | Webhook signature 검증 | Standard Webhooks HMAC-SHA256 (`standardwebhooks` npm) — 헤더 3종 (`webhook-id` / `webhook-timestamp` / `webhook-signature`) | unit: signature pass/fail/stale timestamp/replay | `tests/integration/dodo-webhook.test.ts` | 🟢 자동 |
| NFR-9 | Secrets 노출 0 | `NEXT_PUBLIC_` prefix 외 client 미노출 | 수동 grep + CI 빌드 시 Next.js 자동 차단 | `_workspace/06_review_report.md §2` | 🟢 |
| NFR-10 | 관측성 (Sentry + Vercel Analytics) | DSN 설정 | 수동: launch 후 7일 모니터링 | v1.0 deferred | 🟡 |
| NFR-11 | OpenAI Daily cap = min(soft_cap, 200) | KV `cost:daily:{uid}` | unit: `incrDailyCap` 카운터 | `kv.test.ts` | 🟢 |
| NFR-Retry | Silent Retry ×3 (initial + 3) + Deduct-on-Success | 4회 시도 | unit: 4 attempts on 503 → ERR_LLM_UPSTREAM, success on retry #2 | `tests/integration/analyze.test.ts` | 🟢 |
| NFR-Race | Credit deduction race-free | `record_analysis_and_deduct` RPC | DB-level `FOR UPDATE` + `P0001` | RPC SQL 검증 (`0003_triggers_and_rpc.sql`) | 🟢 |

## 3. 시나리오별 테스트 케이스

### 3.1 Auth (Google OAuth)

| # | 시나리오 | 입력 | 기대 결과 | 유형 | 위치 |
|---|---------|------|----------|------|------|
| A1 | Google OAuth 신규 가입 | `/login` → 동의 → callback | 302 → `/onboarding`, `credit_ledger` `free_grant +3` | 수동 | smoke §5.3 #2-3 |
| A2 | Google OAuth 기존 사용자 (프로필 有) | callback `?code=...` | 302 → `/dashboard` | 수동 | smoke §5.3 #2 |
| A3 | code 누락 | `/api/auth/callback` (no code) | 302 → `/login?error=oauth_failed` | 수동 | code review |
| A4 | 미인증 보호 라우트 접근 | `/dashboard` (no cookie) | 302 → `/login?redirect_to=/dashboard` | 수동 | middleware.ts 코드 검증 |

### 3.2 Onboarding (Profile Hybrid)

| # | 시나리오 | 입력 | 기대 결과 | 유형 |
|---|---------|------|----------|------|
| O1 | resume_text 빈 문자열 | `{resume_text: ""}` | 400 `ERR_BAD_REQUEST` | unit (route) |
| O2 | resume_text 16001 chars | overflow | 413 `ERR_INPUT_TOO_LARGE` | unit (route) |
| O3 | 정상 추출 | "5 years React..." | 200 `{extracted: {skills[], years, rate, tz}}` | 수동 (LLM 실호출) |
| O4 | OpenAI 5xx ×4 | upstream | 502 `ERR_LLM_UPSTREAM` (no DB write) | integration `analyze.test.ts` 동일 코드 경로 |
| O5 | PUT /api/profile upsert | full body | 200 + row in `users_profile` | 수동 smoke §5.3 #4 |

### 3.3 Analyze (Core)

| # | 시나리오 | 입력 | 기대 결과 | 유형 |
|---|---------|------|----------|------|
| AN1 | Safe job (T1 fixture) | upwork-sample.txt | 200 SHOW_REPORT, match_score 70~95, credit_after=2 | 수동 §5.3 #5 |
| AN2 | DANGER risk (Telegram keyword) | fixture mod | 200 DO_NOT_APPLY, match_score=null, action_tip=SCAM_TIP | integration (불가 — 실 LLM) → score.test.ts로 마스킹 검증 |
| AN3 | Backend rule fires (hire_rate=8) | fixture mod | backend_risk.critical=true, rules_triggered=['LOW_HIRE_RATE'] | unit `rules.test.ts` |
| AN4 | 정량 4필드 안전 (78%/✓/$12k/4.9) | normal | backend_risk.critical=false | unit `rules.test.ts` |
| AN5 | Pre-check: balance=0, no sub | poor user | 402 `ERR_OUT_OF_CREDITS` | 수동 (smoke 후 +3 소진) |
| AN6 | Pre-check: soft cap reached | usage_count=100 | 402 `ERR_SOFT_CAP_REACHED` | 수동 (DB 직주입) |
| AN7 | Rate limit per-user 60/min | 61회 1분 | 429 `ERR_RATE_LIMITED scope=user` | unit `kv.test.ts` (60→61 케이스) |
| AN8 | Concurrent lock | 2회 동시 | 두 번째 429 `scope=concurrent` | unit `kv.test.ts` |
| AN9 | Daily cap > 200 | 201회/일 | 429 `daily_safety_cap` | unit `kv.test.ts` (incrDailyCap) |
| AN10 | Silent Retry ×3 모두 실패 | OpenAI 503 ×4 | 502 `ERR_LLM_UPSTREAM`, 0 차감 | integration `analyze.test.ts` |
| AN11 | Silent Retry 두 번째 성공 | 503 → 200 | 200 정상, credit_after=balance-1 | integration `analyze.test.ts` |
| AN12 | LLM schema mismatch | 잘못된 JSON | 422 `ERR_VALIDATION` | integration `analyze.test.ts` |
| AN13 | Input > 16k chars | overflow | 413 `ERR_INPUT_TOO_LARGE` (LLM call 0) | integration `analyze.test.ts` |
| AN14 | Idempotency-Key 재호출 | 동일 key 60s | 첫 결과 그대로 반환 (LLM call 0) | route 코드 검증 + 수동 |

### 3.4 Payment / Webhook (Dodo Payments — Standard Webhooks)

| # | 시나리오 | 입력 | 기대 결과 | 유형 |
|---|---------|------|----------|------|
| P1 | Checkout single | plan=credit_single | 200 `{checkout_url}` → Dodo Hosted Checkout redirect | 수동 §5.3 #7 |
| P2 | Checkout weekly_pass | plan=weekly_pass | 동일 | 수동 |
| P3 | Checkout monthly_sub (mode=subscription) | plan=monthly_sub | 동일, session.metadata 포함 | 수동 |
| P4 | Webhook bad signature | tampered `webhook-signature` 헤더 | 400 `ERR_WEBHOOK_SIGNATURE` | integration `dodo-webhook.test.ts` (Standard Webhooks HMAC-SHA256 검증 케이스) |
| P4b | Webhook stale timestamp | `webhook-timestamp` 5분 초과 | 400 `ERR_WEBHOOK_SIGNATURE` (replay window) | integration |
| P4c | Webhook missing headers | `webhook-id` 누락 | 400 `ERR_WEBHOOK_SIGNATURE` | integration |
| P5 | Webhook valid signature | `standardwebhooks` 생성한 정상 signed body + 헤더 3종 | 200 `{received:true}` | integration |
| P6 | Webhook duplicate event | 동일 `webhook-id` 두 번째 호출 | 200 `{received:true, duplicate:true}` (no second insert) | 수동 (멱등성) — `dodo_events` PK 충돌 |
| P7 | `payment.succeeded` + credit_single | event | `credit_ledger` `purchase_single +1` row | integration |
| P8 | `payment.succeeded` + weekly_pass | event | `subscriptions` row, soft_cap=100, period_end=now+7d | integration |
| P9 | `subscription.active` + monthly_sub | event | `subscriptions` row, soft_cap=500, period_end=now+30d, status='active' | integration |
| P10 | `subscription.renewed` (monthly renewal — 구 `invoice.paid` 흡수) | event | period_end +30d, usage_count=0, status='active' | integration |
| P11 | `subscription.cancelled` | event | status='canceled', period_end 보존 | integration |
| P12 | `refund.succeeded` (credit_single, ≤7d) | event | `credit_ledger` `refund_reversal -1` row, note "within 7d" | integration |
| P13 | `refund.succeeded` (credit_single, >7d) | 8일 후 | 동일 ledger row, note "operator override after 7d" + Sentry warning | integration |
| P14 | `refund.succeeded` (pass/sub) | event | subscriptions.status='refunded' | integration |
| P15 | Unhandled event type | 예: `dispute.created` | 200 silent no-op | integration |

### 3.5 Report Scam

| # | 시나리오 | 입력 | 기대 결과 | 유형 |
|---|---------|------|----------|------|
| R1 | 본인 analysis 신고 | `{analysis_id, reason: "scam"}` | 200, `is_reported=true` | 수동 |
| R2 | 타인 analysis 신고 | 다른 user_id | 404 (RLS hides row) | 수동 §5.3 #10 |
| R3 | UUID 형식 오류 | `analysis_id: "abc"` | 400 `ERR_VALIDATION` | unit (route + Zod) |
| R4 | reason 빈 문자열 | min 1 | 400 `ERR_VALIDATION` | unit |
| R5 | reason 1001 chars | max 1000 | 400 `ERR_VALIDATION` | unit |

### 3.6 GDPR (501 placeholder, v1.1)

| # | 시나리오 | 기대 결과 |
|---|---------|----------|
| G1 | POST `/api/gdpr/export` 로그인 | 501 `ERR_NOT_IMPLEMENTED` |
| G2 | POST `/api/gdpr/delete` 로그인 | 501 `ERR_NOT_IMPLEMENTED` |
| G3 | 미인증 호출 | 401 `ERR_UNAUTHENTICATED` |

### 3.7 Cross-user RLS (수동/live)

| # | 시나리오 | 입력 | 기대 결과 | 유형 |
|---|---------|------|----------|------|
| X1 | User B → User A의 `/analyses/<A_id>` | A가 생성한 row id | 403 또는 404 | 수동 §5.3 #10 |
| X2 | User B → SELECT credit_ledger WHERE user_id=A | RLS | 0 rows | SQL Editor 수동 |
| X3 | User B → POST `/api/report-scam` with A's id | 시도 | 404 (.eq user_id=B와 unmatched) | 수동 |

## 4. 부하/성능 측정 계획 (NFR-1)

### 4.1 측정 절차 (Week 2 Day 9~10)

```bash
# scripts/perf-analyze.sh — devops/qa Week 2 Day 9 작성
#!/usr/bin/env bash
set -euo pipefail
JOB_TEXT=$(jq -Rs . < tests/fixtures/upwork-sample.txt)
TOKEN="$SUPABASE_TEST_USER_JWT"     # 사전 발급
URL="${PERF_BASE_URL:-https://app.connectsaver.com}/api/analyze"

mkdir -p .perf
> .perf/timings.txt

for i in $(seq 1 50); do
  t=$(curl -sS -o /tmp/resp.json -w "%{time_total}\n" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"job_text\": $JOB_TEXT}" "$URL")
  echo "$t" >> .perf/timings.txt
  sleep 1   # 1초 간격 → per-user 60/min 안전
done

sort -g .perf/timings.txt > .perf/sorted.txt
P50=$(awk 'NR==25 {print}' .perf/sorted.txt)
P95=$(awk 'NR==48 {print}' .perf/sorted.txt)
echo "p50=${P50}s, p95=${P95}s, target=3s/6s"
[[ $(echo "$P50 < 3.0" | bc -l) -eq 1 ]] || echo "::warning::p50 SLO violated"
[[ $(echo "$P95 < 6.0" | bc -l) -eq 1 ]] || echo "::warning::p95 SLO violated"
```

### 4.2 통과 기준 / 실패 액션

| 결과 | 액션 |
|------|------|
| p50 < 3s AND p95 < 6s | ✅ launch GO |
| p50 ≥ 3s OR p95 ≥ 6s | 🚨 launch HOLD → spec/06 TD-1 트리거: (a) prompt 축약 (b) gpt-4o-mini → gpt-4o switch deferred (Pro tier 까지 미루기) (c) Vercel function maxDuration 60s로 증액 후 재측정 |
| OpenAI 호출 비용 > $0.005/avg | 🟡 cost guard 검토. v2 24h dedup cache 활성화 트리거 |

### 4.3 측정 입력 다양화

골든 픽스처 1종만으로는 latency 분포가 좁다. p95 측정 시:
- 70% upwork-sample.txt (베이스라인)
- 15% T_DANGER 픽스처 (Telegram + low metrics — §5)
- 15% T_WARNING 픽스처 (aggressive language)

## 5. 회귀 방지 골든 픽스처

`tests/fixtures/` 디렉토리에 다음을 보유/추가한다.

| 파일 | 목적 | 상태 | 트리거 |
|------|------|------|--------|
| `upwork-sample.txt` | spec/02 §3.3.2 T1~T6 기준 (SAFE-ish) | ✅ 존재 | frontend 작성분 |
| `upwork-danger.txt` | DANGER 시나리오: Telegram 연락, 0% hire rate, $0 spend, unverified | 🟡 v1.0에서 추가 권장 | LLM regression 측정 |
| `upwork-warning.txt` | WARNING 시나리오: 비현실적 데드라인 + 저단가 | 🟡 v1.0 권장 | |
| `upwork-empty.txt` | 빈 본문 / 헤더만 | 🟡 v1.0 권장 | extractor edge case |
| `upwork-clipped-header.txt` | "Job details" 키워드 없음 → 본문 전체 보존 | ✅ T3 단위 테스트로 등가 | extractor T3 |
| `upwork-allcaps.txt` | "BACK TO JOB POST" 대문자 | ✅ T6 단위 테스트로 등가 | extractor T6 |

**v1.0 fixture 추가 작업은 spec/06 §QA에 명시. MVP는 1종(upwork-sample.txt) + 6 단위 테스트 케이스로 충분.**

## 6. CI 게이트 (`.github/workflows/ci.yml`)

| 게이트 | 명령 | 차단 조건 |
|-------|------|----------|
| Lint | `pnpm lint` (eslint-config-next) | Error 1+ |
| Typecheck | `pnpm typecheck` (`tsc --noEmit`) | Error 1+ |
| Test | `pnpm test` (vitest run) | Test fail 1+ |
| Build | `pnpm build` (`next build`) | Build fail |

GitHub Settings → Branches → main → Require status checks: `lint`, `typecheck`, `test`, `build` 4종 모두 통과해야 머지.

### 6.1 커버리지 목표 (소프트, 측정만)

| 영역 | 목표 | 측정 도구 | 비고 |
|------|------|----------|------|
| `src/lib/risk-engine/**` | **90% lines** | vitest --coverage (v1.0 도입) | 순수 함수, 차단 비즈니스 로직 |
| `src/lib/extractors/**` | 90% lines | 동일 | spec/02 §3.3.1 본문 freeze |
| `src/lib/rate-limit/**` | 80% lines | 동일 | KV mock 한계 |
| `src/lib/openai/**` | 70% lines | 동일 | Silent Retry 핵심 경로 |
| `src/lib/dodo/**` | 70% lines | 동일 | 5 이벤트 분기 (Standard Webhooks) |
| `src/app/api/**` (route handlers) | 50% lines | 통합 (수동/Playwright) | 라우터 자체는 얇음 |
| **전체** | **70% lines / 60% branches** (v1.0 목표) | | MVP는 측정만, 차단 X |

> MVP는 커버리지 임계 미설정 (개발 속도 우선). v1.0 진입 시 `@vitest/coverage-v8` 도입하여 위 목표를 차단 조건으로 승격.

### 6.2 빌드 시 stub env

CI는 실 시크릿을 보유하지 않는다. `.github/workflows/ci.yml` env 블록의 `NEXT_PUBLIC_*=stub` 값으로 빌드만 통과시키고, 실제 시크릿은 Vercel Project Env Vars에서만 관리한다. 본 정책으로 GitHub Actions 로그에 시크릿이 노출될 가능성을 0으로 만든다.

## 7. 수동 테스트 체크리스트 (launch 직전)

`_workspace/05_deploy_guide.md §5.3`의 12 step smoke test가 단일 출처. 본 문서는 추가 시나리오만 정리한다.

### 7.1 UI 시나리오 (Browser 수동)

- [ ] Landing → `/login` → "Sign in with Google" 클릭 → Google consent → callback 성공
- [ ] 신규 가입자: 자동 `/onboarding` 라우팅
- [ ] Onboarding: 이력서 paste → "Extract with AI" → 4 필드 prefill → 수정 → "Save"
- [ ] Dashboard: 잔여 크레딧 3 표시 (CreditBadge)
- [ ] PasteAnalyzer: 골든 픽스처 paste → "Analyze" → 6초 이내 결과 표시
- [ ] ReportModal: SAFE → match_score + score_reason + action_tip 표시 / DANGER → match_score 숨김 + SCAM_TIP 표시
- [ ] Recent Analyses: 분석 직후 새 row 표시 (created_at desc)
- [ ] `/dashboard/history` → 페이지네이션 (≥ 21건 시 next 버튼)
- [ ] `/analyses/[id]` → 본인 row만 접근, 타인 id 입력 시 404
- [ ] Report Scam: ReportDialog → reason 입력 → 제출 → is_reported badge
- [ ] Pricing 페이지: 3 plan card + Refund disclaimer footer
- [ ] Buy Single → Dodo Hosted Checkout (test card — `[TBD: confirm Dodo test card format, likely 4242 4242 4242 4242 standard sandbox]`) → `/account?checkout=success` redirect → 크레딧 +1
- [ ] Account page: 활성 plan, 잔여 사용량, 만료일 정확히 표시. "Manage in Dodo Customer Portal" 링크 표시 (`[TBD: confirm portal URL with Dodo docs]`)
- [ ] Refund (Dodo Dashboard에서 클릭) → 30초 후 `refund.succeeded` webhook 도착 → ledger에 `refund_reversal` row, account UI에 반영
- [ ] Logout → 보호 라우트 접근 시 `/login` redirect

### 7.2 보안 수동 점검 (`_workspace/06_review_report.md`와 cross-ref)

- [ ] DevTools → Sources → JS bundle에 `dodo_live_`, `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, `service_role` 키워드 검색 → 0건 (`NEXT_PUBLIC_DODO_PRODUCT_*`만 노출 OK — Product ID는 공개 안전)
- [ ] 두 번째 Google 계정으로 첫 계정의 `/analyses/<id>` URL 직접 입력 → 404
- [ ] 음수 webhook signature 테스트: `curl -X POST .../api/webhooks/dodo -H "webhook-id: x" -H "webhook-timestamp: 1234567890" -H "webhook-signature: v1,invalid" -d '{}'` → 400 `ERR_WEBHOOK_SIGNATURE`
- [ ] CSP/X-Frame: Vercel 기본 (v1.0 강화)
- [ ] OAuth callback: `?code=` 누락 / 잘못된 code → 302 `/login?error=oauth_failed`

### 7.3 모바일 (Chrome DevTools → Pixel 5 emulator)

- [ ] Analyze Textarea: 키보드 활성화 시 input이 가려지지 않음 (`viewport interactive-widget=resizes-content` 또는 동등)
- [ ] PricingCard: 3 plan이 세로 stack 깨지지 않음
- [ ] CreditBadge: nav bar 안에 잘 들어감

## 8. 자동 테스트 산출물 (이번 사이클 추가)

| 파일 | 케이스 수 | 영역 |
|------|----------|------|
| `src/lib/extractors/__tests__/upwork.test.ts` | 6 (T1~T6) | frontend 작성, qa 검증 통과 |
| `src/lib/risk-engine/__tests__/rules.test.ts` | 16 | unit (boundary + 조합) |
| `src/lib/risk-engine/__tests__/score.test.ts` | 9 | unit (masking + clamp) |
| `src/lib/rate-limit/__tests__/kv.test.ts` | 9 | unit (mock KV, sliding/lock/cap/IP) |
| `tests/integration/analyze.test.ts` | 5 | integration (Silent Retry, validation) |
| `tests/integration/dodo-webhook.test.ts` | 12 | integration (Standard Webhooks: sig pass/fail/stale/missing-headers + 5 events `payment.succeeded` / `subscription.active|renewed|cancelled` / `refund.succeeded` + idempotency + unhandled-type) |
| `tests/integration/rls.test.ts` | 14 | integration (RLS SQL static + live placeholder) |
| **합계** | **71** (rev 2: dodo-webhook +2 케이스) | |

`pnpm test` (= `vitest run`) 한 번의 호출로 모두 실행, 평균 1.5초 내 완료. CI 머지 차단 게이트로 연결.

## 9. 한계 / 추후 (v1.0)

| 항목 | MVP 상태 | v1.0 도입 트리거 |
|------|---------|----------------|
| Playwright E2E 자동화 | 미도입 (수동 §7) | spec/06 TD-7: 회귀 시간 > 30분 도달 |
| @vitest/coverage-v8 | 미도입 | v1.0 진입 시 커버리지 게이트 활성화 (§6.1) |
| Supabase live RLS 테스트 | 정적 SQL grep만 | dedicated Supabase test project 발급 시 `SUPABASE_TEST_*` env로 활성화 (`rls.test.ts` describe.skipIf) |
| Dodo live 환불 테스트 | 수동 §7 | Dodo Dashboard "Send test webhook" 또는 Dodo CLI(`[TBD: confirm with Dodo docs]`)로 `refund.succeeded` 자동 트리거 CI step 추가 |
| Load test (k6/Artillery) | bash 50회 (§4) | DAU > 100 도달 시 k6 cluster |
| Mutation testing | 미도입 | 영구 미도입 (속도-가성비) |
| 보안 scan (npm audit) | CI 미설정 | v1.0 Dependabot + audit-ci |

---

## 변경 이력

| 날짜 | 변경 | 작성 |
|------|------|------|
| 2026-05-27 | 초기 작성 — 69 테스트 통과 + smoke 12 step 수동 | qa-engineer |
| 2026-05-29 | **PIVOT-01 rev 2** — Stripe → Dodo Payments. webhook 테스트 파일명/이벤트/signature 검증 케이스 갱신, 합계 71로 +2 케이스 (stale timestamp, missing headers) | architect |
