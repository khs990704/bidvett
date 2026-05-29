# 05_deploy_guide.md — ConnectSaver 배포 가이드 (확정본)

> 상위 문서: `_workspace/00_input.md`, `_workspace/01_architecture.md`, `_workspace/03_db_schema.md`
> 초안 출처: `spec/02_architecture_preview.md §8`, `spec/06_milestones.md`
> 본 문서는 MVP 첫 배포부터 운영 루틴, 롤백, 의도적 deferred 결정까지를 단일 문서로 정리한다.
> 상충 시 우선순위: **본 문서 > spec/02 §8 > spec/06**.

---

## 0. 배포 토폴로지 한 장 요약

```mermaid
graph LR
  Dev["Developer<br/>(local)"] -->|git push| GH["GitHub<br/>main branch"]
  GH -->|webhook| GA["GitHub Actions<br/>(lint / typecheck / test / build)"]
  GH -->|webhook| V["Vercel<br/>(iad1 / us-east-1)"]
  V --> NX["Next.js Serverless<br/>(RSC + Route Handlers)"]
  V --> KV[("Vercel KV<br/>(Upstash Redis)")]
  NX --> SB[("Supabase Cloud<br/>(Postgres 15 + Auth + RLS)")]
  NX --> OAI["OpenAI API<br/>(gpt-4o-mini)"]
  NX --> ST["Stripe<br/>(Checkout + Webhooks)"]
  ST -->|Webhook signed| NX
  NX --> SE["Sentry<br/>(v1.0+, deferred at MVP cutover)"]
```

| 항목 | 값 | 출처 |
|------|---|------|
| Vercel region | `iad1` (us-east-1) | Supabase 권장 리전과 동일 → cross-region latency 최소화 |
| Supabase region | `us-east-1` (N. Virginia) | iad1 동일 PoP. 글로벌 타겟이지만 Vercel Edge 캐싱이 정적 자산을 분산 처리 |
| `/api/analyze` maxDuration | 30s | Silent Retry x3 최대 시간(약 1.9s) + OpenAI tail latency p99 < 10s 대비 안전 마진 |
| Stripe mode | test → live (Week 2 Day 14) | spec/06 Week 2 |

---

## 1. 사전 준비 (T-7 days)

### 1.1 외부 계정 발급 체크리스트

| # | 항목 | 발급처 | 비고 |
|---|------|-------|------|
| 1 | **GitHub repo** | `github.com/<owner>/connectsaver` (private OK) | Vercel/Supabase OAuth가 이 repo에 권한 필요 |
| 2 | **Vercel 계정** | https://vercel.com/signup → GitHub 연동 | Hobby plan 시작 (Pro $20/mo는 Week 3+ 트래픽 검토 후) |
| 3 | **Supabase 프로젝트** | https://supabase.com/dashboard → "New project" | DB password는 1password 등에 보관 |
| 4 | **OpenAI API key** | https://platform.openai.com/api-keys → "Create new secret key" (제목: `connectsaver-prod`) | Soft limit / hard limit은 §6.3 참조 |
| 5 | **Stripe 계정 (test mode)** | https://dashboard.stripe.com/register → 이메일 인증 → test mode 자동 활성 | live mode 활성은 Week 2 Day 14에 별도 절차 |
| 6 | **Google Cloud OAuth client** | https://console.cloud.google.com → APIs & Services → Credentials → "OAuth client ID" | §2.2 단계별 |
| 7 | **도메인** (선택) | Cloudflare/Namecheap/Gandi 중 택1 | MVP는 Vercel 기본 도메인(`connectsaver.vercel.app`)으로 충분 |

### 1.2 Google Cloud OAuth 클라이언트 발급 (5분)

1. Google Cloud Console → 프로젝트 생성 (이름: `ConnectSaver`).
2. APIs & Services → **OAuth consent screen** → User Type: `External` → Save.
   - App name: `ConnectSaver`
   - User support email: 본인
   - Authorized domains: `supabase.co` (Supabase Auth가 redirect를 호스팅)
   - Scopes: `email`, `profile`, `openid` (기본)
3. **Credentials** → Create Credentials → **OAuth client ID** → Application type: `Web application`.
   - Authorized JavaScript origins: `https://<your-project>.supabase.co`
   - Authorized redirect URIs: `https://<your-project>.supabase.co/auth/v1/callback`
4. 생성된 **Client ID**, **Client secret**을 복사 → §2.2로.
5. Publishing status: `Testing` 상태로 두면 100명 한도. v1.0 트래픽 진입 시 `In production`으로 전환 (Verification 필요할 수 있음).

---

## 2. Supabase 셋업

### 2.1 프로젝트 생성

1. https://supabase.com/dashboard → **New project**
2. Name: `connectsaver-prod` (또는 `connectsaver-dev`)
3. Database Password: 16자 이상 랜덤 (1password 보관)
4. **Region: `us-east-1` (N. Virginia)** — Vercel `iad1`과 동일 PoP. 글로벌 타겟이지만 가장 큰 LLM/결제 비중을 차지하는 미국 시장 응답을 최적화.
5. Pricing Plan: **Free** (8GB DB / 50MB file storage / 50K MAU로 시작 충분). v1.1 MAU > 30K 도달 시 Pro($25/mo).

### 2.2 Google OAuth provider 설정

1. Supabase Dashboard → **Authentication** → **Providers** → **Google** → Enable.
2. Client ID / Client secret: §1.2에서 발급한 값 붙여넣기.
3. **Authorized Client IDs**: 동일 Client ID 한 번 더 입력 (Web flow 확인용).
4. Save. Redirect URL이 `https://<project>.supabase.co/auth/v1/callback` 형태인지 확인 → Google Cloud Console의 Redirect URIs와 정확히 일치하는지 재확인.
5. **Site URL** 설정: Authentication → URL Configuration → Site URL = `https://<vercel-domain>` (또는 로컬은 `http://localhost:3000`). Additional Redirect URLs에 `https://*.vercel.app` 추가하면 Preview Deploy에서도 OAuth 동작.

