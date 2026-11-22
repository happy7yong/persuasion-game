import { z } from "zod";
import { BAND_GUIDE, COMMON_PRINCIPLES, coreFor, ENGINE_RULES, forPartner, MOVE_GUIDE, OUTPUT_FORMAT, rubricFor, SCENARIO, sceneFactsFor, scenarioFor } from "./content.js";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { band, chooseMove, isFinalTurn, ISSUE_IDS, STRATEGY_LABELS, type GameState, type NpcMove, type StrategyLabel, type TurnFrame } from "./rules.js";

const BeatSchema = z.object({
  type: z.enum(["narration", "dialogue"]),
  content: z.string().trim().min(1).max(300),
});

export const NpcOutputSchema = z.object({
  beats: z.array(BeatSchema).min(1).max(4),
  thought: z.string().trim().min(1).max(80),
});

export interface NpcReply {
  beats: { type: "narration" | "dialogue"; content: string }[];
  move: NpcMove;
  /** 대사 전에 확정한 이번 턴의 관계 해석 */
  frame: TurnFrame;
  suggested: number;
  labels: StrategyLabel[];
  reason: string;
  /** 이번 말에서 플레이어에 대해 알게 된 것 (마지막 판단의 근거) */
  noticed: string;
  model: string;
  usage: LlmUsage | null;
}

const isLabel = (s: string): s is StrategyLabel => (STRATEGY_LABELS as readonly string[]).includes(s);

const TurnFrameSchema = z.object({
  request: z.string().trim().min(1).max(180),
  reason: z.string().trim().min(1).max(180),
  acknowledge: z.string().trim().min(1).max(180),
  retain: z.string().trim().min(1).max(180),
  focus: z.string().trim().min(1).max(180),
  evaluation: z.object({
    suggested_drop: z.number().int().min(0).max(14),
    labels: z.array(z.enum(STRATEGY_LABELS)).max(2),
    reason: z.string().trim().min(1).max(180),
    noticed: z.string().trim().min(1).max(80),
    evidence: z.array(z.string().trim().min(1).max(180)).max(2),
  }),
  stateUpdate: z.object({
    mind: z.object({ fatigue: z.number().int().min(0).max(3), guilt: z.number().int().min(0).max(3), defensiveness: z.number().int().min(0).max(3), care: z.number().int().min(0).max(3), openness: z.number().int().min(0).max(3), focus: z.string().trim().min(1).max(180), want: z.string().trim().min(1).max(180) }),
    acknowledge: z.array(z.string().trim().min(1).max(180)).max(2), retain: z.array(z.string().trim().min(1).max(180)).max(2), resolve: z.array(z.string().trim().min(1).max(180)).max(2), playerStance: z.array(z.string().trim().min(1).max(180)).max(2), propose: z.array(z.string().trim().min(1).max(180)).max(2),
    agreement: z.enum(["none", "discussing", "mutual", "failed"]), evidence: z.array(z.string().trim().min(1).max(180)).max(3),
    progress: z.array(z.object({ type: z.enum(["acknowledged", "player_accepts_limit", "player_changes_approach", "proposal_created", "issue_resolved", "mutual_agreement"]), issue: z.enum([...ISSUE_IDS, "none"]) })).max(3),
  }),
});

export function parseTurnFrame(raw: unknown): TurnFrame {
  return TurnFrameSchema.parse(raw) as TurnFrame;
}

