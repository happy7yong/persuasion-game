-- Supabase SQL Editor에서 한 번 실행한다. 서버는 service role 키로만 접근한다.
create table if not exists plays (
  id text primary key,
  created_at timestamptz not null default now(),
  heard_before boolean,
  finished_at timestamptz,
  outcome text,
  final_score int,
  turns_count int,
  chars_used int,
  ending_model text,
  ending_usage jsonb,
  ending jsonb
);

create table if not exists turns (
  id bigint generated always as identity primary key,
  play_id text not null references plays(id) on delete cascade,
  idx int not null,
  created_at timestamptz not null default now(),
  player_text text not null,
  npc_beats jsonb not null,
  suggested_drop numeric,
  applied_drop int,
  labels text[],
  reason text,
  score_after int,
  model text,
  usage jsonb,
  elapsed_ms int
);

create index if not exists turns_play_idx on turns(play_id, idx);

-- 공개 접근 차단 (anon 키로는 읽고 쓸 수 없음)
alter table plays enable row level security;
alter table turns enable row level security;