### 2.3 마이그레이션 적용 (`supabase/migrations/0001~0004.sql`)

**방법 A — Supabase CLI (권장)**:

```bash
# 1) Supabase CLI 설치 (macOS)
brew install supabase/tap/supabase

# 2) 로그인
supabase login

# 3) 프로젝트 링크
cd /Users/heesubkim/project/bidvett
supabase link --project-ref <your-project-ref>
# project-ref는 Supabase Dashboard URL의 .../project/<ref>/... 부분

# 4) 마이그레이션 push (0001~0004 순서 자동)
supabase db push

# 5) 적용 확인
supabase db diff   # 비어 있어야 함
```

**방법 B — Supabase Studio SQL Editor (CLI 없이)**:

1. Dashboard → **SQL Editor** → New query
2. `supabase/migrations/0001_init_schema.sql` 전체 복사 → Run
3. 동일 절차로 `0002_rls_policies.sql`, `0003_triggers_and_rpc.sql`, `0004_seed_system_prompts.sql` 순서대로 실행
4. 실패 시 트랜잭션 자체가 롤백되므로 안전. 단 0001→0002→0003→0004 순서를 어기면 의존성 에러.

### 2.4 RLS 활성화 확인 체크리스트

Dashboard → **Authentication** → **Policies**에서 다음 6개 테이블이 모두 `RLS enabled` (자물쇠 아이콘)인지 확인:

- [ ] `public.users_profile` — 3 policies (`select_own`, `insert_own`, `update_own`)
- [ ] `public.credit_ledger` — 1 policy (`select_own` only; INSERT/UPDATE는 service_role)
- [ ] `public.subscriptions` — 1 policy (`select_own` only)
- [ ] `public.analyses` — 2 policies (`select_own`, `update_report_own`)
- [ ] `public.system_prompts` — 0 policies (deny by default; service_role only)
- [ ] `public.stripe_events` — 0 policies (deny by default; service_role only)

**검증 쿼리** (Authenticated 모드로 로그인 한 user JWT 사용):

```sql
-- 다른 user_id의 row를 SELECT 시도 → 0 rows 반환되어야 정상
SELECT * FROM public.credit_ledger WHERE user_id <> auth.uid();
```

### 2.5 신규 가입자 트리거 동작 확인

1. SQL Editor → `SELECT * FROM auth.users LIMIT 1;` 으로 가입자 1명 존재 확인 (없으면 §5 smoke test에서 가입 후 재확인).
2. `SELECT * FROM public.credit_ledger WHERE user_id = '<uid>';` → `type='free_grant', delta=3, balance_after=3` row 존재해야 함.

---

## 3. Vercel 셋업

### 3.1 프로젝트 생성 / GitHub 연결

1. https://vercel.com/new → "Import Git Repository" → `connectsaver` repo 선택.
2. Framework Preset: `Next.js` 자동 인식.
3. Root Directory: `.` (모노레포 아님 — 루트가 곧 Next.js 앱).
4. Build Command / Output Directory: 기본값 (`next build` / `.next`).
5. **첫 deploy 직전 환경변수 등록 먼저** (§3.3) → 등록 후 "Deploy" 버튼.

### 3.2 Vercel KV 프로비저닝

1. 프로젝트 페이지 → **Storage** 탭 → **Create Database** → **KV** 선택.
2. Name: `connectsaver-kv`, Region: **iad1** (앱과 동일).
3. **"Connect Project"** → connectsaver 프로젝트 선택 → 모든 환경 (Production/Preview/Development) 체크.
4. 자동 주입 환경변수 (Vercel이 시크릿으로 등록):
   - `KV_URL`
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN` (read-write)
   - `KV_REST_API_READ_ONLY_TOKEN`

**왜 `KV_REST_API_READ_ONLY_TOKEN`이 별도인가?** Server-only로 사용하는 한 read-only 토큰이 굳이 필요해 보이지 않지만, 다음 두 가지 안전망을 위해 분리 유지한다:
1. 향후 RSC에서 카운터를 단순 표시(예: 일일 호출 잔여)할 때 mutate 권한 없는 토큰만 import하면 코드 실수로 인한 INCR 사고를 컴파일 타임에 차단할 수 있다.
2. Vercel이 자동 주입하므로 `KV_REST_API_TOKEN`만 쓰더라도 비용 0 — 보관 자체에 패널티 없음.

### 3.3 환경변수 등록 — 환경별 매트릭스

Vercel Dashboard → 프로젝트 → **Settings** → **Environment Variables**.

| 변수 | Development | Preview | Production | 노출 | 비고 |
|------|-------------|---------|------------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | (local Supabase or staging) | staging | prod | Client | 동일 값이면 single env 가능 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | ✓ | ✓ | Client | |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | ✓ | ✓ | Server | Sensitive 체크 |
| `OPENAI_API_KEY` | dev key | prod key (test usage cap) | prod key | Server | Dev/Preview는 monthly hard limit $20 |
| `STRIPE_SECRET_KEY` | `sk_test_...` | `sk_test_...` | `sk_live_...` (Day 14) | Server | live key는 Day 14 swap |
| `STRIPE_WEBHOOK_SECRET` | (Stripe CLI listen) | test webhook secret | live webhook secret | Server | 각 환경 endpoint마다 다름 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` | `pk_test_...` | `pk_live_...` | Client | |
| `NEXT_PUBLIC_STRIPE_PRICE_SINGLE` | test price_id | test price_id | live price_id | Client | `scripts/seed-stripe.ts` 출력 |
| `NEXT_PUBLIC_STRIPE_PRICE_WEEKLY` | ✓ | ✓ | ✓ | Client | |
| `NEXT_PUBLIC_STRIPE_PRICE_MONTHLY` | ✓ | ✓ | ✓ | Client | |
| `KV_URL` | (auto) | (auto) | (auto) | Server | KV 연결 시 자동 주입 |
| `KV_REST_API_URL` | (auto) | (auto) | (auto) | Server | 자동 |
| `KV_REST_API_TOKEN` | (auto) | (auto) | (auto) | Server | 자동 |
| `KV_REST_API_READ_ONLY_TOKEN` | (auto) | (auto) | (auto) | Server | 자동 |
| `SENTRY_DSN` | (empty until v1.0) | (empty) | (set on v1.0 launch) | Server | `[deferred]` §6.2 |
| `NEXT_PUBLIC_SENTRY_DSN` | (empty) | (empty) | (set on v1.0) | Client | 동일 값 |
| `SYSTEM_PROMPT_VERSION` | `1` | `1` | `1` | Server | DB 조회 실패 시 폴백 |
| `NEXT_PUBLIC_APP_URL` | `http://localhost:3000` | `https://*.vercel.app` | `https://app.connectsaver.com` | Client | OAuth redirect + Stripe success_url |