const TURN_FRAME_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["request", "reason", "acknowledge", "retain", "focus", "evaluation", "stateUpdate"],
  properties: {
    request: { type: "string" },
    reason: { type: "string" },
    acknowledge: { type: "string" },
    retain: { type: "string" },
    focus: { type: "string" },
    evaluation: { type: "object", additionalProperties: false, required: ["suggested_drop", "labels", "reason", "noticed", "evidence"], properties: {
      suggested_drop: { type: "integer", minimum: 0, maximum: 14 }, labels: { type: "array", maxItems: 2, items: { type: "string", enum: [...STRATEGY_LABELS] } }, reason: { type: "string" }, noticed: { type: "string" }, evidence: { type: "array", maxItems: 2, items: { type: "string" } },
    } },
      stateUpdate: { type: "object", additionalProperties: false, required: ["mind", "acknowledge", "retain", "resolve", "playerStance", "propose", "agreement", "evidence", "progress"], properties: {
      mind: { type: "object", additionalProperties: false, required: ["fatigue", "guilt", "defensiveness", "care", "openness", "focus", "want"], properties: { fatigue: { type: "integer", minimum: 0, maximum: 3 }, guilt: { type: "integer", minimum: 0, maximum: 3 }, defensiveness: { type: "integer", minimum: 0, maximum: 3 }, care: { type: "integer", minimum: 0, maximum: 3 }, openness: { type: "integer", minimum: 0, maximum: 3 }, focus: { type: "string" }, want: { type: "string" } } },
      acknowledge: { type: "array", maxItems: 2, items: { type: "string" } }, retain: { type: "array", maxItems: 2, items: { type: "string" } }, resolve: { type: "array", maxItems: 2, items: { type: "string" } }, playerStance: { type: "array", maxItems: 2, items: { type: "string" } }, propose: { type: "array", maxItems: 2, items: { type: "string" } }, agreement: { type: "string", enum: ["none", "discussing", "mutual", "failed"] }, evidence: { type: "array", maxItems: 3, items: { type: "string" } }, progress: { type: "array", maxItems: 3, items: { type: "object", additionalProperties: false, required: ["type", "issue"], properties: { type: { type: "string", enum: ["acknowledged", "player_accepts_limit", "player_changes_approach", "proposal_created", "issue_resolved", "mutual_agreement"] }, issue: { type: "string", enum: [...ISSUE_IDS, "none"] } } } },
    } },
  },
} as const;

const ENDS_WITH_QUESTION = /[?？]\s*[)"”’…~.]*\s*$/u;

/** 끝맺음 방식을 지켰는지. 질문은 ask일 때만, 여운은 행동 묘사로 끝난다. 위반 사유 또는 null. */
export function moveViolation(move: NpcMove, beats: { type: string; content: string }[]): string | null {
  const last = beats.at(-1);
  if (!last) return "no_beats";
  const asks = beats.some((b) => b.type === "dialogue" && ENDS_WITH_QUESTION.test(b.content.trim()));
  const dialogueCount = beats.filter((b) => b.type === "dialogue").length;
  if (move !== "ask" && asks) return `question_in_${move}`;
  if (move === "counter" && dialogueCount > 2) return "counter_too_many_dialogues";
  if (move === "linger" && dialogueCount > 1) return "linger_too_many_dialogues";
  if (move === "linger" && last.type !== "narration") return "linger_not_narration";
  return null;
}

export function parseNpcOutput(raw: unknown, move: NpcMove = "counter", strict = false): Pick<NpcReply, "beats" | "move" | "reason"> {
  const out = NpcOutputSchema.parse(raw);
  const beats = out.beats.map((b) => ({ type: b.type, content: b.content.replace(/^["“]|["”]$/g, "") }));
  if (strict) {
    const v = moveViolation(move, beats);
    if (v) throw new Error(`move_violation:${v}`);
  }
  return {
    beats,
    move,
    reason: out.thought.slice(0, 80),
  };
}

/**
 * 바로 직전 NPC 대사를 뜻만 바꿔 되풀이하는 출력을 막는다.
 * 모델의 의미 판단을 완전히 대체할 수는 없으므로, 한국어 음절 2-gram이 크게 겹치는
 * 명백한 재진술만 거부한다. 프롬프트의 진행 지시와 함께 쓰는 안전망이다.
 */
