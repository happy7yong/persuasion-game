// 대화 피드백: 전체 발화와 연인의 속마음을 대조해, 닿은 부분과 남은 차이를 정리한다.
// 근거 없는 평가는 막는다. 인용은 실제 플레이어 말과 같은 마디의 속마음에 있어야 한다.
import { z } from "zod";
import { coreFor, PARTNERS } from "./content.js";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { type GameState } from "./rules.js";

export const BELIEF_PROMPT_VERSION = "feedback@2";

export interface BeliefEvidence {
  /** 내 말과 상대의 속마음이 나온 마디 번호 (1부터) */
  turn: number;
  playerQuote: string;
  /** 해당 마디에 저장된 속마음의 원문 일부. 속마음이 없는 예전 판은 빈 문자열 */
  thoughtQuote: string;
}

export interface Belief {
  kind: "feedback";
  v: 3;
  npcName: string;
  summary: string;
  received: string;
  gap: string;
  direction: string;
  evidence: BeliefEvidence[];
  model: string;
  usage: LlmUsage | null;
}

export function isCurrentBelief(value: unknown): value is Belief {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown; v?: unknown };
  return candidate.kind === "feedback" && candidate.v === 3 && Raw.safeParse(value).success;
}

/** 성격 유형·심리 진단 라벨. 다섯 마디로 판단할 수 없고, 틀리면 불쾌하다. */
const BANNED = /MBTI|[EI][NS][TF][JP]|애착|불안형|회피형|안정형|자존감|트라우마|우울|강박|성격\s*유형|나르시|경계성|ADHD|공감\s*능력이?\s*(없|부족)/i;

const Raw = z.object({
  summary: z.string().trim().min(1).max(140),
  received: z.string().trim().min(1).max(180),
  gap: z.string().trim().min(1).max(180),
  direction: z.string().trim().min(1).max(120),
  evidence: z.array(z.object({ turn: z.number().int(), playerQuote: z.string().trim().min(1).max(80), thoughtQuote: z.string().trim().max(80) })).min(1).max(3),
});

/** 방향은 사용자에게 보이는 다음 대화의 안내이므로 존댓말 종결로만 보낸다. */
const politeEnding = (text: string) => text.replace(/[.?!…\s]+$/u, "");
const endsPolitely = (text: string) => /(?:요|니다|십시오)$/u.test(politeEnding(text));

const STR = { type: "string" } as const;
export const BELIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "received", "gap", "direction", "evidence"],
  properties: {
    summary: STR,
    received: STR,
    gap: STR,
    direction: STR,
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["turn", "playerQuote", "thoughtQuote"],
        properties: { turn: { type: "integer" }, playerQuote: STR, thoughtQuote: STR },
      },
    },
  },
} as const;

