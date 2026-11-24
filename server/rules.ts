// 게임 규칙. 숫자는 첫 플레이 테스트(2026-11-21) 기준 초기값이며 목표치가 아니다.
import { applyFacts, initialLedger, isTurnFacts, nextMind, progressEvents, type LedgerItem, type Mind, type ProgressEvent, type TurnFacts } from "./ledger.js";
// LLM은 점수를 "제안"만 하고, 확정은 여기 규칙이 한다.

export const RULES = {
  maxTurns: 5,
  charBudget: 600,
  messageMax: 300,
  startScore: 100,
  /** 한 마디로 줄일 수 있는 최대치 */
  maxDropPerTurn: 20,
  /** AI가 발화 자체에 매길 수 있는 기본점수 상한. 나머지는 실제 관계·마음 변화로 얻는다. */
  maxSuggestedDrop: 14,
  /** 압박·반복으로만 이뤄진 말의 최대치 */
  maxDropForPressure: 3,
  /** 다섯 마디가 끝났을 때 이 값 이하면 설득 성공 (흔들림 70% 이상). 일찍 끝나지 않는다: 모두 같은 조건에서 비교 */
  successScore: 30,
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

/** NPC가 이번 차례를 끝내는 방식. 중간 마디는 서버가 정하고 출력이 지켰는지 검사한다. */
export const NPC_MOVES = ["counter", "ask", "concede", "linger"] as const;
export type NpcMove = (typeof NPC_MOVES)[number];

// 장부·감정 단계·점수 이벤트는 server/ledger.ts (docs/dialogue-architecture.md)
export { ISSUE_IDS } from "./ledger.js";
export type { IssueId, LedgerItem, Mind, MindLevel, ProgressEvent, TurnFacts } from "./ledger.js";

/** 이 판에서만 사는 NPC의 현재 마음 (0~3). 코드 규칙으로만 바뀐다 (ledger.ts nextMind). */
export type CurrentMind = Mind;

export interface TurnRecord {
  player: string;
  npc: { type: "dialogue" | "narration"; content: string }[];
  /** 윤재가 이 마디를 끝낸 방식 (예전 기록에는 없을 수 있음) */
  move?: NpcMove;
  /** 이 말을 들은 연인의 속마음 (리포트에서 공개) */
  thought?: string;
  /** 이 말에서 연인이 플레이어에 대해 알게 된 것 ("내가 본 너"의 근거) */
  noticed?: string;
  /** 1차 발화 분석을 검증해 확정한 이번 마디의 사실 (장부 도입 전 기록에는 없음) */
  facts?: TurnFacts;
  suggested: number;
  applied: number;
  labels: StrategyLabel[];
  /** 개발 진단용: 이 턴의 확정 점수 산식 */
  scoreBreakdown?: ScoreBreakdown;
  scoreAfter: number;
}

export interface ScoreBreakdown {
  kind: "state" | "legacy";
  suggested: number;
  base: number;
  eventBonus: number;
  mindBonus: number;
  applied: number;
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
  currentMind: CurrentMind;
  /** 대화 장부: 이 판에서 실제로 말해진 약속·제안·걱정·요청·한계 */
  ledger: LedgerItem[];
  /** 이미 점수를 준 관계 변화 (같은 변화에 두 번 주지 않는다) */
  progress: ProgressEvent[];
  /** 이번 판에서 플레이어가 직접 밝힌 서운함과 그에 대한 NPC 응답의 인용 근거. */
  relationshipEvidence?: RelationshipEvidence;
  turns: TurnRecord[];
  finished: boolean;
  outcome: Outcome | null;
}

/** 한 판에서 실제로 오간 서운함의 근거. 점수와 무관하며, 시작 카톡만으로는 채워지지 않는다. */
export interface RelationshipEvidence {
  player: { turn: number; itemId: string; quote: string; message: string } | null;
  npc: { turn: number; itemId: string; quote: string } | null;
}

/** 플레이어의 이번 판 발화와 윤재의 응답을 같은 장부 항목으로 잇는다. */
export function relationshipEvidence(state: GameState): RelationshipEvidence {
  const candidates = state.turns.flatMap((turn, index) => {
    const hasFeeling = turn.facts?.acts.some((act) => act.act === "feeling") ?? false;
    // 감정과 계기가 함께 말해진 경우만 인정한다. 오프닝의 L3은 후보가 아니다.
    if (!hasFeeling || !/(불안|서운|걱정|외롭|혼자|속상|무섭|섭섭|상처)/u.test(turn.player)
      || !/(읽|답|연락|소식|기다|카톡|메시지|15[:시])/u.test(turn.player)) return [];
    return (turn.facts?.added ?? [])
      .filter((item) => item.by === "player" && item.kind === "concern" && item.issue === "read-gap" && item.turn === index + 1)
      .map((item) => ({ turn: index + 1, itemId: item.id, quote: item.quote, message: turn.player }));
  });
  const responses = candidates.flatMap((player) => state.turns.flatMap((turn, index) => {
    if (index + 1 < player.turn) return [];
    const direct = turn.facts?.responseRefs?.some((ref) => ref.id === player.itemId && ref.use === "reflect");
    if (direct) {
      const quote = turn.npc.find((beat) => beat.type === "dialogue" && /(불안|서운|걱정|외롭|혼자|속상|무섭|섭섭|상처|기다)/u.test(beat.content))?.content;
      return quote ? [{ turn: index + 1, itemId: player.itemId, quote, player }] : [];
    }
    // 이전 턴의 응답은 다음 턴의 발화 분석에서 수용 근거로 확인될 수도 있다.
    const accepted = turn.facts?.resolved.find((r) => r.by === "npc" && r.id === player.itemId && r.status === "accepted");
    return accepted && index > 0 ? [{ turn: index, itemId: player.itemId, quote: accepted.quote, player }] : [];
  }));
  const response = responses[0];
  return {
    player: response?.player ?? candidates[0] ?? null,
    npc: response ? { turn: response.turn, itemId: response.itemId, quote: response.quote } : null,
  };
}

export function newGame(id: string, now: number, heardBefore: boolean, partner: "m" | "f" = "m"): GameState {
  return {
    v: 1, id, partner, startedAt: now, heardBefore, score: RULES.startScore, charsUsed: 0, turns: [], finished: false, outcome: null,
    currentMind: { fatigue: 3, guilt: 1, defensiveness: 3, care: 2, openness: 1 },
    ledger: initialLedger(),
    progress: [],
    relationshipEvidence: { player: null, npc: null },
  };
}

const progressKey = (e: ProgressEvent) => e.type === "mutual_agreement" ? e.type : `${e.type}:${e.issue}`;
const progressPoints: Record<ProgressEvent["type"], number> = { acknowledged: 1, player_accepts_limit: 2, player_changes_approach: 2, proposal_created: 2, issue_resolved: 3, mutual_agreement: 4 };

/**
 * AI의 suggested_drop은 이번 말 자체의 설득력(0~14 평가)이다.
 * 장부에서 도출한 관계 변화와 코드 규칙으로 계산한 마음 변화는 작은 보너스다.
 * 같은 변화에는 보너스를 다시 주지 않는다.
 */
export function scoreTurn(
  state: GameState,
  mindAfter: CurrentMind,
  events: readonly ProgressEvent[],
  suggested: number,
  labels: readonly StrategyLabel[],
): { breakdown: ScoreBreakdown; progress: ProgressEvent[] } {
  const progress = [...state.progress];
  const purePressure = labels.includes("pressure") && !labels.some((l) => l !== "pressure");
  const base = Math.min(RULES.maxSuggestedDrop, Math.max(0, Math.round(suggested)));
  if (purePressure) return { breakdown: { kind: "state", suggested, base, eventBonus: 0, mindBonus: 0, applied: Math.min(RULES.maxDropForPressure, base) }, progress };
  let eventBonus = 0;
  const seen = new Set(progress.map(progressKey));
  for (const e of events) {
    const key = progressKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    progress.push(e);
    eventBonus += progressPoints[e.type];
  }
  const before = state.currentMind;
  const mindBonus = Math.min(3,
    Math.max(0, before.defensiveness - mindAfter.defensiveness)
    + Math.max(0, mindAfter.openness - before.openness)
    + Math.max(0, mindAfter.guilt - before.guilt)
    + Math.max(0, mindAfter.care - before.care),
  );
  const applied = Math.min(RULES.maxDropPerTurn, base + eventBonus + mindBonus);
  return { breakdown: { kind: "state", suggested, base, eventBonus, mindBonus, applied }, progress };
}

/** 이번 말의 확정된 사실만으로 대사 전에 계산할 수 있는 변화. 응답 이후에도 같은 결과를 사용한다. */
export function projectTurn(state: GameState, facts: TurnFacts, suggested: number, labels: readonly StrategyLabel[]) {
  const ledger = applyFacts(state.ledger, facts, state.turns.length + 1);
  const prevFacts = state.turns.at(-1)?.facts;
  const currentMind = nextMind(state.currentMind, facts, ledger, prevFacts && isTurnFacts(prevFacts) ? prevFacts : null);
  const { breakdown, progress } = scoreTurn(state, currentMind, progressEvents(facts, ledger, isFinalTurn(state)), suggested, labels);
  return { ledger, currentMind, progress, breakdown, score: Math.max(0, state.score - breakdown.applied) };
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
  let session: Pick<GameState, "currentMind" | "ledger" | "progress"> = { currentMind: state.currentMind, ledger: state.ledger, progress: state.progress };
  let scoring: ScoreBreakdown;
  if (turn.facts && isTurnFacts(turn.facts)) {
    const projected = projectTurn(state, turn.facts, turn.suggested, turn.labels);
    session = { currentMind: projected.currentMind, ledger: projected.ledger, progress: projected.progress };
    scoring = projected.breakdown;
  } else {
    // 장부 도입 전 기록·대본 모드: AI 제안값만 규칙으로 자른다
    const applied = applyDrop(turn.suggested, turn.labels);
    scoring = { kind: "legacy", suggested: turn.suggested, base: applied, eventBonus: 0, mindBonus: 0, applied };
  }
  const applied = scoring.applied;
  const score = Math.max(0, state.score - applied);
  const turns = [...state.turns, { ...turn, applied, scoreBreakdown: scoring, scoreAfter: score }];
  const charsUsed = state.charsUsed + countChars(turn.player);
  const next: GameState = { ...state, score, turns, charsUsed, ...session };
  next.relationshipEvidence = relationshipEvidence(next);
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

/** 마지막 플레이어 말까지 들은 뒤에만 합의 여부를 판단한다. */
export function isFinalTurn(state: GameState): boolean {
  return state.turns.length + 1 >= RULES.maxTurns;
}

/**
 * 중간 마디의 끝맺음 방식. 반론·질문으로 대화를 이어가고, 결론은 마지막 마디에만 모델이 고른다.
 * 질문은 한 판에 최대 2번, 연속 금지다.
 */
export function chooseMove(state: GameState): NpcMove {
  const n = state.turns.length + 1; // 이번이 몇 번째 마디인지
  const prev = state.turns.at(-1)?.move;
  const asks = state.turns.filter((t) => t.move === "ask").length;
  if (isFinalTurn(state)) return "counter"; // 실제 마지막 결정은 npcReply가 현재 플레이어 말을 읽고 고른다.
  const canAsk = asks < 2 && prev !== "ask";
  const r = seeded(state.id, n);

  if (n === 1) return "counter";
  if (canAsk && r < 0.3) return "ask";
  return "counter";
}