export function replyRepetitionViolation(state: GameState, beats: { type: string; content: string }[], playerText = ""): string | null {
  const previous = state.turns.at(-1)?.npc
    .filter((beat) => beat.type === "dialogue")
    .map((beat) => beat.content)
    .join(" ") ?? "";
  const candidate = beats
    .filter((beat) => beat.type === "dialogue")
    .map((beat) => beat.content)
    .join(" ");
  const a = normalizedBigrams(previous);
  const b = normalizedBigrams(candidate);
  if (a.size < 18 || b.size < 18) return null;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  if ((2 * shared) / (a.size + b.size) >= 0.6) return "reply_repeats_previous";

  // "응, 알겠어"처럼 새 정보 없는 수용 다음에는, 바로 전 대사의 핵심어 하나만
  // 되풀이해도 진행이 멈춘다. 한국어 활용형(늦어질/늦을)은 2-gram으로 놓치므로
  // 이 좁은 경우에만 단어 겹침을 추가로 본다.
  if (isBriefAcknowledgement(playerText) && sharedContentTerm(previous, candidate)) return "reply_repeats_previous";
  return null;
}

function normalizedBigrams(text: string): Set<string> {
  const compact = text.toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
  return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, i) => compact.slice(i, i + 2)));
}

function isBriefAcknowledgement(text: string): boolean {
  const compact = text.replace(/[^\p{L}\p{N}]/gu, "");
  return /^(응|웅|어|그래|알겠어|알았어|응알겠어|그래알겠어|ㅇㅇ)$/u.test(compact);
}

function sharedContentTerm(a: string, b: string): boolean {
  const terms = (text: string) => new Set(
    (text.match(/[가-힣]{3,}/g) ?? [])
      .map((word) => word.replace(/(으로|에게서|에서|부터|까지|처럼|은|는|이|가|을|를|에|의|도|만|과|와|로)$/u, ""))
      .filter((word) => word.length >= 3 && !["그래서", "그렇게", "하지만", "그러니까", "아니었어"].includes(word)),
  );
  const left = terms(a);
  return [...terms(b)].some((word) => left.has(word));
}

