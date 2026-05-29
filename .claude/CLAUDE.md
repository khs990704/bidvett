# Fullstack Web App Harness

아이디어 구체화→사전 기획→요구사항 분석→설계→프론트엔드→백엔드→테스트→배포를 에이전트 팀이 협업하여 개발하는 하네스.

## 구조

```
.claude/
├── agents/
│   ├── architect.md             — 아이디어 구조화 + 시스템 설계 (요구사항, 아키텍처, DB, API)
│   ├── frontend-dev.md          — 프론트엔드 개발 (React/Next.js, UI 컴포넌트, 상태관리)
│   ├── backend-dev.md           — 백엔드 개발 (API 구현, DB, 인증, 비즈니스 로직)
│   ├── qa-engineer.md           — QA 엔지니어 (테스트 전략, 단위/통합/E2E 테스트)
│   └── devops-engineer.md       — DevOps 엔지니어 (CI/CD, 인프라, 배포, 모니터링)
├── skills/
│   ├── fullstack-webapp/
│   │   └── skill.md             — 메인 오케스트레이터 (Phase 0~3, 팀 조율, 에러핸들링)
│   ├── idea_miner/
│   │   └── skill.md             — 앞단 보조 (아이디어 구체화, idea_inquiry.md 생성)
│   ├── spec_check/
│   │   └── skill.md             — 앞단 보조 (사전 기획 프리뷰, spec/ 생성)
│   ├── component-patterns/
│   │   └── skill.md             — 프론트엔드 확장 (React 패턴, 상태관리, 폴더 구조)
│   └── api-security-checklist/
│       └── skill.md             — 백엔드 확장 (OWASP Top 10, 인증/인가, 보안 헤더)
└── CLAUDE.md                    — 이 파일
```

## 전체 워크플로우

```
idea.md (짧은 아이디어)
  ↓
/idea_miner  — 질문 기반 구체화 → idea_inquiry.md
  ↓
/spec_check  — 사전 기획 프리뷰 → spec/
  ↓
/fullstack-webapp  — 풀 구현 파이프라인 → _workspace/ + src/
```

**바로 구현하고 싶으면** `/fullstack-webapp`만 호출해도 된다.  
입력이 충분히 구체적이면 Phase 0을 자동으로 건너뛴다.

## 사용법

| 상황 | 명령 |
|------|------|
| 아이디어가 막연함 | `/idea_miner` 또는 `idea.md` 작성 후 `/fullstack-webapp` |
| 구현 전 전체 그림을 보고 싶음 | `/spec_check` |
| 바로 만들고 싶음 | `/fullstack-webapp` |
| 프론트엔드만 | `/fullstack-webapp` + "프론트엔드만 만들어줘" |
| 컴포넌트 패턴 참고 | `/component-patterns` |
| 보안 점검 | `/api-security-checklist` |

## 산출물

모든 산출물은 프로젝트 루트에 직접 생성된다:

### 앞단 (아이디어 → 기획)
- `idea.md` — 사용자 작성 초기 아이디어 (선택)
- `idea_inquiry.md` — 질문/답변 기반 구체화 문서
- `spec/01_prd.md` — 제품 요구사항 정의서
- `spec/02_architecture_preview.md` — 아키텍처 초안
- `spec/03_api_preview.md` — API 초안
- `spec/04_db_preview.md` — DB 초안 + ERD
- `spec/05_wireframe.md` — 화면 설계
- `spec/06_milestones.md` — 마일스톤
- `spec/index.md` — spec/ ↔ _workspace/ 매핑 가이드

### 구현 단계 (_workspace/)
- `_workspace/00_input.md` — 사용자 입력 정리 (spec/ 통합)
- `_workspace/01_architecture.md` — 아키텍처 설계 문서
- `_workspace/02_api_spec.md` — API 명세
- `_workspace/03_db_schema.md` — DB 스키마
- `_workspace/04_test_plan.md` — 테스트 계획
- `_workspace/05_deploy_guide.md` — 배포 가이드
- `_workspace/06_review_report.md` — 리뷰 보고서
- `src/` — 소스 코드 (프론트엔드 + 백엔드)
