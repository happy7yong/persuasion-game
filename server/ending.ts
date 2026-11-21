// 엔딩: 경로(갈림길)는 코드가 대화 전체에서 계산하고, LLM은 웃긴 문장만 쓴다.
import { z } from "zod";
import { callWithRetry, isScripted, type AttemptRecord, type LlmFailure, type LlmUsage } from "./llm.js";
import { modelConfig } from "./model-config.js";
import { shakePercent, type GameState, type Outcome, type StrategyLabel } from "./rules.js";

/** 마디별 연표 연도. 뒤로 갈수록 스케일이 커진다. */
export const TURN_YEARS: readonly (readonly [number, number, number])[] = [
  [2027, 2028, 2030],
  [2031, 2040, 2047],
  [2050, 2060, 2071],
  [2100, 2150, 2200],
  [2384, 2700, 3026],
];

const LAW: Record<Outcome, string> = {
  success: "은하 연락 보장법",
  compromise: "은하 연락 조약",
  breakdown: "연락 자유화 선언",
  giveup: "침묵 협정",
};

const CIVILIZATION: Record<StrategyLabel, string> = {
  logic: "논리 문명",
  emotion: "고백 문명",
  question: "질문 문명",
  compromise: "조약 문명",
  apology: "사과 문명",
  empathy: "공감 문명",
  humor: "드립 문명",
  pressure: "불도저 문명",
};

const FINAL_ERA = {
  apology: "'미안해' 은하 공용어 시대",
  laugh: "'ㅋㅋㅋ' 은하 평화 신호 시대",
  plain: "은하 직진 시대",
} as const;

export interface Fork {
  era: string;
  basis: string;
  chosen: string;
  untaken: string[];
  decidingTurn: number | null;
}

export interface EndingPlan {
  outcome: Outcome;
  shake: number;
  lines: { turn: number; text: string; drop: number; labels: StrategyLabel[] }[];
  strongestTurn: number | null;
  weakestTurn: number | null;
  forks: Fork[];
}

export function planEnding(state: GameState): EndingPlan {
  const outcome = state.outcome ?? "breakdown";
  const lines = state.turns.map((t, i) => ({ turn: i + 1, text: t.player, drop: t.applied, labels: t.labels }));
  let strongest: number | null = null;
  let weakest: number | null = null;
  for (const l of lines) {
    if (strongest === null || l.drop > (lines[strongest - 1]?.drop ?? -1)) strongest = l.turn;
    if (weakest === null || l.drop < (lines[weakest - 1]?.drop ?? 999)) weakest = l.turn;
  }
  if (lines.length < 2 || strongest === weakest) weakest = null;

  const counts = new Map<StrategyLabel, number>();
  for (const l of lines) for (const lab of l.labels) counts.set(lab, (counts.get(lab) ?? 0) + 1);
  let dominant: StrategyLabel | null = null;
  for (const [lab, n] of counts) if (dominant === null || n > (counts.get(dominant) ?? 0)) dominant = lab;
  const dominantTurn = dominant ? (lines.find((l) => l.labels.includes(dominant!))?.turn ?? null) : null;

  const apologyTurn = lines.find((l) => l.labels.includes("apology") || /미안/.test(l.text))?.turn ?? null;
  const laughTurn = lines.find((l) => /ㅋㅋ/.test(l.text))?.turn ?? null;
  const finalKey = apologyTurn ? "apology" : laughTurn ? "laugh" : "plain";

  const forks: Fork[] = [
    {
      era: "2030년대",
      basis: "대화의 결과",
      chosen: LAW[outcome],
      untaken: Object.values(LAW).filter((v) => v !== LAW[outcome]),
      decidingTurn: strongest,
    },
    {
      era: "2100년대",
      basis: "가장 많이 쓴 말투",
      chosen: dominant ? CIVILIZATION[dominant] : "침묵 문명",
      untaken: ["공감 문명", "논리 문명", "드립 문명", "불도저 문명"].filter((v) => v !== (dominant ? CIVILIZATION[dominant] : "")).slice(0, 3),
      decidingTurn: dominantTurn,
    },
    {
      era: "3026년",
      basis: finalKey === "apology" ? "사과를 했는가" : finalKey === "laugh" ? "웃음을 남겼는가" : "끝까지 직진했는가",
      chosen: FINAL_ERA[finalKey],
      untaken: Object.values(FINAL_ERA).filter((v) => v !== FINAL_ERA[finalKey]),
      decidingTurn: finalKey === "apology" ? apologyTurn : finalKey === "laugh" ? laughTurn : (lines.at(-1)?.turn ?? null),
    },
  ];
  return { outcome, shake: shakePercent(state.score), lines, strongestTurn: strongest, weakestTurn: weakest, forks };
}

