import { z } from "zod";
import { APPRAISAL_OUTPUT_FORMAT, APPRAISAL_PRIORITIES, BAND_GUIDE, COMMON_PRINCIPLES, coreFor, DIALOGUE_PRIORITIES, ENGINE_RULES, EXPERIENCE_OUTPUT_FORMAT, forPartner, MOVE_GUIDE, OUTPUT_FORMAT, PARTNERS, rubricFor, SCENARIO, sceneFactsFor, scenarioFor } from "./content.js";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { buildSceneCheckPrompt, checkOutcome, parseSceneVerdict, reassertViolation, REF_USES, SCENE_JSON_SCHEMA, sceneTriggers, type AttemptCheck, type CheckOutcome, type Ref } from "./checks.js";
import { factsLines, ISSUE_IDS, LEDGER_KINDS, ledgerLines, PLAYER_ACTS, applyFacts, resolveFacts, spokenLines, type LedgerItem, type TurnFacts } from "./ledger.js";
import { band, chooseMove, isFinalTurn, STRATEGY_LABELS, type GameState, type NpcMove, type StrategyLabel } from "./rules.js";

const BeatSchema = z.object({
  type: z.enum(["narration", "dialogue"]),
  content: z.string().trim().min(1).max(300),
});

export const NpcOutputSchema = z.object({
  beats: z.array(BeatSchema).min(1).max(4),
  thought: z.string().trim().min(1).max(80),
  // 검증용 자기 보고라 많이 적었다고 대사를 버리지 않는다: 앞의 6개만 쓴다
  refs: z.array(z.object({ id: z.string().trim().min(1).max(8), use: z.enum(REF_USES) })).default([]).transform((xs) => xs.slice(0, 6)),
});

export interface NpcReply {
  beats: { type: "narration" | "dialogue"; content: string }[];
  move: NpcMove;
  /** 대사 전에 확정한 이번 마디의 사실 (장부 변경 · 발화 행위 · 평가) */
  facts: TurnFacts;
  /** 대사가 다룬 장부 항목과 용도 (V2 검증용 자기 보고) */
  refs: Ref[];
  /** 시도별 검증 결과와 최종 분류 (clean · prevented · exposed) */
  checks: AttemptCheck[];
  outcome: CheckOutcome;
  suggested: number;
  labels: StrategyLabel[];
  reason: string;
  /** 이번 말에서 플레이어에 대해 알게 된 것 (마지막 판단의 근거) */
  noticed: string;
  model: string;
  usage: LlmUsage | null;
}

const isLabel = (s: string): s is StrategyLabel => (STRATEGY_LABELS as readonly string[]).includes(s);

/** 1차 발화 분석 출력의 strict json_schema. 모든 필드 필수, 추가 필드 금지. */
const ITEM_SCHEMA = { type: "object", additionalProperties: false, required: ["kind", "issue", "text", "quote"], properties: { kind: { type: "string", enum: [...LEDGER_KINDS] }, issue: { type: "string", enum: [...ISSUE_IDS] }, text: { type: "string" }, quote: { type: "string" } } } as const;
const RESOLVE_SCHEMA = { type: "object", additionalProperties: false, required: ["id", "status", "quote"], properties: { id: { type: "string" }, status: { type: "string", enum: ["accepted", "rejected", "closed"] }, quote: { type: "string" } } } as const;
export const FACTS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["npcLast", "npcResolved", "acts", "playerNew", "playerResolved", "evaluation"],
  properties: {
    npcLast: { type: "array", maxItems: 3, items: ITEM_SCHEMA },
    npcResolved: { type: "array", maxItems: 3, items: RESOLVE_SCHEMA },
    acts: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", additionalProperties: false, required: ["act", "quote", "refersTo"], properties: { act: { type: "string", enum: [...PLAYER_ACTS] }, quote: { type: "string" }, refersTo: { type: "string" } } } },
    playerNew: { type: "array", maxItems: 3, items: ITEM_SCHEMA },
    playerResolved: { type: "array", maxItems: 3, items: RESOLVE_SCHEMA },
    evaluation: { type: "object", additionalProperties: false, required: ["suggested_drop", "labels", "reason", "noticed", "evidence"], properties: {
      suggested_drop: { type: "integer", minimum: 0, maximum: 14 }, labels: { type: "array", maxItems: 2, items: { type: "string", enum: [...STRATEGY_LABELS] } }, reason: { type: "string" }, noticed: { type: "string" }, evidence: { type: "array", maxItems: 2, items: { type: "string" } },
    } },
  },
} as const;

