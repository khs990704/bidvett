# 00_input.md — BidVett

> 사용자 입력 + idea_inquiry.md (LGTM) + spec/ (FROZEN 2026-05-27) 통합 정리.
> 후속 에이전트(architect/frontend/backend/devops/qa)가 _workspace/ 작성/구현 시 1차 참조 문서.
> 상충 시 우선순위: **_workspace/ 확정본 > spec/ > idea_inquiry.md > idea.md > 본 문서**.

---

## 0. 메타

- **프로젝트명**: BidVett
- **실행 모드**: Full Pipeline (5 agents)
- **배포 대상**: Vercel (Frontend + API) + Supabase Cloud
- **언어/로케일**: English-only (Q5)
- **현재 단계**: `/fullstack-webapp` Phase 1 → Phase 2 진입
- **타임라인 가정**: MVP 2주 (idea.md §6 / spec/06 일정)

## 1. 제품 한 줄 요약

Upwork 프리랜서가 Connects(지원 토큰)를 낭비하지 않도록, 공고 텍스트를 붙여넣으면 정량 룰 엔진과 정성 LLM 추론이 이중으로 사기/먹튀 위험을 스크리닝하고 매칭 점수(0~100) + 액션 플랜을 3초 내에 반환하는 SaaS.

## 2. 핵심 입력 산출물 위치

| 산출물 | 경로 | 상태 |
|--------|------|------|
| 초기 아이디어 | `idea.md` | 원본 |
| 아이디어 구체화 | `idea_inquiry.md` | ✅ LGTM (Q1~Q6 확정) |
| 사전 기획 spec/ | `spec/01_prd.md` ~ `spec/06_milestones.md`, `spec/index.md` | 🔒 FROZEN 2026-05-27 |

## 3. 확정된 핵심 의사결정 (요약)

| # | 항목 | 결정 | 근거 |
|---|------|------|------|
| Q1 | 정량 룰 입력 수집 | 프론트 정규식 전처리 → OpenAI Structured Outputs로 4수치 추출 → 백엔드 Rule Engine 최종 판정 | idea_inquiry §Q1, spec/02 §3.3 |
| Q2 | 결제 → 권한 변환 | 계정 단위 크레딧. 무료 5개 / $0.99 단건 +1개(영구) / $4.99 주간 무제한(주 100 소프트캡) / $19 월 무제한(월 500 소프트캡). 환불 정책은 TBD | idea_inquiry §Q2 |
| Q3 | 프로필 데이터 구조 | (C) 하이브리드. 자유 텍스트 → LLM이 `skills[]`, `years_of_experience`, `target_hourly_rate`, `timezone` 추출 → 유저 확인/수정 → DB 저장 | idea_inquiry §Q3 |
| Q4 | 운영자 기능 | (A) No-Code Admin Stack. Supabase Data Browser + Dodo Dashboard (PIVOT-01, 구 Stripe Dashboard). 어드민 UI 미개발. `analyses.is_reported`/`report_reason` + `system_prompts` 단일 테이블만 필수 | idea_inquiry §Q4 |
| Q5 | UI 언어 | English-only | idea_inquiry §Q5 |
| Q6 | OpenAI 장애 시 | Pre-check Hold → Silent Retry ×3 (backoff 200/500/1200ms) → 3회 모두 실패 시 차감 0 + 안내. 성공 시점에만 1개 차감 (Deduct-on-Success) | idea_inquiry §Q6 |

## 4. 기술 스택 (확정)

| 레이어 | 기술 | 비고 |
|--------|------|------|
| Frontend | Next.js 15 (App Router) + TypeScript + Tailwind CSS + shadcn/ui | spec/02 §1 |
| Backend | Next.js Route Handlers on Vercel Serverless | 단일 저장소 |
| DB/Auth | Supabase (PostgreSQL 15 + Supabase Auth + RLS) | Google OAuth 단일 |
| LLM | OpenAI `gpt-4o-mini` (Structured Outputs) | `gpt-4o` 스위치는 v2 |
| Payment | **Dodo Payments** (Hosted Checkout + Standard Webhooks) — PIVOT-01 rev 2 | MoR: VAT/GST 자동 처리. 구 Stripe(rev 1) 대체 |
| Rate Limit | **Vercel KV** (`@vercel/kv`) | Sliding window |
| Error Tracking | Sentry `[가정]` | |
| Deploy | Vercel + Supabase Cloud | |