const squash = (t: string) => t.replace(/[\s"'“”‘’.,!?~…]/g, "");

/** 인용이 그 마디에서 플레이어가 실제로 한 말에 있는지 (공백·문장부호 차이는 무시). */
export function quoteIsReal(state: GameState, turn: number, quote: string): boolean {
  const line = state.turns[turn - 1]?.player;
  const q = squash(quote);
  return Boolean(line && q.length >= 2 && squash(line).includes(q));
}

export function thoughtQuoteIsReal(state: GameState, turn: number, quote: string): boolean {
  const thought = state.turns[turn - 1]?.thought;
  const q = squash(quote);
  return Boolean(thought && q.length >= 2 && squash(thought).includes(q));
}

/**
 * 출력을 검사한다. 실제 내 말과 속마음에서 가져온 근거만 받는다.
 * 마지막 시도(strict=false)에서는 틀린 근거만 버리되, 속마음이 있는 판은 적어도 하나를 대조한다.
 */
export function parseBelief(state: GameState, json: unknown, strict: boolean): Omit<Belief, "kind" | "v" | "npcName" | "model" | "usage"> {
  const raw = Raw.parse(json);
  const all = [raw.summary, raw.received, raw.gap, raw.direction].join("\n");
  if (BANNED.test(all)) throw new Error("belief_banned_label");
  if (!endsPolitely(raw.direction)) throw new Error("belief_direction_not_polite");
  const seen = new Set<number>();
  const valid = raw.evidence.filter((e) => {
    if (seen.has(e.turn) || !quoteIsReal(state, e.turn, e.playerQuote) || (e.thoughtQuote && !thoughtQuoteIsReal(state, e.turn, e.thoughtQuote))) return false;
    seen.add(e.turn);
    return true;
  });
  if (strict && valid.length !== raw.evidence.length) throw new Error(`belief_evidence:${valid.length}/${raw.evidence.length}`);
  if (valid.length === 0) throw new Error("belief_no_evidence");
  if (state.turns.some((t) => t.thought?.trim()) && !valid.some((e) => e.thoughtQuote)) throw new Error("belief_no_thought_evidence");
  return { summary: raw.summary, received: raw.received, gap: raw.gap, direction: raw.direction, evidence: valid.slice(0, 2) };
}

export function buildBeliefPrompt(state: GameState): { system: string; user: string } {
  const partner = state.partner ?? "m";
  const name = PARTNERS[partner].name;
  const system = `# 역할
너는 연인 사이의 대화를 돌아보는 해설자다. 아래 "인물 Core"는 ${name}의 배경이다. ${name}가 되어 새 대사를 쓰지 않는다.
대화 전체에서 플레이어가 한 말과 각 마디에 남긴 ${name}의 속마음을 대조해, 둘 사이에 닿은 부분과 남은 차이를 설명한다.

# 원칙
- 한 마디씩 채점하거나 말투를 평가하지 않는다. 대화 시작부터 끝까지 흐름을 읽고, ${name}가 받아들인 점과 끝까지 엇갈린 점을 하나씩 정리한다.
- 근거는 플레이어의 실제 말과 그 마디에 저장된 ${name}의 속마음에서 가져온다. evidence에는 같은 마디의 번호와 양쪽 원문에서 **한 글자도 바꾸지 않은** 짧은 구절을 붙인다.
- 속마음이 없는 마디를 근거로 쓸 때만 thoughtQuote를 빈 문자열로 둔다. 속마음이 있는 판은 적어도 한 근거에 속마음을 인용한다.
- 대화에 없던 과거·습관·성격을 지어내지 않는다. 성격 유형·심리 진단·라벨도 금지한다.
- 플레이어가 실제로 표현하지 않은 감정을 "직접 말했다"고 쓰지 않는다. 걱정했다고만 말했다면 서운함까지 직접 말했다고 넓히지 않는다. 듣지 못한 내용은 "대화에서 듣지 못했다"고 구분한다.
- 발화의 주체와 시점(답이 늦기 전/후), 요청과 약속의 범위를 바꾸거나 실제 말보다 강하게 확대하지 않는다.
- gap은 점수가 낮다는 이유만으로 만들지 않는다. 모든 약속에 공통인 "앞으로 지켜질지 모른다" 같은 가상의 불확실성으로 채우지 말고, 대화에서 실제로 드러난 미해결 쟁점이나 아직 말하지 못한 부분을 찾는다. 크게 엇갈린 부분이 남지 않았다면 그렇게 쓴다.
- direction은 남은 차이를 살펴볼 **대화 주제나 관점** 한 가지다. 플레이어가 그대로 따라 말할 완성된 대사나 정답 문장을 쓰지 않는다. 반드시 존댓말 한 문장으로 쓰고, 문장 끝은 "요" 또는 "니다"로 맺는다.
- summary·received·gap·direction은 해설자의 3인칭 문장으로 쓴다. 주체가 필요하면 "플레이어"와 "${name}"를 쓴다. "나/내/너/네"는 내 말과 ${name}의 말 중 누구를 뜻하는지 헷갈리므로 생성 문장에 쓰지 않는다. evidence의 원문 인용은 바꾸지 않는다.
- 점수나 결과 등급을 추정하지 않는다. 실제 말과 속마음만 판단의 근거로 삼는다.

${coreFor(partner)}

# 출력: JSON 하나
{"summary":"...","received":"...","gap":"...","direction":"...","evidence":[{"turn":2,"playerQuote":"...","thoughtQuote":"..."}]}
- summary: 전체 대화의 흐름을 1~2문장, 120자 이내로 요약한다.
- received: 대화 전체에서 ${name}가 받아들였거나 마음이 움직인 부분, 140자 이내. 뚜렷하지 않으면 그렇게 쓴다.
- gap: 플레이어가 전한 말과 ${name}의 속마음 사이에 끝까지 남은 차이, 140자 이내. 억지로 부족한 점을 만들지 않는다.
- direction: gap을 바탕으로 다음에 함께 살펴볼 방향 한 가지, 90자 이내. 직접 말할 문장은 쓰지 않으며 존댓말 종결("요" 또는 "니다")로 끝낸다.
- evidence: 전체 판단을 뒷받침하는 1~2개 마디. playerQuote는 실제 플레이어 말, thoughtQuote는 같은 마디의 속마음에서 그대로 옮긴다.`;

  const turns = state.turns
    .map((t, i) => {
      const npc = t.npc.map((b) => (b.type === "narration" ? `(${b.content})` : b.content)).join(" ");
      return [
        `## ${i + 1}번째 마디`,
        `- 플레이어: ${t.player}`,
        `- ${name}: ${npc}`,
        ...(t.noticed ? [`- 그때 포착한 플레이어의 태도: ${t.noticed}`] : []),
        ...(t.thought ? [`- 그때 ${name}의 속마음: ${t.thought}`] : []),
      ].join("\n");
    })
    .join("\n\n");
  const user = `# 대화
${turns}

플레이어가 한 말의 흐름과 ${name}의 속마음이 바뀐 흐름을 비교하고, 위 대화만 근거로 JSON을 쓴다.`;
  return { system, user };
}

export type BeliefResult = { ok: true; belief: Belief; attempts: AttemptRecord[] } | { ok: false; failure: LlmFailure | null; attempts: AttemptRecord[] };

export async function writeBelief(state: GameState): Promise<BeliefResult> {
  const npcName = PARTNERS[state.partner ?? "m"].name;
  if (state.turns.length === 0) return { ok: false, failure: null, attempts: [] };
  if (isScripted()) return { ok: true, belief: scriptedBelief(state, npcName), attempts: [] };
  const cfg = modelConfig("belief");
  const prompt = buildBeliefPrompt(state);
  const res = await callWithRetry(cfg, { ...prompt, schemaName: "belief", schema: BELIEF_JSON_SCHEMA }, (json, a) => parseBelief(state, json, !a.last));
  if (!res.ok) return res;
  const last = res.attempts.at(-1);
  return { ok: true, belief: { kind: "feedback", v: 3, npcName, ...res.value, model: last?.respondedModel ?? cfg.model, usage: last?.usage ?? null }, attempts: res.attempts };
}

/** 대본 모드: 실제 말과 속마음에서 인용을 뽑아 형식을 보여 준다. */
function scriptedBelief(state: GameState, npcName: string): Belief {
  const turns = state.turns.map((t, i) => ({ turn: i + 1, ...t }));
  const strongest = [...turns].sort((a, b) => b.applied - a.applied)[0]!;
  const last = turns.at(-1)!;
  const withThought = turns.find((t) => t.thought?.trim());
  const pick = [strongest, withThought ?? last, last].filter((t, i, all) => all.findIndex((x) => x.turn === t.turn) === i).slice(0, 2);
  const evidence = pick.map((t) => ({ turn: t.turn, playerQuote: Array.from(t.player).slice(0, 40).join("").trim(), thoughtQuote: Array.from(t.thought ?? "").slice(0, 60).join("").trim() }));
  return {
    kind: "feedback",
    v: 3,
    npcName,
    summary: "대화에서 서로에게 닿은 말과 남은 차이를 함께 돌아봤어요.",
    received: `${strongest.turn}번째 말에서 대화가 가장 많이 움직였어요.`,
    gap: "대화 전체에서 서로 다르게 받아들인 부분이 있었는지 돌아보세요.",
    direction: "상대가 받아들인 부분과 아직 남은 감정을 함께 살펴보면 좋겠습니다.",
    evidence,
    model: "scripted",
    usage: null,
  };
}
