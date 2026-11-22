-- 2026-11-22: 장부 구조(ledger@1)와 대사 검증기(V2·V3)
-- 여러 번 실행해도 안전하다 (컬럼이 이미 있으면 건너뛴다). 데이터를 지우거나 바꾸지 않는다.
--
-- state_frame: 마디마다 확정한 사실(TurnFacts). DB로 상태를 따라잡을 때 장부를 다시 쌓는 데 쓴다.
--   이 컬럼이 없던 동안에는 저장 코드가 조용히 빼고 저장했다 (server/store.ts missingColumn).
-- checks: 대사 검증 결과 { outcome: clean | prevented | exposed, attempts: [...] }
alter table turns add column if not exists state_frame jsonb;
alter table turns add column if not exists checks jsonb;

-- llm_calls.call_type에 turn_frame · scene_check가 새로 생긴다 (text 컬럼이라 변경 없음)

notify pgrst, 'reload schema';