**등록 절차**: 변수 하나씩 Add → Value 입력 → 환경 체크박스 선택 (Production / Preview / Development) → Save. 일괄 등록은 Vercel CLI로:

```bash
vercel env add OPENAI_API_KEY production
# stdin으로 값 입력
```

> spec/02 §8 대비 추가/변경: spec/02 §8에는 `NEXT_PUBLIC_STRIPE_PRICE_SINGLE/WEEKLY/MONTHLY`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SENTRY_DSN`이 명시되지 않았으나 `_workspace/01_architecture.md §10`에서 모두 도입 확정됨. **본 가이드는 §10 표가 단일 출처**이며 spec/02 §8보다 우선.

### 3.4 도메인 연결 (Day 14, 선택)

1. Vercel Dashboard → Settings → **Domains** → Add `app.connectsaver.com` (또는 보유 도메인).
2. DNS provider (Cloudflare 등)에서 CNAME `cname.vercel-dns.com` 추가.
3. Vercel이 자동 SSL (Let's Encrypt) 발급 — 평균 30초.
4. **Supabase Site URL과 Google OAuth Redirect URI를 도메인으로 업데이트** (§2.2 4번 항목). 누락 시 OAuth 콜백 실패.
5. **Stripe Webhook endpoint URL도 업데이트** (§4.2 4번 항목).

---

## 4. Stripe 셋업

### 4.1 Product / Price 생성 — 스크립트 1회 실행

`supabase/migrations/` 외 별도 1회용 스크립트로 처리. `_workspace/03_db_schema.md §6.2` 그대로:

```bash
# 1) Stripe test mode secret key 발급: Dashboard > Developers > API keys
export STRIPE_SECRET_KEY="sk_test_..."

# 2) tsx 글로벌 미설치 시: pnpm dlx tsx scripts/seed-stripe.ts
pnpm dlx tsx scripts/seed-stripe.ts
```

출력 예시:

```text
Set these in Vercel Env Vars:
NEXT_PUBLIC_STRIPE_PRICE_SINGLE= price_1Q...
NEXT_PUBLIC_STRIPE_PRICE_WEEKLY= price_1Q...
NEXT_PUBLIC_STRIPE_PRICE_MONTHLY= price_1Q...
```

→ Vercel Env Vars (§3.3)에 그대로 주입. **테스트 모드와 라이브 모드의 Price ID는 다르므로 Day 14 live 전환 시 본 스크립트를 live key로 재실행 후 Production env만 갱신**.

| Nickname | unit_amount | currency | recurring | 매핑 plan |
|----------|-------------|----------|-----------|----------|
| `credit_single` | 99 ($0.99) | usd | — (one-time) | `single` |
| `weekly_pass` | 499 ($4.99) | usd | — (one-time) | `weekly_pass` (앱이 7일 만료를 처리) |
| `monthly_sub` | 1900 ($19) | usd | `interval: month` | `monthly_sub` |

> **Note on `weekly_pass`**: Stripe Recurring에 `interval: week`도 가능하지만 idea_inquiry §Q2에서 "7일 주간 무제한"으로 확정 → `customer.subscription.*` 이벤트 라이프사이클 대신 단순 one-time 결제 + 앱이 `period_end = checkout_at + 7 days`를 계산하는 모델. `subscriptions.plan='weekly_pass'`는 status='expired' 자연 만료 (재구매가 새 row). spec/02 §3, _workspace/01_architecture.md §6.7과 일치.

### 4.2 Webhook 엔드포인트 등록

1. Stripe Dashboard → **Developers** → **Webhooks** → **Add endpoint**.
2. Endpoint URL:
   - Test mode: `https://<vercel-preview-url>/api/webhooks/stripe`
   - Live mode (Day 14): `https://app.connectsaver.com/api/webhooks/stripe`
3. **Events to send** — 다음 6개만 선택:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `charge.refunded`
4. Endpoint 생성 후 **Signing secret** (`whsec_...`) 복사 → Vercel env `STRIPE_WEBHOOK_SECRET`.
5. **Test / Live 두 endpoint 별도 운영** — signing secret도 별도. Live 전환 시 production env만 swap.

