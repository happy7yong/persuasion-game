# 우리 얘기 좀 해

다섯 마디 안에 연인(남자친구 윤재 또는 여자친구 서아)의 마음을 돌리는 대화 게임. 두 연인은 장면과 첫 대사를 공유하며 인물 Core는 따로 둔다 (`server/content.ts`의 `PARTNERS`). 대화가 끝나면 대화 리포트가 나온다. 마디마다 내 말, 연인의 대답, 그 말로 마음이 몇 % 움직였는지(+%), 그리고 대화 중에는 숨겨져 있던 연인의 속마음이 공개된다. 맨 아래에는 연인이 플레이어를 어떻게 봤는지("○○가 본 너")가 근거와 함께 나온다. 설계와 의도는 [docs/belief.md](docs/belief.md). 사람들이 AI와 어떻게 대화하고 설득하는지 데이터를 모으기 위한 실험이다.

NPC 프롬프트 구조(엔진 규칙 / 공통 원칙 / 인물 Core)와 "LLM은 제안, 엔진이 확정" 원칙은 [relationship-engine](https://github.com/happy7yong/relationship-engine)에서 가져왔다.

## 구조

| 위치 | 역할 |
| --- | --- |
| `src/` | Vite + React 화면 (시작 → 상황 카드 → 대화 → 대화 리포트) |
| `api/` | Vercel Functions: `start`, `turn`, `finish`, `stats` |
| `server/rules.ts` | 게임 규칙과 점수 확정 (턴당 최대 하락, 압박 상한, 엔딩 판정) |
| `server/content.ts` | 시나리오, 윤재 Core, 평가 기준 |
| `server/npc.ts` | NPC 호출과 출력 검증 |
| `server/report.ts` | 저장된 대화로 리포트를 만든다 (LLM 호출 없음) |
| `server/belief.ts` | "○○가 본 너": 근거 있는 판단 생성과 인용 검사 (B의 Belief 시험) |
| `server/token.ts` | 게임 상태를 AES-GCM으로 암호화한 토큰 (클라이언트는 읽지도, 바꾸지도 못함) |
| `server/llm.ts`, `server/model-config.ts` | OpenRouter 호출, 호출별 설정, 하드 타임아웃, 재시도 1회, 시도별 기록 |
| `server/store.ts`, `server/sync.ts` | Supabase 저장(필수 기록·부가 trace), 멱등 처리, 저장된 기록으로 상태 따라잡기 |

점수(마음 지수)는 플레이 중에 화면에 보내지 않는다. 엔딩에서만 공개된다. 모든 판은 다섯 마디를 끝까지 하고(조기 종료 없음), 끝난 뒤 흔든 정도가 60% 이상이면 설득 성공이다. 최대 100%.

## 실패와 중복 요청 처리

relationship-engine의 계약(`api.md`, `turn-lifecycle.md`, `trace-contract.md`)에서 가져온 규칙이다.

- **멱등 키:** 말하기 요청마다 화면이 `idempotency_key`(UUID)를 만든다. 응답을 못 받고 같은 말을 다시 보내면 같은 키를 쓰고, 서버는 LLM을 다시 부르지 않고 처음 결과를 돌려준다. 그 마디가 이미 다른 말로 기록돼 있으면 `409 turn_already_recorded`와 함께 기록된 대화(`resync`)를 돌려주고, 화면은 그걸 이어 붙인 뒤 새로 쓴 말을 입력창에 돌려준다. (Supabase 연결 시)
- **실패 규칙:** LLM 생성·검증 실패는 자동 재시도 1회 후 `502 generation_failed`. 상태는 바뀌지 않고, 대체 대사는 만들지 않는다 (D-043). 화면은 "다시 보내기"를 띄운다.
- **저장이 먼저:** 마디는 Supabase에 저장된 뒤에만 화면에 보낸다. 저장에 실패하면 `503 service_unavailable`.
- **시간 예산:** 시도마다 하드 타임아웃, 재시도까지 합쳐 Vercel 함수 상한(60초) 안에 끝난다 (`server/model-config.ts`).
- **출력 형식:** strict `json_schema`로 강제하고 Zod로 다시 검증한다. 추론은 끈다(`reasoning: none`).
- **오류 형식:** `{ error: { code, message, retryable } }`. 코드 목록은 `server/http.ts`.
- **Trace:** 실패한 시도까지 원문 요청·응답, 모델, 토큰·비용, 걸린 시간, 결과를 `llm_calls`에 응답 뒤 따로 저장한다. API 키는 저장하지 않는다.
- **새로고침:** 화면 상태는 sessionStorage에 있어 새로고침해도 이어진다. 토큰이 만료되면 "처음부터 다시 하기"를 띄운다.

## 로컬 실행

```bash
npm install
cp .env.example .env   # OPENROUTER_API_KEY가 비어 있으면 대본 모드로 동작
npm run dev
npm test
```

채팅 화면을 다듬을 때는 로컬 개발 서버에서 `/?dev=chat`을 연다. 샘플 대사를 추가하거나 입력 버튼으로 말풍선을 확인할 수 있으며, 이 미리보기는 게임 기록이나 AI를 사용하지 않는다. 실제 게임과 미리보기 모두 Enter는 줄바꿈이고 `말하기` 버튼으로만 전송한다.

## 터미널에서 말투 보기

웹과 같은 서버 코드(프롬프트, 점수 규칙, 끝맺음)로 터미널에서 대화한다. Supabase에는 기록하지 않는다. `.env` 또는 `.env.local`에 `OPENROUTER_API_KEY`가 있어야 실제 모델로 동작한다.

```bash
npm run play          # 윤재와 대화 (서아: npm run play -- f)
npm run tone          # 정해 둔 첫마디 5개에 대한 대답을 한 번에 출력
```

대화 중 `/again`은 방금 대답을 같은 말로 다시 생성하고(말투 비교용), `/prompt`는 모델에 들어간 프롬프트를, `/quit`은 종료한다. 마디마다 끝맺음 방식, 오른 %, 라벨, 속마음, 알게 된 것이 보이고, 끝나면 "○○가 본 너"까지 나온다.

## 배포 (Vercel)

1. Vercel에서 이 레포를 Import. Framework는 Vite로 자동 인식된다.
2. Environment Variables에 `SESSION_SECRET`(16자 이상 랜덤), `OPENROUTER_API_KEY`를 넣는다. 기본값은 상태 판정 `FRAME_MODEL=openai/gpt-5.4-mini`, NPC 대사 `NPC_DIALOGUE_MODEL=openai/gpt-5.6-terra`다. 각각 바꿀 수 있으며, 기존 `NPC_MODEL`을 지정하면 두 호출에 같은 모델을 쓴다.
3. 로그를 모으려면 Supabase SQL Editor에서 `supabase/schema.sql`을 실행하고 (테이블 `plays`, `turns`, `llm_calls`) `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MAX_TOTAL_PLAYS`를 넣는다. 이걸 연결해야 시작 화면의 "몇 명 중 몇 명이 설득했어요"가 보이고, 같은 토큰으로 마디를 다시 보내거나 엔딩을 반복 생성하는 것도 막힌다.
4. OpenRouter 콘솔에서 크레딧 한도를 걸어 두면 비용 사고를 막을 수 있다.
5. 선택: [Microsoft Clarity](https://clarity.microsoft.com)에서 프로젝트를 만들고 ID를 `VITE_CLARITY_ID`에 넣은 뒤 다시 배포한다. 대시보드의 Live users에서 접속 중인 참가자를 실시간으로 보고, 녹화를 볼 수 있다. 녹화는 `play_id` 태그로 Supabase `plays.id`와 맞춰 볼 수 있고, 결과(`outcome`, `shake`)와 이벤트(`turn_sent`, `ending_shown`, `error_*` 등)로 거를 수 있다. 채팅 말풍선은 녹화에 보이게 해 두었고(`data-clarity-unmask`), 입력창에 치는 중인 글자는 Clarity가 항상 가린다.

## 수집하는 데이터

`turns` 테이블: 플레이어 발언 원문, 윤재 응답, 제안 점수와 확정 점수, 전략 라벨, 모델과 토큰 사용량·비용, 프롬프트 버전.
`llm_calls` 테이블: LLM 시도별 원문 요청·응답과 실패 사유 (분석·디버깅용).
`plays` 테이블: 결과, 최종 점수, 마디 수, 사용 글자 수, 게임을 미리 들었는지 여부, 엔딩.

외부 참가자를 받기 전에 보관 기간과 삭제 방법을 정해 둔다.
