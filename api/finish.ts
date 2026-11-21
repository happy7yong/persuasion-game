import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { ENDING_PROMPT_VERSION, writeEnding } from "../server/ending.js";
import { fail, guarded, parseRequest, send } from "../server/http.js";
import { finish } from "../server/rules.js";
import { finishPlay, listTurns, rankOf, saveAttempts, stats, storedEnding } from "../server/store.js";
import { catchUp } from "../server/sync.js";
import { decodeState, encodeState } from "../server/token.js";

/** 결과 화면용: 전체 통계와 참가자 대비 순위 (저장된 판 기준, 실패해도 결과는 보여 준다). */
async function standing(score: number) {
  const [s, rank] = await Promise.all([stats(), rankOf(score).catch(() => null)]);
  return { stats: s, rank };
}

const Body = z.object({ token: z.string().min(1), giveup: z.boolean().optional() }).strict();

export default guarded(async (req, res) => {
  const b = parseRequest(req, res, Body);
  if (!b) return;
  let state = decodeState(b.token);
  if (!state) return fail(res, "session_expired", "판 정보가 만료됐어요. 처음부터 다시 시작해 주세요.");

  try {
    const rows = await listTurns(state.id);
    if (rows) state = catchUp(state, rows).latest; // 저장된 기록이 기준
    const cached = await storedEnding(state.id);
    if (cached) return send(res, 200, { token: encodeState(state), ending: cached, ...(await standing(state.score)) });
  } catch {
    return fail(res, "service_unavailable", "기록 저장소에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }

  if (!state.finished) {
    if (b.giveup !== true) return fail(res, "invalid_turn_state", "아직 대화가 끝나지 않았어요.");
    state = finish(state, "giveup");
  }

  const result = await writeEnding(state);
  waitUntil(saveAttempts(state.id, "ending", null, ENDING_PROMPT_VERSION, result.attempts));
  if (!result.ok) {
    console.warn("[finish] generation_failed", state.id, result.failure.message);
    return fail(res, "generation_failed", "은하 신문 인쇄가 늦어지고 있어요. 다시 시도해 주세요.", { token: encodeState(state) });
  }

  try {
    await finishPlay(state, result.ending, result.ending.model, result.ending.usage);
  } catch (e) {
    // 결과는 보여 준다. 다음 요청에서 다시 생성될 수 있을 뿐이다.
    console.warn("[finish] store failed", state.id, e instanceof Error ? e.message : "");
  }
  send(res, 200, { token: encodeState(state), ending: result.ending, ...(await standing(state.score)) });
});
