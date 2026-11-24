// 대화 돌아보기: 끝난 판의 말과 연인 속마음을 대조한다. 리포트를 먼저 보여 준 뒤 따로 부른다.
// 한 번 만든 판단은 저장해 두고 다시 돌려준다 (같은 판에서 판단이 바뀌지 않게, 비용도 한 번만).
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { BELIEF_PROMPT_VERSION, isCurrentBelief, writeBelief } from "../server/belief.js";
import { fail, guarded, parseRequest, send } from "../server/http.js";
import { listTurns, saveAttempts, saveBelief, storedBelief } from "../server/store.js";
import { catchUp } from "../server/sync.js";
import { decodeState } from "../server/token.js";

const Body = z.object({ token: z.string().min(1) }).strict();

export default guarded(async (req, res) => {
  const b = parseRequest(req, res, Body);
  if (!b) return;
  let state = decodeState(b.token);
  if (!state) return fail(res, "session_expired", "판 정보가 만료됐어요. 처음부터 다시 시작해 주세요.");

  try {
    const rows = await listTurns(state.id);
    if (rows) state = catchUp(state, rows).latest;
    const cached = await storedBelief(state.id);
    // 예전 마디별 피드백(v2)은 전체 대화 피드백(v3)과 달라서 다시 만든다.
    if (isCurrentBelief(cached)) return send(res, 200, { belief: cached });
  } catch {
    return fail(res, "service_unavailable", "기록 저장소에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
  if (!state.finished) return fail(res, "invalid_turn_state", "대화가 끝난 뒤에 볼 수 있어요.");

  const result = await writeBelief(state);
  waitUntil(saveAttempts(state.id, "belief", null, BELIEF_PROMPT_VERSION, result.attempts));
  if (!result.ok) {
    console.warn("[belief] failed", state.id, result.failure?.message ?? "no_turns");
    return fail(res, "generation_failed", "아직 생각을 정리하고 있어요. 다시 시도해 주세요.");
  }
  try {
    await saveBelief(state.id, result.belief);
  } catch (e) {
    console.warn("[belief] store failed", state.id, e instanceof Error ? e.message : "");
  }
  send(res, 200, { belief: result.belief });
});
