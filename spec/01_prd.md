# PRD — ConnectSaver (Upwork 공고 이중 리스크 스크리닝 SaaS)

> [PIVOT-01 rev2 — 2026-05-29] Payment provider 변경: Stripe → Dodo Payments. 자세한 결정 매트릭스는 `_workspace/00_input.md §11` 참조. 비즈니스 모델/가격/환불 정책은 불변.
> Last updated: 2026-05-29 (rev 2)
> Source: `idea.md`, `idea_inquiry.md` (Q1~Q6 LGTM)
> Language of user-facing surfaces: **English only** (Q5)

---

## 1. 제품 개요

- **한 줄 요약**: Upwork 공고를 붙여넣으면 정량(Rule Engine) + 정성(LLM) 이중 위험도와 매칭 점수를 3초 내 반환해 Connects 낭비를 막아주는 방어형 SaaS.
- **해결하는 문제**:
  1. 2026년 급등한 Upwork Connects 비용으로 인한 프리랜서의 자본 압박
  2. AI 스팸 지원서 범람 속에서 면접/고용으로 이어질 핵심 공고 식별 난이도
  3. 본인 프로필 대비 공고 적합도(기술/예산/맥락)에 대한 객관적 판단 도구 부재
- **타겟 사용자**:
  - 핵심 페르소나: Upwork 글로벌 1~5년 차 주니어/미드 레벨 프리랜서
  - 확장 페르소나: 공고 분석 시간이 부족한 Top Rated 고단가 프리랜서
- **핵심 가치 제안 (USP)**:
  - "Stop wasting Connects on ghost jobs and scams. Get a 3-second double risk screening before you apply."
  - 룰 엔진(객관)과 LLM(맥락)을 결합한 이중 필터링 — 경쟁 도구가 못 잡는 정성 리스크까지 탐지.
  - 평생 무료 3회 + $0.99 단건 — Try-before-buy 최저 진입장벽.

## 2. 기능 요구사항

### P0 — 반드시 있어야 함 (MVP)

| # | 기능 | User Story | Acceptance Criteria |
|---|------|-----------|---------------------|
| FR-1 | Google OAuth Sign-in | As a freelancer, I want to sign in with Google so I can start in <10 seconds. | Supabase Auth 단일 흐름 / 신규 가입 시 무료 크레딧 3개 자동 지급 / 세션 영구 유지(Refresh Token) |
| FR-2 | Profile Onboarding (Hybrid) | As a new user, I paste my resume once and have my skills/rate/timezone extracted automatically. | Free-text Textarea → `POST /api/profile/extract` → 4개 필드(`skills[]`, `years_of_experience`, `target_hourly_rate`, `timezone`) 자동 추출 → shadcn/ui Tag/Number Input으로 편집 가능 → [Save] 시 `users_profile` upsert |
| FR-3 | Job Posting Paste & Analyze | As a user, I want to paste an Upwork job and click [Analyze] to receive a verdict. | 단일 Textarea / Frontend 전처리(헤더/푸터/광고 제거) → `POST /api/analyze` / 3초 내 응답 (p50<3s) / 응답 동안 로딩 스피너 노출 |
| FR-4 | Quantitative Rule Engine | The backend flags jobs that fail objective hard filters. | OpenAI Structured Outputs로 `hire_rate`, `payment_verified`, `total_spend`, `rating` 추출 → 백엔드 Rule Engine이 다음 중 1개라도 충족 시 `CRITICAL_RISK`: ① hire_rate<20% ② payment_unverified AND total_spend=$0 ③ rating≤3.5 |
| FR-5 | Qualitative LLM Risk | The LLM judges contextual red flags from the posting body. | `gpt-4o-mini` (Structured Outputs) / `risk_level` ∈ {SAFE, WARNING, DANGER} / `contextual_red_flags[]` 배열 반환 |
| FR-6 | Matching Score | Output a 1-100 Connect Value Score weighted 40/30/30. | Technical 40% + Budget 30% + Context 30% / `score_reason` 텍스트 동봉 |
| FR-7 | Report Dashboard | Show a verdict modal: BLOCK on risk, SHOW SCORE on safe. | `CRITICAL_RISK` OR `DANGER` → "DO NOT APPLY" 큰 경고 + 사유 노출 / 둘 다 안전 시 점수+`action_tip` 노출 |
| FR-8 | Credit Pre-check & Deduct-on-Success | A failed OpenAI call must not consume credits. | Pre-check Hold → Silent Retry x3 → 성공 시에만 1개 차감 (`Deduct-on-Success`) / 3회 실패 시 차감 0 + "OpenAI temporary error" 안내 |
| FR-9 | Dodo Payments (3 tiers) | Convert payments into usage rights. | $0.99 = perma-credit +1 / $4.99 = 7-day pass (100 soft cap) / $19 = 30-day subscription (500 soft cap) / Dodo Webhook (`payment.succeeded` / `subscription.active|renewed|cancelled`) → Supabase 동기화 필수 |
| FR-10 | Refund Sync | Refunds in Dodo Payments must reflect in Supabase credits. | `refund.succeeded` Webhook → 해당 크레딧 무효화 / 환불 정책: 0회 사용 + 7일 이내만 100% 환불 |
| FR-11 | Report Scam | Users can flag a result as scam for prompt tuning. | `analyses.is_reported=true`, `report_reason` text 저장 → Supabase Data Browser에서 운영자가 필터링 |
| FR-12 | Pricing Page | A public pricing page with 3 plans. | Landing/Pricing route 공개 / Dodo Hosted Checkout 진입 버튼 |