> **왜 `customer.subscription.created`/`updated`도 받는가?** spec/02 §3에서는 `checkout.session.completed`만 명시했지만, monthly_sub의 경우 Stripe가 결제 후 비동기로 subscription 객체를 생성하는 race가 존재. `created`/`updated` 이벤트로 `subscriptions` row의 `stripe_subscription_id`를 보강 + `period_end` 동기화. `_workspace/01_architecture.md §6.7`과 일치.

### 4.3 Webhook signing secret 보안 검증

배포 직후 다음 명령으로 signature 검증 실패 동작 확인:

```bash
curl -X POST https://<vercel-domain>/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{"id":"evt_test"}'
# → HTTP 400, body: {"error":"ERR_WEBHOOK_SIGNATURE"} 가 정상
```

### 4.4 Stripe Tax — **MVP는 OFF, v1.1로 deferred**

- **이유**: Stripe Tax는 거래액의 약 0.5% 추가 수수료 + EU/US 주별 세무 등록(자동 처리 옵션 사용 시) 필요. MVP 사용자 0명 시점에 활성화 = 매출 0 대비 운영 복잡도 증가.
- **트리거 조건**: **EU 사용자 결제 누적 5건** 도달 또는 미국 매출이 $20K(연환산 California 등록 임계치)에 근접 시.
- **활성화 시 절차** (v1.1):
  1. Dashboard → Tax → Get started → automatic tax 활성화.
  2. Stripe Checkout `tax_behavior: 'exclusive'` 설정 (코드 1줄 추가).
  3. `scripts/seed-stripe.ts`에 `tax_code: 'txcd_10103000'` (SaaS 기준) 추가 + 재실행.
  4. Pricing 페이지에 "Taxes calculated at checkout" 카피 추가 (frontend).
- 자세한 결정 근거: `_workspace/01_architecture.md §0` 변경 메모, spec/06 §5 `[TBD]` 4번 항목.

---

## 5. 첫 배포 절차 (Week 1 Day 7 → Week 2 Day 14)

### 5.1 main 브랜치 push → Vercel 자동 빌드

```bash
git checkout -b feat/initial-deploy
git add .
git commit -m "feat: initial deploy scaffolding"
git push -u origin feat/initial-deploy
# Vercel가 Preview Deploy 자동 생성 → PR에 코멘트로 URL 게시
# 검증 후 main으로 merge → Production Deploy 자동 트리거
```

빌드 중 콘솔 출력에서 다음 항목 확인:
- `✓ Compiled successfully`
- `✓ Generating static pages` — Landing, Pricing, Login 등 정적 라우트
- `λ Server Functions` — `/api/*` 모두 표시
- ⚠ 빌드 경고가 있다면 fail로 간주하지 말되 issue 발급

### 5.2 환경변수 검증 (배포 직후)

```bash
# Vercel CLI로 production env 인벤토리 확인
vercel env ls production

# 다음 17개가 모두 존재해야 함 (KV 자동주입 4개 포함)
# NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# NEXT_PUBLIC_APP_URL, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
# NEXT_PUBLIC_STRIPE_PRICE_SINGLE/WEEKLY/MONTHLY,
# NEXT_PUBLIC_SENTRY_DSN (empty OK at MVP),
# SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY,
# STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
# KV_URL, KV_REST_API_URL, KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN,
# SENTRY_DSN (empty OK), SYSTEM_PROMPT_VERSION
```

### 5.3 Smoke Test 체크리스트 (Day 14 launch 전 필수)

| # | 시나리오 | 기대 결과 | 검증 위치 |
|---|---------|----------|----------|
| 1 | `https://<domain>/` 접근 | 200 + Landing 페이지 | Browser |
| 2 | `/login` → Google OAuth 클릭 → Google 동의 화면 → redirect 성공 | `/dashboard`로 이동, 잔여 크레딧 3 표시 | Browser + Supabase Auth Logs |
| 3 | `auth.users` row 생성 직후 `credit_ledger`에 `free_grant +3` row 존재 | row 1개 | Supabase SQL Editor |
| 4 | `/onboarding`에서 이력서 paste → Extract → 4 필드 prefill → Save | `users_profile` row upsert 성공 | Supabase Data Browser |
| 5 | `/dashboard`에서 골든 픽스처(`tests/fixtures/upwork-sample.txt`) paste → Analyze | 6초 이내 SAFE/WARNING/DANGER + match_score 표시, 크레딧 잔여 2 | Browser + Vercel Logs |
| 6 | `analyses` row insert 확인 + `credit_ledger`에 `consume -1, balance_after=2` row | row 각 1개 | Supabase SQL Editor |
| 7 | Pricing → "Buy single $0.99" → Stripe Checkout → test card `4242 4242 4242 4242` 결제 | `/dashboard?status=success`로 redirect, 크레딧 +1 = 3 | Browser + Stripe Dashboard |
| 8 | `stripe_events` table에 event row + `processed=true` | row 1개 | Supabase SQL Editor |
| 9 | Stripe Dashboard에서 해당 charge `[Refund]` (full refund) → 30초 대기 | `credit_ledger`에 `refund_reversal -1, balance_after=2` row | Supabase + Browser dashboard |
| 10 | 두 번째 Google 계정으로 로그인 후 첫 계정의 `/analyses/<id>` URL 접근 | 404 (RLS 차단) | Browser |
| 11 | Rate limit: `/api/analyze` 60회 1분 내 호출 | 61번째 요청 429 `ERR_RATE_LIMITED` | curl + Vercel KV Inspector |
| 12 | OpenAI key 일시 무효화 후 Analyze 시도 | 3회 retry 후 502 `ERR_OPENAI_UPSTREAM` + 크레딧 차감 0 | Vercel Logs + Supabase (no consume row) |

12개 모두 통과 시 launch GO. 1개라도 실패 시 launch HOLD + 원인 fix → 본 체크리스트 처음부터.

