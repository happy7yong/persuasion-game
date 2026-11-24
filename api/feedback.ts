// 대화 피드백에 대한 플레이어의 답: 맞아(agree) / 좀 달라(disagree).
// NPC의 해석이 실제 사람에게 맞게 느껴지는지 재는 데이터다 (docs/belief.md).
import { z } from "zod";
import { fail, guarded, parseRequest, send } from "../server/http.js";
import { saveBeliefFeedback } from "../server/store.js";
import { decodeState } from "../server/token.js";

const Body = z.object({ token: z.string().min(1), verdict: z.enum(["agree", "disagree"]) }).strict();

export default guarded(async (req, res) => {
  const b = parseRequest(req, res, Body);
  if (!b) return;
  const state = decodeState(b.token);
  if (!state) return fail(res, "session_expired", "판 정보가 만료됐어요.");
  try {
    await saveBeliefFeedback(state.id, b.verdict);
  } catch {
    return fail(res, "service_unavailable", "답을 저장하지 못했어요. 다시 눌러 주세요.");
  }
  send(res, 200, { ok: true });
});
