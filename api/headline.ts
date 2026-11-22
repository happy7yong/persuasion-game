// 은하 신문 1면: 끝난 판에서 가장 많이 움직인 말이 3026년 은하를 어떻게 바꿨는지. 리포트를 보여 준 뒤 따로 부른다.
// 한 번 만든 1면은 저장해 두고 다시 돌려준다 (새로고침해도 같은 신문, 비용도 한 번만).
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { HEADLINE_PROMPT_VERSION, writeHeadline } from "../server/headline.js";
import { fail, guarded, parseRequest, send } from "../server/http.js";
import { listTurns, saveAttempts, saveHeadline, storedHeadline } from "../server/store.js";
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
    const cached = await storedHeadline(state.id);
    if (cached) return send(res, 200, { headline: cached });
  } catch {
    return fail(res, "service_unavailable", "기록 저장소에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
  if (!state.finished) return fail(res, "invalid_turn_state", "대화가 끝난 뒤에 볼 수 있어요.");

  const result = await writeHeadline(state);
  waitUntil(saveAttempts(state.id, "headline", null, HEADLINE_PROMPT_VERSION, result.attempts));
  if (!result.ok) {
    console.warn("[headline] failed", state.id, result.failure?.message ?? "no_turns");
    return fail(res, "generation_failed", "은하 신문이 아직 인쇄 중이에요. 다시 시도해 주세요.");
  }
  try {
    await saveHeadline(state.id, result.headline);
  } catch (e) {
    console.warn("[headline] store failed", state.id, e instanceof Error ? e.message : "");
  }
  send(res, 200, { headline: result.headline });
});
