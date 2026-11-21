// 대화 리포트: 판이 끝나면 저장된 대화만으로 만든다 (LLM 호출 없음, 즉시).
// 숫자는 모두 "움직인 정도(+%)"로 보여 준다. 마음 지수(100에서 내려감)는 내부에서만 쓴다.
import { PARTNERS } from "./content.js";
import { RULES, shakePercent, type GameState, type Outcome } from "./rules.js";

export interface ReportTurn {
  turn: number;
  player: string;
  npc: { type: "narration" | "dialogue"; content: string }[];
  /** 이 마디에서 움직인 % */
  gain: number;
  /** 이 마디까지 누적으로 움직인 % */
  total: number;
  /** 연인의 속마음 (예전 기록에는 없을 수 있음) */
  thought: string | null;
}

export interface Report {
  kind: "report";
  v: 1;
  npcName: string;
  outcome: Outcome;
  /** 최종적으로 움직인 % */
  shake: number;
  /** 설득 성공 기준 % */
  successShake: number;
  turns: ReportTurn[];
  strongestTurn: number | null;
  weakestTurn: number | null;
}

export function buildReport(state: GameState): Report {
  const turns: ReportTurn[] = state.turns.map((t, i) => ({
    turn: i + 1,
    player: t.player,
    npc: t.npc,
    gain: t.applied,
    total: shakePercent(t.scoreAfter),
    thought: t.thought?.trim() || null,
  }));
  let strongest: ReportTurn | null = null;
  let weakest: ReportTurn | null = null;
  for (const t of turns) {
    if (!strongest || t.gain > strongest.gain) strongest = t;
    if (!weakest || t.gain < weakest.gain) weakest = t;
  }
  const flat = !strongest || !weakest || strongest.gain === weakest.gain;
  return {
    kind: "report",
    v: 1,
    npcName: PARTNERS[state.partner ?? "m"].name,
    outcome: state.outcome ?? "breakdown",
    shake: shakePercent(state.score),
    successShake: RULES.startScore - RULES.successScore,
    turns,
    strongestTurn: strongest && !flat ? strongest.turn : null,
    weakestTurn: weakest && !flat ? weakest.turn : null,
  };
}
