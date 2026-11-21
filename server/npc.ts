import { z } from "zod";
import { BAND_GUIDE, COMMON_PRINCIPLES, ENGINE_RULES, MOVE_GUIDE, NPC_CORE, OUTPUT_FORMAT, SCENARIO, SCENE_FACTS, SCORING_RUBRIC } from "./content.js";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { band, chooseMove, STRATEGY_LABELS, type GameState, type NpcMove, type StrategyLabel } from "./rules.js";

const BeatSchema = z.object({
  type: z.enum(["narration", "dialogue"]),
  content: z.string().trim().min(1).max(300),
});

export const NpcOutputSchema = z.object({
  beats: z.array(BeatSchema).min(1).max(4),
  evaluation: z.object({
    suggested_drop: z.number(),
    labels: z.array(z.string()).default([]),
    reason: z.string().default(""),
  }),
});

export interface NpcReply {
  beats: { type: "narration" | "dialogue"; content: string }[];
  move: NpcMove;
  suggested: number;
  labels: StrategyLabel[];
  reason: string;
  model: string;
  usage: LlmUsage | null;
}

const isLabel = (s: string): s is StrategyLabel => (STRATEGY_LABELS as readonly string[]).includes(s);

const ENDS_WITH_QUESTION = /[?？]\s*[)"”’…~.]*\s*$/u;

/** 끝맺음 방식을 지켰는지. 질문은 ask일 때만, 여운은 행동 묘사로 끝난다. 위반 사유 또는 null. */
export function moveViolation(move: NpcMove, beats: { type: string; content: string }[]): string | null {
  const last = beats.at(-1);
  if (!last) return "no_beats";
  const asks = beats.some((b) => b.type === "dialogue" && ENDS_WITH_QUESTION.test(b.content.trim()));
  if (move !== "ask" && asks) return `question_in_${move}`;
  if (move === "linger" && last.type !== "narration") return "linger_not_narration";
  return null;
}

export function parseNpcOutput(raw: unknown, move: NpcMove = "counter", strict = false): Omit<NpcReply, "model" | "usage"> {
  const out = NpcOutputSchema.parse(raw);
  const beats = out.beats.map((b) => ({ type: b.type, content: b.content.replace(/^["“]|["”]$/g, "") }));
  if (strict) {
    const v = moveViolation(move, beats);
    if (v) throw new Error(`move_violation:${v}`);
  }
  return {
    beats,
    move,
    suggested: out.evaluation.suggested_drop,
    labels: [...new Set(out.evaluation.labels.filter(isLabel))],
    reason: out.evaluation.reason.slice(0, 80),
  };
}

export function buildNpcPrompt(state: GameState, playerText: string, move: NpcMove = chooseMove(state)): { system: string; user: string } {
  const system = [
    ENGINE_RULES,
    COMMON_PRINCIPLES,
    NPC_CORE,
    `# 장면\n- 장소: ${SCENARIO.place}\n- 대화 방식: 직접 마주하고 있다\n## 네가 아는 사실\n${SCENE_FACTS.map((f) => `- ${f}`).join("\n")}`,
    `# 지금 상태\n${BAND_GUIDE[band(state.score)]}\n이번 말이 좋았다면 그만큼 반응에 드러내되, 지금 상태보다 한 단계 넘게 갑자기 바뀌지 않는다.`,
    SCORING_RUBRIC,
    OUTPUT_FORMAT,
    `# 이번 차례를 끝내는 방식\n${MOVE_GUIDE[move]}`,
  ].join("\n\n");

  // B(relationship-engine)의 대화 기록 형식: 너/플레이어, 말/행동을 나눠 2인칭으로 준다.
  const lines: string[] = SCENARIO.opening.map(beatLine);
  for (const t of state.turns) {
    lines.push(`- 플레이어 (말): ${t.player}`);
    lines.push(...t.npc.map(beatLine));
  }
  const user = `# 지금까지 네가 보고 들은 대화
${lines.join("\n")}

# 방금 플레이어가 한 것
- 플레이어 (말): ${playerText}

# 이번 차례
위 규칙에 따라 JSON으로 답한다.`;
  return { system, user };
}

function beatLine(b: { type: string; content: string }) {
  return b.type === "narration" ? `- 너 (행동): ${b.content}` : `- 너 (말): ${b.content}`;
}

/** 프롬프트 버전. trace에 남겨 어떤 프롬프트로 나온 응답인지 구분한다. */
export const NPC_PROMPT_VERSION = "yunjae@3";

/** strict json_schema (B의 llm01WireSchema와 같은 방식). 모든 필드 필수, 추가 필드 금지. */
export const NPC_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["beats", "evaluation"],
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
    evaluation: {
      type: "object",
      additionalProperties: false,
      required: ["suggested_drop", "labels", "reason"],
      properties: {
        suggested_drop: { type: "integer" },
        labels: { type: "array", items: { type: "string", enum: [...STRATEGY_LABELS] } },
        reason: { type: "string" },
      },
    },
  },
} as const;

export type NpcResult =
  | { ok: true; reply: NpcReply; attempts: AttemptRecord[] }
  | { ok: false; failure: LlmFailure; attempts: AttemptRecord[] };

export async function npcReply(state: GameState, playerText: string): Promise<NpcResult> {
  if (isScripted()) return { ok: true, reply: scriptedReply(state, playerText), attempts: [] };
  const cfg = modelConfig("npc_turn");
  const move = chooseMove(state);
  const prompt = buildNpcPrompt(state, playerText, move);
  // 첫 시도는 끝맺음 방식까지 엄격하게, 마지막 시도는 형식만 본다 (질문 하나 때문에 마디를 잃지 않게).
  const parse = (json: unknown, a: { last: boolean }) => parseNpcOutput(json, move, !a.last);
  const res = await callWithRetry(cfg, { ...prompt, schemaName: "npc_turn", schema: NPC_JSON_SCHEMA }, parse);
  if (!res.ok) return res;
  const last = res.attempts.at(-1);
  return {
    ok: true,
    reply: { ...res.value, model: last?.respondedModel ?? cfg.model, usage: last?.usage ?? null },
    attempts: res.attempts,
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
  const suggested = labels.includes("pressure") ? 2 : Math.min(20, 4 + labels.length * 5 + Math.floor(text.length / 40));
  const move = chooseMove(state);
  const said: Record<NpcMove, string> = {
    counter: "음, 그 말은 마음에 남는다. 근데 나 화요일은 회의만 다섯 개라 진짜 폰을 못 보거든.",
    ask: "그날 제일 서운했던 게 뭐였어?",
    concede: "알았어, 그건 네 말이 맞아. 대신 회의 몰린 날은 조금만 봐줘.",
    linger: "…그렇구나.",
  };
  const beats: NpcReply["beats"] = [{ type: "dialogue", content: said[move] }];
  if (move === "linger") beats.push({ type: "narration", content: "윤재가 잔을 두 손으로 감싼 채 한참 내려다본다." });
  else beats.unshift({ type: "narration", content: "윤재가 잔을 두 손으로 감싼다." });
  return {
    beats,
    move,
    suggested,
    labels,
    reason: "대본 모드",
    model: "scripted",
    usage: null,
  };
}