const isLabelList = (xs: string[]): StrategyLabel[] => xs.filter(isLabel);

/** 직전 NPC 말 원문 (첫 마디는 오프닝). 장부 인용 검증과 발화 분석에 쓴다. */
export function previousNpcText(state: GameState): string {
  const beats = state.turns.at(-1)?.npc ?? scenarioFor(state.partner ?? "m").opening;
  return beats.map((b) => b.content).join("\n");
}

/** 1차 출력을 검증해 확정한다 (ledger.ts resolveFacts). */
export function parseFacts(state: GameState, playerText: string, raw: unknown, strict: boolean): TurnFacts {
  const facts = resolveFacts(state.ledger, raw, { playerText, prevNpc: previousNpcText(state), turn: state.turns.length + 1 }, strict);
  return { ...facts, evaluation: { ...facts.evaluation, labels: isLabelList(facts.evaluation.labels) } };
}

export const ENDS_WITH_QUESTION = /[?？]\s*[)"”’…~.]*\s*$/u;

/** 끝맺음 방식을 지켰는지. 질문은 ask일 때만, 대사 개수 상한. 여운의 대사·행동 순서는 강제하지 않는다. 위반 사유 또는 null. */
export function moveViolation(move: NpcMove, beats: { type: string; content: string }[]): string | null {
  const last = beats.at(-1);
  if (!last) return "no_beats";
  const asks = beats.some((b) => b.type === "dialogue" && ENDS_WITH_QUESTION.test(b.content.trim()));
  const dialogueCount = beats.filter((b) => b.type === "dialogue").length;
  if (move !== "ask" && asks) return `question_in_${move}`;
  if (move === "counter" && dialogueCount > 2) return "counter_too_many_dialogues";
  if (move === "linger" && dialogueCount > 1) return "linger_too_many_dialogues";
  return null;
}