## 5. 산출물 매핑 (spec/ → _workspace/)

| spec/ 초안 | _workspace/ 확정본 | 담당 | 비고 |
|-----------|-------------------|------|------|
| `spec/01_prd.md` | `_workspace/00_input.md` (본 문서) + `_workspace/01_architecture.md` 도입부 | architect | PRD 자체는 spec/이 단일 출처. _workspace/는 비기능/제약·운영 합의만 인용 |
| `spec/02_architecture_preview.md` | `_workspace/01_architecture.md` | architect | 모듈 책임 + 데이터 흐름 + Vercel KV/Sentry 운영 결정 확정 |
| `spec/03_api_preview.md` | `_workspace/02_api_spec.md` | architect | 9 엔드포인트 상세 (request/response/에러/멱등성/rate-limit 키) |
| `spec/04_db_preview.md` | `_workspace/03_db_schema.md` | architect | Supabase 마이그레이션 SQL + RLS 정책 + seed 포함 |
| `spec/05_wireframe.md` | (없음 — frontend가 직접 구현) | frontend | wireframe → React component tree |
| `spec/06_milestones.md` | `_workspace/05_deploy_guide.md` 일부 + 칸반 그대로 | devops + 오케스트레이터 | 마일스톤은 spec이 단일 출처 |

## 6. _workspace/ 단계에서 결정해야 할 잔여 항목 (spec/에서 명시적으로 이관됨)

1. **`profile_extract.v1` 시스템 프롬프트 본문 작성** — `system_prompts` 테이블의 v1 row로 적재. 출력 스키마는 spec/03 §6.2의 ProfileExtract와 일치. → **architect 책임**
2. **OpenAI 응답 latency p95 SLO 부합성 측정 계획** — 3초 SLO를 어떻게 검증할지. → **qa 책임**
3. **Email 알림 채널 선정** (Resend vs Supabase SMTP vs Postmark) — MVP는 의도적으로 제외 가능. → **devops 의견 + 사용자 확인**
4. **GDPR Data Export/Delete 흐름** — `[TBD]` 유지하되 v1.1 마일스톤 명시. → **backend가 placeholder 엔드포인트만**
5. **동일 공고 재분석 중복 차감 방지** — `job_text_hash` 컬럼은 schema에 미리 예약. 실제 캐싱은 v2. → **backend가 컬럼만 추가**
6. ~~**Stripe EU VAT 자동 처리** — Stripe Tax 활성화 여부.~~ → ✅ **종결 (PIVOT-01)** — Dodo Payments가 Merchant of Record로 VAT/GST/Sales Tax 자동 처리.
7. **환불 정책** — 현재 미노출. 추후 법무/운영 검토 후 필요 시 Pricing/Terms에 추가.
8. **모바일 뷰 Analyze Textarea 키보드 가림 처리** — `viewport` + CSS 처리. → **frontend 책임**

## 7. 디렉토리 레이아웃 가정 (구현 단계 시작점)

```
/Users/heesubkim/project/bidvett/
├── idea.md
├── idea_inquiry.md
├── spec/                           # 🔒 FROZEN
│   ├── 01_prd.md
│   ├── 02_architecture_preview.md
│   ├── 03_api_preview.md
│   ├── 04_db_preview.md
│   ├── 05_wireframe.md
│   ├── 06_milestones.md
│   └── index.md
├── _workspace/                     # 본 문서가 시작점
│   ├── 00_input.md                 # ← 본 문서
│   ├── 01_architecture.md          # ← architect 작성
│   ├── 02_api_spec.md              # ← architect 작성
│   ├── 03_db_schema.md             # ← architect 작성
│   ├── 04_test_plan.md             # ← qa 작성
│   ├── 05_deploy_guide.md          # ← devops 작성
│   └── 06_review_report.md         # ← qa 작성
└── src/                            # ← frontend + backend 작성
    └── (Next.js App Router 표준)
```

## 8. 에이전트별 작업 지시 요약

