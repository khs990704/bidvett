# DB 초안 — BidVett (Supabase / PostgreSQL 15)

> [PIVOT-01 rev2 — 2026-05-29] `stripe_events` → `dodo_events` 테이블 rename. `credit_ledger.stripe_event_id` → `dodo_event_id`, `subscriptions.stripe_*` 컬럼은 일반화하여 `dodo_customer_id` / `dodo_subscription_id` / `dodo_checkout_session_id`로 변경. 결정 매트릭스는 `_workspace/00_input.md §11`.
> Naming: snake_case
> Auth: Supabase `auth.users` (Google OAuth) — 모든 user-owned 테이블은 `user_id uuid references auth.users(id) on delete cascade`
> RLS: 모든 user-owned 테이블에 활성화 — 정책 예시는 §5
> Charset/Locale: UTF-8, en_US

---

## 1. 핵심 엔티티 목록

| Entity | 책임 | 카디널리티 (user 기준) |
|--------|------|---------------------|
| `auth.users` | Supabase 관리 — Google OAuth identity | 1 user = 1 row |
| `users_profile` | 매칭 스코어링용 정형화 프로필 (Q3-C) | 1:1 |
| `credit_ledger` | 크레딧 가산/차감 원장 (append-only 권장) | 1:N |
| `subscriptions` | 주간 패스 / 월 구독 활성 상태 | 1:N (활성은 보통 1) |
| `analyses` | 공고 분석 결과 기록 + 신고 플래그 | 1:N |
| `system_prompts` | 운영자가 직접 수정하는 프롬프트 버전 테이블 | 단일 테이블 (전역) |

부가적으로 `dodo_events` (Standard Webhooks 멱등성 보장용 이벤트 로그 — PK = `webhook-id` 헤더).

## 2. ERD

```mermaid
erDiagram
  AUTH_USERS ||--o| USERS_PROFILE : "has one"
  AUTH_USERS ||--o{ CREDIT_LEDGER : "has many"
  AUTH_USERS ||--o{ SUBSCRIPTIONS : "has many"
  AUTH_USERS ||--o{ ANALYSES : "has many"
  ANALYSES ||--o| CREDIT_LEDGER : "may produce ledger row"
  SUBSCRIPTIONS ||--o{ DODO_EVENTS : "originates from"
  CREDIT_LEDGER ||--o{ DODO_EVENTS : "originates from"

  AUTH_USERS {
    uuid id PK
    text email
    timestamptz created_at
  }
  USERS_PROFILE {
    uuid user_id PK_FK
    text[] skills
    int years_of_experience
    int target_hourly_rate
    text timezone
    text resume_text
    timestamptz created_at
    timestamptz updated_at
  }
  CREDIT_LEDGER {
    uuid id PK
    uuid user_id FK
    text type
    int delta
    int balance_after
    uuid analysis_id FK_nullable
    text dodo_event_id_nullable
    text note
    timestamptz created_at
  }
  SUBSCRIPTIONS {
    uuid id PK
    uuid user_id FK
    text plan
    text status
    timestamptz period_start
    timestamptz period_end
    int usage_count
    int soft_cap
    text dodo_customer_id
    text dodo_subscription_id_nullable
    text dodo_checkout_session_id_nullable
    timestamptz created_at
    timestamptz updated_at
  }
  ANALYSES {
    uuid id PK
    uuid user_id FK
    text job_text_hash
    text verdict
    bool backend_critical
    text[] backend_rules_triggered
    text ai_risk_level
    text[] contextual_red_flags
    int match_score_nullable
    text score_reason_nullable
    text action_tip_nullable
    jsonb extracted_signals
    int prompt_version
    int input_tokens
    int output_tokens
    int took_ms
    bool is_reported
    text report_reason_nullable
    timestamptz created_at
  }
  SYSTEM_PROMPTS {
    int version PK
    text name
    text content
    bool is_active
    timestamptz created_at
  }
  DODO_EVENTS {
    text id PK
    text type
    jsonb payload
    bool processed
    timestamptz received_at
    timestamptz processed_at_nullable
  }
```

## 3. 테이블 초안

### 3.1 `users_profile`

| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| `user_id` | uuid | PK, FK → auth.users.id, on delete cascade | Supabase Auth user 1:1 |
| `skills` | text[] | not null, default '{}' | LLM 추출 + 사용자 보정 (예: `{React,Node.js,TypeScript}`) |
| `years_of_experience` | int | not null, check (>= 0 and <= 60) | |
| `target_hourly_rate` | int | not null, check (>= 0 and <= 1000) | USD 시간당 정수 |
| `timezone` | text | not null | 예: `UTC+9`, `America/Los_Angeles` (자유 형식 허용) |
| `resume_text` | text | nullable | 원본 보존 (재추출용) |
| `created_at` | timestamptz | not null, default now() | |
| `updated_at` | timestamptz | not null, default now() | trigger로 갱신 |