const EventText = z.string().trim().min(1).max(140);
export const EndingTextSchema = z.object({
  chains: z.array(z.object({ turn: z.number().int(), events: z.array(EventText).min(1).max(3) })),
  headline: z.object({ title: z.string().trim().min(1).max(80), subtitle: z.string().trim().min(1).max(120) }),
  textbook: z.string().trim().min(1).max(160),
  side_articles: z.array(z.string().trim().min(1).max(100)).min(1).max(3),
  untaken: z.object({ instead: z.string().trim().min(1).max(100), events: z.array(EventText).min(1).max(3) }),
});
export type EndingText = z.infer<typeof EndingTextSchema>;

export interface Ending {
  plan: EndingPlan;
  chains: { turn: number; line: string; drop: number; events: { year: number; text: string }[] }[];
  headline: { title: string; subtitle: string; quote: string };
  textbook: string;
  sideArticles: string[];
  untaken: { instead: string; events: string[] };
  model: string;
  usage: LlmUsage | null;
}

const OUTCOME_KO: Record<Outcome, string> = { success: "설득 성공", compromise: "타협", breakdown: "결렬", giveup: "포기" };

export function buildEndingPrompt(plan: EndingPlan): { system: string; user: string } {
  const system = `너는 '은하 연합 타임스'의 속보 작가다. 한 지구인이 카페에서 연인 윤재와 연락 문제로 나눈 대화가, 사실은 은하연애위원회에 생중계되고 있었다.
그 지구인의 말 한마디 한마디가 미래를 말도 안 되게 바꿔 놓은 연표를 쓴다.

# 톤
- 낙서 몇 번에 주가가 폭락하는 게임처럼, 사소한 말이 터무니없이 거대한 결과로 번지는 과장된 코미디.
- 해마다 스케일이 커진다: 동네 → 나라 → 세계 → 행성 → 은하. 구체적인 숫자(커플 수, 매출, 주가, 은하크레딧)를 넣는다.
- 그 말의 실제 단어와 내용이 결과의 원인이 되게 한다. 그 말을 비웃지 않고, 말이 세상을 바꾼 것을 웃기게 쓴다.
- 금지: 실존 인물·기업·정치·종교, 죽음·폭력·재난 피해, 외모·몸 비하, 성적 내용.
- 한국어, 짧고 리듬감 있게. 각 사건 60자 안팎.

# 출력: JSON 하나
{"chains":[{"turn":1,"events":["...","...","..."]}],"headline":{"title":"...","subtitle":"..."},"textbook":"...","side_articles":["...","..."],"untaken":{"instead":"...","events":["...","..."]}}
- chains: 모든 마디에 하나씩. events는 주어진 연도 순서대로 3개, 앞 사건이 다음 사건의 원인이 되게. 연도 숫자는 문장에 쓰지 않는다.
- headline: 3026년 은하 신문 1면. title은 가장 결정적인 말이 은하에 남긴 결과, subtitle은 한 줄 부연.
- textbook: 은하 역사 교과서 1장 첫 문장. "모든 것은 한 지구인이 카페에서 ~라고 한 데서 시작되었다." 형식.
- side_articles: 관련 짧은 기사 2개.
- untaken: 가장 약했던 말 대신 다른 말을 했다면 갈라졌을 미래. instead는 "만약 '…'라고 했다면" 형식, events 2개.`;

  const lines = plan.lines
    .map((l) => {
      const years = (TURN_YEARS[l.turn - 1] ?? TURN_YEARS[4]!).join(", ");
      return `${l.turn}. "${l.text}" (윤재 마음 -${l.drop}%, 특징: ${l.labels.join(", ") || "없음"}, 연도: ${years})`;
    })
    .join("\n");
  const forks = plan.forks.map((f) => `- ${f.era} (${f.basis}): ${f.chosen}`).join("\n");
  const user = `# 대화 결과
${OUTCOME_KO[plan.outcome]}, 윤재의 마음을 ${plan.shake}% 흔들었다.

# 지구인의 말 (순서대로)
${lines}

# 가장 결정적인 말: ${plan.strongestTurn ?? "없음"}번
# 가장 약했던 말: ${plan.weakestTurn ?? "없음"}번

# 이미 정해진 갈림길 (연표가 이 결과들로 이어져야 한다)
${forks}`;
  return { system, user };
}

