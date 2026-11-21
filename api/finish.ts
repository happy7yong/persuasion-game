import { writeEnding } from "../server/ending.js";
import { body, onlyPost, send, type Req, type Res } from "../server/http.js";
import { logFinish, stats, storedEnding } from "../server/log.js";
import { finish } from "../server/rules.js";
import { decodeState, encodeState } from "../server/token.js";

export default async function handler(req: Req, res: Res) {
  if (!onlyPost(req, res)) return;
  const b = body(req);
  let state = decodeState(b.token);
  if (!state) return send(res, 400, { error: "판 정보가 만료됐어요. 처음부터 다시 시작해 주세요.", expired: true });

  if (!state.finished) {
    if (b.giveup !== true) return send(res, 400, { error: "아직 대화가 끝나지 않았어요." });
    state = finish(state, "giveup");
  }

  const cached = await storedEnding(state.id);
  if (cached) return send(res, 200, { token: encodeState(state), ending: cached, stats: await stats() });

  let ending;
  try {
    ending = await writeEnding(state);
  } catch {
    return send(res, 502, { error: "은하 신문 인쇄가 늦어지고 있어요. 다시 시도해 주세요.", retryable: true, token: encodeState(state) });
  }
  await logFinish(state, { endingModel: ending.model, endingUsage: ending.usage, ending });
  send(res, 200, { token: encodeState(state), ending, stats: await stats() });
}