export function buildNpcPrompt(
  state: GameState,
  playerText: string,
  move: NpcMove | null = state.turns.length === 0 || isFinalTurn(state) ? null : chooseMove(state),
  frame?: TurnFrame,
): { system: string; user: string } {
  const partner = state.partner ?? "m";
  const finalTurn = isFinalTurn(state);
  const system = [
    ENGINE_RULES,
    COMMON_PRINCIPLES,
    coreFor(partner),
    `# 장면\n- 장소: ${SCENARIO.place}\n- 대화 방식: 직접 마주하고 있다\n## 네가 아는 사실\n${sceneFactsFor(partner).map((f) => `- ${f}`).join("\n")}`,
    `# 지금 상태\n${BAND_GUIDE[band(state.score)]}\n이번 말이 좋았다면 그만큼 반응에 드러내되, 지금 상태보다 한 단계 넘게 갑자기 바뀌지 않는다.`,
    `# 이번 세션의 현재 마음과 관계 상태\n${sessionStateText(state)}\n이 상태는 이 판에서만 이어지는 실제 판단의 재료다. Core를 덮어쓰지 않는다. 이미 인정한 사실을 처음 깨달은 것처럼 반복하지 말고, 아직 유지하는 입장과 미해결 쟁점을 이어서 다룬다.`,
    "# 직전 응답과 반복 금지\n- 직전 네 대사에서 이미 설명한 사정·조건·결론을 같은 뜻의 다른 문장으로 다시 말하지 않는다. 특히 답장을 바로 하기 어렵다는 설명, 미리 한마디 하겠다는 약속처럼 이미 나온 핵심은 재진술 금지다.\n- 플레이어가 새 요구·이유 없이 짧게 수용하거나 확인했다면, 그 수용을 짧게 받거나 행동으로 반응하고 멈춘다. 같은 반론을 다시 증명하려 하지 않는다.\n- 이번 대사는 직전 응답에 없던 구체적인 반응·조건 조정·질문·행동 중 하나를 더할 때만 길게 쓴다. 새로 보탤 것이 없으면 짧게 끝낸다.",
    frame
      ? `# 이번 턴 관계 해석 (대사 전에 확정됨)\n- 플레이어의 요청: ${frame.request}\n- 플레이어가 밝힌 이유·감정: ${frame.reason}\n- 네가 인정할 수 있는 사실: ${frame.acknowledge}\n- 네가 아직 유지하는 입장: ${frame.retain}\n- 이번 대사의 초점: ${frame.focus}\n이 해석의 행위자·횟수·시간 범위를 바꾸지 않는다. 대사는 이 초점 하나에 반응하고, 해석에 없는 약속·사실·요구를 만들지 않는다.`
      : null,
    OUTPUT_FORMAT,
    move === null && finalTurn
      ? "# 마지막 응답의 결정\n이번이 마지막 플레이어 발화다. 지금까지 대화와 방금 말을 모두 읽고 이번 대화의 결말을 정한다. 플레이어가 네 핵심 걱정·반론에 직접 답하고, 실제로 납득할 이유를 보였다면 조건부 수긍(concede)을 고를 수 있다. 일부만 납득했거나 아직 설득되지 않았다면 counter 또는 linger를 고른다. ask는 고를 수 없다. 이전 마디에서 이미 수긍한 것처럼 말하지 말고, 방금 말까지 포함해 판단한다. 실제로 고른 방식을 move에 기록한다."
      : move === null
        ? `# 첫 응답의 끝맺음\n방금 들은 말 중 네가 바로 반응하고 싶은 구체적인 대목에 반응한다. 억울하면 받아치고(counter), 더 듣고 싶은 게 생기면 그 일에 관해 한 가지만 묻는다(ask). 첫 마디에는 합의(concede)나 여운(linger)으로 끝내지 않는다. 해결책은 플레이어가 꺼내게 둔다. 실제로 고른 방식을 move에 기록한다.\n\ncounter를 골랐다면 아래 조건을 모두 지킨다:\n${MOVE_GUIDE.counter}\n\nask를 골랐다면 아래 조건을 모두 지킨다:\n${MOVE_GUIDE.ask}`
      : `# 이번 차례를 끝내는 방식\n${MOVE_GUIDE[move]}`,
  ].join("\n\n");

  // B(relationship-engine)의 대화 기록 형식: 너/플레이어, 말/행동을 나눠 2인칭으로 준다.
  const lines = conversationLines(state);
  const user = `# 지금까지 네가 보고 들은 대화
${lines.join("\n")}

# 방금 플레이어가 한 것
- 플레이어 (말): ${playerText}

# 이번 차례
위 규칙에 따라 JSON으로 답한다.`;
  return { system, user };
}

/** 프레임 생성과 대사 생성이 같은 대화 이력을 보게 한다. */
function conversationLines(state: GameState): string[] {
  const partner = state.partner ?? "m";
  const lines: string[] = scenarioFor(partner).opening.map(beatLine);
  for (const t of state.turns) {
    lines.push(`- 플레이어 (말): ${t.player}`);
    lines.push(...t.npc.map(beatLine));
  }
  return lines;
}

function sessionStateText(state: GameState): string {
  const mind = state.currentMind;
  const list = (xs: { text: string; status: string }[]) => xs.filter((x) => x.status === "held").map((x) => x.text).join(" / ") || "없음";
  const expression = mind.defensiveness === 3 && mind.guilt <= 1
    ? "- 대사 반영: 지금은 방어심이 아주 높고 미안함은 낮다. 사실만 설명하고 끝내지 말고, 플레이어가 네 의도를 어떻게 받아들인 점이 왜 억울하거나 서운한지 한 문장으로 드러낸다. 감정 단어만 던지지 말고 대상은 구체적으로 말한다."
    : mind.defensiveness <= 1 && mind.openness >= 2
      ? "- 대사 반영: 방어하기보다 상대가 겪은 결과를 먼저 듣고, 이미 납득한 부분을 실제 말에 반영한다."
      : "- 대사 반영: 미안함과 자기 입장 중 지금 더 큰 쪽이 자연스럽게 먼저 나온다.";
  return `- 마음: 피곤 ${mind.fatigue}, 미안함 ${mind.guilt}, 방어심 ${mind.defensiveness}, 챙기고 싶은 마음 ${mind.care}, 마음 열림 ${mind.openness}\n${expression}\n- 지금 신경 쓰는 것: ${mind.focus}\n- 지금 바라는 것: ${mind.want}\n- 이미 인정한 사실: ${list(state.relationship.acknowledged)}\n- 아직 유지하는 입장: ${list(state.relationship.retained)}\n- 미해결 쟁점: ${list(state.relationship.unresolved)}\n- 검토 중인 방법: ${list(state.relationship.proposals)}\n- 합의 상태: ${state.relationship.agreement}`;
}