export function parseNpcOutput(raw: unknown, move: NpcMove = "counter", strict = false): Pick<NpcReply, "beats" | "move" | "reason" | "refs"> {
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
    refs: out.refs,
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

/** 직전 응답 반복 금지 (A와 실험 B가 같은 문장을 쓴다) */
const REPEAT_RULES =
  "# 직전 응답과 반복 금지\n- 직전 네 대사에서 이미 설명한 사정·조건·결론을 같은 뜻의 다른 문장으로 다시 말하지 않는다. 특히 답장을 바로 하기 어렵다는 설명, 미리 한마디 하겠다는 약속처럼 이미 나온 핵심은 재진술 금지다.\n- 플레이어가 새 요구·이유 없이 짧게 수용하거나 확인했다면, 그 수용을 짧게 받거나 행동으로 반응하고 멈춘다. 같은 반론을 다시 증명하려 하지 않는다.\n- 이번 대사는 직전 응답에 없던 구체적인 반응·조건 조정·질문·행동 중 하나를 더할 때만 길게 쓴다. 새로 보탤 것이 없으면 짧게 끝낸다.";

export function buildNpcPrompt(
  state: GameState,
  playerText: string,
  move: NpcMove | null = state.turns.length === 0 || isFinalTurn(state) ? null : chooseMove(state),
  facts?: TurnFacts,
): { system: string; user: string } {
  const ledgerAfter = facts ? applyFacts(state.ledger, facts, state.turns.length + 1) : state.ledger;
  const partner = state.partner ?? "m";
  const finalTurn = isFinalTurn(state);
  // 순서: 매번 같은 부분(규칙·Core·장면·출력 형식·반복 금지)을 앞에, 매 마디 바뀌는 부분을 뒤에.
  // 앞부분이 이전 호출과 같으면 공급자의 프롬프트 캐시로 입력이 할인된다 (usage.cachedTokens로 확인).
  const system = [
    ENGINE_RULES,
    COMMON_PRINCIPLES,
    coreFor(partner),
    `# 장면\n- 장소: ${SCENARIO.place}\n- 대화 방식: 직접 마주하고 있다\n## 네가 아는 사실\n${sceneFactsFor(partner).map((f) => `- ${f}`).join("\n")}`,
    OUTPUT_FORMAT,
    DIALOGUE_PRIORITIES,
    REPEAT_RULES,
    // ---- 여기부터 매 마디 바뀐다
    `# 지금 상태\n${BAND_GUIDE[band(state.score)]}\n이번 말이 좋았다면 그만큼 반응에 드러내되, 지금 상태보다 한 단계 넘게 갑자기 바뀌지 않는다.`,
    `# 지금 마음\n${mindLine(state)}\nCore의 성향대로 이 마음이 방금 말을 어떻게 듣게 하는지는 네가 판단한다.`,
    `# 대화 장부 (이번 마디까지 확정된 사실)\n${ledgerLines(ledgerAfter, "npc")}`,
    facts ? `# 방금 플레이어의 말에서 확인된 것\n${factsLines(facts, ledgerAfter)}` : null,
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

/** 지금 마음 (0~3). 수치는 코드 규칙으로만 바뀐다. 어떻게 말하라는 지시는 붙이지 않는다: 해석은 Core의 성향으로 대사 모델이 한다. */
function mindLine(state: GameState): string {
  const m = state.currentMind;
  return `피곤 ${m.fatigue}, 미안함 ${m.guilt}, 방어심 ${m.defensiveness}, 챙기고 싶은 마음 ${m.care}, 마음 열림 ${m.openness} (0~3)`;
}

/**
 * 1차 발화 분석: 대사를 쓰지 않는다. 직전 NPC 말과 이번 플레이어 말에서 실제로 말해진 것만 장부에 기록하고,
 * 플레이어 말을 평가한다. 인물 Core는 넣지 않는다 (사실 기록에는 성격이 필요 없다. NPC의 입장은 장부의 NPC 항목이다).
 */
export function buildFactsPrompt(state: GameState, playerText: string): { system: string; user: string } {
  const partner = state.partner ?? "m";
  const name = PARTNERS[partner].name;
  const finalTurn = isFinalTurn(state);
  const first = state.turns.length === 0;
  const system = `# 역할
너는 연인 대화의 기록원이다. 대사를 쓰지 않는다. 직전 ${name}(NPC)의 말과 이번 플레이어의 말에서 **실제로 말해진 것**만 장부에 기록하고, 플레이어의 말을 평가한다.

# 기록 규칙
- quote는 해당 말에서 **글자 그대로** 옮긴 짧은 구절(25자 이내)이다. 원문에 없는 말이면 기록이 버려진다.
- text는 누가 무엇을 하는지 드러나는 완결된 한 문장이다. 예: "${name}가 늦을 땐 먼저 한마디 하겠다", "플레이어가 무시라고 단정하지 않겠다". 말 조각을 그대로 옮기지 않는다.
- kind: commitment(앞으로 자기가 하겠다는 행동, "~할게") · proposal(둘이 같이 하자는 방법) · concern(서운함·걱정·억울함, 상대가 알아주길 바라는 것) · request(상대에게 바라는 행동, "~해줬으면 좋겠어") · limit(할 수 없다고 밝힌 것). "~했으면 좋았겠다" 같은 후회·인정은 약속이 아니다.
- issue: read-gap(읽고도 답이 없었던 시간) · intent-trust(일부러 그랬는지·무시했는지에 대한 믿음) · availability(일할 때 연락할 수 있는 정도) · repair-method(앞으로 어떻게 할지).
- npcLast: 직전 ${name}의 말에서 **새로** 생긴 항목. 장부에 이미 있는 내용이면 넣지 않는다. 첫 마디에는 비워 둔다.
- npcResolved: 직전 ${name}의 말이 플레이어의 열린 항목의 **내용을** 받아들인다고(accepted) 또는 거절한다고(rejected) 분명히 말했을 때만. 첫 마디에는 비워 둔다.
- playerNew: 이번 플레이어 말에서 새로 생긴 항목.
- playerResolved: 이번 플레이어 말이 ${name}의 열린 항목의 **내용 자체**를 받아들인다고(accepted) 또는 거절한다고(rejected) 분명히 말했을 때, 플레이어 자신의 열린 항목을 거둬들인다고 말했을 때(closed)만. id는 장부의 L번호 또는 이번 npcLast 순서대로 N1·N2·N3. quote는 받아들임·거절·거둬들임이 드러난 부분이다. 플레이어가 자기 행동을 약속한 것("조심할게")은 ${name}의 항목을 받아들인 것이 아니다(그건 playerNew의 commitment). 한 항목을 받아들였다고 다른 항목까지 닫지 않는다.
- acts: 이번 플레이어 말이 하는 일 1~3개. refersTo는 그 행위가 가리키는 장부 id, 없으면 "".
  - apology(사과) · request(상대에게 바라는 행동을 말함. "미리 말해줬으면 좋겠어"는 비난이 아니라 request) · accept(상대 항목의 내용을 받아들인다고 분명히 말함. 맞장구나 "알겠어" 같은 말이 있다는 것만으로 accept가 아니다) · reject(상대 항목의 내용을 받아들이지 않거나 반박함) · question(상대 생각·사정을 진짜로 물음) · accuse(상대의 의도·마음을 나쁘게 단정하거나 탓함: "나 무시했지", "넌 맨날 그래") · explain(자기 사정 설명) · feeling(자기 감정 표현) · propose(둘이 할 방법 제안) · promise(자기 행동 약속: "단정하지 않을게") · other.
- 플레이어 말 속 "너/네가"는 ${name}다. 장면이나 대화에 없는 사건·약속·시점을 만들지 않는다.

# 정리(받아들임·거절·거둬들임)의 기준
- 정리는 말한 사람이 그 항목의 **내용**을 받아들인다, 거절한다, 거둬들인다고 **말로 분명히 드러낸 경우만** 기록한다. 특정 단어가 있는지로 정하지 않는다. 원문과 앞뒤 대화에서 무엇을 받아들였는지 확인한다.
- 그 항목에 반응했지만 내용을 받아들였는지 분명하지 않으면 정리하지 않는다. 사과, 자기 행동 약속, 상대 사정에 맞춰 주겠다는 말, 짧은 맞장구가 그런 경우일 수 있다. 이때는 acts의 refersTo로 그 항목에 **연결만** 한다.
- 기록하는 것은 **말로 표현된** 받아들임이다. 듣는 사람이 속으로 납득했는지, 마음이 풀렸는지는 기록하지 않는다.
- 열린 항목은 "아직 받아들인다고 말하지 않았다"는 뜻일 뿐이다. 확실하지 않으면 정리하지 않는다. npcResolved·playerResolved가 빈 배열인 것도 올바른 기록이다.

# 장면 사실
${sceneFactsFor(partner).map((f) => `- ${f}`).join("\n")}

${rubricFor(partner)}
평가는 ${name}의 입장에서 한다. 장부의 열린 NPC 항목은 ${name}가 말했고 플레이어가 아직 받아들인다고 말하지 않은 것이다.

# 대화 장부 (지금까지)
${ledgerLines(state.ledger, "neutral")}

# 이번 마디의 위치
${first ? "첫 마디다 (npcLast·npcResolved는 비운다)." : finalTurn ? "마지막 마디다." : `${state.turns.length + 1}번째 마디다 (전체 5마디).`}`;
  const user = `# 지금까지의 대화
${conversationLines(state).map((l) => l.replace("- 너 (", `- ${name} (`)).join("\n")}

# 직전 ${name}의 말
${previousNpcText(state)}

# 이번 플레이어의 말
${playerText}

JSON으로만 답한다. 대사는 쓰지 않는다.`;
  return { system, user };
}

function beatLine(b: { type: string; content: string }) {
  return b.type === "narration" ? `- 너 (행동): ${b.content}` : `- 너 (말): ${b.content}`;
}

/** 프롬프트 버전. trace에 남겨 어떤 프롬프트로 나온 응답인지 구분한다. */
// ledger@2 (2026-11-23): 1차의 정리 기준을 "말로 분명히 드러낸 경우만"으로 좁혔다 (docs/appraisal-review.md §12). 대사 프롬프트는 같다
export const NPC_PROMPT_VERSION = "ledger@2";

/** strict json_schema (B의 llm01WireSchema와 같은 방식). 모든 필드 필수, 추가 필드 금지. */
export const NPC_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["beats", "thought", "refs"],
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
    refs: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "use"], properties: { id: { type: "string" }, use: { type: "string", enum: [...REF_USES] } } },
    },
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

/** attempts: 대사 호출, factsAttempts: 1차 발화 분석, sceneAttempts: V3 장면 판정 (trace에 call_type을 나눠 남긴다) */
type Traces = { attempts: AttemptRecord[]; factsAttempts: AttemptRecord[]; sceneAttempts: AttemptRecord[] };
export type NpcResult = ({ ok: true; reply: NpcReply } | { ok: false; failure: LlmFailure }) & Traces;

/** 거부 이유를 다음 시도에 붙일 말로 (모델이 같은 실수를 반복하지 않게). */
function retryNote(lastError: string): string {
  const notes: string[] = [];
  const re = lastError.match(/reasserts_resolved:([\w,]+)/);
  if (re) notes.push(`이미 정리된 ${re[1]}의 주장을 다시 내세웠다. 그 주장은 다시 하지 말고, 남은 마음은 다른 방식으로 드러낸다.`);
  const sc = lastError.match(/scene_contradiction(?::(.*))?/);
  if (sc) notes.push(`지금 카페에 마주 앉아 있다는 장면과 어긋났다${sc[1] ? ` (${sc[1].slice(0, 60)})` : ""}. 장면을 지키고, 플레이어 말이 어긋나면 바로잡는다.`);
  if (lastError.includes("reply_repeats_previous")) notes.push("직전 네 대사를 되풀이했다. 같은 내용을 다시 말하지 않는다.");
  const mv = lastError.match(/move_violation:(\w+)/);
  const MOVE_NOTE: Record<string, string> = {
    linger_too_many_dialogues: "여운(linger)에서는 대사를 1개 이하로 쓴다.",
    counter_too_many_dialogues: "반론(counter)에서는 대사를 2개 이하로 쓴다.",
  };
  if (mv) notes.push(MOVE_NOTE[mv[1]!] ?? (mv[1]!.startsWith("question_in_") ? "이번에는 질문으로 끝내지 않는다. 마지막 문장에 물음표를 쓰지 않는다." : `끝맺음 방식을 어겼다 (${mv[1]}).`));
  return notes.length ? `\n\n# 직전 시도가 거부된 이유\n${notes.map((n) => `- ${n}`).join("\n")}` : "";
}

export async function npcReply(state: GameState, playerText: string): Promise<NpcResult> {
  if (isScripted()) return { ok: true, reply: scriptedReply(state, playerText), attempts: [], factsAttempts: [], sceneAttempts: [] };
  // 1차: 발화 분석. 첫 시도는 인용·id가 모두 맞아야 하고, 마지막 시도는 틀린 것만 버린다.
  const factsCall = buildFactsPrompt(state, playerText);
  const factsResult = await callWithRetry(
    modelConfig("turn_frame"),
    { ...factsCall, schemaName: "turn_facts", schema: FACTS_JSON_SCHEMA },
    (json, a) => parseFacts(state, playerText, json, !a.last),
  );
  if (!factsResult.ok) return { ok: false, failure: factsResult.failure, attempts: [], factsAttempts: factsResult.attempts, sceneAttempts: [] };
  return replyFromFacts(state, playerText, factsResult.value, factsResult.attempts);
}

/**
 * 한 시도의 대사를 검증한다 (V1 반복 · V2 재주장 · V3 장면 · V4 끝맺음).
 * move가 null이면(실험 1 조건 B: 끝맺음을 정하지 않음) V4는 해당 없음이다.
 * 기존 방식(A)과 B가 같은 검증기를 쓰도록 한 곳에 둔다.
 */
async function checkAttempt(
  ctx: { state: GameState; playerText: string; ledgerAfter: readonly LedgerItem[]; sceneAttempts: AttemptRecord[] },
  reply: { beats: { type: string; content: string }[]; refs: Ref[]; move: NpcMove | null },
  a: { index: number; last: boolean },
): Promise<AttemptCheck> {
  const partner = ctx.state.partner ?? "m";
  const violations: string[] = [];
  if (reply.move) {
    const mv = moveViolation(reply.move, reply.beats);
    if (mv) violations.push(`move_violation:${mv}`);
  }
  const rep = replyRepetitionViolation(ctx.state, reply.beats, ctx.playerText);
  if (rep) violations.push(rep);
  const ra = reassertViolation(ctx.ledgerAfter, reply.refs);
  if (ra) violations.push(ra);
  const dialogue = reply.beats.filter((b) => b.type === "dialogue").map((b) => b.content).join(" ");
  const triggers = sceneTriggers(dialogue);
  let sceneVerdict: AttemptCheck["sceneVerdict"];
  if (triggers.length) {
    const sc = buildSceneCheckPrompt(sceneFactsFor(partner), PARTNERS[partner].name, ctx.playerText, dialogue);
    const judged = await callWithRetry(modelConfig("scene_check"), { ...sc, schemaName: "scene_check", schema: SCENE_JSON_SCHEMA }, (j) => parseSceneVerdict(j));
    ctx.sceneAttempts.push(...judged.attempts);
    sceneVerdict = judged.ok ? judged.value : { verdict: "unclear", reason: `판정 실패: ${judged.failure.message}`.slice(0, 120) };
    if (sceneVerdict.verdict === "contradiction") violations.push(`scene_contradiction:${sceneVerdict.reason}`);
  }
  return { attempt: a.index, last: a.last, violations, sceneTriggers: triggers, ...(sceneVerdict ? { sceneVerdict } : {}), refs: reply.refs };
}

/**
 * 확정된 1차 결과로 대사를 만든다 (서비스 경로: npcReply가 1차 뒤에 부른다).
 * 평가는 같은 1차 결과를 여러 조건에 쓰려고 이 함수를 바로 부른다.
 */
export async function replyFromFacts(state: GameState, playerText: string, facts: TurnFacts, factsAttempts: AttemptRecord[] = []): Promise<NpcResult> {
  const ledgerAfter = applyFacts(state.ledger, facts, state.turns.length + 1);
  const cfg = modelConfig("npc_turn");
  const finalTurn = isFinalTurn(state);
  const move = state.turns.length === 0 || finalTurn ? null : chooseMove(state);
  const prompt = buildNpcPrompt(state, playerText, move, facts);
  const checks: AttemptCheck[] = [];
  const sceneAttempts: AttemptRecord[] = [];
  const ctx = { state, playerText, ledgerAfter, sceneAttempts };

  // 첫 시도에서만 거부하고, 마지막 시도는 통과시키되 기록한다.
  const parse = async (json: unknown, a: { index: number; last: boolean }) => {
    const reply = parseNpcOutput(json, move ?? (finalTurn ? finalReplyMove : firstReplyMove).parse(json).move, false);
    const check = await checkAttempt(ctx, reply, a);
    checks.push(check);
    if (check.violations.length && !a.last) throw new Error(check.violations.join(" | "));
    return reply;
  };
  const res = await callWithRetry(
    cfg,
    ({ lastError }) => ({
      ...prompt,
      user: prompt.user + (lastError ? retryNote(lastError) : ""),
      schemaName: "npc_turn",
      schema: move === null ? (finalTurn ? finalReplySchema : firstReplySchema) : NPC_JSON_SCHEMA,
    }),
    parse,
  );
  if (!res.ok) return { ok: false, failure: res.failure, attempts: res.attempts, factsAttempts, sceneAttempts };
  const last = res.attempts.at(-1);
  return {
    ok: true,
    reply: {
      ...res.value,
      facts,
      checks,
      outcome: checkOutcome(checks),
      suggested: facts.evaluation.suggested_drop,
      labels: isLabelList(facts.evaluation.labels),
      noticed: facts.evaluation.noticed,
      model: last?.respondedModel ?? cfg.model,
      usage: last?.usage ?? null,
    },
    attempts: res.attempts,
    factsAttempts,
    sceneAttempts,
  };
}

// ------------------------------------------------------------------ 실험 1 조건 B: 캐릭터 직접 해석 (docs/appraisal-review.md §14)
// 평가(npm run eval -- appraisal)에서만 쓴다. 서비스 경로(npcReply)는 부르지 않는다.

const MIND_AXES = ["fatigue", "guilt", "defensiveness", "care", "openness"] as const;
export const AppraisalOutputSchema = z.object({
  heard: z.string().trim().min(1).max(160),
  // 바뀐 축만. 없으면 빈 목록 (변하지 않을 자유)
  shift: z.array(z.object({ axis: z.enum(MIND_AXES), delta: z.union([z.literal(1), z.literal(-1)]), why: z.string().trim().max(80) })).max(5),
  // 특별히 새로 바라는 게 없으면 ""
  want: z.string().trim().max(120),
  beats: z.array(BeatSchema).min(1).max(4),
  refs: z.array(z.object({ id: z.string().trim().min(1).max(8), use: z.enum(REF_USES) })).default([]).transform((xs) => xs.slice(0, 6)),
});
export type AppraisalOutput = z.infer<typeof AppraisalOutputSchema>;

/** 순서가 곧 생성 순서다: heard → shift → want → beats → refs */
export const APPRAISAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["heard", "shift", "want", "beats", "refs"],
  properties: {
    heard: { type: "string" },
    shift: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["axis", "delta", "why"], properties: { axis: { type: "string", enum: [...MIND_AXES] }, delta: { type: "integer", enum: [-1, 1] }, why: { type: "string" } } },
    },
    want: { type: "string" },
    beats: NPC_JSON_SCHEMA.properties.beats,
    refs: NPC_JSON_SCHEMA.properties.refs,
  },
} as const;

