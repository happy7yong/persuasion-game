// 한 마디 처리. relationship-engine의 규칙:
// - 같은 idempotency_key의 재전송은 LLM을 다시 부르지 않고 처음 결과를 돌려준다 (api.md §2.3).
// - 생성 실패는 자동 재시도 1회 후 generation_failed. 상태를 바꾸지 않으므로 같은 키로 다시 보내면 된다.
// - 마디는 저장에 성공한 뒤에만 화면에 보낸다. 대체 대사는 만들지 않는다 (D-043).
import { waitUntil } from "@vercel/functions";
import { z } from "zod";
import { PARTNERS } from "../server/content.js";
import { fail, guarded, IdempotencyKey, parseRequest, send, type Res } from "../server/http.js";
import { npcReply, NPC_PROMPT_VERSION } from "../server/npc.js";
import { checkMessage, recordTurn, RULES, type GameState } from "../server/rules.js";
import { insertTurn, listTurns, saveAttempts, StoreError, type StoredTurn } from "../server/store.js";
import { catchUp, toExchanges, type Exchange } from "../server/sync.js";
import { decodeState, encodeState } from "../server/token.js";

const Body = z.object({ token: z.string().min(1), message: z.string().max(2000), idempotency_key: IdempotencyKey }).strict();

function progress(state: GameState) {
  return { token: encodeState(state), turnsUsed: state.turns.length, charsLeft: RULES.charBudget - state.charsUsed, finished: state.finished };
}

/** 저장된 기록이 토큰보다 앞서 있을 때: 같은 키면 처음 결과, 다른 키면 resync와 함께 409. */
function answerFromStore(res: Res, key: string, state: GameState, rows: StoredTurn[]): boolean {
  const { latest, extra } = catchUp(state, rows);
  if (extra.length === 0) {
    if (rows.some((r) => r.idempotency_key === key)) {
      fail(res, "idempotency_key_reused", "이미 전달된 말이에요.", { resync: { exchanges: [], ...progress(state) } });
      return true;
    }
    return false;
  }
  const exchanges: Exchange[] = toExchanges(extra);
  if (extra.at(-1)!.idempotency_key === key) {
    send(res, 200, { exchanges, replayed: true, ...progress(latest) });
  } else {
    fail(res, "turn_already_recorded", "앞서 보낸 말이 이미 전달돼 있었어요. 이어서 말해 주세요.", { resync: { exchanges, ...progress(latest) } });
  }
  return true;
}

export default guarded(async (req, res) => {
  const b = parseRequest(req, res, Body);
  if (!b) return;
  let state = decodeState(b.token);
  if (!state) return fail(res, "session_expired", "판 정보가 만료됐어요. 처음부터 다시 시작해 주세요.");

  let rows: StoredTurn[] | null;
  try {
    rows = await listTurns(state.id);
  } catch {
    return fail(res, "service_unavailable", "기록 저장소에 연결하지 못했어요. 잠시 뒤 다시 보내 주세요.");
  }
  if (rows && answerFromStore(res, b.idempotency_key, state, rows)) return;

  const check = checkMessage(state, b.message);
  if (!check.ok) return fail(res, state.finished ? "invalid_turn_state" : "invalid_request", check.reason);

  const started = Date.now();
  const result = await npcReply(state, check.text);
  const idx = state.turns.length + 1;
  waitUntil(Promise.all([
    saveAttempts(state.id, "turn_frame", idx, NPC_PROMPT_VERSION, result.factsAttempts),
    saveAttempts(state.id, "npc_turn", idx, NPC_PROMPT_VERSION, result.attempts),
    saveAttempts(state.id, "scene_check", idx, NPC_PROMPT_VERSION, result.sceneAttempts),
  ]));
  if (!result.ok) {
    console.warn("[turn] generation_failed", state.id, idx, result.failure.message);
    return fail(res, "generation_failed", `${PARTNERS[state.partner ?? "m"].name}가 잠깐 말을 고르고 있어요. 같은 말을 다시 보내 주세요.`);
  }

  const { reply } = result;
  const next = recordTurn(state, {
    player: check.text,
    npc: reply.beats,
    move: reply.move,
    facts: reply.facts,
    thought: reply.reason,
    noticed: reply.noticed,
    suggested: reply.suggested,
    labels: reply.labels,
  });
  const turn = next.turns.at(-1)!;
  try {
    const saved = await insertTurn(state, {
      idx,
      idempotency_key: b.idempotency_key,
      player_text: turn.player,
      npc_beats: turn.npc,
      npc_move: reply.move,
      reason: reply.reason,
      noticed: reply.noticed,
      suggested_drop: turn.suggested,
      labels: turn.labels,
      state_frame: reply.facts,
      checks: { outcome: reply.outcome, attempts: reply.checks },
      applied_drop: turn.applied,
      score_after: turn.scoreAfter,
      model: reply.model,
      usage: reply.usage,
      elapsed_ms: Date.now() - started,
      prompt_version: NPC_PROMPT_VERSION,
    });
    if (saved === "conflict") {
      // 같은 마디를 동시에 처리한 다른 요청이 먼저 저장했다. 저장된 쪽이 기준이다.
      const latestRows = (await listTurns(state.id)) ?? [];
      if (answerFromStore(res, b.idempotency_key, state, latestRows)) return;
      return fail(res, "service_unavailable", "기록을 맞추지 못했어요. 잠시 뒤 다시 보내 주세요.");
    }
  } catch (e) {
    console.warn("[turn] store failed", state.id, idx, e instanceof StoreError ? e.message : "");
    return fail(res, "service_unavailable", "대화를 저장하지 못했어요. 같은 말을 다시 보내 주세요.");
  }

  state = next;
  send(res, 200, { exchanges: [{ player: turn.player, beats: turn.npc }], replayed: false, ...progress(state) });
});