/** 대사 없이 이번 턴의 관계 해석만 고정하는 첫 단계 프롬프트. */
export function buildTurnFramePrompt(state: GameState, playerText: string): { system: string; user: string } {
  const partner = state.partner ?? "m";
  const finalTurn = isFinalTurn(state);
  const system = `# 역할
너는 대사를 쓰지 않는 관계 대화 해석기다. 아래 대화에서 이번 플레이어 말의 의미와 NPC의 이번 반응 범위를 JSON으로만 정리한다.

# 해석 규칙
- 플레이어의 말 속 "너/네가"는 NPC를 뜻한다. 행위자·횟수·시간 범위를 정확히 보존한다.
- 플레이어가 요구를 좁혀 정정했다면, 이미 부정한 넓은 요구를 다시 만들지 않는다.
- request에는 NPC가 하길 바라는 행동과 범위를 쓴다. 없으면 "구체적 요청 없음"이라고 쓴다.
- reason에는 플레이어가 실제로 밝힌 이유·감정만 쓴다. 없으면 "이번 말에서 이유를 밝히지 않음"이라고 쓴다.
- acknowledge에는 반드시 "NPC가 한 행동 → 플레이어에게 생긴 결과" 형태로, NPC가 이번 말에서 인정할 수 있는 구체적 사실 하나를 쓴다. 플레이어 감정만 단독으로 쓰지 않는다. 없으면 "바로 인정할 사실 없음"이라고 쓴다.
- retain에는 NPC가 아직 유지하는 입장·걱정 하나를 쓴다. 없으면 "남은 핵심 걱정 없음"이라고 쓴다.
- focus에는 이번 대사가 직접 답할 한 가지를 쓴다. 대사·사과·해결책은 쓰지 않는다.
- stateUpdate는 이번 판단 뒤의 다음 상태 **제안**이다. mind 수치는 이전 상태에서 한 단계(±1)까지만 바꾼다. playerStance에는 플레이어가 이번 또는 이전 대화에서 실제로 말한 태도만 넣는다. propose는 아직 검토 중인 방법이며, mutual은 마지막 턴에 양쪽이 실제로 행동을 말했을 때만 쓴다. evidence에는 실제 문장을 짧게 적는다. progress는 이번 플레이어 말로 **처음 생긴** 관계 변화만 최대 3개 고른다: acknowledged(윤재가 결과를 인정), player_accepts_limit(플레이어가 윤재가 유지한 현실적 한계를 명시적으로 받아들이고, 그 한계 자체를 더는 잘못으로 다루지 않음), player_changes_approach(플레이어가 자기 접근을 바꿈), proposal_created(방법 검토 시작), issue_resolved(마지막에 쟁점 해결), mutual_agreement(마지막 상호 합의). 플레이어가 겪은 결과를 말하거나 감정을 드러내거나 윤재의 행동을 비판하는 것은, 윤재의 한계를 수용한 것이 아니다. issue에는 read-gap / intent-trust / availability / repair-method 중 하나를 쓰고, mutual_agreement만 issue에 none을 쓴다. 같은 변화의 반복에는 넣지 않는다.
- 장면이나 대화에 없는 사건·약속·시점·규칙을 만들지 않는다.

# NPC 정보
${coreFor(partner)}

# 장면 사실
${sceneFactsFor(partner).map((f) => `- ${f}`).join("\n")}

# 이번 세션의 현재 상태
${sessionStateText(state)}

# 플레이어 발화 평가 기준
${rubricFor(partner)}

# 이번 턴의 위치
${finalTurn ? "마지막 턴이다. 마지막 플레이어 말까지 반영해 결론의 근거를 정리한다." : "마지막 전 턴이다. 핵심 입장은 아직 합의로 끝내지 않는다."}`;
  const user = `# 지금까지 네가 보고 들은 대화
${conversationLines(state).join("\n")}

# 방금 플레이어가 한 것
- 플레이어 (말): ${playerText}

# 이번 작업
JSON으로 이번 턴 관계 해석과 플레이어 발화 평가만 답한다. 대사·사과·행동은 절대 쓰지 않는다.`;
  return { system, user };
}