export function parseAppraisalOutput(raw: unknown): AppraisalOutput {
  const out = AppraisalOutputSchema.parse(raw);
  return { ...out, beats: out.beats.map((b) => ({ type: b.type, content: b.content.replace(/^["“]|["”]$/g, "") })) };
}

// ------------------------------------------------------------------ 경험 실험 (docs/appraisal-review.md §16)
// 실험 1 B 프롬프트에 "이전 경험" 블록과 판단 필드(focus·belief·standard)만 더한다. 평가에서만 쓴다.
// variant를 주지 않으면 실험 1 B와 글자까지 같다.

export interface AppraisalVariant {
  /** 캐릭터의 이전 경험. 일어난 일만 쓰고 교훈·감정은 쓰지 않는다. 없으면 블록 자체를 넣지 않는다 */
  memory?: string;
  /** focus·belief·standard를 함께 받는다 (EXPERIENCE_OUTPUT_FORMAT) */
  judgement?: boolean;
}

export const JudgedAppraisalOutputSchema = AppraisalOutputSchema.extend({
  focus: z.string().trim().min(1).max(100),
  belief: z.string().trim().min(1).max(140),
  standard: z.array(z.string().trim().min(1).max(80)).min(1).max(3),
});
export type Judgement = Pick<z.infer<typeof JudgedAppraisalOutputSchema>, "focus" | "belief" | "standard">;

