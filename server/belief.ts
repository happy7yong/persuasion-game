// "내가 본 너": 대화가 끝난 뒤 연인이 플레이어를 어떻게 봤는지 말한다.
// relationship-engine(B)의 Belief를 작게 시험하는 기능이다 (docs/belief.md).
//   Belief = 경험을 근거로 NPC가 형성한 사용자에 대한 해석. 틀릴 수 있고, 반례와 정정으로 고쳐진다.
// B에서 가져온 규칙:
// - 근거 없는 판단은 없다: 판단마다 근거 마디와 그 마디에서 플레이어가 실제로 한 말을 그대로 붙인다.
//   인용이 원문에 없으면 코드가 거부한다 (LLM은 제안, 엔진이 검증).
// - 정보 경계: 이 대화에 없던 과거·습관을 지어내지 않는다.
// - 연인 자신의 관점(Core)으로 본 가설이며, 화면에도 "틀릴 수 있다"고 밝힌다.
import { z } from "zod";
import { coreFor, PARTNERS } from "./content.js";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { shakePercent, type GameState, type Outcome } from "./rules.js";

export const BELIEF_PROMPT_VERSION = "belief@1";

export interface BeliefPoint {
  /** 관찰 ("서운한 건 돌려 말하지 않는 사람") */
  claim: string;
  /** 근거가 된 마디 번호 (1부터) */
  turn: number;
  /** 그 마디에서 플레이어가 실제로 한 말의 일부, 원문 그대로 */
  quote: string;
  /** 왜 그렇게 봤는지, 연인의 말투로 */
  why: string;
}

export interface Belief {
  kind: "belief";
  v: 1;
  npcName: string;
  summary: string;
  points: BeliefPoint[];
  expectation: string;
  model: string;
  usage: LlmUsage | null;
}

/** 성격 유형·심리 진단 라벨. 다섯 마디로 판단할 수 없고, 틀리면 불쾌하다. */
const BANNED = /MBTI|[EI][NS][TF][JP]|애착|불안형|회피형|안정형|자존감|트라우마|우울|강박|성격\s*유형|나르시|경계성|ADHD|공감\s*능력이?\s*(없|부족)/i;

const OUTCOME_KO: Record<Outcome, string> = { success: "설득됨", compromise: "꽤 흔들렸지만 완전히 넘어가진 않음", breakdown: "거의 안 움직임", giveup: "상대가 대화를 중간에 멈춤" };

const Raw = z.object({
  summary: z.string().trim().min(1).max(120),
  points: z
    .array(z.object({ claim: z.string().trim().min(1).max(60), turn: z.number().int(), quote: z.string().trim().min(1).max(60), why: z.string().trim().min(1).max(100) }))
    .min(1)
    .max(4),
  expectation: z.string().trim().min(1).max(120),
});

const STR = { type: "string" } as const;
export const BELIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "points", "expectation"],
  properties: {
    summary: STR,
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "turn", "quote", "why"],
        properties: { claim: STR, turn: { type: "integer" }, quote: STR, why: STR },
      },
    },
    expectation: STR,
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
  const all = [raw.summary, raw.expectation, ...raw.points.flatMap((p) => [p.claim, p.why])].join("\n");
  if (BANNED.test(all)) throw new Error("belief_banned_label");
  const valid = raw.points.filter((p) => quoteIsReal(state, p.turn, p.quote));
  if (strict && (valid.length !== raw.points.length || valid.length < 2)) throw new Error(`belief_evidence:${valid.length}/${raw.points.length}`);
  if (valid.length === 0) throw new Error("belief_no_evidence");
  return { summary: raw.summary, points: valid.slice(0, 3), expectation: raw.expectation };
}

export function buildBeliefPrompt(state: GameState): { system: string; user: string } {
  const partner = state.partner ?? "m";
  const name = PARTNERS[partner].name;
  const outcome = state.outcome ?? "breakdown";
  const system = `# 역할
너는 아래 "인물 Core"의 ${name}다. 방금 연인과 카페에서 다섯 마디 대화를 마쳤다.
대화를 돌아보며 "내가 본 너"를 연인에게 직접 말하듯 쓴다.

# 원칙
- 이건 사실이 아니라 네 해석(가설)이다. 네 가치관과 성격(Core)으로 본 것이고 틀릴 수 있다.
- **오직 이 대화에서 플레이어가 실제로 한 말**에 근거한다. 판단마다 근거 마디 번호와, 그 마디의 플레이어 말에서 **한 글자도 바꾸지 않고 그대로 옮긴** 짧은 구절(15자 이내)을 붙인다.
- 대화에 없던 과거·습관·성격을 지어내지 않는다("원래 ~잖아", "늘 ~하더라" 금지).
- 성격 유형·심리 진단·라벨 금지: MBTI, 애착 유형, 불안형/회피형, 자존감, 트라우마 같은 말.
- 채점하거나 평가하는 말투 금지. 단점도 애정 섞인 관찰로. 다만 결과와 어긋나지 않게: 많이 안 움직였다면 아직 걸리는 점도 솔직하게.
- 말투는 Core의 말투 그대로(짧고 투박한 반말). 상담사 말투 금지.

${coreFor(partner)}

# 출력: JSON 하나
{"summary":"...","points":[{"claim":"...","turn":2,"quote":"...","why":"..."}],"expectation":"..."}
- summary: "내가 본 너는 ~" 으로 시작하는 1~2문장, 60자 이내.
- points: 2~3개. 서로 다른 마디를 근거로 하면 좋다.
  - claim: 관찰 한 구절(20자 안팎). 예: "서운한 건 돌려 말하지 않는 사람"
  - turn: 근거 마디 번호
  - quote: 그 마디에서 플레이어가 한 말의 일부를 그대로
  - why: 왜 그렇게 봤는지 네 말투로 40자 이내
- expectation: "다음에 내가 또 연락 못 하면, 너는 아마 ~" 로 시작하는 한 문장.`;

  const turns = state.turns
    .map((t, i) => {
      const npc = t.npc.map((b) => (b.type === "narration" ? `(${b.content})` : b.content)).join(" ");
      return [
        `## ${i + 1}번째 마디`,
        `- 플레이어: ${t.player}`,
        `- 너: ${npc}`,
        ...(t.noticed ? [`- 그때 네가 알게 된 것: ${t.noticed}`] : []),
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
  return { ok: true, belief: { kind: "belief", v: 1, npcName, ...res.value, model: last?.respondedModel ?? cfg.model, usage: last?.usage ?? null }, attempts: res.attempts };
}

/** 대본 모드: 실제 말에서 인용을 뽑아 형식만 보여 준다. */
function scriptedBelief(state: GameState, npcName: string): Belief {
  const pick = state.turns
    .map((t, i) => ({ turn: i + 1, applied: t.applied, quote: Array.from(t.player).slice(0, 10).join("").trim(), noticed: t.noticed }))
    .sort((a, b) => b.applied - a.applied)
    .slice(0, 2);
  return {
    kind: "belief",
    v: 1,
    npcName,
    summary: "내가 본 너는… 서운한 걸 참는 사람은 아닌 것 같아.",
    points: pick.map((p) => ({ claim: p.noticed && !p.noticed.includes("모르겠") ? p.noticed : "하고 싶은 말은 하는 사람", turn: p.turn, quote: p.quote, why: "그 말 듣고 좀 놀랐거든." })),
    expectation: "다음에 내가 또 연락 못 하면, 너는 아마 화내기 전에 한 번은 물어볼 것 같아.",
    model: "scripted",
    usage: null,
  };
}