### P1 — 있으면 좋음 (v1.0)

| # | 기능 | 비고 |
|---|------|------|
| FR-13 | Analysis History | 과거 분석 결과 다시 보기 (Dashboard 하단 리스트) |
| FR-14 | Account Settings | Profile 재편집, 결제 이력, 구독 취소 |
| FR-15 | Email Notifications | Dodo Payments 결제 영수증 보조 + 구독 만료 1일 전 알림 ([가정] Resend or Supabase SMTP). Dodo가 발송하는 기본 영수증은 그대로 사용. |
| FR-16 | Soft Cap Hit UX | 주간/월간 캡 도달 시 안내 메시지 |
| FR-17 | Public Landing Page | Reddit 트래픽 유입용 SEO 페이지 |

### P2 — 나중에 (v2.0+)

| # | 기능 | 비고 |
|---|------|------|
| FR-18 | Chrome Extension | 입력 핸들러 모듈 분리 설계 (이미 P0 구조에 반영) |
| FR-19 | Multi-language UI | 영어 단일 시작 → 추후 i18n |
| FR-20 | Admin UI 고도화 | DAU>500 또는 외부 인력 운영 시점에 착수 |
| FR-21 | Team / Agency Plan | 다중 시트 |
| FR-22 | Browser-side cache | 같은 공고 재분석 시 중복 차감 방지 [TBD] |

## 3. 비기능 요구사항

| 항목 | 요구사항 | 비고 |
|------|---------|------|
| 성능 | `/api/analyze` p50 < 3s, p95 < 6s | OpenAI gpt-4o-mini Structured Outputs 기준 |
| 성능 (전처리) | Frontend 전처리 후 LLM 입력 토큰 ≤ 4k | 비용 가드 |
| 가용성 | 99.5% / month (Vercel + Supabase SLA 의존) | |
| 보안 — 인증 | Google OAuth via Supabase Auth, JWT RS256 | Q1~Q6 확정 |
| 보안 — RLS | Supabase Row-Level Security: 모든 user-owned 테이블에 `auth.uid() = user_id` 정책 적용 | `users_profile`, `credit_ledger`, `analyses`, `subscriptions` |
| 보안 — Webhook | Dodo Webhook signature 검증 필수 (Standard Webhooks 스펙 — `webhook-id` / `webhook-timestamp` / `webhook-signature` 헤더 HMAC-SHA256 검증, `standardwebhooks` npm 권장) | |
| 보안 — Secrets | OpenAI/Dodo Payments/Supabase service key는 Vercel 환경변수만, 클라이언트 노출 금지 | |
| 보안 — Rate Limit | `/api/analyze` per-user 60/min, per-IP 120/min | Vercel KV (`@vercel/kv`) — 확정 |
| 비용 가드 | OpenAI 호출 전 입력 토큰 길이 컷오프(16k) + 일일 계정당 호출 캡 | Soft cap (주 100 / 월 500) 외 추가 안전망 |
| 확장성 | 입력 핸들러 모듈을 `lib/extractors/` 로 분리해 크롬 익스텐션 이식 시 재사용 | Q7 확장성 요구 반영 |
| 관측성 | Vercel Analytics + Supabase Logs + Sentry(에러) | [가정] Sentry 도입 |
| 컴플라이언스 | 디지털 재화 환불 약관 1줄 명시 / GDPR Data Export [TBD] / **VAT·GST·Sales Tax는 Dodo Payments가 Merchant of Record로 자동 처리** (별도 활성화 불필요) | |
| i18n | English-only at MVP. 모든 string은 `lib/i18n/en.ts` 또는 raw로 시작, 추후 키 추출 | |