export function assembleEnding(plan: EndingPlan, text: EndingText, model: string, usage: LlmUsage | null): Ending {
  const byTurn = new Map(text.chains.map((c) => [c.turn, c.events]));
  const chains = plan.lines.map((l) => {
    const years = TURN_YEARS[l.turn - 1] ?? TURN_YEARS[4]!;
    const events = byTurn.get(l.turn) ?? [];
    return { turn: l.turn, line: l.text, drop: l.drop, events: events.map((t, i) => ({ year: years[i] ?? years[2], text: t })) };
  });
  const strongest = plan.lines.find((l) => l.turn === plan.strongestTurn)?.text ?? plan.lines.at(-1)?.text ?? "";
  return {
    plan,
    chains,
    headline: { ...text.headline, quote: strongest },
    textbook: text.textbook,
    sideArticles: text.side_articles.slice(0, 2),
    untaken: text.untaken,
    model,
    usage,
  };
}

export const ENDING_PROMPT_VERSION = "galaxy-ending@1";

const STR = { type: "string" } as const;
export const ENDING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["chains", "headline", "textbook", "side_articles", "untaken"],
  properties: {
    chains: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["turn", "events"],
        properties: { turn: { type: "integer" }, events: { type: "array", items: STR } },
      },
    },
    headline: { type: "object", additionalProperties: false, required: ["title", "subtitle"], properties: { title: STR, subtitle: STR } },
    textbook: STR,
    side_articles: { type: "array", items: STR },
    untaken: { type: "object", additionalProperties: false, required: ["instead", "events"], properties: { instead: STR, events: { type: "array", items: STR } } },
  },
} as const;

export type EndingResult = { ok: true; ending: Ending; attempts: AttemptRecord[] } | { ok: false; failure: LlmFailure; attempts: AttemptRecord[] };

export async function writeEnding(state: GameState): Promise<EndingResult> {
  const plan = planEnding(state);
  if (plan.lines.length === 0) return { ok: true, ending: assembleEnding(plan, emptyText(), "none", null), attempts: [] };
  if (isScripted()) return { ok: true, ending: assembleEnding(plan, scriptedText(plan), "scripted", null), attempts: [] };
  const cfg = modelConfig("ending");
  const prompt = buildEndingPrompt(plan);
  const parse = (json: unknown) => {
    const text = EndingTextSchema.parse(json);
    // 모든 마디의 연표가 있어야 한다. 빠지면 형식 실패로 보고 다시 시도한다.
    for (const l of plan.lines) if (!text.chains.some((c) => c.turn === l.turn && c.events.length > 0)) throw new Error(`missing_chain_${l.turn}`);
    return text;
  };
  const res = await callWithRetry(cfg, { ...prompt, schemaName: "galaxy_ending", schema: ENDING_JSON_SCHEMA }, parse);
  if (!res.ok) return res;
  const last = res.attempts.at(-1);
  return { ok: true, ending: assembleEnding(plan, res.value, last?.respondedModel ?? cfg.model, last?.usage ?? null), attempts: res.attempts };
}

function emptyText(): EndingText {
  return {
    chains: [],
    headline: { title: "지구인, 한 마디도 하지 않고 퇴장", subtitle: "은하연애위원회 \"침묵도 하나의 답변\"" },
    textbook: "모든 것은 한 지구인이 카페에서 아무 말도 하지 않은 데서 시작되었다.",
    side_articles: ["은하 언어학회, '…'의 의미 연구 착수"],
    untaken: { instead: "만약 한 마디라도 했다면", events: ["은하의 역사가 달라졌을지도 모른다"] },
  };
}

function scriptedText(plan: EndingPlan): EndingText {
  return {
    chains: plan.lines.map((l) => ({
      turn: l.turn,
      events: [
        `"${l.text.slice(0, 12)}…" 발언이 동네 카페 단골들 사이에 퍼진다`,
        `전국 커플 ${(l.drop + 1) * 37}만 쌍이 같은 말을 따라 하기 시작한다`,
        `은하 ${l.turn * 128}개 행성이 이 말을 공식 연애 문구로 채택한다`,
      ],
    })),
    headline: { title: `지구인 발언, ${plan.forks[0]?.chosen ?? "조약"}으로 1,000년째 유지`, subtitle: "은하연애위원회 \"그 카페의 라떼가 역사를 바꿨다\"" },
    textbook: `모든 것은 한 지구인이 카페에서 "${plan.lines[0]?.text.slice(0, 20) ?? ""}"라고 한 데서 시작되었다.`,
    side_articles: ["은하 외식 연합, 그 지구인에게 1,000년째 감사패 발송 중", "장거리 연애 행성 시리우스, 관광객 폭증"],
    untaken: { instead: "만약 다른 말을 했다면", events: ["2030년 연락 의무화법 통과", "2200년 인류, 답장 쓰느라 문명 발전 중단"] },
  };
}