---

## 6. 운영 모니터링

### 6.1 일상 관측 지점

| 영역 | 도구 | 무엇을 보나 | 빈도 |
|------|------|------------|------|
| 앱 로그 | **Vercel Logs** (Dashboard → Logs) | Runtime errors, slow functions (>3s), 429/5xx 비율 | 일 1회 / 알람 즉시 |
| DB | **Supabase Logs** (Dashboard → Logs) | Auth 실패, RLS 위반 시도, slow queries (>500ms), connection pool 사용률 | 일 1회 |
| Auth | Supabase Dashboard → Authentication → Users | 신규 가입자 수, 로그인 실패율 | 일 1회 |
| 결제 | **Stripe Dashboard** | 매출, 환불, 실패 결제, webhook 실패 | 일 1회 |
| KV 사용량 | Vercel Storage → KV → Metrics | commands/day (Hobby 30K limit), latency | 주 1회 |
| OpenAI 비용 | platform.openai.com → Usage | tokens/day, USD/day | 일 1회 (§6.3 알람) |

### 6.2 Sentry — **MVP는 미도입, v1.0 진입(Week 3) 시 도입**

- **이유**: MVP DAU < 50 추정 → Vercel Logs로 충분. Sentry 추가 시 init/setup 0.5일 + breadcrumb 코드 작성 1일 추가 부담.
- **트리거 조건**: **MVP launch 후 7일 모니터링 중 `ERR_OPENAI_UPSTREAM` 발생 또는 5xx 비율 > 0.5%** 도달 시. spec/06 TD-5와 일치.
- **도입 시 절차** (v1.0 Week 3, 약 2시간):
  1. https://sentry.io → Create project → Next.js → DSN 복사.
  2. `pnpm add @sentry/nextjs` → `pnpm dlx @sentry/wizard@latest -i nextjs` (자동 instrumentation.ts/sentry.client.config.ts 생성).
  3. Vercel env `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`에 동일 값 등록.
  4. `_workspace/01_architecture.md §8.1` Silent Retry breadcrumb 코드 활성화 (이미 lib/openai/client.ts에 작성됨).
  5. Sentry → Alerts → Create alert: `ERR_OPENAI_UPSTREAM` 10건/1h 임계 → 이메일.
- Free tier (5K errors/month, 1 user)로 시작 충분. DAU > 500 시 Team plan($26/mo) 검토.

### 6.3 OpenAI 비용 알람 — **MVP에서 즉시 설정**

OpenAI Dashboard → **Settings** → **Limits** → **Usage limits**:

| 항목 | 값 | 사유 |
|------|---|------|
| **Soft limit** | $50/month | 도달 시 등록 이메일로 경고. 정상 launch 트래픽이면 도달 안 함. |
| **Hard limit** | $200/month | 도달 시 API 호출 차단 → 비용 폭주 사고 차단. MVP 100명 × 1회/day × $0.003 = $9/mo 추정 대비 안전 마진 20배. |
| **Daily email** | ✅ on | platform.openai.com → Settings → Notifications |

추가로 앱 측 KV counter `cost:daily:{user_id}` (TTL 24h) — `_workspace/01_architecture.md §8.3` — 가 per-user 일일 호출을 `min(soft_cap, 200)`회로 제한 → OpenAI 측 알람과 이중 방어.

### 6.4 일일 운영 루틴 (15분 / 일)

매일 아침 1회:

1. **Vercel Logs** → 직전 24h 5xx/4xx 카운트 시각 확인. 5xx > 10건이면 stack trace 1건 무작위 샘플.
2. **Supabase Data Browser** → `analyses` 테이블 → 필터 `is_reported = true` → 신규 신고 분석 1건씩 클릭하여 `report_reason` 확인 → 패턴 발견 시 Notion에 누적 → 5건 누적 시 시스템 프롬프트 v2 튜닝 사이클 트리거 (spec/06 §2 Week 4와 일치).
3. **Supabase Data Browser** → `auth.users` 정렬 `created_at desc` → 직전 24h 신규 가입자 수 카운트 → Notion에 일자별 추이 기록.
4. **Supabase SQL Editor** — 크레딧 분포 1줄 쿼리:
   ```sql
   SELECT
     COUNT(*) FILTER (WHERE balance >= 1) AS active_users,
     COUNT(*) FILTER (WHERE balance = 0)  AS depleted_users,
     AVG(balance)::numeric(10,2) AS avg_balance
   FROM (
     SELECT DISTINCT ON (user_id) user_id, balance_after AS balance
       FROM public.credit_ledger
      ORDER BY user_id, created_at DESC
   ) t;
   ```
5. **Stripe Dashboard** → 직전 24h 신규 매출 + 환불 카운트. 환불 발생 시 webhook이 `credit_ledger`에 `refund_reversal` 기록했는지 cross-check.

### 6.5 알람 임계 (MVP)

| 알람 | 임계 | 채널 | 액션 |
|------|------|------|------|
| OpenAI hard limit 90% | $180/mo | OpenAI email | 코드 리뷰: 무한 retry 루프? Pricing 조정? |
| Vercel build 실패 | 1건 | GitHub Actions PR check | 즉시 fix or revert |
| Stripe webhook 실패 (Dashboard 알람) | 1건 | Stripe email | endpoint URL/secret 확인. signature 실패는 §4.3 검증 재실행 |
| Supabase egress > 5GB/일 | (Pro tier 진입) | Supabase email | abuse user 확인. 1 user에 분석 1만건? |

---

## 7. 롤백 절차

### 7.1 코드 롤백 (Vercel Promote Previous Deployment)

가장 빠르고 안전. **앱 다운타임 < 30초**.

