// 게임 규칙. 숫자는 첫 플레이 테스트(2026-11-21) 기준 초기값이며 목표치가 아니다.
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

export type MindLevel = 0 | 1 | 2 | 3;
export type AgreementStatus = "none" | "discussing" | "mutual" | "failed";
export const ISSUE_IDS = ["read-gap", "intent-trust", "availability", "repair-method"] as const;
export type IssueId = (typeof ISSUE_IDS)[number];
export type ProgressEvent =
  | { type: "acknowledged"; issue: IssueId }
  | { type: "player_accepts_limit"; issue: IssueId }
  | { type: "player_changes_approach"; issue: IssueId }
  | { type: "proposal_created"; issue: IssueId }
  | { type: "issue_resolved"; issue: IssueId }
  | { type: "mutual_agreement"; issue: "none" };

/** 이 판에서만 사는 NPC의 현재 마음. Core·장기 기억과 다르다. */
export interface CurrentMind {
  fatigue: MindLevel;
  guilt: MindLevel;
  defensiveness: MindLevel;
  care: MindLevel;
  openness: MindLevel;
  focus: string;
  want: string;
}

export interface RelationshipItem {
  text: string;
  status: "held" | "resolved";
  sourceTurn: number;
  evidence: string;
}

/** 이 판의 갈등에서 실제로 쌓인 관계 상태. 새 게임이면 폐기한다. */
export interface SessionRelationshipState {
  acknowledged: RelationshipItem[];
  retained: RelationshipItem[];
  unresolved: RelationshipItem[];
  playerStances: RelationshipItem[];
  proposals: RelationshipItem[];
  agreement: AgreementStatus;
  progress: ProgressEvent[];
}

export interface StateUpdate {
  mind: CurrentMind;
  acknowledge: string[];
  retain: string[];
  resolve: string[];
  playerStance: string[];
  propose: string[];
  agreement: AgreementStatus;
  evidence: string[];
  progress: ProgressEvent[];
}

/** 대사 생성 전에 확정하는 이번 턴의 관계 판단과 상태 변경 제안. */
export interface TurnFrame {
  /** 플레이어가 NPC에게 요청한 행동·범위 */
  request: string;
  /** 플레이어가 밝힌 이유·감정 */
  reason: string;
  /** NPC가 이번에 인정할 수 있는 구체적 사실 */
  acknowledge: string;
  /** NPC가 아직 유지하는 걱정·입장 */
  retain: string;
  /** 이번 대사에서 직접 다룰 하나의 초점 */
  focus: string;
  /** 대사를 쓰기 전에, 플레이어 발화만 놓고 확정한 점수 판단 */
  evaluation: {
    suggested_drop: number;
    labels: StrategyLabel[];
    reason: string;
    noticed: string;
    evidence: string[];
  };
  /** 서버 검증 뒤 이 판 상태에 반영할 제안 */
  stateUpdate: StateUpdate;
}

export interface TurnRecord {
  player: string;
  npc: { type: "dialogue" | "narration"; content: string }[];
  /** 윤재가 이 마디를 끝낸 방식 (예전 기록에는 없을 수 있음) */
  move?: NpcMove;
  /** 이 말을 들은 연인의 속마음 (리포트에서 공개) */
  thought?: string;
  /** 이 말에서 연인이 플레이어에 대해 알게 된 것 ("내가 본 너"의 근거) */
  noticed?: string;
  /** 대사 전에 정리한 관계 해석 (기존 기록에는 없을 수 있음) */
  frame?: TurnFrame;
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
  relationship: SessionRelationshipState;
  turns: TurnRecord[];
  finished: boolean;
  outcome: Outcome | null;
}

export function newGame(id: string, now: number, heardBefore: boolean, partner: "m" | "f" = "m"): GameState {
  return {
    v: 1, id, partner, startedAt: now, heardBefore, score: RULES.startScore, charsUsed: 0, turns: [], finished: false, outcome: null,
    currentMind: { fatigue: 3, guilt: 1, defensiveness: 3, care: 2, openness: 1, focus: "일부러 피한 건 아니라는 걸 알아줬으면 함", want: "걱정되면 무시라고 단정하기 전에 직접 말해줬으면 함" },
    relationship: { acknowledged: [], retained: [{ text: "일할 때 모든 연락에 바로 답할 수는 없다", status: "held", sourceTurn: 0, evidence: "장면 시작 입장" }, { text: "일부러 플레이어를 피한 것은 아니다", status: "held", sourceTurn: 0, evidence: "장면 시작 입장" }], unresolved: [{ text: "읽음 뒤 답장을 미룬 일이 만든 불안", status: "held", sourceTurn: 0, evidence: "장면 시작" }], playerStances: [], proposals: [], agreement: "none", progress: [] },
  };
}

const clampMind = (before: MindLevel, next: MindLevel): MindLevel => Math.max(0, Math.min(3, Math.max(before - 1, Math.min(before + 1, next)))) as MindLevel;
const addItems = (items: RelationshipItem[], texts: readonly string[], turn: number, evidence: string[]) => {
  const ev = evidence.join(" / ").slice(0, 180) || "이번 턴";
  for (const raw of texts) {
    const text = raw.trim().slice(0, 180);
    if (text && !items.some((x) => x.text === text)) items.push({ text, status: "held", sourceTurn: turn, evidence: ev });
  }
};