/** 순서: heard → focus → belief → standard → shift → want → beats → refs */
export const JUDGED_APPRAISAL_JSON_SCHEMA = {
  ...APPRAISAL_JSON_SCHEMA,
  required: ["heard", "focus", "belief", "standard", "shift", "want", "beats", "refs"],
  properties: {
    heard: APPRAISAL_JSON_SCHEMA.properties.heard,
    focus: { type: "string" },
    belief: { type: "string" },
    standard: { type: "array", items: { type: "string" } },
    shift: APPRAISAL_JSON_SCHEMA.properties.shift,
    want: APPRAISAL_JSON_SCHEMA.properties.want,
    beats: APPRAISAL_JSON_SCHEMA.properties.beats,
    refs: APPRAISAL_JSON_SCHEMA.properties.refs,
  },
} as const;

export function parseJudgedAppraisalOutput(raw: unknown): AppraisalOutput & Judgement {
  const out = JudgedAppraisalOutputSchema.parse(raw);
  return { ...out, beats: out.beats.map((b) => ({ type: b.type, content: b.content.replace(/^["“]|["”]$/g, "") })) };
}

/**
 * B의 프롬프트. A(buildNpcPrompt)와 다른 점:
 * - 없음: BAND 마음 묘사, 1차의 의미 라벨(factsLines), 장부 상태어, 끝맺음(move) 지정
 * - 바뀜: 장부 → "실제로 말해진 것"(spokenLines), 마음 → "듣기 전 마음", 우선순위 2번, 출력 형식(heard → shift → want → beats)
 * - 같음: 규칙·공통 원칙·Core·장면·반복 금지, 대화 기록과 방금 말(user)
 */
