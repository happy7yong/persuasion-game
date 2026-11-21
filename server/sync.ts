// 저장된 마디로 토큰의 상태를 따라잡는다. 응답을 못 받은 클라이언트가 옛 토큰으로 다시 와도
// 서버의 기록이 기준이 된다.
import { recordTurn, type GameState } from "./rules.js";
import type { StoredTurn } from "./store.js";

export interface Exchange {
  player: string;
  beats: { type: "narration" | "dialogue"; content: string }[];
}

/** 토큰 상태 이후에 저장된 마디를 순서대로 다시 적용한다. */
export function catchUp(state: GameState, rows: readonly StoredTurn[]): { latest: GameState; extra: StoredTurn[] } {
  const extra = rows.filter((r) => r.idx > state.turns.length).sort((a, b) => a.idx - b.idx);
  let latest = state;
  for (const r of extra) {
    if (latest.finished) break;
    latest = recordTurn(latest, { player: r.player_text, npc: r.npc_beats, suggested: Number(r.suggested_drop), labels: r.labels });
  }
  return { latest, extra };
}

export const toExchanges = (rows: readonly StoredTurn[]): Exchange[] => rows.map((r) => ({ player: r.player_text, beats: r.npc_beats }));
