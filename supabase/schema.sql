-- Supabase SQL Editor에서 한 번 실행한다. 서버는 service role 키로만 접근한다.
-- 기록 규칙 (relationship-engine trace-contract 방식):
--   plays, turns  = 필수 기록. 저장에 실패한 마디는 화면에 보내지 않는다.
--   llm_calls     = 부가 기록(LLM 원문). 실패해도 게임 결과는 바뀌지 않는다. API 키는 저장하지 않는다.

create table if not exists plays (
  id text primary key,
  created_at timestamptz not null default now(),
  heard_before boolean,
  partner text,                     -- m(윤재, 남자친구) | f(서아, 여자친구)
  finished_at timestamptz,
  outcome text,
  final_score int,
  turns_count int,
  chars_used int,
  ending_model text,
  ending_usage jsonb,
  ending jsonb,                     -- 대화 리포트
  belief jsonb,                     -- "내가 본 너" (판단·근거·예상)
  belief_feedback text,             -- agree | disagree
  belief_feedback_at timestamptz
);

create table if not exists turns (
  id bigint generated always as identity primary key,
  play_id text not null references plays(id) on delete cascade,
  idx int not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  player_text text not null,
  npc_beats jsonb not null,
  npc_move text,                    -- counter | ask | concede | linger (서버가 정한 끝맺음)
  noticed text,                     -- 이 말에서 연인이 플레이어에 대해 알게 된 것 ("내가 본 너"의 근거)
  suggested_drop numeric not null,
  applied_drop int not null,
  labels text[] not null,
  reason text,
  score_after int not null,
  model text,
  usage jsonb,
  elapsed_ms int,
  prompt_version text,
  -- 같은 마디가 두 번 기록되지 않게 한다 (동시 요청 중 하나만 저장)
  unique (play_id, idx)
);

create table if not exists llm_calls (
  id bigint generated always as identity primary key,
  play_id text not null references plays(id) on delete cascade,
  call_type text not null,          -- npc_turn | belief
  turn_idx int,                     -- ending이면 null
  attempt int not null,             -- 1, 2 (자동 재시도)
  prompt_version text,
  configured_model text,
  responded_model text,
  request jsonb,                    -- 보낸 메시지와 설정. 헤더·키 없음
  response_text text,               -- 받은 원문 (실패한 시도 포함)
  finish_reason text,
  usage jsonb,
  started_at timestamptz,
  latency_ms int,
  result text,                      -- ok | timeout:… | http:… | invalid_output:…
  created_at timestamptz not null default now()
);

create index if not exists llm_calls_play_idx on llm_calls(play_id, call_type, turn_idx);

-- 공개 접근 차단 (anon 키로는 읽고 쓸 수 없음)
alter table plays enable row level security;
alter table turns enable row level security;
alter table llm_calls enable row level security;

-- ------------------------------------------------------------------
-- 이미 테이블이 있는 경우: create table if not exists는 건너뛰므로,
-- 나중에 추가된 컬럼과 제약을 아래에서 채운다. 몇 번을 실행해도 안전하다.
alter table plays add column if not exists heard_before boolean;
alter table plays add column if not exists partner text;
alter table plays add column if not exists finished_at timestamptz;
alter table plays add column if not exists outcome text;
alter table plays add column if not exists final_score int;
alter table plays add column if not exists turns_count int;
alter table plays add column if not exists chars_used int;
alter table plays add column if not exists ending_model text;
alter table plays add column if not exists ending_usage jsonb;
alter table plays add column if not exists ending jsonb;
alter table plays add column if not exists belief jsonb;
alter table plays add column if not exists belief_feedback text;
alter table plays add column if not exists belief_feedback_at timestamptz;

alter table turns add column if not exists idempotency_key text;
alter table turns add column if not exists npc_move text;
alter table turns add column if not exists noticed text;
alter table turns add column if not exists applied_drop int;
alter table turns add column if not exists score_after int;
alter table turns add column if not exists reason text;
alter table turns add column if not exists model text;
alter table turns add column if not exists usage jsonb;
alter table turns add column if not exists elapsed_ms int;
alter table turns add column if not exists prompt_version text;

create unique index if not exists turns_play_idx_unique on turns(play_id, idx);

-- PostgREST가 새 컬럼을 바로 알도록 스키마 캐시를 다시 읽게 한다
notify pgrst, 'reload schema';