1. Vercel Dashboard → Deployments → **Production** 탭.
2. 직전 정상 deployment 클릭 → **"..." 메뉴 → Promote to Production**.
3. 30초 내 DNS 전환 완료 → 즉시 verify (`curl https://<domain>/`).
4. 사후 actions: GitHub `main` 브랜치도 동일 commit으로 `git revert` PR 생성 (코드/배포 일관성 유지).

### 7.2 DB 마이그레이션 롤백

Supabase는 자동 down migration이 없으므로 **수동 reverse SQL** 작성 필요. 본 프로젝트는 4개 마이그레이션이 단순(추가형)이라 일반적으로 forward-fix가 더 안전.

```bash
# 비상 시: 마지막 마이그레이션만 수동 reverse
# 예) 0004 seed 롤백
psql "$SUPABASE_DB_URL" -c "DELETE FROM public.system_prompts WHERE name IN ('analyze.v1','profile_extract.v1') AND version = 1;"

# 0003 RPC 롤백
psql "$SUPABASE_DB_URL" -c "DROP FUNCTION IF EXISTS public.record_analysis_and_deduct CASCADE; DROP FUNCTION IF EXISTS public.grant_free_credits_on_signup CASCADE;"
```

**원칙**: `analyses`/`credit_ledger`/`subscriptions` 등 사용자 데이터를 가진 테이블의 DROP은 **절대 금지**. 데이터 손상 위험 시 read-only 모드(`/api/analyze` 차단)로 전환 후 forward-fix migration 작성.

### 7.3 Stripe Webhook 일시 비활성

결제 동기화 버그 시 추가 row insert를 막아 데이터 오염 차단.

1. Stripe Dashboard → Developers → Webhooks → endpoint 선택 → **Disable**.
2. 비활성 동안 발생한 이벤트는 Stripe가 최대 3일 자동 재시도 (event id 동일) → 멱등성 보장(`stripe_events` PK) 으로 안전.
3. 코드 fix 후 endpoint **Enable** → 자동 재시도 큐 소진까지 약 5분.

### 7.4 OpenAI 키 회전 (유출 의심 시)

1. platform.openai.com → API keys → 의심 키 **Revoke** (즉시 모든 호출 차단).
2. 신규 key 발급 → Vercel env `OPENAI_API_KEY` 즉시 갱신 → `vercel --prod` 또는 Dashboard에서 **Redeploy** (env 변경은 redeploy로 적용).
3. 회전 사이 약 2분 다운타임. `/api/analyze`가 502 반환하지만 Deduct-on-Success로 크레딧 손실 0.

---

## 8. Email 알림 채널 — **MVP 미도입, v1.0 Week 3 결정**

`_workspace/00_input.md §6` 잔여 항목 #3 / spec/06 TD-4와 일치.

| 후보 | 무료 한도 | 도메인 인증 | DKIM/SPF 자동 | 결제 영수증/만료 알림 적합도 | 비고 |
|------|---------|------------|--------------|-----------------------|------|
| **Resend** | 100/day, 3K/mo | Cloudflare 5분 | 자동 | ★★★★★ — React Email 통합, dev exp 최고 | 가장 유력 후보 |
| **Supabase SMTP** | (Supabase Free에 포함) | 별도 SMTP provider 필요 | 사용자 수동 | ★★★ — Auth 메일(가입/비번 리셋) 전용 권장. Transactional은 부적합 | Auth 메일은 사용, 트랜잭셔널은 분리 |
| **Postmark** | 100/mo free | 5분 | 자동 | ★★★★ — 트랜잭셔널 deliverability 1위 | 도메인 신뢰도 1위지만 무료 한도 작음 |

**결정 시점**: **v1.0 진입(Week 3 Day 1)**, 트리거는 "결제 영수증 첫 발송 필요 시" — Stripe Checkout에 receipt 옵션이 내장되어 있어 MVP는 Stripe receipt만으로 운영 가능. ConnectSaver 자체 알림(주간 무제한 만료, 환불 완료, 사용량 80% 도달 등)이 필요해지는 v1.0 시점이 도입 적기.

**제안 default**: **Resend** — Next.js + React Email 조합으로 1일 이내 통합. 도메인은 Cloudflare에서 `mail.connectsaver.com` subdomain 발급 후 Resend DKIM/SPF/Return-Path 자동 설정.

도입 시 env 추가:
```
RESEND_API_KEY=re_...
EMAIL_FROM_DEFAULT="ConnectSaver <noreply@connectsaver.com>"
```

---

## 9. 보안 체크리스트 (배포 전 / 운영 중)

### 9.1 Secrets 관리

- [ ] Vercel env 등록 시 **"Sensitive"** 토글 ON 확인 (특히 `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`). Sensitive ON 시 일단 저장되면 dashboard에서 다시 볼 수 없고, 빌드 로그에도 자동 마스킹.
- [ ] `.env*` 파일이 `.gitignore`에 포함 — 본 가이드 §gitignore 참조. 단 `.env.example`은 추적.
- [ ] GitHub repo에 `git log --all -p | grep -E "(sk_live_|sk_test_|whsec_|sbp_|eyJ)"` — 시크릿 누출 grep. 발견 시 즉시 회전 + `git filter-repo`.
- [ ] `SUPABASE_SERVICE_ROLE_KEY`는 **server-only 파일 (`lib/supabase/admin.ts`)에서만 import**. `'use client'` 컴포넌트나 RSC가 아닌 client component에서 import 시 빌드 실패 강제 (Next.js가 자동 차단하지만 PR 리뷰에서 cross-check).

### 9.2 Stripe Webhook signature 의무화