| 에이전트 | 1순위 입력 | 핵심 산출물 | 외부 자원 |
|---------|----------|------------|----------|
| architect | spec/01~04, idea_inquiry.md | `_workspace/01/02/03` + `profile_extract.v1` 본문 | — |
| frontend-dev | spec/05, _workspace/01, 02 | `src/app/**`, `src/components/**`, `src/lib/extractors/upwork.ts`(v1 확정), shadcn/ui setup | spec/02 §3.3.1 소스 그대로 사용 |
| backend-dev | _workspace/02, 03, spec/02 | `src/app/api/**`, `src/lib/{openai,supabase,dodo,rate-limit,risk-engine,credits}/**`, Supabase migrations (PIVOT-01: `dodo/` 디렉토리, 구 `stripe/` 대체) | analyze.v1 본문은 spec/03 §7 그대로 |
| devops-engineer | spec/02 §8, spec/06 | `_workspace/05_deploy_guide.md`, `.github/workflows/ci.yml`, `vercel.json` | env vars: spec/02 §8 |
| qa-engineer | _workspace/01~03 + src/ | `_workspace/04_test_plan.md`, `_workspace/06_review_report.md`, `src/**/*.test.*`, `tests/**` | upwork-sample.txt 골든 픽스처 활용 |

## 9. 명시적 비-목표 (Out of Scope at MVP)

- Chrome Extension (v2.0)
- Admin Web UI (DAU>500 시점)
- 다국어 i18n (영어 단일)
- Email Notifications (TBD, MVP 후)
- gpt-4o 스위치 (Pro tier, v2.x)
- Multi-tenant / Agency 플랜
- 동일 공고 재분석 캐시 (v2)
- 모바일 네이티브 앱

## 10. 변경 이력

| 날짜 | 변경 | 출처 |
|------|------|------|
| 2026-05-27 | 초기 작성 — spec/ FROZEN 시점에 통합 | `/fullstack-webapp` Phase 1 |
| 2026-05-29 | **결제 프로바이더 pivot: Stripe → Dodo Payments** (PIVOT-01) — 사용자 지시. spec/ 동결 해제 (rev 2). | 사용자 직접 지시 |

---

## 11. PIVOT-01 — Stripe → Dodo Payments (2026-05-29)

### 11.1 결정

`spec/` v1(2026-05-27 FROZEN)에서 결제 인프라로 Stripe Checkout + Webhook을 채택했으나, 2026-05-29 사용자 지시로 **Dodo Payments**로 전면 전환한다. 본 결정은 `idea_inquiry.md` Q2의 비즈니스 모델(무료 5개 / $0.99 단건 / $4.99 주간 / $19 월간 + 환불 정책)을 **그대로 유지**하며, 변경 범위는 **결제 인프라 레이어**에 한정된다.

### 11.2 변경되지 않는 것 (불변)

- 비즈니스 모델: 신규 가입 무료 크레딧 5개, $0.99 단건(영구 보존), $4.99 주간(7d 무제한 + 주 100 소프트 캡), $19 월(30d 무제한 + 월 500 소프트 캡)
- 환불 정책: TBD. MVP 현재 카피/약관 placeholder에서는 환불 가능/불가를 단정하지 않음
- DB 모델: `credit_ledger`, `subscriptions` 컬럼/관계 그대로
- Credit Pre-check → Deduct-on-Success 파이프라인 그대로
- 사용자 대면 흐름(Pricing → Hosted Checkout → 성공/취소 콜백 → Dashboard) 동일
- Q1/Q3/Q4/Q5/Q6 모두 영향 없음

### 11.3 변경되는 것 (델타)

