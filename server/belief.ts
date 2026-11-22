// 대화 피드백: 끝난 판에서 플레이어 발화를 근거로 다음 시도에 쓸 피드백을 만든다.
// 근거 없는 평가는 막는다. 각 항목의 인용은 실제 플레이어 발화에 있어야 한다.
import { z } from "zod";
import { coreFor, PARTNERS } from "./content.js";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { shakePercent, type GameState, type Outcome } from "./rules.js";

export const BELIEF_PROMPT_VERSION = "feedback@1";

export interface BeliefPoint {
  /** 이 발화에서 잘한 점 */
  strength: string;
  /** 근거가 된 마디 번호 (1부터) */
  turn: number;
  /** 그 마디에서 플레이어가 실제로 한 말의 일부, 원문 그대로 */
  quote: string;
  /** 설득을 위해 보완할 지점 */
  improve: string;
  /** 다음에 실제로 쓸 수 있는 한 문장 제안 */
  suggestion: string;
}

export interface Belief {
  kind: "feedback";
  v: 2;
  npcName: string;
  summary: string;
  points: BeliefPoint[];
  closing: string;
  model: string;
  usage: LlmUsage | null;
}

/** 성격 유형·심리 진단 라벨. 다섯 마디로 판단할 수 없고, 틀리면 불쾌하다. */
const BANNED = /MBTI|[EI][NS][TF][JP]|애착|불안형|회피형|안정형|자존감|트라우마|우울|강박|성격\s*유형|나르시|경계성|ADHD|공감\s*능력이?\s*(없|부족)/i;

const OUTCOME_KO: Record<Outcome, string> = { success: "설득됨", compromise: "꽤 흔들렸지만 완전히 넘어가진 않음", breakdown: "거의 안 움직임", giveup: "상대가 대화를 중간에 멈춤" };

const Raw = z.object({
  summary: z.string().trim().min(1).max(120),
  points: z
    .array(z.object({ strength: z.string().trim().min(1).max(80), turn: z.number().int(), quote: z.string().trim().min(1).max(60), improve: z.string().trim().min(1).max(100), suggestion: z.string().trim().min(1).max(160) }))
    .min(1)
    .max(4),
  closing: z.string().trim().min(1).max(120),
});

const STR = { type: "string" } as const;
export const BELIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "points", "closing"],
  properties: {
    summary: STR,
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["strength", "turn", "quote", "improve", "suggestion"],
        properties: { strength: STR, turn: { type: "integer" }, quote: STR, improve: STR, suggestion: STR },
      },
    },
    closing: STR,
  },
} as const;

