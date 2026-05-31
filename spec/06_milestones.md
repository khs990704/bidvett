# 개발 일정 및 마일스톤 — ConnectSaver

> [PIVOT-01 rev2 — 2026-05-29] 결제 인프라가 Dodo Payments로 전환되었다. 일정/스코프는 동일. 마일스톤 표·칸반·기술 부채 표에서 Stripe 언급을 Dodo Payments로 갱신했고 TD-7(Stripe Tax)은 MoR 자동 처리로 종결 표시. 결정 매트릭스는 `_workspace/00_input.md §11`.
> Reference: `idea.md §6` 1~2주 차 랜딩 페이지 + 결제 + Supabase 첫날 연동, 3~4주 차 Reddit 트래픽, 5주차+ 구독 확장 → MVP 일정과 정렬.
> Owner: 1인 창업 (vibe coding). 부지런한 1인 기준 추정.

---

## 1. Phase별 목표

| Phase | 목표 | 포함 기능 | 기간 추정 |
|-------|------|----------|---------|
| **MVP (v0.1)** | 랜딩 + 인증 + 핵심 분석 + Dodo Payments + 무료 3회 모델이 라이브 | FR-1 ~ FR-12 (P0 전부) | **2 weeks** (idea.md §6 1~2주 차) |
| **v1.0** | Reddit 유입 + 이력 조회 + 계정 설정 + 알림 + 신고 트래킹 | + FR-13, FR-14, FR-15, FR-16, FR-17 | +2 weeks (idea.md §6 3~4주 차) |
| **v1.1 (Lean Growth)** | 사용량 분석 + 프롬프트 튜닝 + 환불/CS 운영 안정화 | 프롬프트 v2, Sentry 알람, CS 매크로 | +1~2 weeks (5주 차) |
| **v2.0** | Chrome Extension + i18n 시드 + Admin UI 1차 | FR-18, 일부 FR-19, FR-20 | DAU>500 도달 시 착수 (월 단위) |
| **v2.x** | Agency plan / Browser cache / Pro tier (gpt-4o) | FR-21, FR-22 | TBD |

## 2. 주간 작업 분해

### Week 1 — Foundation + Auth + Profile

| Day | 작업 | 담당 에이전트 |
|-----|------|--------------|
| 1 | Repo 부트스트랩 (Next.js + Tailwind + shadcn/ui + TypeScript), Supabase 프로젝트 생성, Vercel 연결 | devops + frontend |
| 2 | Supabase 스키마 마이그레이션(§spec/04) + RLS 정책 적용 + signup trigger (free 3 credits) | backend |
| 3 | Google OAuth + `/api/auth/callback` + Middleware (auth, rate limit stub) | backend + frontend |
| 4 | `/onboarding` UI + `/api/profile/extract` (OpenAI Structured Outputs) + `PUT /api/profile` | frontend + backend |
| 5 | Landing + Pricing 정적 페이지 + shadcn UI 키트 정렬 | frontend |
| 6 | E2E 스모크 (Playwright 1개): "signup → onboarding → save profile" | qa |
| 7 | 버그 픽스 + Vercel preview deploy 확인 | devops |

### Week 2 — Analyze + Payment + Go Live

| Day | 작업 | 담당 |
|-----|------|------|
| 8 | `lib/extractors/upwork.ts` v1 코드 적재 (spec/02 §3.3.1) + 골든 픽스처(`tests/fixtures/upwork-sample.txt`) + T1~T6 단위 테스트 | frontend + qa |
| 9 | `POST /api/analyze` 풀 구현 (Pre-check, Silent Retry x3, Deduct-on-Success) | backend |
| 10 | Rule Engine (`rules.ts`) + Score Engine (`score.ts`) + 시스템 프롬프트 v1 (`system_prompts` insert) | backend |
| 11 | Dashboard + Report Modal (Safe/Risk) | frontend |
| 12 | `/api/checkout` + Dodo Webhook (`payment.succeeded`, `subscription.active|renewed|cancelled`, `refund.succeeded`) + `dodo_events` 멱등성 (Standard Webhooks `webhook-id`) | backend |
| 13 | E2E 결제 시나리오 (Dodo test mode) + Out-of-credits banner + Pricing 카드 연결 | qa + frontend |
| 14 | Production 도메인 + Dodo live keys + Supabase backup 설정 + 런칭 | devops |

### Weeks 3-4 — Growth & Polish (v1.0)

| Week | 작업 |
|------|------|
| 3 | Analysis History 리스트 + `/analyses/[id]` + Account Settings + Dodo Customer Portal 링크 ([TBD] exact URL — Dodo docs 확인) |
| 3 | Email Notifications (Resend or Supabase SMTP) — Dodo 영수증 보조 / 만료 알림 |
| 4 | Public Landing SEO (sitemap, OG image), Reddit 댓글 템플릿용 공개 리포트 페이지 [TBD] |
| 4 | 신고 트래킹 — `is_reported` 모니터링 → 프롬프트 v2 튜닝 사이클 1회 |

### Week 5+ — Lean Growth (v1.1)

- Sentry 알람 룰 (`ERR_OPENAI_UPSTREAM` 임계치)
- 비용 모니터링 대시보드 (Supabase view: `analyses.input_tokens` 합산)
- 결제 → 구독 전환률 지표 화면 (Supabase SQL view + Notion에 수동 복붙)
- CS 매크로 답변 템플릿 (환불 FAQ, 사기 신고 후속 안내)

## 3. 칸반 보드 초안