| 항목 | v1 (Stripe) | v2 (Dodo Payments) |
|------|------------|-------------------|
| 프로바이더 | Stripe | Dodo Payments |
| Node SDK | `stripe` | `dodopayments` |
| 호스티드 결제 | Stripe Checkout Session | Dodo Hosted Checkout Session |
| 웹훅 시그니처 | `Stripe-Signature` (Stripe HMAC) | Standard Webhooks 스펙 (`webhook-id` / `webhook-timestamp` / `webhook-signature` 헤더, HMAC-SHA256) |
| 웹훅 이벤트 매핑 | `checkout.session.completed` / `customer.subscription.{created,updated,deleted}` / `invoice.paid` / `charge.refunded` | `payment.succeeded` / `subscription.active` / `subscription.renewed` / `subscription.cancelled` / `refund.succeeded` |
| 멱등성 테이블 | `stripe_events` | `dodo_events` |
| 환경 변수 | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` / `NEXT_PUBLIC_STRIPE_PRICE_{SINGLE,WEEKLY,MONTHLY}` | `DODO_API_KEY` / `DODO_WEBHOOK_SECRET` / `NEXT_PUBLIC_DODO_PRODUCT_{SINGLE,WEEKLY,MONTHLY}` (publishable key 불필요 — 호스티드 redirect) |
| 디렉토리 | `src/lib/stripe/`, `src/app/api/webhooks/stripe/` | `src/lib/dodo/`, `src/app/api/webhooks/dodo/` |
| 고객 포털 | Stripe Customer Portal | Dodo Customer Portal (placeholder URL 유지) |
| 운영 콘솔 | Stripe Dashboard | Dodo Dashboard |
| 세금 처리 | Stripe Tax (deferred) | **MoR 자동 처리 — Dodo가 VAT/GST 처리** |

### 11.4 Pivot로 해소되는 기존 TBD

- ~~Stripe EU VAT 자동 처리 옵션 (deploy guide §8)~~ → **Dodo가 Merchant of Record로 자동 처리. TBD 종결.**
- 환불 처리 흐름은 Dodo Dashboard로 동일하게 수동 처리 (Q4 No-Code Admin Stack 그대로).

### 11.5 Pivot로 새로 생기는 TBD

- **Dodo Payments 제품 카탈로그 ID 발급** — `single_credit_099`, `weekly_pass_499`, `monthly_19` 3개. 실제 ID는 devops가 Dodo Dashboard에서 생성 후 환경변수에 주입. → `_workspace/05_deploy_guide.md` §4
- **Dodo 테스트 모드 키 발급 절차** — Dodo가 test/live key 분리하는 형식을 deploy guide에 명시.
- **Customer Portal URL** — Dodo가 제공하는 customer self-service portal URL 형식 확인. 미제공 시 단순 "support 이메일 안내"로 대체.
- **Standard Webhooks 라이브러리 선택** — `standardwebhooks` npm (공식) 사용 권장. backend-dev 결정.

### 11.6 영향 받는 파일 (총 36건 — 리팩토링 범위 한정)

- **문서 14건**: spec/01~06 + spec/index + _workspace/01~06 + 본 문서 (00_input.md 부록)
- **코드 9건**: `src/lib/stripe/{client,webhook,plans}.ts` → `src/lib/dodo/*`, `src/app/api/webhooks/stripe/route.ts` → `dodo/route.ts`, `src/app/api/checkout/route.ts`, `src/app/api/credits/route.ts`, `src/app/account/AccountBilling.tsx`, `src/app/legal/privacy/page.tsx`, `src/lib/env.ts`, `src/lib/errors.ts`, `src/lib/types/api.ts`, `src/middleware.ts`
- **DB 2건**: `supabase/migrations/0001_init_schema.sql` (테이블 rename), `0002_rls_policies.sql` (정책 rename)
- **테스트 3건**: `tests/integration/stripe-webhook.test.ts` → `dodo-webhook.test.ts`, `analyze.test.ts` 소규모 ref, `rls.test.ts` 소규모 ref
- **설정 4건**: `package.json` (deps swap), `.env.example` (env 키 rename), `vercel.json` (webhook path), `.github/workflows/ci.yml` (CI env stubs)
- **History 4건 (변경 없음)**: `idea.md`, `idea_inquiry.md`, `package-lock.json` (재생성 예정) — 단 `idea_inquiry.md` Q2에 1줄 pivot 노트 추가.

### 11.7 라우팅 정리

- 본 pivot 이후 spec/는 **rev 2** 상태로 갱신. `spec/index.md` §0의 FROZEN 마커는 "🔒 FROZEN-rev2 — 2026-05-29 (Stripe→Dodo Payments pivot 반영)"로 바뀐다.
- spec/ rev 2와 idea_inquiry.md Q2 사이에 충돌이 있으면 spec/ rev 2 우선 (idea_inquiry.md는 1차 의사결정 원본으로 보존, Q2 본문은 그대로 두고 § 끝에 "PIVOT-01: 2026-05-29 — Dodo Payments로 전환됨, spec/ rev 2 참조" 한 줄만 추가).