### 3.2 `credit_ledger` (append-only)

| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| `id` | uuid | PK, default gen_random_uuid() | |
| `user_id` | uuid | not null, FK → auth.users.id | |
| `type` | text | not null, check in ('free_grant','purchase_single','consume','refund_reversal','admin_adjust') | |
| `delta` | int | not null | +N or -N |
| `balance_after` | int | not null, check (>= 0) | 트랜잭션 내 일관성 |
| `analysis_id` | uuid | nullable, FK → analyses.id | consume 시점 매핑 |
| `dodo_event_id` | text | nullable | Dodo Standard Webhooks `webhook-id` 헤더 — 멱등성용 |
| `note` | text | nullable | 운영 메모 |
| `created_at` | timestamptz | not null, default now() | |

- `type = consume` 행은 `analysis_id`를 반드시 채운다 (Deduct-on-Success).
- `type = purchase_single`은 `$0.99 = +1` 기록.
- 트랜잭션 절차: `SELECT ... FOR UPDATE` on latest balance row → insert new row.

### 3.3 `subscriptions`

| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| `id` | uuid | PK, default gen_random_uuid() | |
| `user_id` | uuid | not null, FK → auth.users.id | |
| `plan` | text | not null, check in ('weekly_pass','monthly_sub') | |
| `status` | text | not null, check in ('active','expired','canceled','refunded') | |
| `period_start` | timestamptz | not null | |
| `period_end` | timestamptz | not null | weekly_pass: +7d, monthly_sub: +30d |
| `usage_count` | int | not null, default 0 | 현재 기간 사용 횟수 |
| `soft_cap` | int | not null | weekly=100, monthly=500 |
| `dodo_customer_id` | text | not null | Dodo Payments customer 식별자 |
| `dodo_subscription_id` | text | nullable | weekly_pass/monthly_sub — Dodo subscription 식별자 |
| `dodo_checkout_session_id` | text | nullable | Hosted Checkout session 식별자 |
| `created_at` | timestamptz | not null, default now() | |
| `updated_at` | timestamptz | not null, default now() | trigger |

- 사용자별 활성(`status='active' AND period_end > now()`) 행은 0 또는 1을 기대 (앱 레벨 단언). 동시성 위한 partial unique index 권장 (§4).

### 3.4 `analyses`

| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| `id` | uuid | PK, default gen_random_uuid() | |
| `user_id` | uuid | not null, FK → auth.users.id | |
| `job_text_hash` | text | not null | sha256 of cleaned input — 향후 중복 캐시용 |
| `verdict` | text | not null, check in ('SHOW_REPORT','DO_NOT_APPLY') | |
| `backend_critical` | bool | not null | |
| `backend_rules_triggered` | text[] | not null, default '{}' | 예: `{LOW_HIRE_RATE,PAYMENT_UNVERIFIED_ZERO_SPEND,LOW_RATING}` |
| `ai_risk_level` | text | not null, check in ('SAFE','WARNING','DANGER') | |
| `contextual_red_flags` | text[] | not null, default '{}' | |
| `match_score` | int | nullable, check (>=0 and <=100) | DANGER/DO_NOT_APPLY 시 null 허용 (LLM은 0~100, 외부 응답 시 마스킹) |
| `score_reason` | text | nullable | |
| `action_tip` | text | nullable | |
| `extracted_signals` | jsonb | not null | `{client_hire_rate:int 0-100, payment_verified:bool, total_spend_amount:int USD, client_rating:float 0-5}` — `analyze.v1` 프롬프트 출력과 1:1 매핑 (spec/03 §7) |
| `prompt_version` | int | not null | system_prompts.version FK [가정] |
| `input_tokens` | int | not null, default 0 | 비용 추적 |
| `output_tokens` | int | not null, default 0 | 비용 추적 |
| `took_ms` | int | not null | 응답 지연 추적 |
| `is_reported` | bool | not null, default false | Q4 신고 플래그 |
| `report_reason` | text | nullable | |
| `created_at` | timestamptz | not null, default now() | |

### 3.5 `system_prompts`

| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| `version` | int | PK, generated by default as identity | 버전 번호 (1, 2, 3...) |
| `name` | text | not null | 예: `analyze.v1`, `profile_extract.v1` |
| `content` | text | not null | 시스템 프롬프트 본문 (영어) |
| `is_active` | bool | not null, default false | 운영자가 Supabase Browser에서 토글 |
| `created_at` | timestamptz | not null, default now() | |