## 4. 사용자 여정

### 4.1 First-time User Journey

```
1. Landing page (/) → "Sign in with Google" 클릭
2. Google OAuth 동의 → /onboarding 자동 진입
3. Onboarding에서 이력서 텍스트 붙여넣기 → "Extract" 클릭
4. AI 추출 결과(skills / years / hourly rate / timezone) 표시 → 사용자가 보정 → [Save]
5. /dashboard 진입, 무료 크레딧 3개 표기 ("3 free analyses available")
6. Upwork 공고 페이지 복사 → Dashboard Textarea 붙여넣기 → [Analyze]
7. 3초 내 Report Modal 등장: 안전이면 매칭 점수 + Action Tip, 위험이면 "DO NOT APPLY" + 사유
8. 사용자가 결정: Apply on Upwork / Skip / Report Scam
```

### 4.2 Recurring User Journey

```
1. 로그인 상태로 /dashboard 진입
2. 잔여 크레딧 확인 — 부족 시 /pricing 안내 배너
3. 공고 붙여넣기 → 분석 → Report
4. (옵션) Past Analyses 리스트에서 과거 결과 재열람
```

### 4.3 Payment Journey

```
1. 크레딧 0 또는 패스/구독 만료 → Dashboard 상단 배너 "Out of credits"
2. /pricing 클릭 → 3개 카드 노출
3. Dodo Hosted Checkout → 결제 완료 → Dodo Webhook이 Supabase에 반영 (payment.succeeded / subscription.active)
4. /dashboard 리다이렉트 → 크레딧/패스 즉시 가용
```

### 4.4 Error Journey (OpenAI 장애)

```
1. 사용자 [Analyze] 클릭
2. Pre-check: 크레딧 ≥ 1 → Hold (차감 보류)
3. OpenAI 호출 — 5xx/Timeout 발생 → Silent Retry #1, #2, #3 (UI는 스피너만)
4. 3회 모두 실패 → "OpenAI is temporarily unavailable. Please retry later." 토스트
5. credit_ledger 0개 차감 (Hold 해제)
```

## 5. 제외 범위 (Out of Scope at MVP)

- 크롬 익스텐션 (Phase 2 — 단, 입력 핸들러 모듈 분리는 P0에서 진행)
- 다국어 i18n (영어 단일 시작)
- 어드민 UI (Supabase Data Browser + Dodo Dashboard로 100% 운영)
- 팀/에이전시 플랜
- 모바일 앱
- 자동 크롤링/스크래핑 (수동 복붙 유지로 ToS 회피)
- 결제 영수증 자체 발행 (Dodo Payments 영수증 그대로 사용)
- 환불 자동화 어드민 (Dodo Dashboard에서 수동 [Refund] 클릭으로 처리, `refund.succeeded` Webhook이 동기화)

## 6. 성공 지표 (KPI 후보)

| 지표 | 목표 (MVP 후 4주) | 비고 |
|------|-----------------|------|
| Sign-up → first analysis 전환률 | ≥ 70% | 온보딩 마찰 측정 |
| Free credit 소진 → 첫 결제 전환률 | ≥ 8% | 가격 합리성 측정 |
| Repeat usage rate (week 2 retention) | ≥ 30% | |
| Avg cost per analysis (OpenAI) | < $0.005 | 마진 검증 |
| `/api/analyze` 성공률 | ≥ 99% | Retry 후 기준 |

## 7. 가정 및 미정 항목

- Frontend 전처리 로직은 `lib/extractors/upwork.ts` v1(spec/02 §3.3 확정 본문)로 확정. 헤더('Job details'/'Job Description'/'Back to job post') 좌측 컷 + 푸터('Browse jobs'/'About Us'/'Terms of Service'/'Accessibility'/'© YYYY') 우측 컷 + 공백 정규화의 3-step regex. Upwork UI 변경 시 깨질 수 있고 1차 방어선이므로 시스템 프롬프트(`analyze.v1`)가 잔여 노이즈를 2차로 흡수한다. v2 트리거는 spec/02 §3.3.5 참조.
- `[가정]` Soft cap 도달 시 사용자에게 안내만 하고 차단 (강제 차단). 자동 업그레이드 권유 X.
- `[가정]` 무료 크레딧 3개는 영구 보존 (만료 없음).
- `[TBD]` GDPR Data Export / Delete 흐름의 구체 구현 시점.
- `[TBD]` 같은 공고를 재분석할 경우 중복 차감 방지 (해시 기반 캐싱) 여부.
- `[TBD]` Email Notification 채널 (Resend vs Supabase SMTP vs Postmark).