const squash = (t: string) => t.replace(/[\s"'“”‘’.,!?~…]/g, "");

/** 인용이 그 마디에서 플레이어가 실제로 한 말에 있는지 (공백·문장부호 차이는 무시). */
export function quoteIsReal(state: GameState, turn: number, quote: string): boolean {
  const line = state.turns[turn - 1]?.player;
  const q = squash(quote);
  return Boolean(line && q.length >= 2 && squash(line).includes(q));
}

/**
 * 출력을 검사한다. strict: 모든 판단이 진짜 인용을 갖고 2개 이상이어야 한다.
 * 마지막 시도(strict=false)에서는 근거가 맞는 판단만 남기고, 하나라도 있으면 받는다.
 */
export function parseBelief(state: GameState, json: unknown, strict: boolean): Omit<Belief, "kind" | "v" | "npcName" | "model" | "usage"> {
  const raw = Raw.parse(json);
  const all = [raw.summary, raw.closing, ...raw.points.flatMap((p) => [p.strength, p.improve, p.suggestion])].join("\n");
  if (BANNED.test(all)) throw new Error("belief_banned_label");
  const valid = raw.points.filter((p) => quoteIsReal(state, p.turn, p.quote));
  if (strict && (valid.length !== raw.points.length || valid.length < 2)) throw new Error(`belief_evidence:${valid.length}/${raw.points.length}`);
  if (valid.length === 0) throw new Error("belief_no_evidence");
  return { summary: raw.summary, points: valid.slice(0, 3), closing: raw.closing };
}

export function buildBeliefPrompt(state: GameState): { system: string; user: string } {
  const partner = state.partner ?? "m";
  const name = PARTNERS[partner].name;
  const outcome = state.outcome ?? "breakdown";
  const system = `# 역할
너는 아래 "인물 Core"의 ${name}다. 방금 연인과 카페에서 다섯 마디 대화를 마쳤다.
대화를 돌아보며, 플레이어가 다음 대화에서 더 잘 설득할 수 있도록 발화 피드백을 쓴다.

# 원칙
- **오직 이 대화에서 플레이어가 실제로 한 말**과 NPC가 유지한 입장에 근거한다. 항목마다 근거 마디 번호와, 그 마디의 플레이어 말에서 **한 글자도 바꾸지 않고 그대로 옮긴** 짧은 구절을 붙인다.
- 대화에 없던 과거·습관·성격을 지어내지 않는다. 성격 유형·심리 진단·라벨도 금지한다.
- 비난하거나 성격을 평가하지 않는다. 부족한 점은 "어떤 반론이 아직 남았는지"와 "다음에는 무엇을 더 말하면 되는지"로만 설명한다.
- suggestion은 플레이어의 말을 대신 결정하지 않는 짧고 자연스러운 한 문장이다. NPC의 말투를 흉내 내지 않는다.
- 결과와 어긋나지 않게 쓴다. 점수가 낮은 말에도 잘한 점 하나는 찾되, 설득에 부족했던 부분을 분명히 말한다.

${coreFor(partner)}

# 출력: JSON 하나
{"summary":"...","points":[{"strength":"...","turn":2,"quote":"...","improve":"...","suggestion":"..."}],"closing":"..."}
- summary: 이번 대화의 흐름을 요약하는 1~2문장, 80자 이내.
- points: 2~3개. 서로 다른 마디를 근거로 하면 좋다.
  - strength: 해당 발화에서 설득에 도움이 된 점
  - turn: 근거 마디 번호
  - quote: 그 마디에서 플레이어가 한 말의 일부를 그대로
  - improve: 아직 남은 NPC의 반론 또는 보완할 점
  - suggestion: 다음에 쓸 수 있는 더 나은 한 문장
- closing: 다음 대화에서 기억할 핵심 한 줄.`;

  const turns = state.turns
    .map((t, i) => {
      const npc = t.npc.map((b) => (b.type === "narration" ? `(${b.content})` : b.content)).join(" ");
      return [
        `## ${i + 1}번째 마디`,
        `- 플레이어: ${t.player}`,
        `- 너: ${npc}`,
        ...(t.noticed ? [`- 그때 포착한 플레이어의 태도: ${t.noticed}`] : []),
        ...(t.thought ? [`- 그때 네 속마음: ${t.thought}`] : []),
      ].join("\n");
    })
    .join("\n\n");
  const user = `# 대화 결과
네 마음은 ${shakePercent(state.score)}% 움직였다 (${OUTCOME_KO[outcome]}).

# 대화
${turns}

위 대화만 근거로 JSON을 쓴다.`;
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
  return { ok: true, belief: { kind: "feedback", v: 2, npcName, ...res.value, model: last?.respondedModel ?? cfg.model, usage: last?.usage ?? null }, attempts: res.attempts };
}

/** 대본 모드: 실제 말에서 인용을 뽑아 형식만 보여 준다. */
function scriptedBelief(state: GameState, npcName: string): Belief {
  const pick = state.turns
    .map((t, i) => ({ turn: i + 1, applied: t.applied, quote: Array.from(t.player).slice(0, 10).join("").trim(), noticed: t.noticed }))
    .sort((a, b) => b.applied - a.applied)
    .slice(0, 2);
  return {
    kind: "feedback",
    v: 2,
    npcName,
    summary: "구체적으로 말한 마디가 설득에 더 도움이 됐어요.",
    points: pick.map((p) => ({ strength: p.noticed && !p.noticed.includes("모르겠") ? p.noticed : "핵심 감정을 직접 말했어요", turn: p.turn, quote: p.quote, improve: "상대가 유지한 입장에도 직접 답하면 더 설득력이 커져요.", suggestion: "네 사정은 이해해. 대신 내가 불안해진 이유도 같이 봐줬으면 해." })),
    closing: "상대의 한계를 인정한 뒤, 내가 바라는 한 가지를 구체적으로 말해 보세요.",
    model: "scripted",
    usage: null,
  };
}
