# 우리 얘기 좀 해

다섯 마디 안에 연인 윤재의 마음을 돌리는 대화 게임. 대화가 끝나면 그 대화가 사실 은하연애위원회에 생중계되고 있었다는 반전과 함께, 내가 한 말 하나하나가 바꿔 놓은 미래가 공개된다. 사람들이 AI와 어떻게 대화하고 설득하는지 데이터를 모으기 위한 실험이다.

NPC 프롬프트 구조(엔진 규칙 / 공통 원칙 / 인물 Core)와 "LLM은 제안, 엔진이 확정" 원칙은 [relationship-engine](https://github.com/happy7yong/relationship-engine)에서 가져왔다.

## 구조

| 위치 | 역할 |
| --- | --- |
| `src/` | Vite + React 화면 (시작 → 상황 카드 → 대화 → 엔딩 4막) |
| `api/` | Vercel Functions: `start`, `turn`, `finish`, `stats` |
| `server/rules.ts` | 게임 규칙과 점수 확정 (턴당 최대 하락, 압박 상한, 엔딩 판정) |
| `server/content.ts` | 시나리오, 윤재 Core, 평가 기준 |
| `server/npc.ts` | NPC 호출과 출력 검증 |
| `server/ending.ts` | 대화 전체로 미래 갈림길을 계산하고 연표 문장을 생성 |
| `server/token.ts` | 게임 상태를 HMAC 서명 토큰으로 보관 (DB 없이도 조작 불가) |
| `server/log.ts` | 선택: Supabase에 대화 로그 저장 |

점수(마음 지수)는 플레이 중에 화면에 보내지 않는다. 엔딩에서만 공개된다.

## 로컬 실행

```bash
npm install
cp .env.example .env   # OPENROUTER_API_KEY가 비어 있으면 대본 모드로 동작
npm run dev
npm test
```

## 배포 (Vercel)

1. Vercel에서 이 레포를 Import. Framework는 Vite로 자동 인식된다.
2. Environment Variables에 `SESSION_SECRET`(16자 이상 랜덤), `OPENROUTER_API_KEY`를 넣는다. 모델을 바꾸려면 `NPC_MODEL`, `ENDING_MODEL`.
3. 로그를 모으려면 Supabase SQL Editor에서 `supabase/schema.sql`을 실행하고 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `MAX_TOTAL_PLAYS`를 넣는다. 이걸 연결해야 시작 화면의 "몇 명 중 몇 명이 설득했어요"가 보이고, 같은 토큰으로 마디를 다시 보내거나 엔딩을 반복 생성하는 것도 막힌다.
4. OpenRouter 콘솔에서 크레딧 한도를 걸어 두면 비용 사고를 막을 수 있다.

## 수집하는 데이터

`turns` 테이블: 플레이어 발언 원문, 윤재 응답, 제안 점수와 확정 점수, 전략 라벨, 모델과 토큰 사용량·비용.
`plays` 테이블: 결과, 최종 점수, 마디 수, 사용 글자 수, 게임을 미리 들었는지 여부, 엔딩.

외부 참가자를 받기 전에 보관 기간과 삭제 방법을 정해 둔다.