export function buildAppraisalPrompt(state: GameState, playerText: string, facts: TurnFacts, variant: AppraisalVariant = {}): { system: string; user: string } {
  const ledgerAfter = applyFacts(state.ledger, facts, state.turns.length + 1);
  const partner = state.partner ?? "m";
  const system = [
    ENGINE_RULES,
    COMMON_PRINCIPLES,
    coreFor(partner),
    `# 장면\n- 장소: ${SCENARIO.place}\n- 대화 방식: 직접 마주하고 있다\n## 네가 아는 사실\n${sceneFactsFor(partner).map((f) => `- ${f}`).join("\n")}`,
    variant.judgement ? EXPERIENCE_OUTPUT_FORMAT : APPRAISAL_OUTPUT_FORMAT,
    APPRAISAL_PRIORITIES,
    REPEAT_RULES,
    // ---- 여기부터 매 마디 바뀐다 (경험 블록은 조건마다 다르므로 이 아래에 둔다: 앞부분 캐시를 조건끼리 나눠 쓴다)
    ...(variant.memory ? [`# 전에 있었던 일 (네 기억)\n${variant.memory}`] : []),
    `# 듣기 전 네 마음\n${mindLine(state)}\n방금 플레이어의 말을 듣기 전의 마음이다. 그 말을 어떻게 받아들일지는 Core의 성향과 이 마음으로 네가 판단한다.`,
    `# 지금까지 실제로 말해진 것 (누가 무엇을 말했나)\n${spokenLines(ledgerAfter)}`,
  ].join("\n\n");
  const user = `# 지금까지 네가 보고 들은 대화
${conversationLines(state).join("\n")}

# 방금 플레이어가 한 것
- 플레이어 (말): ${playerText}

# 이번 차례
위 규칙에 따라 JSON으로 답한다.`;
  return { system, user };
}

