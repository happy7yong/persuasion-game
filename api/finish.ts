// 판을 끝내고 대화 리포트를 돌려준다. LLM을 부르지 않으므로 바로 끝난다.
import { z } from "zod";
import { fail, guarded, parseRequest, send } from "../server/http.js";
import { buildReport } from "../server/report.js";
import { finish } from "../server/rules.js";
import { distribution, finishPlay, listTurns, playFinished, stats } from "../server/store.js";
import { catchUp } from "../server/sync.js";
import { decodeState, encodeState } from "../server/token.js";

const Body = z.object({ token: z.string().min(1), giveup: z.boolean().optional() }).strict();

export default guarded(async (req, res) => {
  const b = parseRequest(req, res, Body);
  if (!b) return;
  let state = decodeState(b.token);
  if (!state) return fail(res, "session_expired", "판 정보가 만료됐어요. 처음부터 다시 시작해 주세요.");

  let alreadySaved = false;
  try {
    const rows = await listTurns(state.id);
    if (rows) state = catchUp(state, rows).latest; // 저장된 기록이 기준
    alreadySaved = await playFinished(state.id);
  } catch {
    return fail(res, "service_unavailable", "기록 저장소에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }

  if (!state.finished) {
    if (b.giveup !== true) return fail(res, "invalid_turn_state", "아직 대화가 끝나지 않았어요.");
    state = finish(state, "giveup");
  }

  const report = buildReport(state);
  if (!alreadySaved) {
    try {
      await finishPlay(state, report);
    } catch (e) {
      // 리포트는 보여 준다. 다음 요청에서 다시 저장을 시도한다.
      console.warn("[finish] store failed", state.id, e instanceof Error ? e.message : "");
    }
  }
  // 분포는 판이 끝날 때 한 번만 읽는다 (내 판이 저장된 뒤라 나도 포함된다). 결과 화면은 이 값을 저장해 두고 다시 묻지 않는다.
  const [s, dist] = await Promise.all([stats(), distribution()]);
  send(res, 200, { token: encodeState(state), report, stats: s ? { ...s, distribution: dist } : null });
});