function beatLine(b: { type: string; content: string }) {
  return b.type === "narration" ? `- 너 (행동): ${b.content}` : `- 너 (말): ${b.content}`;
}

/** 프롬프트 버전. trace에 남겨 어떤 프롬프트로 나온 응답인지 구분한다. */
export const NPC_PROMPT_VERSION = "turn-state@2";

/** strict json_schema (B의 llm01WireSchema와 같은 방식). 모든 필드 필수, 추가 필드 금지. */
export const NPC_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["beats", "thought"],
  properties: {
    beats: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "content"],
        properties: { type: { type: "string", enum: ["narration", "dialogue"] }, content: { type: "string" } },
      },
    },
    thought: { type: "string" },
  },
} as const;

const firstReplyMove = z.object({ move: z.enum(["counter", "ask"]) });
const finalReplyMove = z.object({ move: z.enum(["counter", "concede", "linger"]) });
const firstReplySchema = {
  ...NPC_JSON_SCHEMA,
  required: [...NPC_JSON_SCHEMA.required, "move"],
  properties: { ...NPC_JSON_SCHEMA.properties, move: { type: "string", enum: ["counter", "ask"] } },
};
const finalReplySchema = {
  ...NPC_JSON_SCHEMA,
  required: [...NPC_JSON_SCHEMA.required, "move"],
  properties: { ...NPC_JSON_SCHEMA.properties, move: { type: "string", enum: ["counter", "concede", "linger"] } },
};

export type NpcResult =
  | { ok: true; reply: NpcReply; attempts: AttemptRecord[] }
  | { ok: false; failure: LlmFailure; attempts: AttemptRecord[] };

export async function npcReply(state: GameState, playerText: string): Promise<NpcResult> {
  if (isScripted()) return { ok: true, reply: scriptedReply(state, playerText), attempts: [] };
  const frameCall = buildTurnFramePrompt(state, playerText);
  const frameResult = await callWithRetry(modelConfig("turn_frame"), { ...frameCall, schemaName: "turn_frame", schema: TURN_FRAME_JSON_SCHEMA }, parseTurnFrame);
  if (!frameResult.ok) return frameResult;

  const cfg = modelConfig("npc_turn");
  const finalTurn = isFinalTurn(state);
  const move = state.turns.length === 0 || finalTurn ? null : chooseMove(state);
  const prompt = buildNpcPrompt(state, playerText, move, frameResult.value);
  // 첫·마지막 마디는 모델이 형식 안에서 방식을 고른다. 마지막 시도는 형식만 본다.
  const parse = (json: unknown, a: { last: boolean }) => {
    const reply = parseNpcOutput(json, move ?? (finalTurn ? finalReplyMove : firstReplyMove).parse(json).move, !a.last);
    const repetition = replyRepetitionViolation(state, reply.beats, playerText);
    if (repetition) throw new Error(repetition);
    return reply;
  };
  const res = await callWithRetry(
    cfg,
    { ...prompt, schemaName: "npc_turn", schema: move === null ? (finalTurn ? finalReplySchema : firstReplySchema) : NPC_JSON_SCHEMA },
    parse,
  );
  if (!res.ok) return { ...res, attempts: [...frameResult.attempts, ...res.attempts] };
  const last = res.attempts.at(-1);
  return {
    ok: true,
    reply: {
      ...res.value,
      frame: frameResult.value,
      suggested: frameResult.value.evaluation.suggested_drop,
      labels: frameResult.value.evaluation.labels,
      noticed: frameResult.value.evaluation.noticed,
      model: last?.respondedModel ?? cfg.model,
      usage: last?.usage ?? null,
    },
    attempts: [...frameResult.attempts, ...res.attempts],
  };
}