export interface AppraisalReply {
  beats: { type: "narration" | "dialogue"; content: string }[];
  heard: string;
  shift: AppraisalOutput["shift"];
  want: string;
  refs: Ref[];
  /** 생성 뒤 분류 (끝맺음을 미리 정하지 않았으므로): 마지막 대사가 질문으로 끝나는가 */
  endsWithQuestion: boolean;
  checks: AttemptCheck[];
  outcome: CheckOutcome;
  /** variant.judgement일 때만 */
  focus?: string;
  belief?: string;
  standard?: string[];
}
export type AppraisalResult = ({ ok: true; reply: AppraisalReply } | { ok: false; failure: LlmFailure }) & { attempts: AttemptRecord[]; sceneAttempts: AttemptRecord[] };

/** 조건 B로 대사를 만든다. 검증기·재시도 정책은 A와 같다 (V4는 끝맺음을 정하지 않아 해당 없음). 상태는 바꾸지 않는다. */
export async function appraisalReplyFromFacts(state: GameState, playerText: string, facts: TurnFacts, variant: AppraisalVariant = {}): Promise<AppraisalResult> {
  const ledgerAfter = applyFacts(state.ledger, facts, state.turns.length + 1);
  const prompt = buildAppraisalPrompt(state, playerText, facts, variant);
  const schema = variant.judgement ? JUDGED_APPRAISAL_JSON_SCHEMA : APPRAISAL_JSON_SCHEMA;
  const checks: AttemptCheck[] = [];
  const sceneAttempts: AttemptRecord[] = [];
  const ctx = { state, playerText, ledgerAfter, sceneAttempts };
  const parse = async (json: unknown, a: { index: number; last: boolean }) => {
    const out: AppraisalOutput & Partial<Judgement> = variant.judgement ? parseJudgedAppraisalOutput(json) : parseAppraisalOutput(json);
    const check = await checkAttempt(ctx, { beats: out.beats, refs: out.refs, move: null }, a);
    checks.push(check);
    if (check.violations.length && !a.last) throw new Error(check.violations.join(" | "));
    return out;
  };
  const res = await callWithRetry(
    modelConfig("npc_turn"),
    ({ lastError }) => ({ ...prompt, user: prompt.user + (lastError ? retryNote(lastError) : ""), schemaName: "npc_appraisal", schema }),
    parse,
  );
  if (!res.ok) return { ok: false, failure: res.failure, attempts: res.attempts, sceneAttempts };
  const lastDialogue = res.value.beats.filter((b) => b.type === "dialogue").at(-1)?.content ?? "";
  return {
    ok: true,
    reply: { ...res.value, endsWithQuestion: ENDS_WITH_QUESTION.test(lastDialogue.trim()), checks, outcome: checkOutcome(checks) },
    attempts: res.attempts,
    sceneAttempts,
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
    refs: [],
    checks: [],
    outcome: "clean",
    // 대본 모드는 장부를 바꾸지 않는다 (발화 행위만 간이로)
    facts: {
      v: 2,
      added: [],
      resolved: [],
      acts: [{ act: labels.includes("apology") ? "apology" : labels.includes("pressure") ? "accuse" : labels.includes("compromise") ? "propose" : "other", quote: "", refersTo: "" }],
      evaluation: { suggested_drop: suggested, labels, reason: "대본 모드의 간이 평가", noticed: labels.includes("compromise") ? "방법부터 꺼내는 편" : labels.includes("emotion") ? "서운한 걸 바로 말하는 편" : "아직 잘 모르겠음", evidence: [] },
    },
    suggested,
    labels,
    reason: labels.includes("pressure") ? "내 사정을 아예 안 보려는 말 같네" : labels.length > 1 ? "어떤 말을 하려는진 알겠는데 아직 헷갈린다" : "음… 아직은 잘 모르겠음",
    noticed: labels.includes("compromise") ? "방법부터 꺼내는 편" : labels.includes("emotion") ? "서운한 걸 바로 말하는 편" : "아직 잘 모르겠음",
    model: "scripted",
    usage: null,
  };
}
