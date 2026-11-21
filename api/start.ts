import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PARTNER_KEYS, scenarioFor, type Partner } from "../server/content.js";
import { fail, guarded, parseRequest, send } from "../server/http.js";
import { newGame, RULES } from "../server/rules.js";
import { createPlay, stats } from "../server/store.js";
import { encodeState } from "../server/token.js";

const Body = z.object({ consent: z.literal(true), heardBefore: z.boolean().optional(), partner: z.enum(PARTNER_KEYS as [Partner, ...Partner[]]) }).strict();

export default guarded(async (req, res) => {
  const b = parseRequest(req, res, Body);
  if (!b) return;

  const max = Number(process.env.MAX_TOTAL_PLAYS);
  if (Number.isFinite(max) && max > 0) {
    const s = await stats();
    if (s && s.total >= max) return fail(res, "closed", "은하연애위원회가 휴정 중이에요. 준비한 판이 모두 끝났어요.");
  }

  const state = newGame(randomUUID(), Date.now(), b.heardBefore === true, b.partner);
  try {
    await createPlay(state);
  } catch {
    return fail(res, "service_unavailable", "지금은 판을 시작할 수 없어요. 잠시 뒤 다시 시도해 주세요.");
  }
  send(res, 200, {
    token: encodeState(state),
    playId: state.id,
    scenario: scenarioFor(b.partner),
    rules: { maxTurns: RULES.maxTurns, charBudget: RULES.charBudget, messageMax: RULES.messageMax },
  });
});
