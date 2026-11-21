// 엔딩: 경로(갈림길)는 코드가 대화 전체에서 계산하고, LLM은 웃긴 문장만 쓴다.
import { z } from "zod";
import { PARTNERS } from "./content.js";
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
  /** 연인의 이름 */
  npcName: string;
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

  // 말투는 "몇 번 썼나"가 아니라 "그 말투로 얼마나 흔들었나"로 정한다. 물음표 하나가 문명을 정하지 않게.
  // 압박은 흔든 양이 거의 없으므로, 압박밖에 없는 판에서만 불도저 문명이 된다.
  const weight = new Map<StrategyLabel, number>();
  for (const l of lines) for (const lab of l.labels) weight.set(lab, (weight.get(lab) ?? 0) + Math.max(l.drop, 1));
  let dominant: StrategyLabel | null = null;
  for (const [lab, w] of weight) if (dominant === null || w > (weight.get(dominant) ?? 0)) dominant = lab;
  const dominantTurn = dominant
    ? (lines.filter((l) => l.labels.includes(dominant!)).sort((a, b) => b.drop - a.drop || a.turn - b.turn)[0]?.turn ?? null)
    : null;

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
      basis: finalKey === "apology" ? "사과를 했는가" : finalKey === "laugh" ? "웃음을 남겼는가" : "사과도 웃음도 없이 끝까지 갔는가",
      chosen: FINAL_ERA[finalKey],
      untaken: Object.values(FINAL_ERA).filter((v) => v !== FINAL_ERA[finalKey]),
      decidingTurn: finalKey === "apology" ? apologyTurn : finalKey === "laugh" ? laughTurn : (lines.at(-1)?.turn ?? null),
    },
  ];
  return { npcName: PARTNERS[state.partner ?? "m"].name, outcome, shake: shakePercent(state.score), lines, strongestTurn: strongest, weakestTurn: weakest, forks };
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
  const system = `너는 '은하 연합 타임스'의 속보 작가다. 한 지구인이 카페에서 연인 ${plan.npcName}와 연락 문제로 나눈 대화가, 사실은 은하연애위원회에 생중계되고 있었다.
그 지구인의 말 한마디 한마디가 미래를 말도 안 되게 바꿔 놓은 연표를 쓴다.

# 톤
- 낙서 몇 번에 주가가 폭락하는 게임처럼, 사소한 말이 터무니없이 거대한 결과로 번지는 과장된 코미디.
- **한 마디 안에서** 사건 3개가 폭발적으로 커진다: ① 동네·개인 → ② 나라·세계 → ③ 행성·은하. 첫 사건부터 이미 웃겨야 하고, 마지막 사건은 말도 안 되게 거대해야 한다.
- 숫자를 크고 구체적으로: 커플 수(만 쌍~억 쌍), 매출·주가(%), 은하크레딧, 행성 수. 법·공휴일·국가 기관·외계 종족이 등장해도 좋다.
- 그 말의 실제 단어와 내용이 결과의 원인이어야 한다. 그 말을 비웃지 않고, 그 말이 세상을 바꿔 버린 것을 웃기게 쓴다. 욕설이나 비속어가 있으면 그 단어를 다시 쓰지 말고 "그 한마디" 등으로 돌려 말한다.
- 금지: 실존 인물·기업·정치·종교, 죽음·폭력·재난 피해, 외모·몸 비하, 성적 내용.
- 한국어, 짧고 리듬감 있게. 각 사건 60자 안팎. 문장 끝은 "~다"로.

# 톤 예시 (그대로 베끼지 말 것)
말: "바쁘면 미리 말만 해줘"
① 동네 카페 단골 37명이 회의 전에 "나 회의 들어감"을 보내기 시작한다
② 사전 고지법 UN 만장일치 통과, 오전 9시 59분마다 전 세계 메신저 서버가 터진다
③ 외계 문명과의 첫 교신 내용이 "혹시 바쁘시면 미리 말씀해 주시겠어요?"였다, 감동한 외계인 즉시 동맹 체결

# 출력: JSON 하나
{"chains":[{"turn":1,"events":["...","...","..."]}],"headline":{"title":"...","subtitle":"..."},"textbook":"...","side_articles":["...","..."],"untaken":{"instead":"...","events":["...","..."]}}
- chains: 모든 마디에 하나씩. events는 주어진 연도 순서대로 3개, 앞 사건이 다음 사건의 원인이 되게. 연도 숫자는 문장에 쓰지 않는다.
- headline: 3026년 은하 신문 1면. title은 가장 결정적인 말이 은하에 남긴 결과, subtitle은 한 줄 부연.
- textbook: 은하 역사 교과서 1장 첫 문장. "모든 것은 한 지구인이 카페에서 ~라고 한 데서 시작되었다." 형식.
- side_articles: 관련 짧은 기사 2개.
- untaken: 가장 약했던 말 대신, 그 순간에 했으면 더 좋았을 **새로운 한 문장**을 네가 지어서 갈라졌을 미래를 쓴다. instead는 "만약 '새 문장'이라고 했다면" 형식이고, 새 문장은 실제로 한 말과 달라야 한다(20자 안팎의 자연스러운 구어체). events 2개도 크게 터지게.`;

  const lines = plan.lines
    .map((l) => {
      const years = (TURN_YEARS[l.turn - 1] ?? TURN_YEARS[4]!).join(", ");
      return `${l.turn}. "${l.text}" (${plan.npcName} 마음 -${l.drop}%, 특징: ${l.labels.join(", ") || "없음"}, 연도: ${years})`;
    })
    .join("\n");
  const forks = plan.forks.map((f) => `- ${f.era} (${f.basis}): ${f.chosen}`).join("\n");
  const user = `# 대화 결과
${OUTCOME_KO[plan.outcome]}, ${plan.npcName}의 마음을 ${plan.shake}% 흔들었다.

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

export const ENDING_PROMPT_VERSION = "galaxy-ending@2";

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
    // 갈라지지 않은 미래는 실제로 한 말이 아니라 다른 말이어야 한다.
    const weak = plan.lines.find((l) => l.turn === plan.weakestTurn)?.text.replace(/\s/g, "");
    if (weak && text.untaken.instead.replace(/\s/g, "").includes(weak.slice(0, 12))) throw new Error("untaken_repeats_actual_line");
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