- [ ] `/api/webhooks/stripe/route.ts` 첫 줄에 `stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)` 호출. 실패 시 400. `_workspace/01_architecture.md §8.4` 그대로.
- [ ] Next.js Route Handler에서 raw body 보존을 위해 `req.text()` 사용. **`req.json()` 절대 금지** (JSON parse가 byte sequence를 변형하여 signature 깨짐).
- [ ] §4.3 음수 테스트(서명 없는 POST → 400) 배포 직후 1회 실행 확인.

### 9.3 입력 검증 (OWASP A03 — Injection)

- [ ] `/api/analyze`: char length cap 64K (HTTP reject) + Zod schema 검증 (`{ job_text: string.max(65536) }`).
- [ ] `/api/profile/extract`: char length cap 16K + 동일 Zod.
- [ ] `/api/report-scam`: `is_reported`, `report_reason` **두 컬럼만** UPDATE 하도록 라우트 핸들러에서 명시 (RLS는 row 단위만 — _workspace/03_db_schema.md §4.5 주의 박스).
- [ ] 모든 DB 접근은 `@supabase/supabase-js` 파라미터라이즈드 API 사용 — raw SQL 금지. (Supabase admin client의 `.rpc('record_analysis_and_deduct', {...})`는 PostgreSQL prepared statement로 자동 escape.)

### 9.4 HTTPS / 헤더 / CORS

- [ ] Vercel은 자동 HTTPS 강제 (HTTP → 301). HSTS 헤더 자동.
- [ ] `next.config.ts`에 CSP/X-Frame-Options 헤더 추가는 v1.0 항목 — MVP는 Vercel 기본 + Supabase가 자체 CORS 관리하므로 충분.
- [ ] CORS: `/api/*`는 same-origin이므로 Next.js 기본 (no CORS header) OK. 단 `/api/webhooks/stripe`는 Stripe IP에서 호출 — Next.js Route Handler가 origin 무관하게 처리하므로 추가 설정 불필요.

### 9.5 Rate Limiting / Cost Guards