/** LLM 판단의 변경안을 서버가 제한적으로 적용한다. 중간 턴에는 상호 합의를 확정할 수 없다. */
export function applyStateUpdate(state: GameState, update: StateUpdate): Pick<GameState, "currentMind" | "relationship"> {
  const turn = state.turns.length + 1;
  const mind: CurrentMind = {
    fatigue: clampMind(state.currentMind.fatigue, update.mind.fatigue), guilt: clampMind(state.currentMind.guilt, update.mind.guilt),
    defensiveness: clampMind(state.currentMind.defensiveness, update.mind.defensiveness), care: clampMind(state.currentMind.care, update.mind.care),
    openness: clampMind(state.currentMind.openness, update.mind.openness), focus: update.mind.focus.slice(0, 180), want: update.mind.want.slice(0, 180),
  };
  const relationship: SessionRelationshipState = structuredClone(state.relationship);
  addItems(relationship.acknowledged, update.acknowledge, turn, update.evidence);
  addItems(relationship.retained, update.retain, turn, update.evidence);
  addItems(relationship.playerStances, update.playerStance, turn, update.evidence);
  addItems(relationship.proposals, update.propose, turn, update.evidence);
  for (const text of update.resolve) for (const item of [...relationship.unresolved, ...relationship.proposals]) if (item.text === text) item.status = "resolved";
  if (update.agreement === "mutual" && isFinalTurn(state)) relationship.agreement = "mutual";
  else if (update.agreement === "failed" || update.agreement === "discussing") relationship.agreement = update.agreement;
  return { currentMind: mind, relationship };
}

const progressKey = (e: ProgressEvent) => e.type === "mutual_agreement" ? e.type : `${e.type}:${e.issue}`;
const progressPoints: Record<ProgressEvent["type"], number> = { acknowledged: 1, player_accepts_limit: 2, player_changes_approach: 2, proposal_created: 2, issue_resolved: 3, mutual_agreement: 4 };

/**
 * AI의 suggested_drop은 이번 말 자체의 설득력(0~14 평가)이다.
 * 관계 이벤트와 실제 마음 변화는 작은 보너스다. 같은 변화에는 보너스를 다시 주지 않지만,
 * 이번 말 자체의 설득력은 AI의 평가를 그대로 반영한다.
 */
export function applyProgress(state: GameState, session: Pick<GameState, "currentMind" | "relationship">, update: StateUpdate, suggested: number, labels: readonly StrategyLabel[]): ScoreBreakdown {
  const purePressure = labels.includes("pressure") && !labels.some((l) => l !== "pressure");
  let eventBonus = 0;
  const seen = new Set(state.relationship.progress.map(progressKey));
  for (const event of update.progress) {
    const key = progressKey(event);
    if (seen.has(key)) continue;
    const allowed = event.type === "acknowledged" ? update.acknowledge.length > 0
      : event.type === "player_accepts_limit" || event.type === "player_changes_approach" ? update.playerStance.length > 0
      : event.type === "proposal_created" ? update.propose.length > 0
      : event.type === "issue_resolved" ? isFinalTurn(state) && update.resolve.length > 0
      : isFinalTurn(state) && session.relationship.agreement === "mutual";
    if (!allowed) continue;
    session.relationship.progress.push(event);
    seen.add(key);
    eventBonus += progressPoints[event.type];
  }
  const before = state.currentMind;
  const after = session.currentMind;
  const mindBonus = Math.min(3,
    Math.max(0, before.defensiveness - after.defensiveness)
    + Math.max(0, after.openness - before.openness)
    + Math.max(0, after.guilt - before.guilt)
    + Math.max(0, after.care - before.care),
  );
  const base = Math.min(RULES.maxSuggestedDrop, Math.max(0, Math.round(suggested)));
  if (purePressure) return { kind: "state", suggested, base, eventBonus: 0, mindBonus: 0, applied: Math.min(RULES.maxDropForPressure, base) };
  const applied = Math.min(RULES.maxDropPerTurn, base + eventBonus + mindBonus);
  return { kind: "state", suggested, base, eventBonus, mindBonus, applied };
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
  const session = applyStateUpdate(state, turn.frame?.stateUpdate ?? { mind: state.currentMind, acknowledge: [], retain: [], resolve: [], playerStance: [], propose: [], agreement: state.relationship.agreement, evidence: [], progress: [] });
  const scoring = turn.frame
    ? applyProgress(state, session, turn.frame.stateUpdate, turn.suggested, turn.labels)
    : { kind: "legacy" as const, suggested: turn.suggested, base: applyDrop(turn.suggested, turn.labels), eventBonus: 0, mindBonus: 0, applied: applyDrop(turn.suggested, turn.labels) };
  const applied = scoring.applied;
  const score = Math.max(0, state.score - applied);
  const turns = [...state.turns, { ...turn, applied, scoreBreakdown: scoring, scoreAfter: score }];
  const charsUsed = state.charsUsed + countChars(turn.player);
  const next: GameState = { ...state, score, turns, charsUsed, ...session };
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
