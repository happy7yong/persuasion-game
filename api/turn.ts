import { body, onlyPost, send, type Req, type Res } from "../server/http.js";
import { logTurn, storedTurnCount } from "../server/log.js";
import { npcReply } from "../server/npc.js";
import { checkMessage, recordTurn, RULES } from "../server/rules.js";
import { decodeState, encodeState } from "../server/token.js";

export default async function handler(req: Req, res: Res) {
  if (!onlyPost(req, res)) return;
  const b = body(req);
  const state = decodeState(b.token);
  if (!state) return send(res, 400, { error: "판 정보가 만료됐어요. 처음부터 다시 시작해 주세요.", expired: true });

  const check = checkMessage(state, typeof b.message === "string" ? b.message : "");
  if (!check.ok) return send(res, 400, { error: check.reason });

  const stored = await storedTurnCount(state.id);
  if (stored !== null && stored > state.turns.length) return send(res, 409, { error: "이미 보낸 마디예요. 화면을 새로 고쳐 주세요." });

  const started = Date.now();
  let reply;
  try {
    reply = await npcReply(state, check.text);
  } catch {
    // 상태를 바꾸지 않았으니 같은 말을 다시 보내면 된다.
    return send(res, 502, { error: "윤재가 잠깐 말을 고르고 있어요. 같은 말을 다시 보내 주세요.", retryable: true });
  }

  const next = recordTurn(state, { player: check.text, npc: reply.beats, suggested: reply.suggested, labels: reply.labels });
  const turn = next.turns.at(-1)!;
  await logTurn(next, turn, { reason: reply.reason, model: reply.model, usage: reply.usage, elapsedMs: Date.now() - started });

  send(res, 200, {
    token: encodeState(next),
    beats: reply.beats,
    turnsUsed: next.turns.length,
    charsLeft: RULES.charBudget - next.charsUsed,
    finished: next.finished,
  });
}