### To Do (Backlog)

- [ ] FR-13 Analysis History page
- [ ] FR-14 Account Settings (Profile / Billing / Notifications tabs)
- [ ] FR-15 Email Notifications integration
- [ ] FR-16 Soft cap hit toast + banner copy
- [ ] FR-17 Public landing SEO + OG image
- [ ] FR-18 Chrome Extension scaffold (Manifest V3) — v2.0
- [ ] FR-19 i18n key extraction — v2.0
- [ ] FR-20 Admin UI — DAU>500 trigger
- [ ] FR-21 Team / Agency plan — v2.x
- [ ] FR-22 Job hash dedup cache — v2.x
- [ ] GDPR Data Export RPC — [TBD]
- [ ] Pro tier (`gpt-4o` switch) — v2.x

### In Progress (MVP Week 1-2)

- [ ] FR-1 Google OAuth
- [ ] FR-2 Profile Onboarding (extract + edit + save)
- [ ] FR-3 Paste & Analyze input
- [ ] FR-4 Quantitative Rule Engine
- [ ] FR-5 Qualitative LLM risk
- [ ] FR-6 Matching score (40/30/30)
- [ ] FR-7 Report Dashboard / Modal
- [ ] FR-8 Pre-check + Deduct-on-Success
- [ ] FR-9 Dodo Hosted Checkout (3 tiers)
- [ ] FR-10 Refund sync via webhook
- [ ] FR-11 Report scam endpoint
- [ ] FR-12 Pricing page

### Done (Acceptance criteria for MVP Done)

1. New user can sign up via Google in < 10s
2. New user gets 3 free credits visible in `/dashboard`
3. Onboarding extracts skills/years/rate/timezone with editable UI
4. Paste a real Upwork posting → see SAFE/WARNING/DANGER verdict + match score in < 6s (p95)
5. Dodo Hosted Checkout works for all 3 tiers in test mode
6. `refund.succeeded` triggers credit revocation
7. OpenAI failure 3x results in 0 credit deduction
8. RLS policies prevent cross-user data access (verified via second account)
9. Vercel + Supabase production env live with custom domain
10. Refund policy + Terms + Privacy linked from Pricing footer (taxes auto-handled by Dodo MoR — no extra UI)

## 4. 기술 부채 / 이후 결정 필요 항목

| # | 항목 | 분류 | 영향 | 결정 시점 |
|---|------|------|------|----------|
| TD-1 | `lib/extractors/upwork.ts` v1 (header/footer regex) 가 Upwork UI 변경 또는 비표준 페이지(검색결과/My Jobs) 복붙에 취약 — spec/02 §3.3.5 v2 트리거 명시(T1 통과율<95% or LLM 토큰 p95>4k 시 DOM-aware 또는 anchor-region segmentation으로 교체) | 안정성 | Medium (1차 코드 확정) | 출시 후 7일 모니터링 → 트리거 도달 시 v2 작업 |
| TD-2 | 동일 공고 재분석 시 중복 차감 | 비용/UX | Medium | v2.0 (`job_text_hash` 캐시) |
| TD-3 | `system_prompts` 활성 전환 시 zero-downtime 보장 | 운영 | Low | partial unique index로 1차 방어, 무중단 스위치 RPC는 v1.1 |
| TD-4 | Email Notifications 채널 선정 (Resend vs SMTP) | 인프라 | Medium | v1.0 시작 시점 |
| TD-5 | Sentry 도입 / 무료 tier 한계 | 관측성 | Medium | Week 2 마지막 날 |
| TD-6 | Vercel KV 무료 한도(30k commands/day) 초과 시 유료 플랜 전환 또는 Sliding Window 알고리즘으로 commands 절감 | 인프라 | Low | DAU>200 도달 시 |
| TD-7 | ~~Stripe Tax (EU VAT 자동 처리) 활성화~~ → **Dodo Payments MoR로 자동 처리, 종결됨** (2026-05-29 PIVOT-01) | 컴플라이언스 | — | (완료) |
| TD-7b | GDPR / DSAR 자동화 부재 | 컴플라이언스 | Low (글로벌이지만 SMB) | v1.1 |
| TD-8 | Admin UI 미존재 — 외부 인력 위임 불가 | 운영 | Low at MVP | DAU>500 시 착수 |
| TD-9 | Pro tier (gpt-4o) 가격 정책 미정 | 매출 | Low | v2.x |
| TD-10 | i18n string keyization (영어 raw → 키화) | 유지보수 | Low | v2.0 |

## 5. 리스크 / 미정 항목

- `[TBD]` 출시 후 첫 30일 OpenAI 실제 cost/analysis가 예측치($0.005)에 부합하는지 측정 → 가격 조정 트리거
- `[TBD]` Reddit r/upwork 운영 정책 위반 가능성 검증 (자체 PR 댓글)
- ~~`[TBD]` Stripe 결제 통화 — 전부 USD로 시작하되 EU VAT/Tax 자동 처리 옵션 활성화 여부~~ → **Dodo Payments MoR로 자동 처리, 종결** (2026-05-29 PIVOT-01)
- `[TBD]` Dodo Payments Customer Portal URL 형식 확인 — 미제공 시 support 이메일 안내로 대체
- `[TBD]` Dodo test mode / live mode 키 발급·전환 절차 (devops가 deploy guide §4에 placeholder 작성)
- `[TBD]` `gpt-4o-mini` 의 응답 latency p95 — 3초 SLO에 부합하는지 1주차에 측정
