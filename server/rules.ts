// 게임 규칙. 숫자는 첫 플레이 테스트(2026-11-21) 기준 초기값이며 목표치가 아니다.
// LLM은 점수를 "제안"만 하고, 확정은 여기 규칙이 한다.

export const RULES = {
  maxTurns: 5,
  charBudget: 600,
  messageMax: 300,
  startScore: 100,
  /** 한 마디로 줄일 수 있는 최대치 */
  maxDropPerTurn: 20,
  /** 압박·반복으로만 이뤄진 말의 최대치 */
  maxDropForPressure: 3,
  /** 다섯 마디가 끝났을 때 이 값 이하면 설득 성공 (흔들림 60% 이상). 일찍 끝나지 않는다: 모두 같은 조건에서 비교 */
  successScore: 40,
  /** 이 값 이하로 끝나면 타협 (흔들림 30% 이상) */
  compromiseScore: 70,
} as const;

export const STRATEGY_LABELS = [
  "logic", // 논리·근거
  "emotion", // 솔직한 감정 표현
  "question", // 상대 생각을 묻기
  "compromise", // 구체적 타협안
  "apology", // 사과·인정
  "empathy", // 상대 입장 이해
  "humor", // 장난·유머
  "pressure", // 압박·비난·죄책감·반복
] as const;
export type StrategyLabel = (typeof STRATEGY_LABELS)[number];

export type Outcome = "success" | "compromise" | "breakdown" | "giveup";

/** 윤재가 이번 차례를 끝내는 방식. 서버가 정하고 출력이 지켰는지 검사한다. */
export const NPC_MOVES = ["counter", "ask", "concede", "linger"] as const;
export type NpcMove = (typeof NPC_MOVES)[number];

export interface TurnRecord {
  player: string;
  npc: { type: "dialogue" | "narration"; content: string }[];
  /** 윤재가 이 마디를 끝낸 방식 (예전 기록에는 없을 수 있음) */
  move?: NpcMove;
  /** 이 말을 들은 연인의 속마음 (리포트에서 공개) */
  thought?: string;
  suggested: number;
  applied: number;
  labels: StrategyLabel[];
  scoreAfter: number;
}

export interface GameState {
  v: 1;
  id: string;
  /** 고른 연인. 예전 토큰에는 없을 수 있으며 그때는 "m" */
  partner?: "m" | "f";
  startedAt: number;
  heardBefore: boolean;
  score: number;
  charsUsed: number;
  turns: TurnRecord[];
  finished: boolean;
  outcome: Outcome | null;
}

export function newGame(id: string, now: number, heardBefore: boolean, partner: "m" | "f" = "m"): GameState {
  return { v: 1, id, partner, startedAt: now, heardBefore, score: RULES.startScore, charsUsed: 0, turns: [], finished: false, outcome: null };
}

/** 글자 수. 이모지 등 서로게이트 쌍을 한 글자로 센다. */
export function countChars(text: string): number {
  return Array.from(text).length;
}

export type MessageCheck = { ok: true; text: string } | { ok: false; reason: string };

export function checkMessage(state: GameState, raw: string): MessageCheck {
  if (state.finished) return { ok: false, reason: "이미 끝난 판이에요. 새로 시작해 주세요." };
  if (state.turns.length >= RULES.maxTurns) return { ok: false, reason: "다섯 마디를 모두 썼어요." };
  const text = raw.replace(/\s+$/u, "").replace(/^\s+/u, "");
  const n = countChars(text);
  if (n === 0) return { ok: false, reason: "할 말을 입력해 주세요." };
  if (n > RULES.messageMax) return { ok: false, reason: `한 번에 ${RULES.messageMax}자까지 말할 수 있어요.` };
  if (state.charsUsed + n > RULES.charBudget) return { ok: false, reason: `발언권이 ${RULES.charBudget - state.charsUsed}자 남았어요.` };
  return { ok: true, text };
}

/** LLM의 제안값을 규칙에 맞게 확정한다. */
export function applyDrop(suggested: number, labels: readonly StrategyLabel[]): number {
  const s = Number.isFinite(suggested) ? Math.round(suggested) : 0;
  let drop = Math.min(Math.max(s, 0), RULES.maxDropPerTurn);
  const constructive = labels.some((l) => l !== "pressure");
  if (labels.includes("pressure") && !constructive) drop = Math.min(drop, RULES.maxDropForPressure);
  return drop;
}

export function shakePercent(score: number): number {
  return Math.max(0, Math.min(100, RULES.startScore - score));
}

export function band(score: number): "firm" | "wavering" | "seeking" | "accepting" {
  if (score > 80) return "firm";
  if (score > 60) return "wavering";
  if (score > RULES.successScore) return "seeking";
  return "accepting";
}

export function recordTurn(state: GameState, turn: Omit<TurnRecord, "scoreAfter" | "applied">): GameState {
  const applied = applyDrop(turn.suggested, turn.labels);
  const score = Math.max(0, state.score - applied);
  const turns = [...state.turns, { ...turn, applied, scoreAfter: score }];
  const charsUsed = state.charsUsed + countChars(turn.player);
  const next: GameState = { ...state, score, turns, charsUsed };
  const outOfTurns = turns.length >= RULES.maxTurns;
  const outOfChars = charsUsed >= RULES.charBudget;
  if (outOfTurns || outOfChars) return finish(next, null);
  return next;
}

export function finish(state: GameState, forced: "giveup" | null): GameState {
  if (state.finished) return state;
  const outcome: Outcome =
    forced ?? (state.score <= RULES.successScore ? "success" : state.score <= RULES.compromiseScore ? "compromise" : "breakdown");
  return { ...state, finished: true, outcome };
}

/** 같은 판, 같은 마디에서는 항상 같은 값이 나오는 0~1 난수 (재시도·따라잡기에도 같은 방식이 나오게). */
function seeded(id: string, n: number): number {
  let h = 2166136261;
  for (const c of `${id}:${n}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * 윤재가 이번 마디를 끝내는 방식을 정한다.
 * - 반론이 기본. 질문은 한 판에 최대 2번, 연속 금지, 마지막 마디 금지 (플레이어가 대답만 하는 흐름을 막는다).
 * - 조건부 수긍은 마음이 충분히 흔들린 구간에서만.
 */
export function chooseMove(state: GameState): NpcMove {
  const n = state.turns.length + 1; // 이번이 몇 번째 마디인지
  const prev = state.turns.at(-1)?.move;
  const asks = state.turns.filter((t) => t.move === "ask").length;
  const canAsk = n < RULES.maxTurns && asks < 2 && prev !== "ask";
  const b = band(state.score);
  const r = seeded(state.id, n);

  if (b === "accepting") return r < 0.7 ? "concede" : "linger";
  if (b === "seeking") return r < 0.5 ? "concede" : r < 0.8 ? "counter" : "linger";
  // 단호하거나 흔들리는 중
  if (n === 1) return r < 0.75 ? "counter" : "linger";
  if (canAsk && r < 0.3) return "ask";
  if (prev === "linger") return "counter";
  return r < 0.8 ? "counter" : "linger";
}