- [ ] middleware.ts → per-IP rate limit 120/min 동작 확인 (§5.3 #11).
- [ ] `/api/analyze` 라우트 → per-user 60/min + in-flight lock 30s 동작 확인.
- [ ] `cost:daily:{user_id}` KV counter → `min(soft_cap, 200)` 한도 동작 확인.

### 9.6 KV 토큰 권한 분리

- [ ] `KV_REST_API_TOKEN` (rw)은 mutation 코드 (lib/rate-limit/kv.ts)에서만 import.
- [ ] `KV_REST_API_READ_ONLY_TOKEN` (ro)은 향후 RSC 표시 코드 도입 시에만 사용 — MVP에서는 코드 미사용 상태로 env만 보관.
- [ ] 클라이언트 컴포넌트 (`'use client'`)에서 KV 토큰을 **절대 import 금지** — Vercel KV 토큰에는 `NEXT_PUBLIC_` prefix가 없으므로 자동 차단됨. PR 리뷰에서 grep으로 cross-check.

### 9.7 데이터 보호

- [ ] Supabase Auth가 비밀번호를 저장하지 않음 (Google OAuth만) → 자체 비번 해싱/회전 부담 0.
- [ ] `users_profile.resume_text` (사용자 이력서)는 RLS로 본인만 read. service_role 외 cross-user 접근 0건임을 §2.4 검증 쿼리로 확인.
- [ ] GDPR Data Export/Delete 엔드포인트는 v1.1 placeholder만 — backend가 `/api/me/export`, `/api/me/delete` skeleton 라우트 작성 후 v1.1에서 RPC 구현 (`_workspace/00_input.md §6` 잔여 #4).

---

## 10. CI/CD 파이프라인 — `.github/workflows/ci.yml`

본 repo에 별도 작성. 요약:

- **Trigger**: `pull_request` → `main`, `push` → `main`.
- **Jobs**: `install` → (`lint`, `typecheck`, `test`) 병렬 → `build`.
- **Node 20.x + pnpm 9** (actions/setup-node + pnpm/action-setup@v4 cache).
- **빌드 시 stub envs** — `NEXT_PUBLIC_*`만 fake 값으로 주입 (Next.js가 빌드 시 public env 존재 확인). 실제 시크릿은 CI에 등록하지 않음 (Vercel만 보유).
- **Concurrency**: 동일 ref 새 commit 시 진행 중 run 자동 cancel.

자세한 YAML은 파일 직접 참조. CI 실패 시 PR이 main에 merge 차단되도록 GitHub Settings → Branches → main → **Require status checks**: `lint`, `typecheck`, `test`, `build` 체크.

---

## 11. 인프라 구성도 (배포 후 상태)

```mermaid
graph TB
  subgraph User["End User"]
    Browser["Browser<br/>(Chrome/Safari/FF)"]
  end

  subgraph Edge["Vercel Edge Network"]
    CDN["CDN<br/>(static assets, ISR)"]
    DNSr["DNS / SSL<br/>app.connectsaver.com"]
  end

  subgraph Compute["Vercel Functions (iad1)"]
    RSC["RSC / SSR"]
    API["Route Handlers /api/*<br/>(maxDuration analyze=30s, webhook=15s)"]
    MW["Middleware<br/>(auth + per-IP rate limit)"]
  end

  subgraph Storage["Vercel Storage (iad1)"]
    KV[("KV / Upstash Redis<br/>rl:* lock:* cost:* prompt:*")]
  end

  subgraph SB["Supabase Cloud (us-east-1)"]
    AUTH["Supabase Auth<br/>(Google OAuth)"]
    PG[("PostgreSQL 15<br/>6 tables + RLS + RPC")]
    LOGS["Logs Explorer"]
  end

  subgraph SaaS["3rd-party SaaS"]
    OAI["OpenAI<br/>(gpt-4o-mini)"]
    ST["Stripe<br/>(Checkout + Webhooks)"]
    SEN["Sentry<br/>(deferred v1.0)"]
    RES["Resend<br/>(deferred v1.0 Wk3)"]
  end

  Browser --> DNSr
  DNSr --> CDN
  CDN --> RSC
  Browser --> MW
  MW --> API
  RSC --> PG
  API --> AUTH
  API --> KV
  API --> PG
  API --> OAI
  API --> ST
  ST -->|signed webhook| API
  API -.->|v1.0+| SEN
  API -.->|v1.0 Wk3+| RES
```

---

## 12. Local Dev Quickstart

저장소 clone 직후 5분 안에 dev 서버 띄우기:

```bash
# 1) 의존성 설치 (pnpm 사용 — package.json은 lockfile-agnostic, 본 가이드는 pnpm 기준)
cd /Users/heesubkim/project/bidvett && pnpm install

# 2) 환경변수 템플릿 복사
cp .env.example .env.local
# .env.local 열어 실제 값 채우기 (최소 NEXT_PUBLIC_SUPABASE_URL/ANON_KEY,
# OPENAI_API_KEY, STRIPE_SECRET_KEY/PUBLISHABLE_KEY는 필수)

# 3) Supabase 마이그레이션 (local 또는 dev 프로젝트 대상 — §2.3)
pnpm dlx supabase db push

# 4) Stripe Product/Price seed (1회)
pnpm dlx tsx scripts/seed-stripe.ts
# 출력된 price_* ID를 .env.local NEXT_PUBLIC_STRIPE_PRICE_* 에 채워넣기

# 5) Dev 서버
pnpm dev
# http://localhost:3000
```

**Stripe Webhook 로컬 테스트** (선택):

```bash
# 별도 터미널
pnpm dlx stripe listen --forward-to http://localhost:3000/api/webhooks/stripe
# 출력된 whsec_... 을 .env.local STRIPE_WEBHOOK_SECRET 에 임시 설정 후 dev 서버 재기동
```

테스트 카드: `4242 4242 4242 4242` (모든 만료/CVC), 환불 시뮬레이션은 Stripe Dashboard → test 결제 → Refund 버튼.

---

## 13. 변경 이력 / 의도적 Deferred 결정 요약

| # | 결정 | 상태 | 트리거 조건 |
|---|------|------|-----------|
| D1 | **Sentry 도입** | MVP 미도입 | launch 후 7일 ERR_OPENAI_UPSTREAM 발생 OR 5xx > 0.5% → v1.0 Week 3 |
| D2 | **Email 알림 채널** (Resend 권장) | MVP 미도입 | 결제/만료 알림 사용자 요청 OR v1.0 Week 3 도달 |
| D3 | **Stripe Tax** | OFF | EU 결제 5건 OR US 매출 $20K 근접 → v1.1 |
| D4 | **Custom domain** | Vercel 기본 도메인 사용 가능 | launch 직전 (Day 14) 선택 사항 |
| D5 | **GDPR Data Export/Delete** | placeholder 라우트만 | v1.1 |
| D6 | **CSP/보안 헤더 강화** | Vercel 기본 + HSTS만 | v1.0 — `next.config.ts` headers() 추가 |
| D7 | **Vercel Pro plan** | Hobby tier | DAU > 100 OR bandwidth > 100GB/mo |
| D8 | **Vercel KV 유료 전환** | Hobby (30K cmd/day) | DAU > 200 (spec/06 TD-6) |

---

## 14. 부록 — Quick Reference

### 14.1 자주 쓰는 명령

```bash
# Vercel
vercel               # 로컬 → Preview 즉시 배포
vercel --prod        # Production 즉시 배포
vercel env ls        # 환경변수 확인
vercel logs <url>    # 최근 로그
vercel rollback      # 직전 배포로 즉시 롤백

# Supabase
supabase db push                 # migrations apply
supabase db diff                 # 로컬 vs 원격 차이
supabase functions deploy        # (사용 안함 — Next.js Route Handlers로 통일)
supabase gen types typescript --local > src/lib/types/db.ts  # 타입 생성

# Stripe
stripe listen --forward-to http://localhost:3000/api/webhooks/stripe
stripe trigger checkout.session.completed   # 임의 이벤트 발화
```

### 14.2 트러블슈팅 빠른 인덱스

| 증상 | 진단 | 해결 |
|------|------|------|
| OAuth redirect 후 404/500 | Google Cloud Console Redirect URI ≠ Supabase Site URL | §2.2 4번, §3.4 4번 재확인 |
| `/api/analyze` 502 ERR_OPENAI_UPSTREAM 연발 | OpenAI key 무효 / quota 초과 | platform.openai.com → Usage / Limits 확인 |
| Webhook 400 ERR_WEBHOOK_SIGNATURE | `STRIPE_WEBHOOK_SECRET` mismatch (test↔live 혼동) | §4.2 4번 secret 재확인 + Vercel redeploy |
| RLS로 본인 데이터도 안 보임 | `@supabase/ssr` cookie 세션 만료 | `/login` 재진입 (logout 안 해도 OK) |
| KV 429 (`Daily commands exceeded`) | Hobby 30K cmd/day 초과 | Vercel Storage → Upgrade (TD-6 트리거) |
| Vercel build fail "Missing env" | NEXT_PUBLIC_ 변수 미등록 | Settings → Env → 환경별 등록 + Redeploy |

---

문서 종료. 본 문서의 어떤 항목이라도 `_workspace/01_architecture.md`, `_workspace/03_db_schema.md`와 충돌하면 후자가 우선 — devops는 충돌 발견 시 즉시 architect에게 핑.