/** 키 없이 화면을 확인하는 대본 모드. 점수는 말의 특징으로 대충 정한다. */
export function scriptedReply(state: GameState, text: string): NpcReply {
  const labels: StrategyLabel[] = [];
  if (/미안|잘못/.test(text)) labels.push("apology");
  if (/서운|속상|불안|궁금|좋아/.test(text)) labels.push("emotion");
  if (/\?|까\b|어때/.test(text)) labels.push("question");
  if (/규칙|하자|정하|대신|만약/.test(text)) labels.push("compromise");
  if (/ㅋ/.test(text)) labels.push("humor");
  if (/당연|무시|애인 맞|왜 안/.test(text) && labels.length === 0) labels.push("pressure");
  const suggested = labels.includes("pressure") ? 2 : Math.min(14, 4 + labels.length * 5 + Math.floor(text.length / 40));
  let move = chooseMove(state);
  if (isFinalTurn(state)) {
    move = labels.includes("compromise") || labels.includes("apology") ? "concede" : labels.includes("emotion") ? "linger" : "counter";
  } else if (state.turns.length === 0) {
    if (labels.includes("pressure")) move = "counter";
    else if (/팀장|목소리|힘들|속상/.test(text)) move = "ask";
    else move = "counter";
  }
  const said: Record<NpcMove, string> = {
    counter: "음, 그 말은 좀 세게 들린다. 근데 나 화요일은 회의만 다섯 개라 진짜 폰을 못 보거든.",
    ask: text.includes("팀장") ? "아까 팀장님이 뭐라고 했는데?" : "그때 무슨 일이 있었어?",
    concede: "알았어, 그건 네 말이 맞아. 대신 회의 몰린 날은 조금만 봐줘.",
    linger: "…그렇구나.",
  };
  const beats: NpcReply["beats"] = [{ type: "dialogue", content: said[move] }];
  const p = state.partner ?? "m";
  if (move === "linger") beats.push({ type: "narration", content: forPartner("윤재가 잔을 두 손으로 감싼 채 한참 내려다본다.", p) });
  else beats.unshift({ type: "narration", content: forPartner("윤재가 잔을 두 손으로 감싼다.", p) });
  return {
    beats,
    move,
    frame: {
      request: "대본 모드라 세부 해석 없음",
      reason: "대본 모드라 세부 해석 없음",
      acknowledge: "대본 모드라 세부 해석 없음",
      retain: "대본 모드라 세부 해석 없음",
      focus: "대본 모드 응답",
      evaluation: { suggested_drop: suggested, labels, reason: "대본 모드의 간이 평가", noticed: labels.includes("compromise") ? "방법부터 꺼내는 편" : labels.includes("emotion") ? "서운한 걸 바로 말하는 편" : "아직 잘 모르겠음", evidence: [] },
      stateUpdate: { mind: state.currentMind, acknowledge: [], retain: [], resolve: [], playerStance: [], propose: [], agreement: state.relationship.agreement, evidence: [], progress: [] },
    },
    suggested,
    labels,
    reason: labels.includes("pressure") ? "내 사정을 아예 안 보려는 말 같네" : labels.length > 1 ? "어떤 말을 하려는진 알겠는데 아직 헷갈린다" : "음… 아직은 잘 모르겠음",
    noticed: labels.includes("compromise") ? "방법부터 꺼내는 편" : labels.includes("emotion") ? "서운한 걸 바로 말하는 편" : "아직 잘 모르겠음",
    model: "scripted",
    usage: null,
  };
}