- 운영 룰: 동일 `name` 그룹 내에서 `is_active=true`인 row가 최대 1개여야 함 → partial unique index.

#### Seed data (MVP 배포 시 삽입)

| `name` | `version` | `is_active` | `content` 출처 |
|--------|-----------|-------------|---------------|
| `analyze.v1` | 1 | true | `spec/03_api_preview.md` §7 (full body) — 배포 시 그대로 복사 적재 |
| `profile_extract.v1` | 1 | true | `[TBD]` — Profile 추출용 시스템 프롬프트 본문은 미확정. `_workspace/` 단계에서 작성 후 동일 형식으로 삽입 |

> 코드 하드코딩 금지. 백엔드 `lib/openai/prompts.ts`는 `system_prompts` 테이블에서 `is_active=true` row만 로드한다.

### 3.6 `dodo_events` (멱등성)

| 컬럼 | 타입 | 제약 | 설명 |
|------|------|------|------|
| `id` | text | PK | Dodo Standard Webhooks `webhook-id` 헤더 값 (이벤트별 고유) |
| `type` | text | not null | `payment.succeeded` / `subscription.active` / `subscription.renewed` / `subscription.cancelled` / `refund.succeeded` 등 |
| `payload` | jsonb | not null | raw event body |
| `processed` | bool | not null, default false | |
| `received_at` | timestamptz | not null, default now() | |
| `processed_at` | timestamptz | nullable | |

## 4. 인덱스 전략 초안

| 테이블 | 인덱스 | 컬럼 | 용도 |
|--------|--------|------|------|
| `credit_ledger` | btree | `(user_id, created_at desc)` | 잔액 조회/이력 |
| `credit_ledger` | unique | `(dodo_event_id)` where dodo_event_id is not null | Webhook 멱등성 |
| `subscriptions` | btree | `(user_id, status)` | 활성 subscription lookup |
| `subscriptions` | partial unique | `(user_id) WHERE status='active'` | 사용자당 활성 1개 강제 |
| `analyses` | btree | `(user_id, created_at desc)` | 이력 리스트 (cursor pagination) |
| `analyses` | btree | `(is_reported)` where is_reported=true | 운영자 신고 모니터링 |
| `analyses` | btree | `(job_text_hash, user_id)` | 동일 공고 중복 분석 캐시 [TBD v2] |
| `system_prompts` | partial unique | `(name) WHERE is_active=true` | active 1개 강제 |
| `dodo_events` | btree | `(received_at desc)` | 운영 모니터링 |

## 5. RLS (Row Level Security) 정책 예시

모든 user-owned 테이블에 다음 패턴을 적용:

```sql
-- users_profile
alter table users_profile enable row level security;

create policy "users_profile_select_own"
  on users_profile for select
  using (auth.uid() = user_id);

create policy "users_profile_upsert_own"
  on users_profile for insert
  with check (auth.uid() = user_id);

create policy "users_profile_update_own"
  on users_profile for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
```

- `credit_ledger`, `subscriptions`, `analyses`: `select`만 사용자 본인, `insert/update/delete`는 **service_role** 키만 (Webhook/Server actions에서 처리)
- `system_prompts`: 모든 사용자에게 RLS deny — service_role만 접근. 운영자는 Supabase Data Browser에서 service_role 모드로 직접 편집.
- `dodo_events`: service_role 전용.

## 6. 트리거 / 함수 (요지)

- `update_timestamp_trigger`: 모든 테이블의 `updated_at` 자동 갱신
- `consume_credit(user_id, analysis_id)` (RPC, security definer): 트랜잭션 내에서
  1. 활성 subscription/pass가 있고 soft_cap 안이면 `usage_count++`
  2. 아니면 latest balance > 0 일 때 `credit_ledger`에 `(type=consume, delta=-1)` insert
  3. 둘 다 불가하면 throw → 호출자가 402 반환
- `grant_free_credits_on_signup`: `auth.users` insert trigger로 신규 가입자에게 `(type=free_grant, delta=+5, balance_after=5)` 한 줄 자동 삽입

## 7. 가정 / 미정

- `[가정]` `analyses.prompt_version`은 `system_prompts.version`을 참조하지만 FK는 걸지 않음 (운영자 행 삭제 시 이력 보존을 위해).
- `[가정]` 동일 공고 중복 분석 캐시는 v2 이후 도입 — `job_text_hash` 필드는 미리 채워둠.
- `[TBD]` `analyses.cost_usd`(numeric) 컬럼 추가 여부 — 현재는 `input_tokens`/`output_tokens`로 후처리.
- `[TBD]` GDPR Data Export RPC 함수 정의.
