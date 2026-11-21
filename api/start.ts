import { randomUUID } from "node:crypto";
import { SCENARIO } from "../server/content.js";
import { body, onlyPost, send, type Req, type Res } from "../server/http.js";
import { logStart, stats } from "../server/log.js";
import { newGame, RULES } from "../server/rules.js";
import { encodeState } from "../server/token.js";

export default async function handler(req: Req, res: Res) {
  if (!onlyPost(req, res)) return;
  const b = body(req);
  if (b.consent !== true) return send(res, 400, { error: "시작하려면 대화 기록 활용에 동의해 주세요." });

  const max = Number(process.env.MAX_TOTAL_PLAYS);
  if (Number.isFinite(max) && max > 0) {
    const s = await stats();
    if (s && s.total >= max) return send(res, 503, { error: "은하연애위원회가 휴정 중이에요. 준비한 판이 모두 끝났어요.", closed: true });
  }

  const state = newGame(randomUUID(), Date.now(), b.heardBefore === true);
  await logStart(state);
  send(res, 200, {
    token: encodeState(state),
    scenario: { title: SCENARIO.title, npcName: SCENARIO.npcName, place: SCENARIO.place, kakao: SCENARIO.kakao, opening: SCENARIO.opening },
    rules: { maxTurns: RULES.maxTurns, charBudget: RULES.charBudget, messageMax: RULES.messageMax },
  });
}
